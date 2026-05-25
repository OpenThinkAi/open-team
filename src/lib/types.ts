export interface TicketSource {
  type: string;
  url: string | null;
  id: string | null;
  fetchedAt: Date | null;
}

export const MANUAL_SOURCE: TicketSource = {
  type: "manual",
  url: null,
  id: null,
  fetchedAt: null,
};

export interface VaultTicket {
  id: string;
  numericID: number;
  title: string;
  state: string;
  team: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: string | null;
  repo: string | null;
  blockedBy: string[];
  linkedGitHub: string | null;
  linkedPR: string | null;
  priority: string | null;
  labels: string[];
  source: TicketSource;
  filePath: string;
}

export const TICKET_STATES = [
  "triage",
  "refined",
  "in-progress",
  "blocked",
  "done",
] as const;

export type TicketState = (typeof TICKET_STATES)[number];
