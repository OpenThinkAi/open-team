import { existsSync, readFileSync } from "node:fs";
import {
  findTicketFileAnywhere,
  isAgtId,
  resolveVaultPath,
} from "../lib/vault.ts";
import { extractFrontmatter } from "../lib/frontmatter.ts";

export interface ShowOptions {
  idOrPath: string;
  vault?: string;
}

// Frontmatter fields surfaced by `oteam show`, in display order.
const SHOWN_FIELDS = [
  "id",
  "title",
  "state",
  "team",
  "project",
  "repo",
  "linked-github",
  "linked-pr",
  "priority",
  "labels",
] as const;

export function runShow(opts: ShowOptions): string {
  const vaultPath = resolveVaultPath({ flagValue: opts.vault });
  const filePath = resolveTicketPath(vaultPath, opts.idOrPath);

  const raw = readFileSync(filePath, "utf8");
  const frontmatter = extractFrontmatter(raw);
  if (!frontmatter) {
    throw new Error(`oteam show: ${filePath} has no frontmatter block`);
  }

  const lines: string[] = [];
  for (const key of SHOWN_FIELDS) {
    const value = frontmatter[key];
    if (value === undefined || value.length === 0) continue;
    const display = key === "title" ? value.replace(/^["']|["']$/g, "") : value;
    lines.push(`${key.padEnd(13)} ${display}`);
  }

  const comment = lastComment(raw);
  if (comment) {
    lines.push("");
    lines.push(comment);
  }

  return lines.join("\n");
}

function resolveTicketPath(vaultPath: string, idOrPath: string): string {
  if (isAgtId(idOrPath)) {
    return findTicketFileAnywhere(vaultPath, idOrPath);
  }
  if (existsSync(idOrPath)) return idOrPath;
  throw new Error(
    `oteam show: "${idOrPath}" is neither an AGT-NNN id nor an existing file path`,
  );
}

/**
 * Return the most recent `### YYYY-MM-DD — <role>` comment block from the
 * ticket's `## Comments` section. Comments are appended chronologically, so the
 * last `###` heading is newest. Returns null when there are no comments.
 */
function lastComment(raw: string): string | null {
  // Scope strictly to the Comments section. Without this guard, body sections
  // (Problem Statement, Spike, …) that use `###` subheadings would be
  // misread as comments.
  const commentsIdx = raw.indexOf("\n## Comments");
  if (commentsIdx < 0) return null;
  const region = raw.slice(commentsIdx);
  const headings = [...region.matchAll(/^### .*$/gm)];
  if (headings.length === 0) return null;

  const start = headings[headings.length - 1]!.index!;
  const after = region.slice(start);
  const nextSection = after.search(/\n## /);
  const block = nextSection >= 0 ? after.slice(0, nextSection) : after;
  return block.trimEnd();
}
