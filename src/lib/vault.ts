import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function resolveVaultPath(): string {
  const env = process.env.PRODUCT_VAULT_PATH;
  if (env && env.length > 0) {
    return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
  }
  return defaultVaultPath();
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
    repo: nonEmpty(frontmatter.repo),
    linkedGitHub: nonEmpty(frontmatter["linked-github"]),
    linkedPR: nonEmpty(frontmatter["linked-pr"]),
    priority: nonEmpty(frontmatter.priority),
    labels: parseLabels(frontmatter.labels ?? "[]"),
    source: parseSource(frontmatter.source),
    filePath: path,
  };
}
