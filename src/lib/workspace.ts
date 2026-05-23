import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Filename (sibling to `repo/`, inside `<root>/<ticket-id-lc>/`) that records
 * the SHA the worktree's default branch was cloned from. The pre-review
 * freshness guard in `assign-ticket.md` reads this to detect when `origin/main`
 * has advanced under the worktree between clone time and `stamp review` time —
 * see the "clone→merge staleness window" note on `prepareAgentWorkspace`.
 */
export const BASE_SHA_FILENAME = "base-sha";

export interface PreparedWorkspace {
  /** Absolute path to the cloned worktree (i.e. `<root>/<ticket-id-lc>/repo`). */
  path: string;
  /** The URL we cloned from — also the worktree's `origin`. */
  originUrl: string;
  /**
   * HEAD SHA of the cloned worktree's default branch at clone time, i.e. the
   * exact base the agent worktree was cut from. The pre-review freshness guard
   * compares this against the current `origin/main` so a metered review is
   * never spent on a stale base. `null` when the SHA couldn't be resolved
   * (e.g. the fake clone in unit tests leaves no git history) — capturing it is
   * best-effort and never blocks the clone.
   */
  baseSha: string | null;
  /**
   * Absolute path of the file the `baseSha` was written to (sibling to `repo/`),
   * or `null` when no SHA was captured. The freshness guard reads this file
   * deterministically rather than re-deriving the base.
   */
  baseShaFile: string | null;
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
   * Injectable runner that resolves the cloned worktree's base SHA (default:
   * `spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'])`). Tests pass a
   * fake so the base-SHA capture path stays free of real git invocations.
   */
  revParseRunner?: RevParseRunner;
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

/** Resolves the freshly cloned worktree's base SHA. `repoDir` is the clone dest. */
export type RevParseRunner = (repoDir: string) => RevParseResult;

export interface RevParseResult {
  status: number;
  /** The resolved SHA on success; ignored when `status !== 0`. */
  stdout: string;
}

/**
 * Prepares an isolated agent workspace by cloning `cloneUri` into
 * `<root>/<ticket-id-lc>/repo`. Stamp-enforcement and URI-match checks are
 * the caller's responsibility (done by the runner's `resolveCloneUriForAssign`
 * before this function is ever called). Any clone failure surfaces as a plain
 * `Error` regardless of the URI scheme.
 *
 * Clone-time freshness is correct by construction — the worktree is cut from
 * whatever `origin/main` is at clone time. But a role can run for many minutes
 * (spike + implementation), and `origin/main` can advance *underneath* the
 * worktree before the role reaches `stamp review`/`stamp merge` (a concurrent
 * operator, another session, or a sibling ticket in the same
 * `/implement-project` wave landing first). Reviewing/merging against that
 * stale base wastes a metered review and gets the eventual push rejected
 * non-fast-forward. To let the later step close that clone→merge window, we
 * record the cloned worktree's base SHA here — both returned on
 * `PreparedWorkspace.baseSha` and written to `<ticket-dir>/base-sha`
 * (`BASE_SHA_FILENAME`). The pre-review freshness guard in `assign-ticket.md`
 * reads that file, re-fetches `origin`, and rebases onto current `main` if it
 * has advanced. Capturing the SHA is best-effort: a failure leaves `baseSha`
 * null and never blocks the clone.
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

  // Record the base SHA the worktree was cut from so the pre-review freshness
  // guard can detect a stale base (see the doc comment above). Best-effort:
  // any failure leaves baseSha null and is non-fatal — the clone already
  // succeeded and freshness is only a guard, not a correctness invariant here.
  const revParseRunner = opts.revParseRunner ?? defaultRevParseRunner;
  let baseSha: string | null = null;
  let baseShaFile: string | null = null;
  try {
    const rp = revParseRunner(repoDir);
    const sha = rp.status === 0 ? rp.stdout.trim() : "";
    if (rp.status === 0 && /^[0-9a-f]{7,64}$/.test(sha)) {
      baseSha = sha;
      baseShaFile = join(ticketDir, BASE_SHA_FILENAME);
      writeFileSync(baseShaFile, `${sha}\n`);
    }
  } catch {
    // Capturing the base SHA is best-effort; never let it fail the prepare.
    baseSha = null;
    baseShaFile = null;
  }

  return { path: repoDir, originUrl: opts.cloneUri, baseSha, baseShaFile };
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

const defaultRevParseRunner: RevParseRunner = (repoDir) => {
  // HEAD of the freshly cloned worktree is its default branch's tip — i.e. the
  // exact `origin/main` the worktree was cut from at clone time.
  const r = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
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
