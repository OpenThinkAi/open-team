import { Command, Option } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderManualTicket } from "../lib/render.ts";
import {
  nextTicketID,
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
  /** Documented form; takes precedence over `vault`. */
  workspace?: string;
  /** Back-compat alias for `workspace`. */
  vault?: string;
}

export interface TicketNewResult {
  ticketID: string;
  path: string;
}

export function runTicketNew(opts: TicketNewOptions): TicketNewResult {
  const title = opts.title.trim();
  if (title.length === 0) {
    throw new Error("oteam ticket new: <title> must not be empty");
  }

  const vault = resolveVaultPath({ flagValue: opts.workspace ?? opts.vault });
  const triageDir = join(vault, "tickets", "triage");
  mkdirSync(triageDir, { recursive: true });

  const id = nextTicketID(vault);
  const slug = slugify(title);
  if (slug.length === 0) {
    throw new Error(
      `oteam ticket new: title "${title}" produced an empty slug — use a title with at least one alphanumeric character`,
    );
  }

  const target = join(triageDir, `${id}-${slug}.md`);
  if (existsSync(target)) {
    throw new Error(
      `oteam ticket new: target already exists at ${target} — ID scan collision`,
    );
  }

  const body = renderManualTicket({
    id,
    title,
    todayISO: todayISODate(),
    fetchedAtISO: nowISOTimestamp(),
    team: opts.team ?? "product",
    project: opts.project ?? null,
    priority: opts.priority ?? "medium",
    labels: opts.labels ?? [],
  });

  writeFileSync(target, body, "utf8");
  return { ticketID: id, path: target };
}

function collectLabel(value: string, prev: string[] = []): string[] {
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
      "--label <label>",
      "Add a label (repeatable: --label foo --label bar)",
      collectLabel,
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
          labels: opts.label,
          vault: opts.workspace ?? opts.vault,
        });
        process.stdout.write(`✅ Filed ${result.ticketID}\n   ${result.path}\n`);
      },
    );

  return ticket;
}
