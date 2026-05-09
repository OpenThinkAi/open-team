import { Command } from "commander";
import {
  addVault,
  clearBotIdentity,
  clearModel,
  clearStamp,
  configPath,
  getBotIdentity,
  getModels,
  getProductDownshift,
  getRepoEntry,
  getStampConfig,
  getTelemetryEnabled,
  listRepoEntries,
  listVaults,
  removeRepoEntry,
  removeVault,
  setBotIdentity,
  setDefault,
  setModel,
  setProductDownshift,
  setRepoCloneUri,
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

  models
    .command("product-downshift <on|off|show>")
    .description(
      "Toggle the AGT-107 Haiku-downshift heuristic for well-formed manual tickets (default: on)",
    )
    .action((flag: string) => {
      const lower = flag.toLowerCase();
      if (lower === "show") {
        process.stdout.write(`${getProductDownshift() ? "on" : "off"}\n`);
        return;
      }
      if (lower !== "on" && lower !== "off") {
        process.stderr.write(
          `oteam config models product-downshift: expected on|off|show, got "${flag}"\n`,
        );
        process.exit(2);
      }
      const next = setProductDownshift(lower === "on");
      process.stdout.write(
        `✅ models.productDownshift = ${next ? "on" : "off"}\n`,
      );
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

  const botIdentity = new Command("bot-identity").description(
    "Manage the GitHub login `oteam assign` claims issues under (default: empty — no claim attempted)",
  );

  botIdentity
    .command("set <login>")
    .description("Set the bot identity (GitHub login)")
    .action((login: string) => {
      const next = setBotIdentity(login);
      process.stdout.write(`✅ botIdentity = ${next}\n`);
    });

  botIdentity
    .command("clear")
    .description("Remove the bot identity (disables claim-on-assign)")
    .action(() => {
      clearBotIdentity();
      process.stdout.write("✅ botIdentity cleared\n");
    });

  botIdentity
    .command("show")
    .description("Print the current bot identity")
    .action(() => {
      const id = getBotIdentity();
      process.stdout.write(id.length > 0 ? `${id}\n` : "(unset)\n");
    });

  const repo = new Command("repo").description(
    "Manage per-repo clone URIs (<owner>/<name> → git-url)",
  );

  repo
    .command("add <slug> <git-url>")
    .description("Record a clone URI for a repo (e.g. OpenThinkAi/open-team git@github.com:OpenThinkAi/open-team.git)")
    .action((slug: string, gitUrl: string) => {
      const entry = setRepoCloneUri(slug, gitUrl);
      process.stdout.write(`✅ repos.${slug} clone-uri = ${entry["clone-uri"]}\n`);
    });

  repo
    .command("set <slug>")
    .description("Update fields for an existing repo entry")
    .option("--clone-uri <url>", "New clone URI")
    .action((slug: string, opts: { cloneUri?: string }) => {
      if (!opts.cloneUri) {
        process.stderr.write("oteam config repo set: pass --clone-uri <url>\n");
        process.exit(2);
      }
      const entry = setRepoCloneUri(slug, opts.cloneUri);
      process.stdout.write(`✅ repos.${slug} clone-uri = ${entry["clone-uri"]}\n`);
    });

  repo
    .command("show <slug>")
    .description("Print the recorded entry for a repo")
    .action((slug: string) => {
      const entry = getRepoEntry(slug);
      if (!entry) {
        process.stdout.write(`(no entry for "${slug}")\n`);
        return;
      }
      process.stdout.write(`clone-uri: ${entry["clone-uri"]}\nadded:     ${entry.added}\n`);
    });

  repo
    .command("list")
    .description("List all recorded repo entries")
    .action(() => {
      const entries = listRepoEntries();
      if (entries.length === 0) {
        process.stdout.write(`(no repos registered)\n   config: ${configPath()}\n`);
        return;
      }
      const slugWidth = Math.max(...entries.map((e) => e.slug.length));
      for (const { slug, entry } of entries) {
        process.stdout.write(`${slug.padEnd(slugWidth)}  ${entry["clone-uri"]}\n`);
      }
    });

  repo
    .command("remove <slug>")
    .description("Remove the clone URI entry for a repo (idempotent)")
    .action((slug: string) => {
      const removed = removeRepoEntry(slug);
      if (removed) {
        process.stdout.write(`✅ Removed "${slug}"\n`);
      } else {
        process.stdout.write(`ℹ️  No entry for "${slug}" — nothing to remove\n`);
      }
    });

  config.addCommand(vault);
  config.addCommand(stamp);
  config.addCommand(repo);
  config.addCommand(models);
  config.addCommand(telemetry);
  config.addCommand(botIdentity);
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
