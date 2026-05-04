import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The user-facing workspace bootstrapped by `oteam init`. Distinct from
 * `src/lib/workspace.ts` (the runner-time agent worktree under
 * `/tmp/open-team-issues/`): different concept, different lifecycle. They
 * happen to share a name in English; they don't share code.
 */

export const SENTINEL_FILENAME = ".oteam-workspace";

export const WORKSPACE_SUBDIRS: ReadonlyArray<string> = [
  "tickets/triage",
  "tickets/refined",
  "tickets/in-progress",
  "tickets/qa",
  "tickets/blocked",
  "projects",
  "archive",
  "00-meta",
];

const META_README_BODY = `# 00-meta

Workspace metadata. Templates, schema notes, and ad-hoc bookkeeping live
here. Created by \`oteam init\` — safe to extend.
`;

const SENTINEL_BODY = `${JSON.stringify(
  { version: 1, createdBy: "@openthink/team" },
  null,
  2,
)}\n`;

export function defaultWorkspacePath(): string {
  return join(homedir(), "openteam");
}

export type BootstrapOutcome = "created" | "already-initialised";

export interface BootstrapResult {
  outcome: BootstrapOutcome;
  path: string;
}

export class WorkspaceConflictError extends Error {
  readonly path: string;
  readonly conflictingPaths: ReadonlyArray<string>;
  constructor(path: string, conflictingPaths: ReadonlyArray<string>) {
    const head = `oteam init: refusing to initialise workspace at ${path} — directory is non-empty and lacks the ${SENTINEL_FILENAME} marker.`;
    const list = conflictingPaths
      .slice(0, 10)
      .map((p) => `  - ${p}`)
      .join("\n");
    const more =
      conflictingPaths.length > 10
        ? `\n  ...and ${conflictingPaths.length - 10} more`
        : "";
    super(`${head}\nConflicting entries:\n${list}${more}`);
    this.name = "WorkspaceConflictError";
    this.path = path;
    this.conflictingPaths = conflictingPaths;
  }
}

function expandHome(input: string): string {
  const home = homedir();
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/**
 * Idempotently bootstraps the on-disk workspace tree at `target`.
 *
 * Outcomes:
 * - sentinel present → no-op, returns `already-initialised`.
 * - dir missing OR present-but-empty → creates the tree, returns `created`.
 * - dir present and non-empty (excluding dotfiles) → throws
 *   `WorkspaceConflictError` naming the conflicting entries.
 *
 * Dotfiles are ignored when computing the conflict list so a stray
 * `.DS_Store` doesn't block initialisation. The sentinel itself is a
 * dotfile, but is checked first so a previously-initialised workspace is
 * detected even if other dotfiles are present.
 */
export function bootstrapWorkspace(rawTarget: string): BootstrapResult {
  const target = resolve(expandHome(rawTarget));

  if (existsSync(join(target, SENTINEL_FILENAME))) {
    return { outcome: "already-initialised", path: target };
  }

  if (existsSync(target)) {
    const visible = readdirSync(target).filter((n) => !n.startsWith("."));
    if (visible.length > 0) {
      throw new WorkspaceConflictError(target, visible);
    }
  }

  mkdirSync(target, { recursive: true });
  for (const sub of WORKSPACE_SUBDIRS) {
    mkdirSync(join(target, sub), { recursive: true });
  }
  writeFileSync(join(target, "00-meta", "README.md"), META_README_BODY);
  writeFileSync(join(target, SENTINEL_FILENAME), SENTINEL_BODY);

  return { outcome: "created", path: target };
}
