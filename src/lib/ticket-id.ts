import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function nextTicketID(vaultPath: string): string {
  let highest = 0;
  for (const sub of ["tickets", "archive"]) {
    const dir = join(vaultPath, sub);
    walk(dir, (basename) => {
      if (!basename.startsWith("AGT-") || !basename.endsWith(".md")) return;
      const trimmed = basename.slice("AGT-".length);
      const digits = trimmed.match(/^\d+/)?.[0];
      if (!digits) return;
      const n = parseInt(digits, 10);
      if (n > highest) highest = n;
    });
  }
  return `AGT-${String(highest + 1).padStart(3, "0")}`;
}

function walk(dir: string, visit: (basename: string) => void): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, visit);
    } else if (stat.isFile()) {
      visit(name);
    }
  }
}

export function slugify(title: string): string {
  const lower = title.toLowerCase();
  let current = "";
  let lastWasHyphen = false;
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) {
      current += ch;
      lastWasHyphen = false;
    } else if (!lastWasHyphen && current.length > 0) {
      current += "-";
      lastWasHyphen = true;
    }
  }
  let slug = current.replace(/-+$/, "");
  if (slug.length > 50) slug = slug.slice(0, 50);
  slug = slug.replace(/-+$/, "");
  return slug;
}

export function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowISOTimestamp(): string {
  return new Date().toISOString();
}
