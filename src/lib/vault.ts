import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  resolveByNameOrPath,
  type OteamConfig,
  type ResolvedVault,
} from "./config.ts";
import {
  extractFrontmatter,
  nonEmpty,
  parseLabels,
  parseSource,
} from "./frontmatter.ts";
import type { VaultTicket } from "./types.ts";

export function defaultVaultPath(): string {
  return join(homedir(), "Documents/product-vault");
}

export interface ResolveOptions {
  flagValue?: string;
  config?: OteamConfig;
}

export function resolveVault(opts: ResolveOptions = {}): ResolvedVault {
  const config = opts.config ?? readConfig();

  if (opts.flagValue && opts.flagValue.length > 0) {
    const fromFlag = resolveByNameOrPath(opts.flagValue, config);
    if (!fromFlag) {
      throw new Error(
        `--workspace: "${opts.flagValue}" is not a registered workspace name or path`,
      );
    }
    return fromFlag;
  }

  const env = process.env.PRODUCT_VAULT_PATH;
  if (env && env.length > 0) {
    const path = env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
    const named = Object.entries(config.vaults).find(([, p]) => p === path);
    return { name: named?.[0] ?? "(env)", path };
  }

  if (config.default) {
    const path = config.vaults[config.default];
    if (path) return { name: config.default, path };
  }

  return { name: "(implicit)", path: defaultVaultPath() };
}

export function resolveVaultPath(opts: ResolveOptions = {}): string {
  return resolveVault(opts).path;
}

const AGT_ID_RE = /^AGT-\d+$/;

export function isAgtId(s: string): boolean {
  return AGT_ID_RE.test(s);
}

export function findTicketFileByID(vaultPath: string, ticketID: string): string {
  if (!isAgtId(ticketID)) {
    throw new Error(
      `findTicketFileByID: "${ticketID}" is not an AGT-NNN id`,
    );
  }
  const ticketsRoot = join(vaultPath, "tickets");
  const matches: string[] = [];
  const triedStates: string[] = [];

  let stateDirs: string[] = [];
  try {
    stateDirs = readdirSync(ticketsRoot).filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        return statSync(join(ticketsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    throw new Error(
      `vault has no tickets/ directory at ${ticketsRoot}`,
    );
  }

  for (const state of stateDirs) {
    triedStates.push(state);
    const stateDir = join(ticketsRoot, state);
    let entries: string[] = [];
    try {
      entries = readdirSync(stateDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      if (name === `${ticketID}.md` || name.startsWith(`${ticketID}-`)) {
        matches.push(join(stateDir, name));
      }
    }
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(
      `no ticket file matching ${ticketID}-*.md in ${ticketsRoot} (states tried: ${triedStates.join(", ") || "none"})`,
    );
  }
  throw new Error(
    `multiple files match ${ticketID} in ${ticketsRoot}:\n  ${matches.join("\n  ")}`,
  );
}

export function readAllTickets(vaultPath?: string): VaultTicket[] {
  const root = vaultPath ?? resolveVaultPath();
  const ticketsDir = join(root, "tickets");
  let exists = false;
  try {
    exists = statSync(ticketsDir).isDirectory();
  } catch {
    return [];
  }
  if (!exists) return [];

  const tickets: VaultTicket[] = [];
  walkMarkdown(ticketsDir, (path) => {
    const ticket = parseTicket(path);
    if (ticket) tickets.push(ticket);
  });
  return tickets;
}

/**
 * Walk `<vault>/archive/YYYY-MM/*.md`. Used by surfaces that need a complete
 * project rollup (active + completed) — e.g. `oteam project show` deriving
 * `tickets-completed` from real ticket data instead of a stored count.
 * `oteam list` deliberately does NOT call this.
 */
export function readAllArchivedTickets(vaultPath?: string): VaultTicket[] {
  const root = vaultPath ?? resolveVaultPath();
  const archiveDir = join(root, "archive");
  let exists = false;
  try {
    exists = statSync(archiveDir).isDirectory();
  } catch {
    return [];
  }
  if (!exists) return [];

  const tickets: VaultTicket[] = [];
  walkMarkdown(archiveDir, (path) => {
    const ticket = parseTicket(path);
    if (ticket) tickets.push(ticket);
  });
  return tickets;
}

function walkMarkdown(dir: string, visit: (path: string) => void): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkMarkdown(full, visit);
    } else if (stat.isFile() && full.endsWith(".md")) {
      visit(full);
    }
  }
}

export function parseTicket(path: string): VaultTicket | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const frontmatter = extractFrontmatter(raw);
  if (!frontmatter) return null;

  const id = frontmatter.id;
  const title = frontmatter.title;
  const state = frontmatter.state;
  if (!id || !title || !state) return null;

  const numericID = parseInt(id.replace(/^AGT-/, ""), 10) || 0;
  const created = frontmatter.created ? new Date(frontmatter.created) : new Date();
  const updated = frontmatter.updated ? new Date(frontmatter.updated) : created;

  return {
    id,
    numericID,
    title: title.replace(/^["']|["']$/g, ""),
    state,
    team: nonEmpty(frontmatter.team),
    createdAt: isNaN(created.getTime()) ? new Date() : created,
    updatedAt: isNaN(updated.getTime()) ? created : updated,
    project: nonEmpty(frontmatter.project),
    repo: nonEmpty(frontmatter.repo),
    linkedGitHub: nonEmpty(frontmatter["linked-github"]),
    linkedPR: nonEmpty(frontmatter["linked-pr"]),
    priority: nonEmpty(frontmatter.priority),
    labels: parseLabels(frontmatter.labels ?? "[]"),
    source: parseSource(frontmatter.source),
    filePath: path,
  };
}
