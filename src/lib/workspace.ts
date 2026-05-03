import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import {
  buildGithubUrl,
  buildStampUrl,
  readStampServerConfig,
  stampServerConfigPath,
} from "./stamp.ts";

/**
 * Lives at `/tmp/open-team-issues/`. Every per-ticket workspace gets a
 * directory whose name is the ticket id lowercased; the canonical agent
 * worktree is `<ticket-id-lc>/repo` inside it. Matches the convention
 * already documented in `assign-ticket.md` Hard rule 6 — the runner now
 * owns the layout.
 */
export const WORKSPACE_ROOT = "/tmp/open-team-issues";

const TICKET_ID_RE = /^AGT-\d+$/;
const ORPHAN_DIR_RE = /^agt-\d+$/;

export type WorkspaceSource = "stamp" | "github";

export interface PreparedWorkspace {
  /** Absolute path to the cloned worktree (i.e. `<root>/<ticket-id-lc>/repo`). */
  path: string;
  /** The URL we cloned from — also the worktree's `origin`. */
  originUrl: string;
  /** Where we cloned from, for the runner's user-facing log line. */
  source: WorkspaceSource;
}

export interface PrepareWorkspaceOptions {
  /** Vault ticket id, e.g. "AGT-050". Lowercased and used as the dirname. */
  ticketId: string;
  /** `<owner>/<name>` from the ticket's `repo:` frontmatter. */
  repoSlug: string;
  /** When true, skip the stamp-server gate and clone from GitHub instead. */
  noStamp: boolean;
  /**
   * Injectable git-clone runner. Default is `spawnSync('git', ['clone', ...])`.
   * Tests pass a fake to avoid real network I/O.
   */
  cloneRunner?: CloneRunner;
  /**
   * Set of every active vault ticket id (lowercased). Used by the GC sweep
   * to identify orphan workspace dirs whose tickets are gone. When omitted,
   * GC is skipped — useful for unit tests that don't want to assert on it.
   */
  activeTicketIds?: ReadonlySet<string>;
  /** Override `WORKSPACE_ROOT`; only used by tests. */
  rootDir?: string;
}

export type CloneRunner = (url: string, dest: string) => CloneResult;

export interface CloneResult {
  status: number;
  stderr: string;
}

export class StampGateError extends Error {
  readonly stampUrl: string | null;
  readonly cloneStderr: string;
  constructor(args: {
    repoSlug: string;
    stampUrl: string | null;
    reason: string;
    cloneStderr?: string;
  }) {
    // AC #2: error must name the affected repo, identify the missing stamp
    // remote, and point at how to provision one.
    const lines = [
      `oteam assign: ${args.repoSlug} is not stamp-governed.`,
    ];
    if (args.stampUrl) {
      lines.push(`  Tried: git clone ${args.stampUrl}`);
    }
    lines.push(
      `  Reason: ${args.reason}`,
      `  Fix: provision the repo on the stamp server with`,
      `    stamp provision ${basename(args.repoSlug)}`,
      `  Or pass --no-stamp to bypass this gate (not recommended; see README).`,
    );
    super(lines.join("\n"));
    this.name = "StampGateError";
    this.stampUrl = args.stampUrl;
    this.cloneStderr = args.cloneStderr ?? "";
  }
}

/**
 * Prepares an isolated agent workspace and returns its path. The clone IS
 * the stamp-governance check: success means the repo is registered on the
 * stamp server; failure (or missing `~/.stamp/server.yml`) means it's not.
 *
 * AC #4 (the user's primary checkout is never modified) is satisfied by
 * construction — this function only reads `~/.stamp/server.yml` and writes
 * to `WORKSPACE_ROOT`. It never touches `$HOME/Development/<anything>`.
 */
export function prepareAgentWorkspace(
  opts: PrepareWorkspaceOptions,
): PreparedWorkspace {
  // Validate ticketId BEFORE any filesystem operation. ticketId comes from
  // ticket frontmatter and ingest-time normalisation, not from a CLI prompt
  // — but the trust boundary is still wider than "stuff the user typed",
  // so a `../...` id must never be allowed to reach the rmSync below.
  if (!TICKET_ID_RE.test(opts.ticketId)) {
    throw new Error(
      `prepareAgentWorkspace: refusing to operate on non-AGT ticket id "${opts.ticketId}" (expected AGT-NNN)`,
    );
  }

  const root = opts.rootDir ?? WORKSPACE_ROOT;
  mkdirSync(root, { recursive: true });

  if (opts.activeTicketIds) gcOrphanWorkspaces(root, opts.activeTicketIds);

  const ticketDir = join(root, opts.ticketId.toLowerCase());
  const repoDir = join(ticketDir, "repo");
  // Hermetic re-runs: blow away any prior workspace before cloning.
  rmSync(ticketDir, { recursive: true, force: true });
  mkdirSync(ticketDir, { recursive: true });

  const repoBasename = basename(opts.repoSlug);
  const cloneRunner = opts.cloneRunner ?? defaultCloneRunner;

  if (opts.noStamp) {
    const url = buildGithubUrl(opts.repoSlug);
    const r = cloneRunner(url, repoDir);
    if (r.status !== 0) {
      throw new Error(
        `oteam assign: --no-stamp fallback clone failed (git clone ${url}):\n${r.stderr.trim() || "(no stderr)"}`,
      );
    }
    return { path: repoDir, originUrl: url, source: "github" };
  }

  const stampConfig = readStampServerConfig();
  if (!stampConfig) {
    throw new StampGateError({
      repoSlug: opts.repoSlug,
      stampUrl: null,
      reason: `${stampServerConfigPath()} not found — no stamp server is configured`,
    });
  }
  const stampUrl = buildStampUrl(stampConfig, repoBasename);
  const r = cloneRunner(stampUrl, repoDir);
  if (r.status !== 0) {
    throw new StampGateError({
      repoSlug: opts.repoSlug,
      stampUrl,
      reason: stampGateReason(r),
      cloneStderr: r.stderr,
    });
  }
  return { path: repoDir, originUrl: stampUrl, source: "stamp" };
}

function stampGateReason(r: CloneResult): string {
  const stderr = r.stderr.trim();
  if (!stderr) return `git clone exited ${r.status}`;
  // Compact the stderr to the most informative line for the error banner;
  // the full output is still attached to the StampGateError.
  const firstLine = stderr.split(/\r?\n/).find((l) => l.trim().length > 0);
  return `git clone exited ${r.status}: ${firstLine ?? "(no stderr)"}`;
}

const defaultCloneRunner: CloneRunner = (url, dest) => {
  const r = spawnSync("git", ["clone", "--quiet", url, dest], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: r.status ?? -1,
    stderr: r.stderr ?? "",
  };
};

/**
 * Sweeps `<root>/<ticket-id>` directories whose ticket id has no
 * corresponding ticket in the vault. Stale workspaces from prior runs
 * accumulate in `/tmp/open-team-issues/` and the OS only collects them on
 * reboot; this keeps the floor swept on every fresh assign.
 */
export function gcOrphanWorkspaces(
  root: string,
  activeTicketIds: ReadonlySet<string>,
): string[] {
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!ORPHAN_DIR_RE.test(name)) continue;
    if (activeTicketIds.has(name)) continue;
    const target = join(root, name);
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      // Best-effort GC — a single permission error shouldn't abort the spawn.
    }
  }
  return removed;
}
