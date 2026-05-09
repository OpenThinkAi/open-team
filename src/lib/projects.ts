import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractFrontmatter, nonEmpty, parseLabels } from "./frontmatter.ts";

export interface Project {
  id: string;
  title: string | null;
  status: string | null;
  parentProject: string | null;
  repos: string[];
  body: string;
  siblings: string[];
  readmePath: string;
  projectDir: string;
}

export const PROJECT_STATUSES = [
  "planning",
  "in-progress",
  "shipped",
  "abandoned",
] as const;

export function projectsRoot(vaultPath: string): string {
  return join(vaultPath, "projects");
}

export function projectDir(vaultPath: string, id: string): string {
  return join(projectsRoot(vaultPath), id);
}

export function projectReadmePath(vaultPath: string, id: string): string {
  return join(projectDir(vaultPath, id), "README.md");
}

export function readProject(vaultPath: string, id: string): Project | null {
  const dir = projectDir(vaultPath, id);
  const readme = projectReadmePath(vaultPath, id);
  if (!existsSync(readme)) return null;

  let raw: string;
  try {
    raw = readFileSync(readme, "utf8");
  } catch {
    return null;
  }
  const frontmatter = extractFrontmatter(raw);
  // Body = everything after the second `---`. extractFrontmatter doesn't return
  // the offset, so re-find here. If there's no frontmatter, treat the whole
  // file as body.
  const body = bodyAfterFrontmatter(raw);
  const siblings = listSiblings(dir);

  return {
    id,
    title: nonEmpty(frontmatter?.title),
    status: nonEmpty(frontmatter?.status),
    parentProject: nonEmpty(frontmatter?.["parent-project"]),
    repos: parseLabels(frontmatter?.repos ?? "[]"),
    body,
    siblings,
    readmePath: readme,
    projectDir: dir,
  };
}

export function listProjects(vaultPath: string): Project[] {
  const root = projectsRoot(vaultPath);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const projects: Project[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const project = readProject(vaultPath, name);
    if (project) projects.push(project);
  }
  projects.sort((a, b) => a.id.localeCompare(b.id));
  return projects;
}

/**
 * Build the system-prompt-append payload that the role-pipeline injects when a
 * ticket carries `project: <id>`. Includes the project README body plus a
 * sibling-path index so the agent knows what other docs it can read by name
 * without grepping.
 */
export function formatProjectContextForPrompt(project: Project): string {
  const headParts: string[] = [];
  headParts.push(`# Project context: ${project.id}`);
  if (project.title) headParts.push(project.title);
  const meta: string[] = [];
  if (project.status) meta.push(`status: ${project.status}`);
  if (project.parentProject) meta.push(`parent: ${project.parentProject}`);
  if (project.repos.length > 0) meta.push(`repos: ${project.repos.join(", ")}`);
  if (meta.length > 0) headParts.push(meta.join(" · "));

  const lines: string[] = [
    headParts.join("\n"),
    "",
    "The ticket you are working belongs to this project. The README below is the canonical design doc; treat it as authoritative for project-wide decisions (architecture, scope, naming, defaults). Do not bubble up gaps to the human that this doc already answers.",
    "",
    "---",
    "",
    project.body.trim(),
  ];

  if (project.siblings.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("**Additional design docs in this project** (read by name as needed):");
    lines.push("");
    for (const path of project.siblings) {
      lines.push(`- ${path}`);
    }
  }

  return lines.join("\n");
}

function bodyAfterFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0] !== "---") return raw;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return raw;
}

function listSiblings(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const siblings: string[] = [];
  for (const name of entries) {
    if (name === "README.md") continue;
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let isFile = false;
    try {
      isFile = statSync(full).isFile();
    } catch {
      continue;
    }
    if (isFile) siblings.push(full);
  }
  siblings.sort();
  return siblings;
}

export function projectFrontmatterTemplate(id: string): string {
  return `---
id: ${id}
title:
status: planning
parent-project:
repos: []
---

# ${id}

<!-- Canonical design doc for this project. Tickets reference this project via \`project: ${id}\` in their frontmatter. The role-pipeline auto-loads this README into the spawned agent's context, so anything authoritative about the project's architecture, scope, naming, or defaults belongs here. -->

## Tickets

For the live ticket list, run:

\`\`\`sh
oteam project show ${id} --tickets
\`\`\`

Tickets are not stored inside this folder — they live in \`<workspace>/tickets/<state>/\` and reference this project via frontmatter \`project: ${id}\`.

### Notable shipped milestones (drift expected)

<!-- Hand-maintained narrative entries for shipped work worth calling out. The \`oteam project show ${id} --tickets\` command above is the canonical source of truth for the ticket list — keep entries here to short, durable highlights, and accept that this subsection will drift. -->
`;
}
