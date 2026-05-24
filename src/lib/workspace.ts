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
  /**
   * Whether the workspace was reused from a prior phase rather than freshly
   * cloned. True when the existing worktree had unpushed commits (AC 1/4/5).
   * False on clone paths (fresh clone or clean re-clone).
   */
  reused: boolean;
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
   * When true, unconditionally blow away any existing worktree and re-clone,
   * even if it has unpushed commits. Useful for deliberate from-scratch re-runs.
   * Default: false.
   */
  fresh?: boolean;
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
   * Injectable runner that inspects an existing worktree to determine whether
   * it's safe to reuse. Default impl runs `git rev-list --count origin/HEAD..HEAD`
   * (with a `git rev-parse --git-dir` precheck). Tests pass a fake so the
   * reuse-vs-clone decision is exercised without real git.
   */
  inspectRunner?: InspectRunner;
  /**
   * Injectable runner that fetches origin refs on the reuse path. Fetch failure
   * is non-fatal — we degrade to "reuse without fetch" because the freshness
   * guard in assign-ticket.md re-fetches anyway. Tests pass a fake to assert
   * the fetch was (or wasn't) called.
   */
  fetchRunner?: FetchRunner;
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
 * Inspects an existing `repoDir` to determine whether it's safe to reuse.
 *
 * The default implementation:
 *   1. Runs `git -C <repoDir> rev-parse --git-dir` to confirm the dir is a
 *      healthy (non-bare) git repo.
 *   2. Checks for in-progress rebase/merge state files that make the worktree
 *      unsafe to reuse without human intervention.
 *   3. Runs `git -C <repoDir> rev-list --count origin/HEAD..HEAD` to count
 *      unpushed commits.
 *
 * Tests inject a fake that returns canned results without real git I/O.
 */
export type InspectRunner = (repoDir: string) => InspectResult;

export interface InspectResult {
  /**
   * True when the dir contains a valid, non-bare git repo (`.git/` resolves).
   * False on missing `.git/`, bare clones, or `rev-parse --git-dir` failure.
   */
  gitDir: boolean;
  /**
   * True when the worktree is in an in-progress rebase or merge state
   * (`.git/rebase-merge`, `.git/rebase-apply`, or `.git/MERGE_HEAD` exist).
   * Only meaningful when `gitDir === true`.
   */
  inProgress: boolean;
  /**
   * Number of commits in the worktree ahead of `origin/HEAD` (i.e. unpushed).
   * Only meaningful when `gitDir === true && !inProgress`. `-1` on rev-list
   * failure (treated as AC-6 unexpected-state error).
   */
  aheadCount: number;
  /** Raw exit status of the rev-list command; 0 on success. */
  status: number;
  /** Stderr from the innermost failing command, for error messages. */
  stderr: string;
}

/** Fetches remote refs on the reuse path to keep the freshness guard current. */
export type FetchRunner = (repoDir: string) => FetchResult;

export interface FetchResult {
  status: number;
  stderr: string;
}

/**
 * Prepares an isolated agent workspace.
 *
 * Three-way branch on the existing worktree:
 *
 *   (a) **Dir absent** — clone fresh (today's behaviour, AC 3).
 *   (b) **Dir present, clean** (0 unpushed commits, no `--fresh`) — rm + clone
 *       fresh. Preserves the "first assign re-run" behaviour (AC 2).
 *   (c) **Dir present with unpushed WIP** (N > 0 commits, no `--fresh`) —
 *       **reuse**: `fetch` origin (best-effort) and skip both `rmSync` and clone.
 *       Returns `reused: true` so the assignment block surface it (AC 1/4/5).
 *   (d) **`--fresh`** — unconditionally rm + clone, regardless of WIP (AC escape).
 *   (e) **Unexpected state** (missing `.git`, bare, mid-rebase, unresolvable
 *       `origin/HEAD`) — throw a clear `Error` with the path (AC 6).
 *
 * Stamp-enforcement and URI-match checks are the caller's responsibility.
 * Any clone failure surfaces as a plain `Error` regardless of URI scheme.
 *
 * The `baseSha` / `baseShaFile` pair is captured on both the clone and reuse
 * paths — on reuse, derived from `origin/HEAD` after fetch (best-effort).
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

  const cloneRunner = opts.cloneRunner ?? defaultCloneRunner;
  const revParseRunner = opts.revParseRunner ?? defaultRevParseRunner;
  const inspectRunner = opts.inspectRunner ?? defaultInspectRunner;
  const fetchRunner = opts.fetchRunner ?? defaultFetchRunner;

  // ── Decision: does an existing worktree exist? ──────────────────────────
  if (existsSync(repoDir) && !opts.fresh) {
    // Dir exists and no --fresh override: inspect the worktree to decide
    // whether to reuse or re-clone.
    const inspect = inspectRunner(repoDir);

    if (!inspect.gitDir || inspect.inProgress || inspect.status !== 0 || inspect.aheadCount < 0) {
      // AC 6: unexpected state — surface a clear error, do NOT silently rm+clone.
      const reason = !inspect.gitDir
        ? "missing or bare .git directory"
        : inspect.inProgress
          ? "worktree is mid-rebase or mid-merge"
          : `rev-list failed (exit ${inspect.status}: ${inspect.stderr.trim() || "no stderr"})`;
      throw new Error(
        `prepareAgentWorkspace: existing worktree at ${repoDir} is in an unexpected state (${reason}); re-run with --fresh to discard it`,
      );
    }

    if (inspect.aheadCount > 0) {
      // AC 1: reuse — there are unpushed commits, preserve them.
      process.stdout.write(
        `oteam assign: reusing existing worktree (${inspect.aheadCount} unpushed commit${inspect.aheadCount === 1 ? "" : "s"})\n`,
      );

      // Fetch origin to keep the freshness guard current. Non-fatal on failure.
      const fr = fetchRunner(repoDir);
      if (fr.status !== 0) {
        process.stderr.write(
          `oteam assign: warning — fetch failed on reuse path (${fr.stderr.trim() || "no stderr"}); freshness guard will re-fetch\n`,
        );
      }

      // Capture base SHA from origin/HEAD after fetch (best-effort).
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
        // Best-effort; never let it fail the reuse.
        baseSha = null;
        baseShaFile = null;
      }

      return { path: repoDir, originUrl: opts.cloneUri, baseSha, baseShaFile, reused: true };
    }

    // AC 2: dir present but clean (aheadCount === 0) — re-clone fresh.
    process.stdout.write(
      `oteam assign: cloning fresh worktree (existing worktree is clean, no unpushed commits)\n`,
    );
    rmSync(ticketDir, { recursive: true, force: true });
  } else if (opts.fresh && existsSync(ticketDir)) {
    // --fresh override: unconditionally re-clone.
    process.stdout.write(
      `oteam assign: cloning fresh worktree (--fresh)\n`,
    );
    rmSync(ticketDir, { recursive: true, force: true });
  } else {
    // AC 3: dir absent — clone fresh (no log needed, it's the default path).
  }

  // ── Clone path (cases a, b, d, and clean-dir-absent) ───────────────────
  mkdirSync(ticketDir, { recursive: true });

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

  return { path: repoDir, originUrl: opts.cloneUri, baseSha, baseShaFile, reused: false };
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
 * Default inspect runner: checks for a valid git dir, mid-progress state, then
 * counts unpushed commits with `git rev-list --count origin/HEAD..HEAD`.
 *
 * Returns `gitDir: false` when the dir isn't a healthy git repo.
 * Returns `inProgress: true` when a rebase or merge is in flight.
 * Returns `aheadCount: -1` when `rev-list` fails (treated as AC-6 error).
 */
export const defaultInspectRunner: InspectRunner = (repoDir) => {
  // Precheck: is this a non-bare git repo?
  const gitDirCheck = spawnSync(
    "git",
    ["-C", repoDir, "rev-parse", "--git-dir"],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (gitDirCheck.status !== 0) {
    return {
      gitDir: false,
      inProgress: false,
      aheadCount: 0,
      status: gitDirCheck.status ?? -1,
      stderr: gitDirCheck.stderr ?? "",
    };
  }
  const gitDirPath = gitDirCheck.stdout.trim();
  // A bare repo reports "." as its git-dir; reject it.
  if (gitDirPath === ".") {
    return {
      gitDir: false,
      inProgress: false,
      aheadCount: 0,
      status: 0,
      stderr: "bare repository",
    };
  }

  // Check for in-progress rebase or merge state.
  const gitDir = gitDirPath.startsWith("/") ? gitDirPath : join(repoDir, gitDirPath);
  const inProgress =
    existsSync(join(gitDir, "rebase-merge")) ||
    existsSync(join(gitDir, "rebase-apply")) ||
    existsSync(join(gitDir, "MERGE_HEAD"));
  if (inProgress) {
    return {
      gitDir: true,
      inProgress: true,
      aheadCount: 0,
      status: 0,
      stderr: "",
    };
  }

  // Count unpushed commits: origin/HEAD..HEAD.
  const revList = spawnSync(
    "git",
    ["-C", repoDir, "rev-list", "--count", "origin/HEAD..HEAD"],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (revList.status !== 0) {
    return {
      gitDir: true,
      inProgress: false,
      aheadCount: -1,
      status: revList.status ?? -1,
      stderr: revList.stderr ?? "",
    };
  }

  const aheadCount = parseInt(revList.stdout.trim(), 10);
  return {
    gitDir: true,
    inProgress: false,
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : -1,
    status: 0,
    stderr: "",
  };
};

export const defaultFetchRunner: FetchRunner = (repoDir) => {
  const r = spawnSync("git", ["-C", repoDir, "fetch", "origin"], {
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
