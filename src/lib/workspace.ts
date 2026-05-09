import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

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

export interface PreparedWorkspace {
  /** Absolute path to the cloned worktree (i.e. `<root>/<ticket-id-lc>/repo`). */
  path: string;
  /** The URL we cloned from — also the worktree's `origin`. */
  originUrl: string;
}

export interface PrepareWorkspaceOptions {
  /** Vault ticket id, e.g. "AGT-050". Lowercased and used as the dirname. */
  ticketId: string;
  /** `<owner>/<name>` from the ticket's `repo:` frontmatter. */
  repoSlug: string;
  /**
   * The git URI to clone from. Resolved by the runner from the per-repo config
   * entry (after the first-encounter prompt if needed). The workspace module
   * treats this as opaque — stamp enforcement and URI validation happen in the
   * runner before this function is called.
   */
  cloneUri: string;
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

/**
 * Prepares an isolated agent workspace by cloning `cloneUri` into
 * `<root>/<ticket-id-lc>/repo`. Stamp-enforcement and URI-match checks are
 * the caller's responsibility (done by the runner's `resolveCloneUriForAssign`
 * before this function is ever called). Any clone failure surfaces as a plain
 * `Error` regardless of the URI scheme.
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

  const cloneRunner = opts.cloneRunner ?? defaultCloneRunner;
  const r = cloneRunner(opts.cloneUri, repoDir);
  if (r.status !== 0) {
    throw new Error(
      `oteam assign: clone failed (git clone ${opts.cloneUri}):\n${r.stderr.trim() || "(no stderr)"}`,
    );
  }
  return { path: repoDir, originUrl: opts.cloneUri };
}

const defaultCloneRunner: CloneRunner = (url, dest) => {
  const r = spawnSync("git", ["clone", "--quiet", "--", url, dest], {
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
