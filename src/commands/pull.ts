import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIngestor, IngestorError } from "../ingestors/index.ts";
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
}

export async function runPull(opts: PullOptions): Promise<string> {
  const vault = resolveVaultPath();
  const triageDir = join(vault, "tickets", "triage");
  if (!existsSync(triageDir)) {
    throw new IngestorError(`vault triage dir missing at ${triageDir}`);
  }

  const ingestor = getIngestor(opts.source);
  const payload = await ingestor.fetch(opts.ref);

  const existing = readAllTickets(vault).find(
    (t) => t.source.id === payload.id,
  );
  if (existing) {
    process.stderr.write(
      `oteam pull: idempotent — reusing existing ticket ${existing.id} for ${payload.id}\n`,
    );
    return existing.filePath;
  }

  const normalised = await normaliseSource(payload);
  const id = nextTicketID(vault);
  const slug = slugify(payload.title);
  const filename = `${id}-${slug}.md`;
  const target = join(triageDir, filename);
  if (existsSync(target)) {
    throw new IngestorError(
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
  return target;
}
