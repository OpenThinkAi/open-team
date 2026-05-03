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

export function runList(opts: ListOptions): string {
  const vaultPath = resolveVaultPath({ flagValue: opts.vault });
  const tickets = opts.includeArchived
    ? [...readAllTickets(vaultPath), ...readAllArchivedTickets(vaultPath)]
    : readAllTickets(vaultPath);

  let filtered = opts.state
    ? tickets.filter((t) => t.state === opts.state)
    : opts.includeArchived
      ? tickets
      : tickets.filter((t) => t.state !== "done");

  if (opts.project) {
    filtered = filterEqualsCI(filtered, "project", opts.project);
  }
  if (opts.repo) {
    filtered = filterEqualsCI(filtered, "repo", opts.repo);
  }
  if (opts.team) {
    filtered = filterEqualsCI(filtered, "team", opts.team);
  }
  if (opts.priority) {
    filtered = filterEqualsCI(filtered, "priority", opts.priority);
  }
  if (opts.source) {
    const target = opts.source.toLowerCase();
    filtered = filtered.filter((t) => t.source.type.toLowerCase() === target);
  }
  if (opts.label && opts.label.length > 0) {
    const wanted = opts.label.map((l) => l.toLowerCase());
    filtered = filtered.filter((t) => {
      const have = t.labels.map((l) => l.toLowerCase());
      return wanted.every((w) => have.includes(w));
    });
  }
  if (opts.match) {
    const needle = opts.match.toLowerCase();
    filtered = filtered.filter((t) => t.title.toLowerCase().includes(needle));
  }
  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    filtered = filtered.filter((t) => bodyMatches(t.filePath, needle));
  }

  if (filtered.length === 0) return "(no tickets)";

  const order: readonly string[] = TICKET_STATES;
  filtered.sort((a, b) => {
    const sa = order.indexOf(a.state);
    const sb = order.indexOf(b.state);
    if (sa !== sb) return sa - sb;
    return a.numericID - b.numericID;
  });

  return filtered.map(formatTicket).join("\n");
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
