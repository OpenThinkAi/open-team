import { readFileSync } from "node:fs";
import {
  readAllArchivedTickets,
  readAllTickets,
  resolveVaultPath,
} from "../lib/vault.ts";
import { TICKET_STATES, type VaultTicket } from "../lib/types.ts";

export interface ListOptions {
  state?: string;
  vault?: string;
  project?: string;
  repo?: string;
  team?: string;
  priority?: string;
  source?: string;
  label?: string[];
  match?: string;
  grep?: string;
  includeArchived?: boolean;
}

// Header row labelling the column order. STATE is the only fixed-width column
// (padEnd(12), matching formatTicket); team/project are inline annotations, so
// the header names field order rather than aligning every column.
const LIST_HEADER = `${"STATE".padEnd(12)} ID  [TEAM] (PROJECT)  TITLE  REPO`;

export function runList(opts: ListOptions): string {
  const vaultPath = resolveVaultPath({ flagValue: opts.vault });
  const tickets = opts.includeArchived
    ? [...readAllTickets(vaultPath), ...readAllArchivedTickets(vaultPath)]
    : readAllTickets(vaultPath);

  // Apply the explicit field filters first; the implicit done-hiding is handled
  // afterwards so we can count what it hides for the footer.
  let matched = tickets;
  if (opts.state) {
    matched = matched.filter((t) => t.state === opts.state);
  }
  if (opts.project) {
    matched = filterEqualsCI(matched, "project", opts.project);
  }
  if (opts.repo) {
    matched = filterEqualsCI(matched, "repo", opts.repo);
  }
  if (opts.team) {
    matched = filterEqualsCI(matched, "team", opts.team);
  }
  if (opts.priority) {
    matched = filterEqualsCI(matched, "priority", opts.priority);
  }
  if (opts.source) {
    const target = opts.source.toLowerCase();
    matched = matched.filter((t) => t.source.type.toLowerCase() === target);
  }
  if (opts.label && opts.label.length > 0) {
    const wanted = opts.label.map((l) => l.toLowerCase());
    matched = matched.filter((t) => {
      const have = t.labels.map((l) => l.toLowerCase());
      return wanted.every((w) => have.includes(w));
    });
  }
  if (opts.match) {
    const needle = opts.match.toLowerCase();
    matched = matched.filter((t) => t.title.toLowerCase().includes(needle));
  }
  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    matched = matched.filter((t) => bodyMatches(t.filePath, needle));
  }

  // Done tickets are hidden unless an explicit --state or --include-archived
  // was given. Count the hidden ones (matching the other filters) for the footer.
  const hideDone = !opts.includeArchived && !opts.state;
  const doneHidden = hideDone
    ? matched.filter((t) => t.state === "done").length
    : 0;
  const filtered = hideDone
    ? matched.filter((t) => t.state !== "done")
    : matched;

  if (filtered.length === 0) {
    if (doneHidden > 0) {
      return `(no active tickets; ${doneHidden} done hidden — use --include-archived)`;
    }
    return "(no tickets)";
  }

  const order: readonly string[] = TICKET_STATES;
  filtered.sort((a, b) => {
    const sa = order.indexOf(a.state);
    const sb = order.indexOf(b.state);
    if (sa !== sb) return sa - sb;
    return a.numericID - b.numericID;
  });

  const lines = [LIST_HEADER, ...filtered.map(formatTicket)];
  if (doneHidden > 0) {
    lines.push(
      `(${doneHidden} done ticket${doneHidden === 1 ? "" : "s"} hidden — use --include-archived)`,
    );
  }
  return lines.join("\n");
}

function filterEqualsCI(
  tickets: VaultTicket[],
  field: "project" | "repo" | "team" | "priority",
  target: string,
): VaultTicket[] {
  const lower = target.toLowerCase();
  return tickets.filter((t) => {
    const value = t[field];
    return typeof value === "string" && value.toLowerCase() === lower;
  });
}

function bodyMatches(filePath: string, needleLower: string): boolean {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw.toLowerCase().includes(needleLower);
  } catch {
    return false;
  }
}

function formatTicket(t: VaultTicket): string {
  const teamMark = t.team ? ` [${t.team}]` : "";
  const projectMark = t.project ? ` (${t.project})` : "";
  const repo = t.repo ? `  ${t.repo}` : "";
  return `${t.state.padEnd(12)} ${t.id}${teamMark}${projectMark}  ${t.title}${repo}`;
}
