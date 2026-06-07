import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Returns true if any file under `<vaultPath>/tickets/**` or
 * `<vaultPath>/archive/**` has a basename matching `AGT-<id>[-.]…`,
 * regardless of slug.  Used by issueTicketID to detect numeric-ID collisions
 * that a full-filename check would miss.
 */
export function idExistsInVault(vaultPath: string, id: string): boolean {
  const numeric = id.replace(/^AGT-0*/, "");
  // Match AGT-NNN-slug.md or AGT-NNN.md (no-slug edge case), padding-insensitive.
  for (const sub of ["tickets", "archive"]) {
    const dir = join(vaultPath, sub);
    let found = false;
    walk(dir, (basename) => {
      if (found) return;
      if (!basename.startsWith("AGT-") || !basename.endsWith(".md")) return;
      const rest = basename.slice("AGT-".length); // "007-foo.md" or "7-foo.md"
      const digits = rest.match(/^(\d+)/)?.[1];
      if (!digits) return;
      if (parseInt(digits, 10) === parseInt(numeric, 10)) {
        found = true;
      }
    });
    if (found) return true;
  }
  return false;
}

/**
 * Issues the next free ticket ID, writes the ticket file atomically, and
 * returns `{ id, path }`.  On EEXIST (lost race or vault-wide collision the
 * pre-write rescan missed), bumps the candidate and retries.  The `render`
 * callback is called with the *final* chosen ID so the file body always
 * contains the right frontmatter ID.
 *
 * @param vaultPath   Absolute path to the vault root.
 * @param targetDir   Absolute path to the directory to write into (e.g.
 *                    `<vault>/tickets/triage`).  Caller is responsible for
 *                    ensuring it exists before calling.
 * @param slug        Filename slug (e.g. "my-ticket-title").
 * @param render      Returns the full file body for the given ID string.
 */
export function issueTicketID(
  vaultPath: string,
  targetDir: string,
  slug: string,
  render: (id: string) => string,
): { id: string; path: string } {
  const MAX_ATTEMPTS = 100;
  let candidate = nextTicketID(vaultPath);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Pre-write rescan: skip numeric IDs already present anywhere in the vault.
    if (idExistsInVault(vaultPath, candidate)) {
      candidate = bumpID(candidate);
      continue;
    }

    const filename = `${candidate}-${slug}.md`;
    const targetPath = join(targetDir, filename);
    const body = render(candidate);

    try {
      // Atomic claim: O_CREAT | O_EXCL — fails with EEXIST if another process
      // won the race between our rescan and this write.
      writeFileSync(targetPath, body, { flag: "wx", encoding: "utf8" });
      return { id: candidate, path: targetPath };
    } catch (err: unknown) {
      if (isEExist(err)) {
        // Lost the write race — bump and retry.
        candidate = bumpID(candidate);
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `issueTicketID: exceeded ${MAX_ATTEMPTS} attempts — vault may be locked or in an inconsistent state`,
  );
}

/** Increment the numeric part of an AGT-NNN ID by 1, preserving padding. */
function bumpID(id: string): string {
  const digits = id.match(/^AGT-(\d+)$/)?.[1];
  if (!digits) throw new Error(`issueTicketID: cannot bump malformed ID "${id}"`);
  const next = parseInt(digits, 10) + 1;
  return `AGT-${String(next).padStart(digits.length, "0")}`;
}

function isEExist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

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
  // Strip → truncate → strip again: the truncation can land mid-run-of-hyphens
  // (e.g. trimming "...-c" out of a longer slug), so the second strip cleans up
  // any trailing hyphen the truncation leaves behind.
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
