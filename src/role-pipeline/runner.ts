import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  findVaultRootForPath,
  getTelemetryEnabled,
  getRepoEntry,
  readConfig,
  resolveBotIdentity,
  setRepoCloneUri,
  type OteamConfig,
} from "../lib/config.ts";
import {
  NoTTYError,
  promptCloneUri,
} from "../lib/prompt-clone-uri.ts";
import {
  claimGitHubIssue,
  parseIssueRef,
  type IssueClaim,
} from "../lib/github.ts";
import {
  HAIKU_PRODUCT_MODEL,
  phaseForState,
  resolveModelForTicket,
} from "../lib/models.ts";
import {
  formatProjectContextForPrompt,
  projectDir,
  readProject,
} from "../lib/projects.ts";
import {
  findTicketFileByID,
  isAgtId,
  parseTicket,
  readAllTickets,
  resolveVault,
} from "../lib/vault.ts";
import {
  prepareAgentWorkspace,
  type PreparedWorkspace,
} from "../lib/workspace.ts";
import { installRolePipelineSlashCommand } from "./install-slash-command.ts";

export interface AssignOptions {
  ticketPath: string;
  vault?: string;
  /**
   * Injectable URI resolver for testing — bypasses the config lookup and
   * prompt so unit tests can exercise the runner logic without I/O.
   */
  cloneUriResolver?: CloneUriResolver;
  /**
   * When true, force a fresh re-clone of the worktree, discarding any unpushed
   * WIP. Passed through to `prepareAgentWorkspace` as `fresh: true`.
   */
  fresh?: boolean;
}

export type CloneUriResolver = (slug: string) => Promise<string>;

/**
 * The deterministic prep `oteam assign` hands back to the in-session
 * orchestrator. As of the zero-SDK conversion `oteam assign` no longer spawns
 * `claude` — it claims the issue, clones a hermetic worktree, resolves the
 * per-phase model, and emits this so an interactive Claude Code parent can
 * dispatch a Task subagent into the prepared worktree. Everything here is
 * filesystem/git/concurrency work that belongs in tested TypeScript, not in a
 * markdown skill.
 */
export interface AssignmentContext {
  ticketId: string;
  ticketPath: string;
  /** Ticket `state:` (triage|refined|in-progress|qa|blocked|done|…). */
  state: string;
  /** Role-pipeline phase for this state, or null on blocked/done. */
  phase: string | null;
  vaultPath: string;
  /** Prepared agent worktree, or null for workspace-only (no `repo:`) tickets. */
  workspacePath: string | null;
  /** Resolved clone URI of the prepared worktree, or null when none. */
  originUrl: string | null;
  /**
   * Base SHA the worktree was cloned from (`origin/main` HEAD at clone time),
   * or null for workspace-only tickets / when the SHA couldn't be captured.
   * The pre-review freshness guard in `assign-ticket.md` compares this against
   * current `origin/main` and rebases if it has advanced — closing the
   * clone→merge staleness window.
   */
  baseSha: string | null;
  /**
   * Absolute path of the file the base SHA was written to (sibling to the
   * worktree's `repo/`), or null when no SHA was captured. The freshness guard
   * reads this file deterministically.
   */
  baseShaFile: string | null;
  /**
   * Env files the subagent should source before build/install/test, in order
   * (guard each with `[ -r ]` — some, like the per-repo secrets file, may not
   * exist until the user supplies missing tokens mid-run). Empty for
   * workspace-only tickets.
   */
  envFiles: string[];
  /** Per-phase model the subagent should run on (advisory). */
  model: string;
  /** First instruction for the subagent — the existing role-pipeline skill. */
  slashCommand: string;
  /** Path to the `--append-system-prompt` payload, or null when none. */
  systemPromptFile: string | null;
  haikuDownshift: boolean;
  /**
   * Whether the prepared worktree was reused from a prior phase (true) rather
   * than freshly cloned (false). Surfaces AC-4 observability so orchestrators
   * and subagents know the worktree already carries commits from an earlier role.
   */
  reused: boolean;
  /**
   * Telemetry handle for the orchestrator's teardown `oteam telemetry record`
   * call after the subagent finishes. Null when telemetry is off or the state
   * has no role agent. (Token accounting for in-session subagents is being
   * reworked separately — wall-clock/phase/model/outcome still record.)
   */
  telemetry: {
    sessionId: string;
    phase: string;
    model: string;
    startedAt: string;
  } | null;
}

/**
 * Resolve the clone URI for `oteam assign` (AGT-097):
 * 1. Look up `config.repos[slug]`; if found, return its clone-uri.
 * 2. Prompt on first encounter (interactive only); record the result.
 * 3. On non-TTY without a recorded URI: throw `NoTTYError`.
 * 4. When `stamp.enforce: true`: assert the URI starts with `stamp.host`;
 *    throw a `StampEnforceError` otherwise.
 */
export async function resolveCloneUriForAssign(
  config: OteamConfig,
  slug: string,
  resolver?: CloneUriResolver,
): Promise<string> {
  // Injection point for tests.
  if (resolver) return resolver(slug);

  const existing = getRepoEntry(slug, config);
  let uri: string;
  if (existing) {
    uri = existing["clone-uri"];
  } else {
    const defaultUri = `https://github.com/${slug}.git`;
    const result = await promptCloneUri(
      slug,
      defaultUri,
      { isTTY: process.stdin.isTTY === true },
      "refuse",
    );
    uri = result.uri;
    setRepoCloneUri(slug, uri);
  }

  // Stamp-enforce check: when enforce is on, the recorded URI must start with
  // stamp.host. The durable knob to disable is 'oteam config stamp set --enforce off'.
  if (config.stamp?.enforce) {
    if (!config.stamp.host || config.stamp.host.length === 0) {
      throw new Error(
        "oteam assign: stamp.enforce is on but stamp.host is empty — run 'oteam config stamp set --host <url>' or 'oteam config stamp set --enforce off'",
      );
    }
    if (!uri.startsWith(config.stamp.host)) {
      throw new StampEnforceError({ slug, uri, stampHost: config.stamp.host });
    }
  }

  return uri;
}

export class StampEnforceError extends Error {
  readonly slug: string;
  readonly uri: string;
  constructor(args: { slug: string; uri: string; stampHost: string }) {
    const lines = [
      `oteam assign: ${args.slug} clone URI is not stamp-governed.`,
      `  Recorded URI: ${args.uri}`,
      `  Expected URI starting with: ${args.stampHost}`,
      `  Fix: update the recorded URI:`,
      `    oteam config repo set ${args.slug} --clone-uri <stamp-url>`,
      `  Or turn enforcement off:`,
      `    oteam config stamp set --enforce off`,
    ];
    super(lines.join("\n"));
    this.name = "StampEnforceError";
    this.slug = args.slug;
    this.uri = args.uri;
  }
}

export async function assignTicket(opts: AssignOptions): Promise<void> {
  const ctx = await prepareAssignment(opts);
  process.stdout.write(assignmentSummary(ctx) + "\n\n");
  process.stdout.write(assignmentBlock(ctx) + "\n");
}

/**
 * Do all the deterministic prep and return the assignment context. Split out
 * from `assignTicket` (which owns stdout) so the choreography is unit-testable
 * and reusable by future in-process callers.
 */
export async function prepareAssignment(
  opts: AssignOptions,
): Promise<AssignmentContext> {
  const config = readConfig();

  // Resolve the ticket file path. Three input shapes:
  //   1. AGT-NNN              — look up in the resolved workspace's tickets/<state>/
  //   2. /full/path/to/X.md   — auto-detect workspace from path if registered
  //   3. relative path        — resolve against cwd, same auto-detect rule
  let resolvedVault = resolveVault({ flagValue: opts.vault, config });
  let ticketPath: string;
  if (isAgtId(opts.ticketPath)) {
    ticketPath = findTicketFileByID(resolvedVault.path, opts.ticketPath);
  } else {
    ticketPath = resolve(opts.ticketPath);
    if (!opts.vault) {
      // Auto-detect: a path inside a registered workspace is more specific than
      // the config default, so override silently when no --workspace was passed.
      const detected = findVaultRootForPath(ticketPath, config);
      if (detected) resolvedVault = detected;
    }
  }

  const ticket = parseTicket(ticketPath);
  if (!ticket) {
    throw new Error(
      `assign: could not parse ticket at ${ticketPath} (frontmatter unreadable)`,
    );
  }

  // Pre-flight: claim the underlying GH issue (when configured + applicable).
  // Only fires for github-sourced tickets with a parseable URL and an
  // operator-set `botIdentity`. On any non-ok outcome the runner exits before
  // any expensive work (clone-uri prompt, workspace prep).
  enforceClaimOrExit(ticket.source, config);

  // Make sure the in-session orchestrator/subagent can resolve `/assign-ticket`.
  installRolePipelineSlashCommand();

  // AGT-097: resolve the clone URI from the per-repo config map. First
  // encounter prompts once (interactive) or refuses (non-TTY). When
  // stamp.enforce is on, the URI must start with stamp.host.
  let workspace: PreparedWorkspace | null = null;
  let cloneUri: string | null = null;
  if (ticket.repo) {
    try {
      cloneUri = await resolveCloneUriForAssign(
        config,
        ticket.repo,
        opts.cloneUriResolver,
      );
    } catch (err) {
      if (err instanceof NoTTYError || err instanceof StampEnforceError) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
      throw err;
    }
    try {
      workspace = prepareAgentWorkspace({
        ticketId: ticket.id,
        repoSlug: ticket.repo,
        cloneUri,
        fresh: opts.fresh,
        activeTicketIds: collectActiveTicketIds(resolvedVault.path),
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  // AGT-023: when the ticket carries `project: <id>`, load the project's
  // README + sibling-file index. AGT-107 may also append a Product-agent hint
  // (haiku downshift) and AGT-099 a push-disabled hint; all three share the
  // same system-prompt payload (single tmp file the subagent can `cat`).
  const projectContext = loadProjectContext(resolvedVault.path, ticket.project);

  // AGT-105/107: pick the per-phase model from oteam config based on the
  // ticket's current state, layering the Haiku downshift on the Product phase
  // when the ticket is a well-formed manual one.
  const ticketBody = readTicketBody(ticketPath);
  const model = resolveModelForTicket({
    state: ticket.state,
    sourceType: ticket.source.type,
    body: ticketBody,
    productDownshift: config.productDownshift,
    models: config.models,
  });
  const haikuDownshift =
    model === HAIKU_PRODUCT_MODEL && ticket.state === "triage";
  // AGT-099: the global push toggle. The subagent skips Phase 4b's push when off.
  const pushDisabled = config.push === "off";
  const systemPrompt = composeSystemPrompt(
    ticket.id,
    projectContext,
    haikuDownshift,
    pushDisabled,
  );

  // Mint a telemetry handle for the orchestrator's teardown record. Phase is
  // null on `blocked`/`done` states (no role agent) — emit no telemetry then.
  const phase = phaseForState(ticket.state);
  const telemetry =
    phase !== null && getTelemetryEnabled()
      ? {
          sessionId: randomUUID(),
          phase,
          model,
          startedAt: new Date().toISOString(),
        }
      : null;

  return {
    ticketId: ticket.id,
    ticketPath,
    state: ticket.state,
    phase,
    vaultPath: resolvedVault.path,
    workspacePath: workspace?.path ?? null,
    originUrl: cloneUri,
    baseSha: workspace?.baseSha ?? null,
    baseShaFile: workspace?.baseShaFile ?? null,
    reused: workspace?.reused ?? false,
    envFiles: ticket.repo ? resolveEnvFiles(ticket.repo) : [],
    model,
    slashCommand: `/assign-ticket ${ticketPath}`,
    systemPromptFile: systemPrompt?.tmpFile ?? null,
    haikuDownshift,
    telemetry,
  };
}

/** Human-readable summary printed above the machine block. */
export function assignmentSummary(ctx: AssignmentContext): string {
  const lines = [
    `oteam assign: prepared ${ctx.ticketId} (${ctx.phase ?? ctx.state} phase)`,
  ];
  if (ctx.workspacePath) {
    const worktreeStatus = ctx.reused ? " (reused, unpushed commits)" : " (fresh clone)";
    lines.push(`  worktree: ${ctx.workspacePath}${worktreeStatus}`);
  }
  lines.push(`  model:    ${ctx.model}`);
  lines.push(
    `  next:     dispatch a subagent to run \`${ctx.slashCommand}\`` +
      (ctx.workspacePath ? ` in the worktree above` : ``),
  );
  return lines.join("\n");
}

/**
 * The machine-readable contract for the orchestrator: a fenced
 * ```oteam:assignment``` block wrapping the context as JSON. Fenced + tagged so
 * an in-session parent can locate and parse it unambiguously from the output.
 */
export function assignmentBlock(ctx: AssignmentContext): string {
  return ["```oteam:assignment", JSON.stringify(ctx, null, 2), "```"].join("\n");
}

/**
 * Candidate env files the subagent should source before build/install/test,
 * mirroring what the kitty `envSourcingPrefix` sourced in the spawn era:
 *   1. the primary checkout's `.env` / `.env.local` (`~/Development/<basename>`)
 *   2. the per-repo secrets file `~/.open-team/env-<owner>-<name>` (lowercased)
 * The personal/work split (`env-<personal|work>`) is dropped — it was keyed off
 * the removed kitty/OTEAM_MONITORED_ORGS routing. Paths are validated against a
 * conservative charset so they're safe for the subagent to `. ` directly.
 */
export function resolveEnvFiles(repoSlug: string): string[] {
  const home = homedir();
  const files: string[] = [];
  const slash = repoSlug.lastIndexOf("/");
  const base = slash >= 0 ? repoSlug.slice(slash + 1) : repoSlug;
  if (/^[A-Za-z0-9._-]+$/.test(base)) {
    files.push(join(home, "Development", base, ".env"));
    files.push(join(home, "Development", base, ".env.local"));
  }
  const ownerName = repoSlug.replace(/\//g, "-").toLowerCase();
  if (/^[a-z0-9._-]+$/.test(ownerName)) {
    files.push(join(home, ".open-team", `env-${ownerName}`));
  }
  return files;
}

// Terminal states have no remaining work to do in the workspace; their dirs
// are treated as orphans so gcOrphanWorkspaces sweeps them on the next assign.
const TERMINAL_STATES = new Set(["done", "blocked"]);

function collectActiveTicketIds(vaultPath: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const t of readAllTickets(vaultPath)) {
      if (!TERMINAL_STATES.has(t.state)) ids.add(t.id.toLowerCase());
    }
  } catch {
    // Best-effort — a workspace read failure should not block prep. The GC
    // sweep skips when the active set is empty/missing.
  }
  return ids;
}

interface SystemPromptHandle {
  /** Absolute path to the tmp file containing the prompt payload. */
  tmpFile: string;
  /** The same payload as a string. */
  content: string;
}

/** Project README only — no haiku-downshift hint. */
function loadProjectContext(
  vaultPath: string,
  projectId: string | null,
): string | null {
  if (!projectId) return null;
  const project = readProject(vaultPath, projectId);
  if (!project) {
    process.stderr.write(
      `oteam: ticket references project "${projectId}" but no README at ${projectDir(vaultPath, projectId)}/README.md — proceeding without project context\n`,
    );
    return null;
  }
  return formatProjectContextForPrompt(project);
}

/**
 * Combine the project-context payload (AGT-023), the AGT-107 haiku-downshift
 * hint, and the AGT-099 push-disabled hint into a single system-prompt payload,
 * written to a tmp file the subagent can `cat`. Returns null when none active.
 */
function composeSystemPrompt(
  ticketId: string,
  projectContext: string | null,
  haikuDownshift: boolean,
  pushDisabled: boolean,
): SystemPromptHandle | null {
  const parts: string[] = [];
  if (projectContext) parts.push(projectContext);
  if (haikuDownshift) parts.push(haikuDownshiftPromptHint());
  if (pushDisabled) parts.push(pushDisabledPromptHint());
  if (parts.length === 0) return null;
  const content = parts.join("\n\n");
  // Tmp file is reused per ticket so re-runs overwrite cleanly and stale files
  // don't accumulate. /tmp is OS-swept on reboot.
  const safeId = ticketId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpFile = join(tmpdir(), `oteam-prompt-${safeId}.md`);
  writeFileSync(tmpFile, content, "utf8");
  return { tmpFile, content };
}

function haikuDownshiftPromptHint(): string {
  return [
    "# Product agent: haiku-downshift heuristic active",
    "",
    "AGT-107: this ticket is a well-formed manual ticket (source.type=manual + populated `## Acceptance Criteria`), so the runner picked Haiku 4.5 instead of the configured Product model. The heuristic exists to handle structural-cleanup cases cheaply; full synthesis still belongs on the configured Product model.",
    "",
    "When you advance the ticket, write the comment header as:",
    "",
    "    ### YYYY-MM-DD — Product agent (haiku-downshift)",
    "",
    "instead of the standard `### YYYY-MM-DD — Product agent`. That makes the heuristic visible in the ticket's audit trail.",
  ].join("\n");
}

function pushDisabledPromptHint(): string {
  return [
    "# Push step: disabled by oteam config",
    "",
    "AGT-099: the operator has set `push: off` in `~/.open-team/config.json`. When you reach Phase 4b's outbound push (Step 5a `stamp push`, Step 5b `git push -u origin <feature>`, or Step 5c `git push -u origin <feature>` after the local stamp-merge), do NOT run it. Run every step before the push as normal — review, status gate, stamp-merge — but stop short of the push command itself.",
    "",
    "Instead of pushing, print this status line verbatim (substituting `<sha>` with the SHA of the most recent commit on the branch about to be pushed — `git rev-parse HEAD` after the merge in 5a/5c, or after the last feature commit in 5b):",
    "",
    "    push disabled by oteam config; merge commit is local at <sha>; run 'git push origin' manually when ready",
    "",
    "Then continue with the rest of Phase 4b (PR creation in 5b/5c is also skipped, since there is nothing pushed for `gh pr create` to reference; record `linked-pr:` as empty and note in the wrap-up comment that the push was held). Step 6 (stamp retro routing) still runs because it does not depend on any push.",
    "",
    "This gate covers only the assign-side push step. Ingest commands (`oteam pull github`) are unaffected.",
  ].join("\n");
}

function readTicketBody(path: string): string {
  // Best-effort: a read failure here would already have been surfaced by
  // parseTicket above (which is called first), so a thrown read here is
  // genuinely unexpected. Fall back to the empty string so the heuristic
  // reads as "AC not populated" — that biases toward the configured Product
  // model rather than silently downshifting.
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Run the GH-issue claim pre-flight when applicable. Exits the process on
 * any non-ok outcome (assigned-elsewhere, closed, no-write-access,
 * api-error). The unconfigured / non-github path is a silent no-op.
 */
function enforceClaimOrExit(
  source: { type: string; url: string | null },
  config: OteamConfig,
): void {
  if (source.type !== "github" || !source.url) return;

  const identity = resolveBotIdentity(config);
  if (identity.length === 0) return; // back-compat: no identity set, no claim

  const ref = parseIssueRef(source.url);
  if (!ref) {
    process.stderr.write(
      `oteam assign: ticket source.url "${source.url}" is not a parseable github issue ref — skipping claim\n`,
    );
    return;
  }

  const claim: IssueClaim = claimGitHubIssue(ref.slug, ref.number, identity);
  if (claim.ok) return;

  switch (claim.reason) {
    case "issue-closed":
      process.stderr.write(
        `oteam assign: refusing to drive role pipeline — ${ref.slug}#${ref.number} is closed\n`,
      );
      process.exit(1);
    case "already-claimed":
      process.stderr.write(
        `oteam assign: refusing to drive role pipeline — ${ref.slug}#${ref.number} is assigned to ${claim.assignees.join(", ")} (not "${identity}")\n`,
      );
      process.exit(1);
    case "no-write-access":
      process.stderr.write(
        `oteam assign: cannot claim ${ref.slug}#${ref.number} as "${identity}" — gh token has no push access on the repo (assignee changes are silently dropped). Add the operator as a collaborator, or unset botIdentity if claims aren't wanted on this repo.\n`,
      );
      process.exit(1);
    case "api-error":
      process.stderr.write(
        `oteam assign: claim failed for ${ref.slug}#${ref.number} — ${claim.error}\n`,
      );
      process.exit(1);
  }
}
