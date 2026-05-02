import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIngestor } from "../ingestors/index.ts";
import { renderTicket } from "../lib/render.ts";
import { normaliseSource } from "../lib/normalise.ts";
import {
  nextTicketID,
  nowISOTimestamp,
  slugify,
  todayISODate,
} from "../lib/ticket-id.ts";
import { readAllTickets, resolveVaultPath } from "../lib/vault.ts";

export interface PullOptions {
  source: string;
  ref: string;
  vault?: string;
}

export interface PullResult {
  path: string;
  reused: boolean;
  ticketID: string;
}

export async function runPull(opts: PullOptions): Promise<PullResult> {
  const vault = resolveVaultPath({ flagValue: opts.vault });
  const triageDir = join(vault, "tickets", "triage");
  if (!existsSync(triageDir)) {
    throw new Error(
      `vault triage dir missing at ${triageDir} — create it or set PRODUCT_VAULT_PATH`,
    );
  }

  const ingestor = getIngestor(opts.source);
  const payload = await ingestor.fetch(opts.ref);

  const existing = readAllTickets(vault).find(
    (t) => t.source.id === payload.id,
  );
  if (existing) {
    return { path: existing.filePath, reused: true, ticketID: existing.id };
  }

  const normalised = await normaliseSource(payload);
  const id = nextTicketID(vault);
  const slug = slugify(payload.title);
  const filename = `${id}-${slug}.md`;
  const target = join(triageDir, filename);
  if (existsSync(target)) {
    throw new Error(
      `target already exists at ${target} — ID scan collision`,
    );
  }
  mkdirSync(triageDir, { recursive: true });
  const body = renderTicket({
    id,
    payload,
    normalised,
    todayISO: todayISODate(),
    fetchedAtISO: nowISOTimestamp(),
  });
  writeFileSync(target, body);
  return { path: target, reused: false, ticketID: id };
}
