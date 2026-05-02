import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Source markdown that ships with the npm package. tsup copies it to dist/
// next to index.js (see package.json `build` script).
const moduleDir = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PROMPT = join(moduleDir, "assign-ticket.md");

/**
 * Install the bundled `/assign-ticket` slash-command body into every Claude
 * config dir we can reasonably find. The spawned `claude` session picks the
 * one matching its $CLAUDE_CONFIG_DIR; agentic-desktop and many users run
 * multiple parallel Claude profiles (`~/.claude`, `~/.claude-personal`,
 * `~/.claude-work`), and each needs a copy or `/assign-ticket` is "Unknown
 * command" in that profile.
 *
 * Idempotent: skips writes when contents already match. Best-effort: a write
 * failure on one target doesn't stop the others. No-op if the bundled prompt
 * isn't present (dev-mode without `npm run build`).
 */
export function installRolePipelineSlashCommand(): void {
  if (!existsSync(BUNDLED_PROMPT)) return;
  const bundled = readFileSync(BUNDLED_PROMPT);

  const targets = resolveTargetDirs();
  for (const dir of targets) {
    try {
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "assign-ticket.md");
      if (existsSync(target)) {
        const current = readFileSync(target);
        if (current.equals(bundled)) continue;
      }
      copyFileSync(BUNDLED_PROMPT, target);
    } catch {
      // Don't fail the spawn over an install hiccup — the user can still
      // invoke `claude` manually if their preferred profile is unreachable.
    }
  }
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
