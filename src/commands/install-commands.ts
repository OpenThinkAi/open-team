import { Command } from "commander";
import { installRolePipelineSlashCommand } from "../role-pipeline/install-slash-command.ts";

/**
 * Implements `oteam install-commands`.
 *
 * (Re)installs all role-pipeline slash-command bodies into every Claude config
 * dir found on the host. Idempotent: when all files are already up-to-date,
 * reports that and exits 0. Exits non-zero if any individual file could not be
 * written, but always attempts all files first (best-effort, not fail-fast).
 */
export function buildInstallCommandsCommand(): Command {
  return new Command("install-commands")
    .description("(Re)install role-pipeline slash commands into ~/.claude*/commands/")
    .action(() => {
      const result = installRolePipelineSlashCommand();

      for (const { dir, dest } of result.written) {
        process.stdout.write(`✅ Installed ${dest} → ${dir}\n`);
      }
      for (const { dir, dest } of result.skipped) {
        process.stdout.write(`ℹ️  Already up-to-date ${dest} in ${dir}\n`);
      }
      for (const { dir, dest, error } of result.failed) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`❌ Failed to install ${dest} → ${dir}: ${msg}\n`);
      }

      if (result.failed.length > 0) {
        process.exit(1);
      }
    });
}
