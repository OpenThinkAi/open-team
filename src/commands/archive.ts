import { mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { readAllTickets, resolveVaultPath } from "../lib/vault.ts";

export class ArchiveError extends Error {}

export interface ArchiveOptions {
  ticketID: string;
}

export function runArchive(opts: ArchiveOptions): string {
  const vault = resolveVaultPath();
  const tickets = readAllTickets(vault);
  const match = tickets.find((t) => t.id === opts.ticketID);
  if (!match) {
    throw new ArchiveError(`no ticket found with id ${opts.ticketID}`);
  }
  if (match.state !== "done") {
    throw new ArchiveError(
      `ticket ${match.id} has state="${match.state}", expected "done" before archiving`,
    );
  }

  const yearMonth = new Date().toISOString().slice(0, 7);
  const archiveDir = join(vault, "archive", yearMonth);
  mkdirSync(archiveDir, { recursive: true });
  const target = join(archiveDir, basename(match.filePath));
  renameSync(match.filePath, target);
  return target;
}
