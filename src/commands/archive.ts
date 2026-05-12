import { mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { isAgtId, readAllTickets, resolveVaultPath } from "../lib/vault.ts";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

export interface ArchiveOptions {
  ticketID: string;
  vault?: string;
}

export function runArchive(opts: ArchiveOptions): string {
  const vault = resolveVaultPath({ flagValue: opts.vault });
  const tickets = readAllTickets(vault);
  const match = tickets.find((t) => t.id === opts.ticketID);
  if (!match) {
    throw new Error(`no ticket found with id ${opts.ticketID}`);
  }
  if (match.state !== "done") {
    throw new Error(
      `ticket ${match.id} has state="${match.state}", expected "done" before archiving`,
    );
  }

  const yearMonth = new Date().toISOString().slice(0, 7);
  const archiveDir = join(vault, "archive", yearMonth);
  mkdirSync(archiveDir, { recursive: true });
  const target = join(archiveDir, basename(match.filePath));
  renameSync(match.filePath, target);

  if (isAgtId(match.id)) {
    rmSync(join(WORKSPACE_ROOT, match.id.toLowerCase()), { recursive: true, force: true });
  }

  return target;
}
