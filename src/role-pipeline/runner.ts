import { resolve, basename, dirname } from "node:path";
import {
  envSourcingPrefix,
  findKittyBinary,
  findKittySocket,
  isMacOS,
  kittyLaunch,
  preferredKittyContext,
  shellEscape,
} from "../lib/kitty.ts";
import { parseTicket } from "../lib/vault.ts";
import { runRolePipeline } from "./role-run.ts";

export interface AssignOptions {
  ticketPath: string;
  monitoredOrgs?: string[];
  workInline?: boolean;
}

export class AssignError extends Error {}

export async function assignTicket(opts: AssignOptions): Promise<void> {
  const ticketPath = resolve(opts.ticketPath);
  const ticket = parseTicket(ticketPath);
  if (!ticket) {
    throw new AssignError(
      `assign: could not parse ticket at ${ticketPath} (frontmatter unreadable)`,
    );
  }

  const kittyPath =
    !opts.workInline && isMacOS() ? findKittyBinary() : null;
  if (!kittyPath) {
    await runRolePipeline({ ticketPath });
    return;
  }

  const monitored = opts.monitoredOrgs ?? readMonitoredOrgsFromEnv();
  const preferring = preferredKittyContext(ticket.repo, monitored);
  const socket = findKittySocket(kittyPath, preferring);
  if (!socket) {
    process.stderr.write(
      `oteam assign: no kitty socket reachable (preferring "${preferring}"); falling back to inline run.\n`,
    );
    await runRolePipeline({ ticketPath });
    return;
  }

  const oteamBin = process.argv[1] ?? "oteam";
  const cwd = dirname(ticketPath);
  const title = `Vault · ${basename(ticketPath)}`;
  const escapedBin = shellEscape(oteamBin);
  const escapedTicket = shellEscape(ticketPath);
  const repoBasename = ticket.repo?.split("/").pop() ?? null;
  const repoSlug = ticket.repo
    ? ticket.repo.replace(/\//g, "-").toLowerCase()
    : null;
  const envPrefix = envSourcingPrefix(preferring, repoBasename, repoSlug);
  const shellCmd = `${envPrefix}exec '${escapedBin}' _role-run '${escapedTicket}'`;

  const result = kittyLaunch({
    socket,
    title,
    cwd,
    shellCmd,
    kittyPath,
  });
  if (result.exitCode !== 0) {
    throw new AssignError(
      `kitty @ launch exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`,
    );
  }
}

function readMonitoredOrgsFromEnv(): string[] {
  const raw = process.env.OTEAM_MONITORED_ORGS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
