import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename, dirname, join } from "node:path";
import { findVaultRootForPath, readConfig } from "../lib/config.ts";
import {
  envSourcingPrefix,
  findKittyBinary,
  findKittySocket,
  isMacOS,
  kittyLaunch,
  preferredKittyContext,
  shellEscape,
} from "../lib/kitty.ts";
import { ROLE_PIPELINE_MODEL } from "../lib/models.ts";
import {
  formatProjectContextForPrompt,
  projectDir,
  readProject,
} from "../lib/projects.ts";
import {
  findTicketFileByID,
  isAgtId,
  parseTicket,
  resolveVault,
} from "../lib/vault.ts";
import { installRolePipelineSlashCommand } from "./install-slash-command.ts";

export interface AssignOptions {
  ticketPath: string;
  vault?: string;
  monitoredOrgs?: string[];
  workInline?: boolean;
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

  // AGT-023: when the ticket carries `project: <id>`, load the project's
  // README + sibling-file index and pass it to claude as an appended system
  // prompt. Lets the agent auto-resolve project-wide design decisions instead
  // of bubbling them up to the human as a "gap."
  const projectContext = loadProjectContext(resolvedVault.path, ticket.project);

  const kittyPath =
    !opts.workInline && isMacOS() ? findKittyBinary() : null;
  if (!kittyPath) {
    runInline(claudePath, ticketPath, resolvedVault.path, projectContext);
    return;
  }

  const monitored = opts.monitoredOrgs ?? readMonitoredOrgsFromEnv();
  const preferring = preferredKittyContext(ticket.repo, monitored);
  const socket = findKittySocket(kittyPath, preferring);
  if (!socket) {
    process.stderr.write(
      `oteam assign: no kitty socket reachable (preferring "${preferring}"); falling back to inline run.\n`,
    );
    runInline(claudePath, ticketPath, resolvedVault.path, projectContext);
    return;
  }

  const cwd = dirname(ticketPath);
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
  // Project context (AGT-023) gets injected via --append-system-prompt with the
  // payload sourced from a tmp file. Inlining a multi-KB markdown blob into the
  // shell command is fragile (backticks, $-subst); `"$(cat tmpfile)"` is safe
  // because the outer single-quoting protects the substitution and the inner
  // double-quoting preserves whitespace.
  const projectFlag = projectContext
    ? ` --append-system-prompt "$(cat '${shellEscape(projectContext.tmpFile)}')"`
    : "";
  const shellCmd = `${envPrefix}exec '${escapedClaude}' --dangerously-skip-permissions --model ${ROLE_PIPELINE_MODEL}${projectFlag} '${escapedPrompt}'`;

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

function runInline(
  claudePath: string,
  ticketPath: string,
  vaultPath: string,
  projectContext: ProjectContextHandle | null,
): void {
  // Spawn claude in the current terminal with the slash command pre-typed,
  // inheriting stdio so the user can interact with the session normally.
  // PRODUCT_VAULT_PATH is propagated explicitly so the agent's follow-up
  // `oteam pull/list/...` calls land in the same vault.
  const args: string[] = [
    "--dangerously-skip-permissions",
    "--model", ROLE_PIPELINE_MODEL,
  ];
  if (projectContext) {
    // Inline path uses spawnSync's argv directly — no shell escaping needed,
    // and we can pass the prompt content rather than reading it from the tmp
    // file. Tmp file is still written for parity with the kitty path (and so
    // failure modes match across the two spawn shapes).
    args.push("--append-system-prompt", projectContext.content);
  }
  args.push(`/assign-ticket ${ticketPath}`);

  const r = spawnSync(
    claudePath,
    args,
    {
      stdio: "inherit",
      env: { ...process.env, PRODUCT_VAULT_PATH: vaultPath },
    },
  );
  if (r.status != null && r.status !== 0) process.exit(r.status);
}

interface ProjectContextHandle {
  /** Absolute path to the tmp file containing the prompt payload. */
  tmpFile: string;
  /** The same payload as a string (used by the inline path). */
  content: string;
}

function loadProjectContext(
  vaultPath: string,
  projectId: string | null,
): ProjectContextHandle | null {
  if (!projectId) return null;
  const project = readProject(vaultPath, projectId);
  if (!project) {
    process.stderr.write(
      `oteam: ticket references project "${projectId}" but no README at ${projectDir(vaultPath, projectId)}/README.md — proceeding without project context\n`,
    );
    return null;
  }
  const content = formatProjectContextForPrompt(project);
  // Tmp file lifetime: written once per spawn, never cleaned up. The OS will
  // sweep /tmp on reboot. Using the project id (sanitised) in the filename so
  // re-spawns overwrite cleanly and a stale file from yesterday doesn't survive
  // forever per ticket.
  const safeId = projectId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpFile = join(tmpdir(), `oteam-project-${safeId}.md`);
  writeFileSync(tmpFile, content, "utf8");
  return { tmpFile, content };
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
