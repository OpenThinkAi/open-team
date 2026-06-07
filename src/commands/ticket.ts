import { Command, Option } from "commander";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderManualTicket } from "../lib/render.ts";
import {
  issueTicketID,
  nowISOTimestamp,
  slugify,
  todayISODate,
} from "../lib/ticket-id.ts";
import { resolveVaultPath } from "../lib/vault.ts";

export interface TicketNewOptions {
  title: string;
  project?: string;
  team?: string;
  priority?: string;
  labels?: string[];
  /** GitHub repo slug (`owner/name`) written to the `repo:` frontmatter. */
  repo?: string;
  /** Dependency ticket ids (`AGT-NNN`) written to the structured `blocked-by:` list. */
  blockedBy?: string[];
  /** Documented form; takes precedence over `vault`. */
  workspace?: string;
  /** Back-compat alias for `workspace`. */
  vault?: string;
}

const REPO_SLUG_RE = /^[^/\s]+\/[^/\s]+$/;
const BLOCKED_BY_RE = /^AGT-\d+$/;

export interface TicketNewResult {
  ticketID: string;
  path: string;
}

export function runTicketNew(opts: TicketNewOptions): TicketNewResult {
  const title = opts.title.trim();
  if (title.length === 0) {
    throw new Error("oteam ticket new: <title> must not be empty");
  }

  const repo = opts.repo?.trim();
  if (repo !== undefined && repo.length > 0 && !REPO_SLUG_RE.test(repo)) {
    throw new Error(
      `oteam ticket new: --repo "${repo}" is not an owner/name slug (e.g. OpenThinkAi/open-team)`,
    );
  }

  const blockedBy = (opts.blockedBy ?? []).map((id) => id.trim());
  for (const id of blockedBy) {
    if (!BLOCKED_BY_RE.test(id)) {
      throw new Error(
        `oteam ticket new: --blocked-by "${id}" is not an AGT-NNN id (e.g. AGT-012)`,
      );
    }
  }

  const vault = resolveVaultPath({ flagValue: opts.workspace ?? opts.vault });
  const triageDir = join(vault, "tickets", "triage");
  mkdirSync(triageDir, { recursive: true });

  const slug = slugify(title);
  if (slug.length === 0) {
    throw new Error(
      `oteam ticket new: title "${title}" produced an empty slug — use a title with at least one alphanumeric character`,
    );
  }

  const todayISO = todayISODate();
  const fetchedAtISO = nowISOTimestamp();
  const { id, path: target } = issueTicketID(vault, triageDir, slug, (id) =>
    renderManualTicket({
      id,
      title,
      todayISO,
      fetchedAtISO,
      team: opts.team ?? "product",
      project: opts.project ?? null,
      repo: repo && repo.length > 0 ? repo : null,
      blockedBy,
      priority: opts.priority ?? "medium",
      labels: opts.labels ?? [],
    }),
  );

  return { ticketID: id, path: target };
}

function collect(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

export function buildTicketCommand(): Command {
  const ticket = new Command("ticket").description(
    "Create workspace tickets directly (without an external source)",
  );

  ticket
    .command("new <title>")
    .description(
      "File a new ticket in <workspace>/tickets/triage/ — works with or without a project",
    )
    .option(
      "--project <id>",
      "Tag the ticket with a project (omit for no project)",
    )
    .option("--team <team>", "Owning team frontmatter (default: product)")
    .option("--priority <priority>", "Priority frontmatter (default: medium)")
    .option(
      "--repo <slug>",
      "GitHub repo slug (owner/name) for the repo: frontmatter field",
    )
    .option(
      "--blocked-by <id>",
      "Record a dependency (AGT-NNN) in the blocked-by: list (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--label <label>",
      "Add a label (repeatable: --label foo --label bar)",
      collect,
      [] as string[],
    )
    .option("-w, --workspace <name-or-path>", "Use a specific registered workspace")
    .addOption(new Option("--vault <name-or-path>").hideHelp())
    .action(
      (
        title: string,
        opts: {
          project?: string;
          team?: string;
          priority?: string;
          repo?: string;
          blockedBy: string[];
          label: string[];
          workspace?: string;
          vault?: string;
        },
      ) => {
        const result = runTicketNew({
          title,
          project: opts.project,
          team: opts.team,
          priority: opts.priority,
          repo: opts.repo,
          blockedBy: opts.blockedBy,
          labels: opts.label,
          vault: opts.workspace ?? opts.vault,
        });
        process.stdout.write(`✅ Filed ${result.ticketID}\n   ${result.path}\n`);
      },
    );

  return ticket;
}
