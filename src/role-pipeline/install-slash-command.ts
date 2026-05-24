import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Source markdown files that ship with the npm package. tsup copies them to
// dist/ next to index.js (see package.json `build` script).
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * The role-pipeline slash-command bodies bundled with the package, by dest
 * filename. Exported so tests can assert the registered set without re-deriving
 * it. Each entry's `dest` must also be copied into `dist/` by the
 * `package.json` `build` script — keep the two lists in sync.
 */
export const BUNDLED_COMMANDS: ReadonlyArray<{ src: string; dest: string }> = [
  { src: join(moduleDir, "assign-ticket.md"), dest: "assign-ticket.md" },
  { src: join(moduleDir, "implement-project.md"), dest: "implement-project.md" },
  { src: join(moduleDir, "dispatch.md"), dest: "dispatch.md" },
  { src: join(moduleDir, "refine.md"), dest: "refine.md" },
  // Shared per-ticket lane read by /implement-project and /dispatch. Not a
  // user-facing slash command, but it must be installed alongside them so the
  // orchestrators can read it at `<config>/commands/_ticket-lane.md`.
  { src: join(moduleDir, "_ticket-lane.md"), dest: "_ticket-lane.md" },
];

/**
 * Aggregate result returned by `installRolePipelineSlashCommand()`.
 *
 * - `written`: files that were created or updated.
 * - `skipped`: files whose contents already matched (idempotent no-op).
 * - `failed`:  files that could not be written (best-effort; includes the error).
 */
export interface InstallResult {
  written: Array<{ dir: string; dest: string }>;
  skipped: Array<{ dir: string; dest: string }>;
  failed: Array<{ dir: string; dest: string; error: unknown }>;
}

/**
 * Install the bundled role-pipeline slash-command bodies into every Claude
 * config dir we can reasonably find. The spawned `claude` session picks the
 * one matching its $CLAUDE_CONFIG_DIR; agentic-desktop and many users run
 * multiple parallel Claude profiles (`~/.claude`, `~/.claude-personal`,
 * `~/.claude-work`), and each needs a copy or the commands are "Unknown
 * command" in that profile.
 *
 * Installs: /assign-ticket, /implement-project, /dispatch, /refine (plus the
 * shared _ticket-lane.md body the orchestrators read).
 *
 * Idempotent: skips writes when contents already match. Best-effort: a write
 * failure on one target doesn't stop the others. No-op for any command whose
 * bundled source isn't present (dev-mode without `npm run build`).
 *
 * Returns a structured per-file result so callers (e.g. `oteam install-commands`)
 * can report success/failure. Existing callers that ignore the return value
 * (the runner) continue to work unchanged.
 */
export function installRolePipelineSlashCommand(): InstallResult {
  const result: InstallResult = { written: [], skipped: [], failed: [] };
  const targets = resolveTargetDirs();
  for (const { src, dest } of BUNDLED_COMMANDS) {
    if (!existsSync(src)) continue;
    const bundled = readFileSync(src);
    for (const dir of targets) {
      try {
        mkdirSync(dir, { recursive: true });
        const target = join(dir, dest);
        if (existsSync(target)) {
          const current = readFileSync(target);
          if (current.equals(bundled)) {
            result.skipped.push({ dir, dest });
            continue;
          }
        }
        copyFileSync(src, target);
        result.written.push({ dir, dest });
      } catch (err) {
        // Don't fail the spawn over an install hiccup — the user can still
        // invoke `claude` manually if their preferred profile is unreachable.
        result.failed.push({ dir, dest, error: err });
      }
    }
  }
  return result;
}

function resolveTargetDirs(): string[] {
  const home = homedir();
  const dirs = new Set<string>();

  // Canonical default: ~/.claude/commands/
  dirs.add(join(home, ".claude", "commands"));

  // Honour CLAUDE_CONFIG_DIR if the calling shell has one set.
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && configDir.length > 0) {
    dirs.add(join(configDir, "commands"));
  }

  // Sibling profiles under $HOME — `~/.claude-personal/`, `~/.claude-work/`,
  // etc. The Swift wrapper enumerated these because the spawned shell can
  // resolve a different CLAUDE_CONFIG_DIR than the parent process.
  try {
    for (const name of readdirSync(home)) {
      if (!name.startsWith(".claude-")) continue;
      const candidate = join(home, name);
      let isDir = false;
      try {
        isDir = statSync(candidate).isDirectory();
      } catch {
        /* skip */
      }
      if (isDir) dirs.add(join(candidate, "commands"));
    }
  } catch {
    /* HOME unreadable; bail */
  }

  return Array.from(dirs);
}
