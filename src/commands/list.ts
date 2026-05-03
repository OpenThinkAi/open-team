import { readAllTickets, resolveVaultPath } from "../lib/vault.ts";
import { TICKET_STATES, type VaultTicket } from "../lib/types.ts";

export interface ListOptions {
  state?: string;
  vault?: string;
  project?: string;
}

export function runList(opts: ListOptions): string {
  const tickets = readAllTickets(resolveVaultPath({ flagValue: opts.vault }));
  let filtered = opts.state
    ? tickets.filter((t) => t.state === opts.state)
    : tickets.filter((t) => t.state !== "done");

  if (opts.project) {
    const target = opts.project;
    filtered = filtered.filter((t) => t.project === target);
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

function formatTicket(t: VaultTicket): string {
  const teamMark = t.team ? ` [${t.team}]` : "";
  const projectMark = t.project ? ` (${t.project})` : "";
  const repo = t.repo ? `  ${t.repo}` : "";
  return `${t.state.padEnd(12)} ${t.id}${teamMark}${projectMark}  ${t.title}${repo}`;
}
