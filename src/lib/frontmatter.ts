import { MANUAL_SOURCE, type TicketSource } from "./types.ts";

export function extractFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;

  const result: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---") return result;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    result[key] = value;
  }
  return null;
}

export function parseLabels(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1);
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

export function parseSource(raw: string | undefined): TicketSource {
  if (!raw) return MANUAL_SOURCE;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return MANUAL_SOURCE;
  const inner = trimmed.slice(1, -1);
  const pairs = splitInlineFlow(inner);
  const fields: Record<string, string> = {};
  for (const pair of pairs) {
    const colon = pair.indexOf(":");
    if (colon === -1) continue;
    const key = pair.slice(0, colon).trim();
    const value = pair.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields[key] = value;
  }
  const type = fields.type || "manual";
  const url = nonEmpty(fields.url);
  const id = nonEmpty(fields.id);
  const fetchedRaw = nonEmpty(fields["fetched-at"]);
  const fetchedAt = fetchedRaw ? new Date(fetchedRaw) : null;
  return {
    type,
    url,
    id,
    fetchedAt: fetchedAt && !isNaN(fetchedAt.getTime()) ? fetchedAt : null,
  };
}

function splitInlineFlow(s: string): string[] {
  const pairs: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of s) {
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      current += ch;
      inQuote = ch;
    } else if (ch === ",") {
      pairs.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) pairs.push(current);
  return pairs;
}

export function nonEmpty(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}
