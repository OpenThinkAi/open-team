import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { Command, Option } from "commander";
import {
  listMarkdownFiles,
  parseTicket,
  readAllTickets,
  resolveVaultPath,
} from "../lib/vault.ts";
import { listProjects } from "../lib/projects.ts";
import { TICKET_STATES } from "../lib/types.ts";

export type IssueClass =
  | "ghost-archive"
  | "done-unarchived"
  | "state-folder-mismatch"
  | "duplicate-id"
  | "malformed-frontmatter"
  | "missing-repo"
  | "stale-project-status";

export interface DoctorIssue {
  class: IssueClass;
  severity: "error" | "warning";
  /** Path relative to the vault root (file, or project dir for project issues). */
  path: string;
  id?: string;
  message: string;
  fixable: boolean;
  fixed?: boolean;
}

export interface DoctorResult {
  issues: DoctorIssue[];
  errorCount: number;
  warningCount: number;
  fixedCount: number;
  /** Unresolved error-class issues — drives the process exit code. */
  unresolvedErrors: number;
}

export interface DoctorOptions {
  vault?: string;
  fix?: boolean;
}

const VALID_STATE = new Set<string>(TICKET_STATES);
// Project statuses that legitimately have zero active tickets.
const TERMINAL_PROJECT_STATUSES = new Set<string>([
  "shipped",
  "done",
  "abandoned",
  "archived",
  "obsolete",
  "complete",
  "completed",
]);

function idFromFilename(file: string): string | undefined {
  return basename(file).match(/^(AGT-\d+)/)?.[1];
}

export function runDoctor(opts: DoctorOptions = {}): DoctorResult {
  const vault = resolveVaultPath({ flagValue: opts.vault });
  const issues: DoctorIssue[] = [];
  const idToPaths = new Map<string, string[]>();
  const rel = (p: string) => relative(vault, p);

  const recordId = (id: string | undefined, file: string) => {
    if (!id) return;
    const arr = idToPaths.get(id) ?? [];
    arr.push(file);
    idToPaths.set(id, arr);
  };

  // --- tickets/ (including any shadow tickets/archive) ---
  const ticketsDir = join(vault, "tickets");
  for (const file of listMarkdownFiles(ticketsDir)) {
    const base = basename(file);
    if (!base.startsWith("AGT-")) continue; // not a ticket file
    const segments = rel(file).split(sep); // ["tickets", <folder>, ...]
    const folder = segments[1];
    const underArchive = segments.includes("archive");
    const parsed = parseTicket(file);
    recordId(parsed?.id ?? idFromFilename(file), file);

    if (underArchive) {
      issues.push({
        class: "ghost-archive",
        severity: "error",
        path: rel(file),
        id: parsed?.id ?? idFromFilename(file),
        message:
          "ticket sits under tickets/archive/ — the canonical archive is top-level archive/YYYY-MM/",
        fixable: true,
      });
      continue;
    }

    if (!parsed) {
      issues.push({
        class: "malformed-frontmatter",
        severity: "error",
        path: rel(file),
        id: idFromFilename(file),
        message: "missing or unparseable frontmatter (need at least id, title, state)",
        fixable: false,
      });
      continue;
    }

    if (parsed.state === "done") {
      issues.push({
        class: "done-unarchived",
        severity: "error",
        path: rel(file),
        id: parsed.id,
        message: `state: done but still in tickets/${folder}/ — should be archived`,
        fixable: true,
      });
    } else if (folder && VALID_STATE.has(folder) && parsed.state !== folder) {
      issues.push({
        class: "state-folder-mismatch",
        severity: "error",
        path: rel(file),
        id: parsed.id,
        message: `frontmatter state="${parsed.state}" but file is in tickets/${folder}/`,
        fixable: true,
      });
    }

    if (parsed.project && !parsed.repo) {
      const proj = listProjects(vault).find(
        (p) => p.id.toLowerCase() === parsed.project!.toLowerCase(),
      );
      if (proj && proj.repos.length > 0) {
        issues.push({
          class: "missing-repo",
          severity: "warning",
          path: rel(file),
          id: parsed.id,
          message: `blank repo: but project "${parsed.project}" declares repos (${proj.repos.join(", ")})`,
          fixable: false,
        });
      }
    }
  }

  // --- top-level archive/ (for duplicate-id detection across the whole vault) ---
  for (const file of listMarkdownFiles(join(vault, "archive"))) {
    if (!basename(file).startsWith("AGT-")) continue;
    const parsed = parseTicket(file);
    recordId(parsed?.id ?? idFromFilename(file), file);
  }

  // --- duplicate IDs ---
  for (const [id, paths] of idToPaths) {
    if (paths.length > 1) {
      issues.push({
        class: "duplicate-id",
        severity: "error",
        path: paths.map(rel).join(", "),
        id,
        message: `${id} is used by ${paths.length} files — IDs must be unique across the vault`,
        fixable: false,
      });
    }
  }

  // --- stale project status ---
  const activeByProject = new Map<string, number>();
  for (const t of readAllTickets(vault)) {
    if (t.state === "done" || !t.project) continue;
    const key = t.project.toLowerCase();
    activeByProject.set(key, (activeByProject.get(key) ?? 0) + 1);
  }
  for (const proj of listProjects(vault)) {
    const active = activeByProject.get(proj.id.toLowerCase()) ?? 0;
    const status = (proj.status ?? "").toLowerCase();
    if (active === 0 && !TERMINAL_PROJECT_STATUSES.has(status)) {
      issues.push({
        class: "stale-project-status",
        severity: "warning",
        path: rel(proj.projectDir),
        id: proj.id,
        message: `project has 0 active tickets but status is "${proj.status ?? "(unset)"}" — close it (shipped/abandoned) or archive the folder`,
        fixable: false,
      });
    }
  }

  // --- apply fixes ---
  let fixedCount = 0;
  if (opts.fix) {
    for (const issue of issues) {
      if (!issue.fixable) continue;
      const abs = join(vault, issue.path);
      try {
        if (issue.class === "ghost-archive" || issue.class === "done-unarchived") {
          archiveFile(vault, abs);
        } else if (issue.class === "state-folder-mismatch") {
          const parsed = parseTicket(abs);
          if (parsed && VALID_STATE.has(parsed.state)) {
            moveToStateFolder(vault, abs, parsed.state);
          } else {
            continue;
          }
        } else {
          continue;
        }
        issue.fixed = true;
        fixedCount += 1;
      } catch {
        // Leave issue.fixed unset; it stays counted as an unresolved error.
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const unresolvedErrors = issues.filter(
    (i) => i.severity === "error" && !i.fixed,
  ).length;

  return { issues, errorCount, warningCount, fixedCount, unresolvedErrors };
}

/** Move a ticket file into top-level archive/YYYY-MM/, forcing state: done. */
function archiveFile(vault: string, filePath: string): string {
  const ym = new Date().toISOString().slice(0, 7);
  const dir = join(vault, "archive", ym);
  mkdirSync(dir, { recursive: true });
  const raw = readFileSync(filePath, "utf8");
  if (!/^state: *done *$/m.test(raw)) {
    writeFileSync(filePath, raw.replace(/^state:.*$/m, "state: done"));
  }
  const target = join(dir, basename(filePath));
  renameSync(filePath, target);
  return target;
}

/** Move a ticket file into tickets/<state>/ to match its frontmatter state. */
function moveToStateFolder(vault: string, filePath: string, state: string): string {
  const dir = join(vault, "tickets", state);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(filePath));
  renameSync(filePath, target);
  return target;
}

function formatHuman(result: DoctorResult, fixMode: boolean): string {
  if (result.issues.length === 0) {
    return "✓ vault is clean — no hygiene issues found";
  }
  const lines: string[] = [];
  const byClass = new Map<IssueClass, DoctorIssue[]>();
  for (const issue of result.issues) {
    const arr = byClass.get(issue.class) ?? [];
    arr.push(issue);
    byClass.set(issue.class, arr);
  }
  for (const [cls, list] of byClass) {
    lines.push(`\n${cls} (${list.length}):`);
    for (const issue of list) {
      const icon = issue.fixed ? "✓ fixed" : issue.severity === "error" ? "✗" : "⚠";
      const idPart = issue.id ? `${issue.id} ` : "";
      lines.push(`  ${icon} ${idPart}${issue.path}`);
      lines.push(`        ${issue.message}`);
    }
  }
  const summary: string[] = [];
  summary.push(`${result.errorCount} error(s)`);
  summary.push(`${result.warningCount} warning(s)`);
  if (fixMode) summary.push(`${result.fixedCount} fixed`);
  lines.push(`\n${summary.join(", ")}`);
  if (!fixMode && result.issues.some((i) => i.fixable)) {
    lines.push("Run `oteam doctor --fix` to auto-correct the fixable issues.");
  }
  return lines.join("\n");
}

export function buildDoctorCommand(): Command {
  return new Command("doctor")
    .description(
      "Validate vault hygiene (state↔folder, ghost archives, duplicate IDs, done-but-unarchived, malformed/incomplete tickets, stale project status)",
    )
    .option("--fix", "Auto-correct the safe issue classes (moves files)")
    .option("--json", "Emit the report as JSON")
    .option("-w, --workspace <name-or-path>", "Use a specific registered workspace")
    .addOption(new Option("--vault <name-or-path>").hideHelp())
    .action(
      (opts: {
        fix?: boolean;
        json?: boolean;
        workspace?: string;
        vault?: string;
      }) => {
        const result = runDoctor({
          vault: opts.workspace ?? opts.vault,
          fix: opts.fix,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(formatHuman(result, Boolean(opts.fix)) + "\n");
        }
        process.exit(result.unresolvedErrors > 0 ? 1 : 0);
      },
    );
}
