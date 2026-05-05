import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import readline from "node:readline";
import {
  addVault,
  getStampConfig,
  listVaults,
  seedDefaultModelsIfEmpty,
  setStamp,
  type SeedModelsResult,
  type StampConfig,
} from "../lib/config.ts";
import { PHASES } from "../lib/models.ts";
import {
  bootstrapWorkspace,
  defaultWorkspacePath,
  WorkspaceConflictError,
  type BootstrapOutcome,
} from "../lib/workspace-tree.ts";

const BLOCK_BEGIN =
  "<!-- oteam:begin (managed by `oteam init` — do not edit between markers) -->";
const BLOCK_END = "<!-- oteam:end -->";

const AGENTS_BODY = `## oteam — workspace-driven role pipeline for Claude agents

If the user asks you to **search, find, list, filter, count, or file
tickets**, or mentions a "workspace", an "Obsidian vault", an \`AGT-NNN\` id,
a project, "ingesting GitHub issues or PRs", or driving tickets through a
"role pipeline" — \`oteam\` is the right tool. The workspace is a directory
of markdown files (typically \`~/openteam/tickets/<state>/AGT-NNN-*.md\`),
but **do not search it with \`find\` or \`grep\` directly.** The CLI knows the
ticket schema and has structured + free-text filters; filesystem search
does not, and you will fight false positives from incidental keyword
mentions.

**First reach for \`oteam list\`.** It supports:

- \`oteam list --grep "<term>"\` — body substring (case-insensitive)
- \`oteam list --match "<term>"\` — title substring (case-insensitive)
- \`oteam list --project X\` / \`--repo X\` / \`--team X\` / \`--priority X\` /
  \`--label X\` (repeatable) / \`--source github|manual\` — all case-insensitive
- \`--state <state>\`, \`--include-archived\` — when you need them

Other common verbs: \`oteam ticket new "<title>" [--project X]\` to file a
ticket, \`oteam pull github owner/repo#NN\` to ingest a GitHub issue or PR,
\`oteam assign <AGT-NNN>\` to drive a ticket through the role pipeline. Run
\`oteam --help\` or \`oteam <command> --help\` for full details. If you don't
know whether a workspace is configured, \`oteam config vault list\` tells you.
`;

const CLAUDE_BODY = `## oteam

If the user asks to search, find, list, or file tickets, or mentions a
"workspace", "Obsidian vault", an \`AGT-NNN\` id, or a role pipeline, use the
\`oteam\` CLI — **do not** \`find\`/\`grep\` the workspace directly. Start with
\`oteam list --grep "<term>"\` or \`oteam list --match "<term>"\`. See
\`AGENTS.md\` next to this file for the short summary and \`oteam --help\` for
the full surface.
`;

type UpsertResult = "created" | "updated" | "appended";

function renderBlock(body: string): string {
  return `${BLOCK_BEGIN}\n\n${body.trimEnd()}\n\n${BLOCK_END}\n`;
}

function upsertBlock(filePath: string, body: string): UpsertResult {
  const block = renderBlock(body);

  if (!existsSync(filePath)) {
    writeFileSync(filePath, block, "utf8");
    return "created";
  }

  const existing = readFileSync(filePath, "utf8");
  const beginIdx = existing.indexOf(BLOCK_BEGIN);
  const endIdx = existing.indexOf(BLOCK_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + BLOCK_END.length);
    // Strip a single trailing newline from `block` so we don't accumulate
    // blank lines on every refresh; preserve whatever gap the user had after
    // the original end marker.
    writeFileSync(filePath, before + block.trimEnd() + after, "utf8");
    return "updated";
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(filePath, existing + separator + block, "utf8");
  return "appended";
}

function expandHome(input: string): string {
  const home = process.env.HOME ?? "";
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

function prompt(question: string, fallback: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolvePrompt(trimmed.length === 0 ? fallback : trimmed);
    });
  });
}

function promptRaw(question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer.trim());
    });
  });
}

export interface RunInitOptions {
  /** Workspace location. Alias of `workspace`. Default: `~/openteam/`. */
  dir?: string;
  /** Workspace location (alias of `dir`). */
  workspace?: string;
  /** Where to write the AGENTS.md / CLAUDE.md guidance block. Default: `$HOME`. */
  docsDir?: string;
  /** Skip interactive prompt; use defaults. */
  yes?: boolean;
  /**
   * Skip the stamp prompt-pair entirely. Existing stamp config is left
   * untouched. AC #4: `oteam init --skip-stamp` jumps the prompts.
   */
  skipStamp?: boolean;
  /**
   * Test injection — bypass the stamp host readline. Empty string means
   * "user hit enter" (skip). When `undefined`, the readline runs.
   */
  stampHost?: string;
  /**
   * Test injection — bypass the stamp enforce readline. Only consulted when
   * `stampHost` resolves to a non-empty value (host or pre-existing).
   */
  stampEnforce?: boolean;
}

export type StampInitOutcome =
  | { action: "skipped" }
  | { action: "unchanged"; stamp: StampConfig | null }
  | { action: "set"; stamp: StampConfig | null };

export interface RunInitResult {
  workspace: {
    path: string;
    outcome: BootstrapOutcome;
    registeredAs: string;
    promotedToDefault: boolean;
    currentDefault: string | null;
  };
  agents: { path: string; result: UpsertResult };
  claude: { path: string; result: UpsertResult };
  stamp: StampInitOutcome;
  models: SeedModelsResult;
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const home = process.env.HOME ?? "";
  const defaultWorkspace = defaultWorkspacePath();

  if (opts.dir && opts.workspace && opts.dir !== opts.workspace) {
    throw new Error(
      `oteam init: --dir and --workspace disagree (${opts.dir} vs ${opts.workspace}); pass one`,
    );
  }
  const workspaceFlag = opts.workspace ?? opts.dir;

  let workspaceDir: string;
  if (workspaceFlag) {
    workspaceDir = workspaceFlag;
  } else if (opts.yes) {
    workspaceDir = defaultWorkspace;
  } else {
    workspaceDir = await prompt(
      `Where should the oteam workspace live? (${defaultWorkspace}) `,
      defaultWorkspace,
    );
  }
  workspaceDir = resolve(expandHome(workspaceDir));

  const bootstrap = bootstrapWorkspace(workspaceDir);
  const registration = addVault(bootstrap.path);
  const currentDefault = listVaults().default;

  // Seeds defaults only when the on-disk `models` block is absent or empty;
  // any partial user customisation is preserved verbatim per AC #2.
  const models = seedDefaultModelsIfEmpty();

  const stamp = await runStampStep(opts);

  const docsDir = resolve(expandHome(opts.docsDir ?? home));
  if (!existsSync(docsDir)) {
    process.stderr.write(`oteam init: docs directory does not exist: ${docsDir}\n`);
    process.exit(1);
  }

  const agentsPath = join(docsDir, "AGENTS.md");
  const claudePath = join(docsDir, "CLAUDE.md");

  const agents = upsertBlock(agentsPath, AGENTS_BODY);
  const claude = upsertBlock(claudePath, CLAUDE_BODY);

  return {
    workspace: {
      path: bootstrap.path,
      outcome: bootstrap.outcome,
      registeredAs: registration.name,
      promotedToDefault: registration.promotedToDefault,
      currentDefault,
    },
    agents: { path: agentsPath, result: agents },
    claude: { path: claudePath, result: claude },
    stamp,
    models,
  };
}

async function runStampStep(opts: RunInitOptions): Promise<StampInitOutcome> {
  // AC #4: --skip-stamp jumps the prompts entirely and leaves the stamp
  // block untouched. -y also skips, so the non-interactive path stays
  // backwards-compatible (no surprise stdin reads).
  if (opts.skipStamp || opts.yes) {
    return { action: "skipped" };
  }

  const existing = getStampConfig();

  // Decide host. Test injection wins; otherwise prompt.
  let hostInput: string;
  if (opts.stampHost !== undefined) {
    hostInput = opts.stampHost.trim();
  } else {
    const hint = existing
      ? ` (current: ${existing.host}; press enter to keep)`
      : " (leave blank to skip)";
    hostInput = await promptRaw(
      `Configure a stamp server for signed-merge integration?\n  Paste host (e.g. ssh://git@host:port)${hint}: `,
    );
  }

  // Empty input means: keep current value if any, else skip stamp entirely.
  let nextHost: string | null;
  if (hostInput.length === 0) {
    nextHost = existing?.host ?? null;
  } else {
    nextHost = hostInput;
  }

  if (nextHost === null) {
    // No host now, no host before — nothing to write.
    return { action: "unchanged", stamp: null };
  }

  // Decide enforce. Test injection wins; otherwise prompt with default N.
  let enforce: boolean;
  if (opts.stampEnforce !== undefined) {
    enforce = opts.stampEnforce;
  } else {
    const enforceHint = existing
      ? ` [${existing.enforce ? "Y/n" : "y/N"}]`
      : " [y/N]";
    const enforceAnswer = await promptRaw(
      `Refuse to operate on repos not registered on this stamp server?${enforceHint}: `,
    );
    if (enforceAnswer.length === 0) {
      enforce = existing?.enforce ?? false;
    } else {
      enforce = /^(y|yes)$/i.test(enforceAnswer);
    }
  }

  // Write only when something differs. Avoids touching the file on a no-op
  // re-run where the user just hit enter twice.
  if (
    existing &&
    existing.host === nextHost &&
    existing.enforce === enforce
  ) {
    return { action: "unchanged", stamp: existing };
  }

  // Single config write — `setStamp` validates host non-empty, which
  // satisfies the G3 guard ("enforce on with no host" can't happen because
  // both fields are written together).
  const result = setStamp({ host: nextHost, enforce });
  return { action: "set", stamp: result };
}

function modelsLine(result: SeedModelsResult): string {
  if (result.action === "preserved") {
    return "ℹ️  Models: existing customisation preserved";
  }
  const pairs = PHASES.map((phase) => `${phase}=${result.models[phase]}`).join(
    ", ",
  );
  return `✅ Models: defaults seeded (${pairs})`;
}

function stampLine(outcome: StampInitOutcome): string | null {
  switch (outcome.action) {
    case "skipped":
      return null;
    case "unchanged":
      if (!outcome.stamp) return null;
      return `ℹ️  Stamp integration: host=${outcome.stamp.host} enforce=${outcome.stamp.enforce ? "on" : "off"} (no changes)`;
    case "set":
      if (!outcome.stamp) return "✅ Stamp integration: cleared";
      return `✅ Stamp integration: host=${outcome.stamp.host} enforce=${outcome.stamp.enforce ? "on" : "off"}`;
  }
}

function pastTense(action: UpsertResult): string {
  switch (action) {
    case "created":
      return "Created";
    case "updated":
      return "Updated oteam block in";
    case "appended":
      return "Appended oteam block to";
  }
}

function workspaceLine(ws: RunInitResult["workspace"]): string {
  if (ws.outcome === "already-initialised") {
    return `ℹ️  Workspace already initialised at ${ws.path} (registered as "${ws.registeredAs}")`;
  }
  const trail = ws.promotedToDefault
    ? "set as default"
    : ws.currentDefault && ws.currentDefault !== ws.registeredAs
      ? `current default is "${ws.currentDefault}" — pass \`oteam config vault default --set ${ws.registeredAs}\` to switch`
      : "registered";
  return `✅ Created workspace at ${ws.path} (registered as "${ws.registeredAs}"; ${trail})`;
}

export function buildInitCommand(): Command {
  return new Command("init")
    .description(
      "Bootstrap an oteam workspace and write guidance to AGENTS.md / CLAUDE.md",
    )
    .option(
      "-d, --dir <path>",
      "Workspace location (default: ~/openteam)",
    )
    .option(
      "-w, --workspace <path>",
      "Workspace location (alias of --dir)",
    )
    .option(
      "--docs-dir <path>",
      "Where to write AGENTS.md / CLAUDE.md (default: $HOME)",
    )
    .option("-y, --yes", "Skip prompts, use defaults")
    .option(
      "--skip-stamp",
      "Skip the stamp host/enforce prompts (leaves any existing config alone)",
    )
    .action(async (opts: RunInitOptions) => {
      let result: RunInitResult;
      try {
        result = await runInit(opts);
      } catch (err) {
        if (err instanceof WorkspaceConflictError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(1);
        }
        throw err;
      }
      process.stdout.write(`${workspaceLine(result.workspace)}\n`);
      process.stdout.write(
        `✅ ${pastTense(result.agents.result)} ${result.agents.path}\n`,
      );
      process.stdout.write(
        `✅ ${pastTense(result.claude.result)} ${result.claude.path}\n`,
      );
      process.stdout.write(`${modelsLine(result.models)}\n`);
      const stampMsg = stampLine(result.stamp);
      if (stampMsg) process.stdout.write(`${stampMsg}\n`);
    });
}
