import { Command } from "commander";
import {
  addVault,
  configPath,
  listVaults,
  removeVault,
  setDefault,
} from "../lib/config.ts";

export function buildConfigCommand(): Command {
  const config = new Command("config").description(
    "Manage oteam config (~/.open-team/config.json)",
  );

  const vault = new Command("vault").description(
    "Manage registered vault paths and the default vault",
  );

  vault
    .command("add <path>")
    .description("Register a vault path under a name")
    .option("--name <name>", "Override the auto-derived name")
    .action((rawPath: string, opts: { name?: string }) => {
      const result = addVault(rawPath, { name: opts.name });
      const promoted = result.promotedToDefault
        ? "\n   (set as default — first vault registered)"
        : "";
      process.stdout.write(
        `✅ Registered "${result.name}" → ${result.path}${promoted}\n`,
      );
    });

  vault
    .command("list")
    .description("List registered vaults")
    .action(() => {
      const { vaults, default: def } = listVaults();
      if (vaults.length === 0) {
        process.stdout.write(
          `(no vaults registered)\n   config: ${configPath()}\n`,
        );
        return;
      }
      const width = Math.max(...vaults.map((v) => v.name.length));
      const lines = vaults.map((v) => {
        const tag = v.name === def ? "  (default)" : "";
        return `${v.name.padEnd(width)}  ${v.path}${tag}`;
      });
      process.stdout.write(lines.join("\n") + "\n");
    });

  vault
    .command("remove <name-or-path>")
    .description("Remove a vault registration")
    .action((nameOrPath: string) => {
      const result = removeVault(nameOrPath);
      const note = result.clearedDefault
        ? '\n   default cleared — pass --vault until you set a new one with "oteam config vault default --set <name>"'
        : "";
      process.stdout.write(`✅ Removed "${result.name}"${note}\n`);
    });

  vault
    .command("default")
    .description("Print or set the default vault")
    .option("--set <name-or-path>", "Set the default to this name or path")
    .action((opts: { set?: string }) => {
      if (opts.set) {
        const name = setDefault(opts.set);
        process.stdout.write(`✅ Default is now "${name}"\n`);
        return;
      }
      const { default: def } = listVaults();
      if (!def) {
        process.stdout.write(
          "(no default — pass --vault on every command, or set one with --set)\n",
        );
        return;
      }
      process.stdout.write(`${def}\n`);
    });

  config.addCommand(vault);
  return config;
}
