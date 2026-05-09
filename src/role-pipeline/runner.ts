import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename, dirname, join } from "node:path";
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
  envSourcingPrefix,
  findKittyBinary,
  findKittySocket,
  isMacOS,
  kittyLaunch,
  preferredKittyContext,
  shellEscape,
} from "../lib/kitty.ts";
import {
  HAIKU_PRODUCT_MODEL,
  phaseForState,
  resolveModelForTicket,
} from "../lib/models.ts";
import { recordPhase } from "../lib/telemetry.ts";
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
  monitoredOrgs?: string[];
  workInline?: boolean;
  /**
   * Per-run override of the `stamp.enforce` config knob. Skips the stamp-host
   * URI-match check for this single run. Has no effect when stamp enforcement
   * is already off (the default). The recorded clone URI is still used —
   * `--no-stamp` only bypasses the URI-must-match-stamp-host assertion.
   * (AGT-098 will retire this flag once the surface settles.)
   */
  noStamp?: boolean;
  /**
   * Injectable URI resolver for testing — bypasses the config lookup and
   * prompt so unit tests can exercise the runner logic without I/O.
   */
  cloneUriResolver?: CloneUriResolver;
}

export type CloneUriResolver = (slug: string) => Promise<string>;

/**
 * Resolve the clone URI for `oteam assign`:
 * 1. Look up `config.repos[slug]`; if found, return its clone-uri.
 * 2. Prompt on first encounter (interactive only); record the result.
 * 3. On non-TTY without a recorded URI: throw `NoTTYError` (AC #4).
 * 4. When `stamp.enforce: true && !noStamp`: assert the URI starts with
 *    `stamp.host`; throw a `StampEnforceError` otherwise.
 */
async function resolveCloneUriForAssign(
  config: OteamConfig,
  slug: string,
  noStamp: boolean,
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

  // Stamp-enforce check (AC #6): when enforce is on and --no-stamp is NOT
  // set, the recorded URI must start with stamp.host.
  if (!noStamp && config.stamp?.enforce) {
    if (!config.stamp.host || config.stamp.host.length === 0) {
      // G3: hand-edited config. Loud, fast.
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
      `  Or pass --no-stamp to bypass this gate for a single run.`,
    ];
    super(lines.join("\n"));
    this.name = "StampEnforceError";
    this.slug = args.slug;
    this.uri = args.uri;
  }
}

export async function assignTicket(opts: AssignOptions): Promise<void> {
  const config = readConfig();

  // Resolve the ticket file path. Three input shapes:
  //   1. AGT-NNN              — look up in the resolved vault's tickets/<state>/
  //   2. /full/path/to/X.md   — auto-detect vault from path if registered
  //   3. relative path        — resolve against cwd, same auto-detect rule
  let resolvedVault = resolveVault({ flagValue: opts.vault, config });
  let ticketPath: string;
  if (isAgtId(opts.ticketPath)) {
    ticketPath = findTicketFileByID(resolvedVault.path, opts.ticketPath);
  } else {
    ticketPath = resolve(opts.ticketPath);
    if (!opts.vault) {
      // Auto-detect: a path inside a registered vault is more specific than
      // the config default, so override silently when no --vault was passed.
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
  // operator-set `botIdentity` (or OTEAM_BOT_IDENTITY env override). The
  // unconfigured path is a silent no-op so legacy installs keep working.
  // On any non-ok outcome the runner exits before any expensive work
  // (workspace prep, kitty spawn, claude SDK init).
  enforceClaimOrExit(ticket.source, config);

  // Make sure the spawned `claude` session can find `/assign-ticket`.
  installRolePipelineSlashCommand();

  const claudePath = findToolOnPath("claude");
  if (!claudePath) {
    throw new Error(
      "claude CLI not found on PATH — install Claude Code (https://claude.com/claude-code) first",
    );
  }

  // AGT-097: resolve the clone URI from the per-repo config map. First
  // encounter prompts once (interactive) or refuses (non-TTY). When
  // stamp.enforce is on and --no-stamp is not set, the URI must start with
  // stamp.host. --no-stamp skips only the URI-match check; the recorded URI
  // is still used. (AGT-098 will retire the flag once the surface settles.)
  let workspace: PreparedWorkspace | null = null;
  if (ticket.repo) {
    let cloneUri: string;
    try {
      cloneUri = await resolveCloneUriForAssign(
        config,
        ticket.repo,
        opts.noStamp ?? false,
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
        activeTicketIds: collectActiveTicketIds(resolvedVault.path),
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
    if (opts.noStamp && config.stamp?.enforce) {
      // Loud only when the override actually changes behaviour.
      process.stderr.write(
        `oteam assign: --no-stamp set; cloned from ${workspace!.originUrl}. The stamp enforce check is bypassed — verify any push manually.\n`,
      );
    }
  }

  // AGT-023: when the ticket carries `project: <id>`, load the project's
  // README + sibling-file index. AGT-107 may also append a small Product-
  // agent hint when the haiku-downshift heuristic fires; both share the
  // same `--append-system-prompt` payload (single tmp file, single flag).
  const projectContext = loadProjectContext(resolvedVault.path, ticket.project);

  // AGT-105: pick the per-phase model from oteam config based on the
  // ticket's current state. Each `oteam assign` spawn drives one phase, so
  // resolving once here covers both the kitty and inline spawn shapes.
  // AGT-107 layers a Haiku downshift on the Product phase when the ticket
  // is a well-formed manual one — populated AC, source.type=manual, knob on.
  const ticketBody = readTicketBody(ticketPath);
  const model = resolveModelForTicket({
    state: ticket.state,
    sourceType: ticket.source.type,
    body: ticketBody,
    productDownshift: config.productDownshift,
    models: config.models,
  });
  const haikuDownshift = model === HAIKU_PRODUCT_MODEL && ticket.state === "triage";
  const systemPrompt = composeSystemPrompt(ticket.id, projectContext, haikuDownshift);

  // AGT-108: mint a deterministic session UUID + start timestamp before
  // spawning. `--session-id` pins the per-message JSONL Claude Code writes
  // to `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<uuid>.jsonl`, which lets
  // the post-spawn telemetry record sum tokens without guesswork. Phase is
  // null on `blocked`/`done` states (no role agent runs there) — skip
  // telemetry plumbing entirely in that case.
  const phase = phaseForState(ticket.state);
  const telemetry: TelemetryHandle | null =
    phase !== null && getTelemetryEnabled()
      ? {
          ticketId: ticket.id,
          phase,
          sessionId: randomUUID(),
          startedAt: new Date().toISOString(),
        }
      : null;

  // AGT-017: when the user asked for inline (or the platform can't host kitty
  // anyway), take the inline path and print a starting line. Failures from
  // here on are loud (stderr + non-zero exit) — no silent fallback.
  const wantsKitty = !opts.workInline && isMacOS();
  if (!wantsKitty) {
    process.stdout.write(inlineStartLine(ticket.id) + "\n");
    runInline(
      claudePath,
      ticketPath,
      resolvedVault.path,
      systemPrompt,
      workspace,
      model,
      telemetry,
    );
    return;
  }

  const kittyPath = findKittyBinary();
  if (!kittyPath) {
    process.stderr.write(
      "oteam assign: kitty not installed (or not on PATH); pass --inline to run in this terminal\n",
    );
    process.exit(1);
  }

  const monitored = opts.monitoredOrgs ?? readMonitoredOrgsFromEnv();
  const preferring = preferredKittyContext(ticket.repo, monitored);
  const socket = findKittySocket(kittyPath, preferring);
  if (!socket) {
    process.stderr.write(
      `oteam assign: no kitty socket reachable (preferring "${preferring}"); pass --inline to run in this terminal\n`,
    );
    process.exit(1);
  }

  const cwd = workspace?.path ?? dirname(ticketPath);
  const title = `Vault · ${basename(ticketPath)}`;
  const repoBasename = ticket.repo?.split("/").pop() ?? null;
  const repoSlug = ticket.repo
    ? ticket.repo.replace(/\//g, "-").toLowerCase()
    : null;
  const envPrefix = envSourcingPrefix(preferring, repoBasename, repoSlug, {
    vaultPath: resolvedVault.path,
  });
  // `/assign-ticket <path>` is the literal first prompt the spawned claude
  // session sees. The slash-command body is installed by
  // installRolePipelineSlashCommand() above; claude resolves it from the
  // session's CLAUDE_CONFIG_DIR/commands/ directory.
  const escapedClaude = shellEscape(claudePath);
  const escapedTicket = shellEscape(ticketPath);
  const slashPrompt = `/assign-ticket ${escapedTicket}`;
  const escapedPrompt = shellEscape(slashPrompt);
  // System-prompt context (AGT-023 project README + AGT-107 haiku-downshift
  // hint) gets injected via --append-system-prompt with the payload sourced
  // from a tmp file. Inlining a multi-KB markdown blob into the shell command
  // is fragile (backticks, $-subst); `"$(cat tmpfile)"` is safe because the
  // outer single-quoting protects the substitution and the inner double-
  // quoting preserves whitespace.
  const projectFlag = systemPrompt
    ? ` --append-system-prompt "$(cat '${shellEscape(systemPrompt.tmpFile)}')"`
    : "";
  const sessionFlag = telemetry
    ? ` --session-id '${shellEscape(telemetry.sessionId)}'`
    : "";
  // AGT-108: drop the old `exec` here — `exec` would replace the shell with
  // claude, leaving no way to run the telemetry record after claude exits.
  // The post-step is `; oteam telemetry record …` (semicolon, not `&&`) so a
  // non-zero claude exit still records. `EC=$?` captures the original exit
  // code so we can preserve it both into the record and as the wrapper's
  // exit status.
  const claudeCmd = `'${escapedClaude}' --dangerously-skip-permissions --model ${shellEscape(model)}${sessionFlag}${projectFlag} '${escapedPrompt}'`;
  const telemetryTail = telemetry
    ? buildTelemetryTail({
        oteamPath: findToolOnPath("oteam") ?? "oteam",
        ticketId: telemetry.ticketId,
        phase: telemetry.phase,
        model,
        sessionId: telemetry.sessionId,
        startedAt: telemetry.startedAt,
      })
    : "";
  const shellCmd = `${envPrefix}${claudeCmd}${telemetryTail}`;

  const result = kittyLaunch({
    socket,
    title,
    cwd,
    shellCmd,
    kittyPath,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `kitty @ launch exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`,
    );
  }
  process.stdout.write(kittySpawnLine(ticket.id, workspace?.path ?? null) + "\n");
}

export function kittySpawnLine(
  ticketId: string,
  workspacePath: string | null,
): string {
  const suffix = workspacePath ? ` (worktree at ${workspacePath})` : "";
  return `oteam assign: spawned kitty window for ${ticketId}${suffix}`;
}

export function inlineStartLine(ticketId: string): string {
  return `oteam assign: running inline for ${ticketId}; agent starting…`;
}

interface TelemetryHandle {
  ticketId: string;
  phase: string;
  sessionId: string;
  startedAt: string;
}

function buildTelemetryTail(input: {
  oteamPath: string;
  ticketId: string;
  phase: string;
  model: string;
  sessionId: string;
  startedAt: string;
}): string {
  // Best-effort per AC #4: redirect stdout/stderr of the record step to
  // /dev/null so a record-side error never leaks into the kitty window.
  // The record subcommand also stderrs internally; the redirect here is a
  // belt-and-suspenders guard against an unexpected throw.
  const oteam = `'${shellEscape(input.oteamPath)}'`;
  const args = [
    `--ticket '${shellEscape(input.ticketId)}'`,
    `--phase '${shellEscape(input.phase)}'`,
    `--model '${shellEscape(input.model)}'`,
    `--session '${shellEscape(input.sessionId)}'`,
    `--started-at '${shellEscape(input.startedAt)}'`,
    `--exit-code "$EC"`,
  ].join(" ");
  return `; EC=$?; ${oteam} telemetry record ${args} >/dev/null 2>&1 || true; exit "$EC"`;
}

function runInline(
  claudePath: string,
  ticketPath: string,
  vaultPath: string,
  systemPrompt: SystemPromptHandle | null,
  workspace: PreparedWorkspace | null,
  model: string,
  telemetry: TelemetryHandle | null,
): void {
  // Spawn claude in the current terminal with the slash command pre-typed,
  // inheriting stdio so the user can interact with the session normally.
  // PRODUCT_VAULT_PATH is propagated explicitly so the agent's follow-up
  // `oteam pull/list/...` calls land in the same vault.
  const args: string[] = [
    "--dangerously-skip-permissions",
    "--model", model,
  ];
  if (telemetry) {
    args.push("--session-id", telemetry.sessionId);
  }
  if (systemPrompt) {
    // Inline path uses spawnSync's argv directly — no shell escaping needed,
    // and we can pass the prompt content rather than reading it from the tmp
    // file. Tmp file is still written for parity with the kitty path (and so
    // failure modes match across the two spawn shapes).
    args.push("--append-system-prompt", systemPrompt.content);
  }
  args.push(`/assign-ticket ${ticketPath}`);

  const cwd = workspace?.path ?? process.cwd();
  const r = spawnSync(
    claudePath,
    args,
    {
      stdio: "inherit",
      cwd: workspace?.path,
      env: { ...process.env, PRODUCT_VAULT_PATH: vaultPath },
    },
  );
  if (telemetry) {
    // AGT-108: best-effort per AC #4 — recordPhase already wraps its own
    // body in try/catch and writes any failure to stderr. The runner does
    // not check the return value because there's nothing to fail over to.
    recordPhase({
      ticket: telemetry.ticketId,
      phase: telemetry.phase,
      model,
      sessionId: telemetry.sessionId,
      startedAt: telemetry.startedAt,
      exitCode: r.status ?? -1,
      cwd,
    });
  }
  if (r.status != null && r.status !== 0) process.exit(r.status);
}

function collectActiveTicketIds(vaultPath: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const t of readAllTickets(vaultPath)) {
      ids.add(t.id.toLowerCase());
    }
  } catch {
    // Best-effort — a vault read failure should not block the spawn. The
    // GC sweep skips when the active set is empty/missing.
  }
  return ids;
}

interface SystemPromptHandle {
  /** Absolute path to the tmp file containing the prompt payload. */
  tmpFile: string;
  /** The same payload as a string (used by the inline path). */
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
 * Combine the project-context payload (AGT-023) and the AGT-107 haiku-
 * downshift hint into a single `--append-system-prompt` payload. Returns
 * null when neither is active so the spawn skips the flag entirely.
 *
 * The haiku-downshift hint tells the Product agent to mark its comment
 * header as `(haiku-downshift)`. Putting the signal here (single source of
 * truth) keeps the agent from re-running the heuristic itself.
 */
function composeSystemPrompt(
  ticketId: string,
  projectContext: string | null,
  haikuDownshift: boolean,
): SystemPromptHandle | null {
  const parts: string[] = [];
  if (projectContext) parts.push(projectContext);
  if (haikuDownshift) parts.push(haikuDownshiftPromptHint());
  if (parts.length === 0) return null;
  const content = parts.join("\n\n");
  // Tmp file is reused per ticket so re-spawns overwrite cleanly and stale
  // files don't accumulate. /tmp is OS-swept on reboot.
  const safeId = ticketId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpFile = join(tmpdir(), `oteam-prompt-${safeId}.md`);
  writeFileSync(tmpFile, content, "utf8");
  return { tmpFile, content };
}

function haikuDownshiftPromptHint(): string {
  return [
    "# Product agent: haiku-downshift heuristic active",
    "",
    "AGT-107: this ticket is a well-formed manual ticket (source.type=manual + populated `## Acceptance Criteria`), so the runner spawned you on Haiku 4.5 instead of the configured Product model. The heuristic exists to handle structural-cleanup cases cheaply; full synthesis still belongs on the configured Product model.",
    "",
    "When you advance the ticket, write the comment header as:",
    "",
    "    ### YYYY-MM-DD — Product agent (haiku-downshift)",
    "",
    "instead of the standard `### YYYY-MM-DD — Product agent`. That makes the heuristic visible in the ticket's audit trail.",
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

function findToolOnPath(name: string): string | null {
  const r = spawnSync("/usr/bin/env", ["which", name], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const path = (r.stdout || "").trim();
  return path.length > 0 ? path : null;
}

function readMonitoredOrgsFromEnv(): string[] {
  const raw = process.env.OTEAM_MONITORED_ORGS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
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
