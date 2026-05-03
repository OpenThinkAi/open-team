import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import readline from "node:readline";

const BLOCK_BEGIN =
  "<!-- oteam:begin (managed by `oteam init` — do not edit between markers) -->";
const BLOCK_END = "<!-- oteam:end -->";

const AGENTS_BODY = `## oteam — vault-driven role pipeline for Claude agents

If the user asks you to **search, find, list, filter, count, or file
tickets**, or mentions a "vault", an "Obsidian vault", an \`AGT-NNN\` id, a
project, "ingesting GitHub issues or PRs", or driving tickets through a
"role pipeline" — \`oteam\` is the right tool. The vault is a directory of
markdown files (typically \`~/Documents/<vault>/tickets/<state>/AGT-NNN-*.md\`),
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
know whether a vault is configured, \`oteam config vault list\` tells you.
`;

const CLAUDE_BODY = `## oteam

If the user asks to search, find, list, or file tickets, or mentions a
"vault", "Obsidian vault", an \`AGT-NNN\` id, or a role pipeline, use the
\`oteam\` CLI — **do not** \`find\`/\`grep\` the vault directly. Start with
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

export interface RunInitOptions {
  dir?: string;
  yes?: boolean;
}

export interface RunInitResult {
  agents: { path: string; result: UpsertResult };
  claude: { path: string; result: UpsertResult };
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const home = process.env.HOME ?? "";
  const defaultDir = home;

  let targetDir: string;
  if (opts.dir) {
    targetDir = opts.dir;
  } else if (opts.yes) {
    targetDir = defaultDir;
  } else {
    targetDir = await prompt(
      `Where should AGENTS.md / CLAUDE.md be written? (${defaultDir}) `,
      defaultDir,
    );
  }

  targetDir = resolve(expandHome(targetDir));

  if (!existsSync(targetDir)) {
    process.stderr.write(`oteam init: directory does not exist: ${targetDir}\n`);
    process.exit(1);
  }

  const agentsPath = join(targetDir, "AGENTS.md");
  const claudePath = join(targetDir, "CLAUDE.md");

  const agents = upsertBlock(agentsPath, AGENTS_BODY);
  const claude = upsertBlock(claudePath, CLAUDE_BODY);

  return {
    agents: { path: agentsPath, result: agents },
    claude: { path: claudePath, result: claude },
  };
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

export function buildInitCommand(): Command {
  return new Command("init")
    .description(
      "Write oteam guidance to AGENTS.md (full) and CLAUDE.md (pointer) so agents discover oteam at session start",
    )
    .option(
      "-d, --dir <path>",
      "Target directory for AGENTS.md and CLAUDE.md (defaults to $HOME)",
    )
    .option("-y, --yes", "Skip prompt, use defaults")
    .action(async (opts: RunInitOptions) => {
      const result = await runInit(opts);
      process.stdout.write(
        `✅ ${pastTense(result.agents.result)} ${result.agents.path}\n`,
      );
      process.stdout.write(
        `✅ ${pastTense(result.claude.result)} ${result.claude.path}\n`,
      );
    });
}
