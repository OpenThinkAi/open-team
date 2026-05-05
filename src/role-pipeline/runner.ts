import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename, dirname, join } from "node:path";
import {
  findVaultRootForPath,
  getTelemetryEnabled,
  readConfig,
  type OteamConfig,
} from "../lib/config.ts";
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
  StampGateError,
  type PreparedWorkspace,
  type WorkspaceSource,
} from "../lib/workspace.ts";
import { installRolePipelineSlashCommand } from "./install-slash-command.ts";

export interface AssignOptions {
  ticketPath: string;
  vault?: string;
  monitoredOrgs?: string[];
  workInline?: boolean;
  /**
   * Per-run override of the `stamp.enforce` config knob. Forces the agent
   * worktree to be cloned from `git@github.com:<repo>.git` regardless of
   * what oteam config says. Has no effect when stamp enforcement is already
   * off (the default). Documented in `oteam assign --help` as a one-shot
   * escape hatch; the durable setting is `oteam config stamp set --enforce off`.
   */
  noStamp?: boolean;
}

function resolveWorkspaceMode(
  config: OteamConfig,
  noStamp: boolean,
): WorkspaceSource {
  if (noStamp) return "github";
  if (config.stamp?.enforce) {
    if (!config.stamp.host || config.stamp.host.length === 0) {
      // G3 (AGT-096): hand-edited config can reach this state. Loud, fast.
      throw new Error(
        "oteam assign: stamp.enforce is on but stamp.host is empty — run 'oteam config stamp set --host <url>' or 'oteam config stamp set --enforce off'",
      );
    }
    return "stamp";
  }
  return "github";
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

  // Make sure the spawned `claude` session can find `/assign-ticket`.
  installRolePipelineSlashCommand();

  const claudePath = findToolOnPath("claude");
  if (!claudePath) {
    throw new Error(
      "claude CLI not found on PATH — install Claude Code (https://claude.com/claude-code) first",
    );
  }

  // AGT-096: pick the clone source from oteam config. With `stamp.enforce:
  // true` the AGT-050 stamp gate fires (clone from stamp; failure exits
  // non-zero). With anything else (no stamp, or `stamp.enforce: false`) the
  // worktree is cloned from GitHub directly. The legacy `--no-stamp` flag
  // forces the github path regardless — it's a per-run override of the
  // enforce config knob (AGT-098 will retire the flag once the surface
  // settles).
  let workspace: PreparedWorkspace | null = null;
  if (ticket.repo) {
    const mode = resolveWorkspaceMode(config, opts.noStamp ?? false);
    try {
      workspace = prepareAgentWorkspace({
        ticketId: ticket.id,
        repoSlug: ticket.repo,
        mode,
        stampHost: mode === "stamp" ? config.stamp?.host : undefined,
        activeTicketIds: collectActiveTicketIds(resolvedVault.path),
      });
    } catch (err) {
      if (err instanceof StampGateError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    if (opts.noStamp && config.stamp?.enforce) {
      // Loud only when the override actually changes behaviour. If the user
      // is in no-enforce mode anyway, repeating the warning is just noise.
      process.stderr.write(
        `oteam assign: --no-stamp set; cloned from ${workspace.originUrl}. The stamp gate is bypassed — verify any push manually.\n`,
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

  const kittyPath =
    !opts.workInline && isMacOS() ? findKittyBinary() : null;
  if (!kittyPath) {
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

  const monitored = opts.monitoredOrgs ?? readMonitoredOrgsFromEnv();
  const preferring = preferredKittyContext(ticket.repo, monitored);
  const socket = findKittySocket(kittyPath, preferring);
  if (!socket) {
    process.stderr.write(
      `oteam assign: no kitty socket reachable (preferring "${preferring}"); falling back to inline run.\n`,
    );
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
