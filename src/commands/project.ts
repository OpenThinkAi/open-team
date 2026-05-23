import { Command, Option } from "commander";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  listProjects,
  projectDir,
  projectFrontmatterTemplate,
  projectReadmePath,
  readProject,
  type Project,
} from "../lib/projects.ts";
import {
  readAllArchivedTickets,
  readAllTickets,
  resolveVaultPath,
} from "../lib/vault.ts";
import type { VaultTicket } from "../lib/types.ts";

export function buildProjectCommand(): Command {
  const project = new Command("project").description(
    "Manage workspace projects (folders under <workspace>/projects/<id>/)",
  );

  project
    .command("init <id>")
    .description("Scaffold <workspace>/projects/<id>/README.md and open in $EDITOR")
    .option("-w, --workspace <name-or-path>", "Use a specific registered workspace")
    .addOption(new Option("--vault <name-or-path>").hideHelp())
    .option(
      "--from-doc <path>",
      "Seed a design doc as a sibling file in the project dir (e.g. design.md)",
    )
    .option("--no-edit", "Skip opening the README in $EDITOR after scaffolding")
    .action(
      (
        id: string,
        opts: { workspace?: string; vault?: string; fromDoc?: string; edit: boolean },
      ) => {
        runInit(id, {
          vault: opts.workspace ?? opts.vault,
          fromDoc: opts.fromDoc,
          edit: opts.edit,
        });
      },
    );

  project
    .command("list")
    .description("List projects in the workspace with derived ticket counts")
    .option("-w, --workspace <name-or-path>", "Use a specific registered workspace")
    .addOption(new Option("--vault <name-or-path>").hideHelp())
    .action((opts: { workspace?: string; vault?: string }) => {
      runList({ vault: opts.workspace ?? opts.vault });
    });

  project
    .command("show <id>")
    .description("Print a project's frontmatter, body, siblings, and ticket counts")
    .option("-w, --workspace <name-or-path>", "Use a specific registered workspace")
    .addOption(new Option("--vault <name-or-path>").hideHelp())
    .option("--tickets", "Also list every ticket tagged with this project")
    .action((id: string, opts: { workspace?: string; vault?: string; tickets?: boolean }) => {
      runShow(id, { vault: opts.workspace ?? opts.vault, tickets: opts.tickets });
    });

  return project;
}

export function runInit(
  id: string,
  opts: { vault?: string; fromDoc?: string; edit: boolean },
): void {
  if (!isValidProjectId(id)) {
    process.stderr.write(
      `oteam project init: invalid project id "${id}" — use lowercase letters, digits, and hyphens (e.g. think-cli-v2)\n`,
    );
    process.exit(2);
  }

  // Validate the source doc up front so we fail before scaffolding anything.
  let fromDoc: { src: string; dest: string } | null = null;
  if (opts.fromDoc !== undefined && opts.fromDoc.length > 0) {
    const src = opts.fromDoc;
    let isFile = false;
    try {
      isFile = statSync(src).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      process.stderr.write(
        `oteam project init: --from-doc "${src}" is not a readable file\n`,
      );
      process.exit(1);
    }
    // Land the doc as a sibling so readProject's sibling discovery picks it up.
    // Avoid colliding with the scaffolded README.md.
    const base = basename(src);
    const destName = base === "README.md" ? "design.md" : base;
    fromDoc = { src, dest: destName };
  }

  const vaultPath = resolveVaultPath({ flagValue: opts.vault });
  const dir = projectDir(vaultPath, id);
  const readme = projectReadmePath(vaultPath, id);

  if (existsSync(readme)) {
    process.stderr.write(
      `oteam project init: ${readme} already exists — refusing to overwrite\n`,
    );
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(readme, projectFrontmatterTemplate(id), "utf8");
  process.stdout.write(`✅ Created project ${id}\n   ${readme}\n`);

  if (fromDoc) {
    const destPath = join(dir, fromDoc.dest);
    copyFileSync(fromDoc.src, destPath);
    process.stdout.write(`   seeded design doc → ${destPath}\n`);
  }

  if (opts.edit !== false) {
    openInEditor(readme);
  }
}

function runList(opts: { vault?: string }): void {
  const vaultPath = resolveVaultPath({ flagValue: opts.vault });
  const projects = listProjects(vaultPath);
  if (projects.length === 0) {
    process.stdout.write(
      `(no projects)\n   <workspace>/projects/<id>/README.md is the convention; create one with: oteam project init <id>\n`,
    );
    return;
  }

  const tickets = [
    ...readAllTickets(vaultPath),
    ...readAllArchivedTickets(vaultPath),
  ];
  const idWidth = Math.max(...projects.map((p) => p.id.length));
  const statusWidth = Math.max(
    ...projects.map((p) => (p.status ?? "—").length),
  );

  for (const p of projects) {
    const counts = ticketCounts(tickets, p.id);
    const parent = p.parentProject ? ` ← ${p.parentProject}` : "";
    process.stdout.write(
      `${p.id.padEnd(idWidth)}  ${(p.status ?? "—").padEnd(statusWidth)}  ${counts.active} active / ${counts.completed} done${parent}\n`,
    );
  }
}

function runShow(
  id: string,
  opts: { vault?: string; tickets?: boolean },
): void {
  const vaultPath = resolveVaultPath({ flagValue: opts.vault });
  const project = readProject(vaultPath, id);
  if (!project) {
    process.stderr.write(
      `oteam project show: no project "${id}" in ${vaultPath}/projects/\n`,
    );
    process.exit(1);
  }

  const counts = ticketCounts(
    [...readAllTickets(vaultPath), ...readAllArchivedTickets(vaultPath)],
    id,
  );

  const lines: string[] = [];
  lines.push(`# ${project.id}`);
  if (project.title) lines.push(project.title);
  lines.push("");
  lines.push(`  status:         ${project.status ?? "(unset)"}`);
  if (project.parentProject) {
    lines.push(`  parent-project: ${project.parentProject}`);
  }
  if (project.repos.length > 0) {
    lines.push(`  repos:          ${project.repos.join(", ")}`);
  }
  lines.push(`  tickets:        ${counts.active} active / ${counts.completed} done`);
  lines.push(`  readme:         ${project.readmePath}`);

  if (project.siblings.length > 0) {
    lines.push("");
    lines.push("Sibling docs:");
    for (const path of project.siblings) {
      lines.push(`  - ${basename(path)}`);
    }
  }

  const firstParagraph = takeFirstParagraph(project.body);
  if (firstParagraph) {
    lines.push("");
    lines.push(firstParagraph);
  }

  if (opts.tickets) {
    const ticketsForProject = [
      ...readAllTickets(vaultPath),
      ...readAllArchivedTickets(vaultPath),
    ].filter((t) => t.project === id);
    if (ticketsForProject.length > 0) {
      lines.push("");
      lines.push("Tickets:");
      ticketsForProject
        .sort((a, b) => a.numericID - b.numericID)
        .forEach((t) => {
          const team = t.team ? ` [${t.team}]` : "";
          lines.push(`  ${t.state.padEnd(12)} ${t.id}${team}  ${t.title}`);
        });
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
}

interface TicketCounts {
  active: number;
  completed: number;
}

function ticketCounts(tickets: VaultTicket[], projectId: string): TicketCounts {
  let active = 0;
  let completed = 0;
  for (const t of tickets) {
    if (t.project !== projectId) continue;
    if (t.state === "done") completed += 1;
    else active += 1;
  }
  return { active, completed };
}

function takeFirstParagraph(body: string): string {
  // Skip leading blank lines and the project's own H1 (since show already prints
  // it). Stop at the first blank line after the first prose line.
  const lines = body.split("\n");
  const out: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("<!--")) continue;
      started = true;
    } else if (trimmed.length === 0) {
      break;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

function isValidProjectId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

function openInEditor(path: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) return;
  const r = spawnSync(editor, [path], { stdio: "inherit", shell: true });
  if (r.status !== 0 && r.status !== null) {
    process.stderr.write(
      `oteam project init: $EDITOR exited ${r.status} (file is created at ${path}; edit it manually)\n`,
    );
  }
}
