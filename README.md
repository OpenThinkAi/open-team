# open-team

Source-agnostic vault-driven role pipeline for spawning Claude agents against tickets. Lifts the "Assign to agent" + role-pipeline flow out of agentic-desktop's Swift code into a standalone npm CLI.

## Install

Requires Node `>=22.5.0`.

```sh
npm install -g open-team   # once published; see "Status" below
```

Until then, install from a local clone:

```sh
git clone git@github.com:OpenThinkAi/open-team.git
cd open-team
npm install
npm run build
npm link
```

## Status

`v0` is **private and not yet published to npm** (`package.json` has `"private": true`). Flip when the source repo goes public.

## Vault setup

`open-team` reads from a `product-vault` directory. By default that's `~/Documents/product-vault`; override with `PRODUCT_VAULT_PATH`. Layout:

```
product-vault/
├── 00-meta/templates/ticket.md
├── tickets/
│   ├── triage/  refined/  in-progress/  qa/  blocked/
└── archive/<YYYY-MM>/
```

A ticket's `state:` frontmatter must always match its containing folder under `tickets/`.

## Subcommands

```sh
oteam pull <source> <ref>          # ingest external item → tickets/triage/
oteam assign <ticket-path>         # drive role pipeline (spawns kitty on macOS)
oteam assign --inline <path>       # … or run inline in current terminal
oteam list [--state <state>]       # list active tickets
oteam archive <ticket-id>          # move done ticket to archive/YYYY-MM/
```

Sources currently implemented: `github` (refs: `owner/repo#NN` or full issue URL). Linear/Jira/Notion ingestors land as additional files in `src/ingestors/`.

## Source-ingestor configuration

Each ingestor pulls a payload from its source then runs an LLM normaliser (`src/lib/normalise.ts`) that turns the unstructured body into a 1–2 sentence problem statement plus 2+ end-state-shaped acceptance criteria — shape-equivalent to a hand-filed `/file-ticket`. The normaliser uses `@anthropic-ai/claude-agent-sdk`'s `query()` and inherits whatever auth the SDK resolves (typically Claude Code's stored session).

Add a new source by writing one new `Ingestor` in `src/ingestors/<name>.ts` and registering it in `src/ingestors/index.ts`. No new UI surface, no new top-level command.

## Role-pipeline state machine

`oteam assign <ticket-path>` reads the ticket's `state:` and dispatches:

| state          | role agent                |
|----------------|---------------------------|
| `triage`       | Product (refine AC)       |
| `refined`      | Engineering — spike       |
| `in-progress`  | Engineering — implement   |
| `qa`           | QA                        |
| `blocked`      | (stops, surfaces comment) |
| `done`         | (stops)                   |

The pipeline body lives at `src/role-pipeline/assign-ticket.md` and is bundled into `dist/`. On `oteam assign` the runner (`src/role-pipeline/runner.ts`) installs the bundled body into every reachable Claude profile (`~/.claude/commands/`, `~/.claude-personal/commands/`, `$CLAUDE_CONFIG_DIR/commands/`, etc.) and spawns:

```
claude --dangerously-skip-permissions --model claude-opus-4-7 "/assign-ticket <path>"
```

…inside a new kitty OS window on macOS, or inline in the calling terminal on `--inline` / non-macOS platforms. The spawned session inherits your full Claude Code environment — global `CLAUDE.md`, MCP servers, hooks, your other slash commands. The role pipeline runs there as the literal `/assign-ticket` slash command.

Requires the `claude` CLI on PATH (https://claude.com/claude-code).

## Migration from agentic-desktop

agentic-desktop now keeps only the PR-side modules (`GitHubPRs`, `AIReview*`, `ClaudeCodeService`, menu-bar shell). The Issues panel, Vault module, AgentAssignmentService, and Ingestors moved here.

Migration steps:

1. `npm install -g open-team` (or `npm link` from a local clone).
2. Set `PRODUCT_VAULT_PATH` if your vault isn't at `~/Documents/product-vault`.
3. Optionally set `OTEAM_MONITORED_ORGS=Org1,Org2` to route those repos' tickets to the "work" kitty socket (preserves the personal/work split agentic-desktop had).
4. Delete `~/Library/Application Support/AgenticDesktop/vault-assignments.json` (panel-indicator state, no longer used).
5. Use `oteam pull github <ref>` instead of clicking "Assign to agent" on the Issues panel.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```

The repo is stamp-protected. See `AGENTS.md` and `CLAUDE.md` for the required `stamp review` / `stamp merge` flow.
