import { readAllTickets, resolveVaultPath } from "../lib/vault.ts";
import type { VaultTicket } from "../lib/types.ts";

export interface ListOptions {
  state?: string;
}

const STATE_ORDER = [
  "triage",
  "refined",
  "in-progress",
  "qa",
  "blocked",
  "done",
];

export function runList(opts: ListOptions): string {
  const tickets = readAllTickets(resolveVaultPath());
  const filtered = opts.state
    ? tickets.filter((t) => t.state === opts.state)
    : tickets.filter((t) => t.state !== "done");

  if (filtered.length === 0) return "(no tickets)";

  filtered.sort((a, b) => {
    const sa = STATE_ORDER.indexOf(a.state);
    const sb = STATE_ORDER.indexOf(b.state);
    if (sa !== sb) return sa - sb;
    return a.numericID - b.numericID;
  });

  return filtered.map(formatTicket).join("\n");
}

function formatTicket(t: VaultTicket): string {
  const teamMark = t.team ? ` [${t.team}]` : "";
  const repo = t.repo ? `  ${t.repo}` : "";
  return `${t.state.padEnd(12)} ${t.id}${teamMark}  ${t.title}${repo}`;
}
