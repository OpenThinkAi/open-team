import { Command } from "commander";
import {
  addVault,
  clearModel,
  clearStamp,
  configPath,
  getModels,
  getStampConfig,
  getTelemetryEnabled,
  listVaults,
  removeVault,
  setDefault,
  setModel,
  setStampEnforce,
  setStampHost,
  setTelemetryEnabled,
} from "../lib/config.ts";
import { isPhase, PHASES, type Phase } from "../lib/models.ts";

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

  const stamp = new Command("stamp").description(
    "Manage stamp-server integration (host + enforce flag)",
  );

  const stampSet = new Command("set")
    .description("Set the stamp host and/or the enforce flag")
    .option("--host <url>", "Stamp server host (e.g. ssh://git@host:port)")
    .option("--enforce <on|off>", "Refuse repos not registered on stamp")
    .action((opts: { host?: string; enforce?: string }) => {
      if (!opts.host && !opts.enforce) {
        process.stderr.write(
          "oteam config stamp set: pass --host <url> and/or --enforce <on|off>\n",
        );
        process.exit(2);
      }
      if (opts.host) {
        const next = setStampHost(opts.host);
        process.stdout.write(
          `✅ stamp.host = ${next.host} (enforce=${next.enforce ? "on" : "off"})\n`,
        );
      }
      if (opts.enforce) {
        const flag = opts.enforce.toLowerCase();
        if (flag !== "on" && flag !== "off") {
          process.stderr.write(
            `oteam config stamp set: --enforce expects on|off, got "${opts.enforce}"\n`,
          );
          process.exit(2);
        }
        const next = setStampEnforce(flag === "on");
        process.stdout.write(
          `✅ stamp.enforce = ${next.enforce ? "on" : "off"} (host=${next.host || "(unset)"})\n`,
        );
      }
    });

  const stampClear = new Command("clear")
    .description("Remove the stamp block from oteam config")
    .action(() => {
      clearStamp();
      process.stdout.write("✅ stamp config cleared\n");
    });

  const stampShow = new Command("show")
    .description("Print the current stamp config")
    .action(() => {
      const s = getStampConfig();
      if (!s) {
        process.stdout.write("(stamp not configured)\n");
        return;
      }
      process.stdout.write(`host: ${s.host}\nenforce: ${s.enforce ? "on" : "off"}\n`);
    });

  stamp.addCommand(stampSet);
  stamp.addCommand(stampClear);
  stamp.addCommand(stampShow);

  const models = new Command("models").description(
    "Per-phase model overrides for the role pipeline (product|spike|implementation|qa)",
  );

  models
    .command("set <phase> <model-id>")
    .description(
      `Pin a model id for one phase (phase: ${PHASES.join("|")})`,
    )
    .action((phaseRaw: string, modelId: string) => {
      const phase = expectPhase(phaseRaw);
      const next = setModel(phase, modelId);
      process.stdout.write(
        `✅ models.${phase} = ${next[phase]}\n`,
      );
    });

  models
    .command("clear <phase>")
    .description("Remove the override for one phase (falls back to the role-pipeline default)")
    .action((phaseRaw: string) => {
      const phase = expectPhase(phaseRaw);
      clearModel(phase);
      process.stdout.write(`✅ models.${phase} cleared\n`);
    });

  models
    .command("show")
    .description("Print the current per-phase model overrides")
    .action(() => {
      const m = getModels();
      const lines = PHASES.map((p) => `${p.padEnd(15)} ${m[p] ?? "(unset)"}`);
      process.stdout.write(lines.join("\n") + "\n");
    });

  const telemetry = new Command("telemetry").description(
    "Manage per-phase telemetry recording (default: on)",
  );

  telemetry
    .command("set <on|off>")
    .description("Turn per-phase telemetry recording on or off")
    .action((flag: string) => {
      const lower = flag.toLowerCase();
      if (lower !== "on" && lower !== "off") {
        process.stderr.write(
          `oteam config telemetry set: expected on|off, got "${flag}"\n`,
        );
        process.exit(2);
      }
      const next = setTelemetryEnabled(lower === "on");
      process.stdout.write(
        `✅ telemetry ${next.enabled ? "on" : "off"}\n`,
      );
    });

  telemetry
    .command("show")
    .description("Print whether telemetry recording is on")
    .action(() => {
      process.stdout.write(`${getTelemetryEnabled() ? "on" : "off"}\n`);
    });

  config.addCommand(vault);
  config.addCommand(stamp);
  config.addCommand(models);
  config.addCommand(telemetry);
  return config;
}

function expectPhase(value: string): Phase {
  if (!isPhase(value)) {
    process.stderr.write(
      `oteam config models: unknown phase "${value}" — supported: ${PHASES.join(", ")}\n`,
    );
    process.exit(2);
  }
  return value;
}
