import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getIngestor } from "../ingestors/index.ts";
import { renderTicket } from "../lib/render.ts";
import { normaliseSource } from "../lib/normalise.ts";
import {
  issueTicketID,
  nowISOTimestamp,
  slugify,
  todayISODate,
} from "../lib/ticket-id.ts";
import { readAllTickets, resolveVaultPath } from "../lib/vault.ts";
import { getRepoEntry, readConfig, setRepoCloneUri } from "../lib/config.ts";
import { promptCloneUri } from "../lib/prompt-clone-uri.ts";

export interface PullOptions {
  source: string;
  ref: string;
  vault?: string;
  project?: string;
  /**
   * Bypass the first-encounter prompt for daemon/non-interactive contexts.
   * When set, this URI is recorded (or the existing entry is left as-is if
   * already present) without prompting.
   */
  cloneUri?: string;
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
      `workspace triage dir missing at ${triageDir} — create it or set PRODUCT_VAULT_PATH`,
    );
  }

  const ingestor = getIngestor(opts.source);
  const payload = await ingestor.fetch(opts.ref);

  // First-encounter: record the clone URI if not already present. Pull uses
  // "default" on non-TTY (silently records the GitHub HTTPS default) so the
  // dispatch daemon keeps working. Assign uses "refuse" — the asymmetry is
  // intentional; see prompt-clone-uri.ts for the rationale.
  if (payload.repo) {
    const config = readConfig();
    const existing = getRepoEntry(payload.repo, config);
    if (!existing) {
      if (opts.cloneUri) {
        setRepoCloneUri(payload.repo, opts.cloneUri);
      } else {
        const defaultUri = `https://github.com/${payload.repo}.git`;
        const result = await promptCloneUri(
          payload.repo,
          defaultUri,
          { isTTY: process.stdin.isTTY === true },
          "default",
        );
        setRepoCloneUri(payload.repo, result.uri);
      }
    }
  }

  const existing = readAllTickets(vault).find(
    (t) => t.source.id === payload.id,
  );
  if (existing) {
    return { path: existing.filePath, reused: true, ticketID: existing.id };
  }

  const normalised = normaliseSource(payload);
  const slug = slugify(payload.title);
  mkdirSync(triageDir, { recursive: true });
  const todayISO = todayISODate();
  const fetchedAtISO = nowISOTimestamp();
  const project = opts.project ?? deriveProject(payload.repo);
  const { id, path: target } = issueTicketID(
    vault,
    triageDir,
    slug,
    (id) =>
      renderTicket({
        id,
        payload,
        normalised,
        todayISO,
        fetchedAtISO,
        project,
      }),
  );
  return { path: target, reused: false, ticketID: id };
}

// Default project = bare repo name (e.g. owner/foo-bar -> foo-bar). The
// actual repo is preserved verbatim in `repo:`; this is just a coarse
// grouping label so `oteam list --project foo-bar` works without config.
// Pass --project to override when the repo name and the project name diverge.
function deriveProject(repoSlug: string | undefined): string | null {
  if (!repoSlug) return null;
  const slash = repoSlug.lastIndexOf("/");
  const bare = slash >= 0 ? repoSlug.slice(slash + 1) : repoSlug;
  return bare.length > 0 ? bare : null;
}
