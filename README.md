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

`open-team` reads from a `product-vault` directory. Layout:

```
product-vault/
├── 00-meta/templates/ticket.md
├── tickets/
│   ├── triage/  refined/  in-progress/  qa/  blocked/
└── archive/<YYYY-MM>/
```

A ticket's `state:` frontmatter must always match its containing folder under `tickets/`.

For the simplest single-vault setup, leave `~/Documents/product-vault` in place or set `PRODUCT_VAULT_PATH`. For multiple vaults (personal + work, etc.) see [Config & multiple vaults](#config--multiple-vaults).

## Subcommands

```sh
oteam pull <source> <ref>           # ingest external item → tickets/triage/
oteam pull --project <name> ...     # tag the new ticket with a project
oteam assign <ticket-or-id>         # drive role pipeline (full path or AGT-NNN)
oteam assign --inline <path>        # … or run inline in current terminal
oteam list [--state <state>]        # list active tickets
oteam list --project <name>         # filter by project frontmatter
oteam archive <ticket-id>           # move done ticket to archive/YYYY-MM/
oteam config vault add <path>       # register a vault under a name
oteam config vault list             # show registered vaults + default
```

Most commands accept `--vault <name-or-path>` to operate on a specific vault.

### Tagging tickets by project

Tickets carry an optional `project:` frontmatter field. It's a free-form
grouping label — distinct from `repo:` (which is the source-of-truth slug like
`owner/repo`). Use it to slice work that spans multiple repos, or to give a
human-readable name to a single repo's tickets.

- `oteam pull github owner/foo#42` auto-tags the ticket with `project: foo`
  (the bare repo name).
- `oteam pull github owner/foo#42 --project candlesight` overrides the
  default — useful when the repo name and the project name diverge.
- `oteam list --project candlesight` returns just that project's active
  tickets. Combine with `--state` to narrow further.
- For tickets filed by hand or via `/file-ticket`, set `project:` directly in
  the frontmatter; nothing else needs to change.

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

## Config & multiple vaults

`open-team` supports any number of named vaults via `~/.open-team/config.json`. Register them with:

```sh
oteam config vault add ~/Documents/product-vault           # auto-name "product-vault"; first add becomes default
oteam config vault add ~/Documents/work-vault --name work
oteam config vault list
oteam config vault default --set work
oteam config vault remove work                              # clears default if it pointed here
```

Paths are resolved to absolute at `add` time, so the registration survives `cd`. Removing the default vault clears `default` and forces an explicit `--vault` on every subsequent command until you set a new one — there is no silent promotion.

### Resolution precedence (most-specific wins)

| # | Source                                            | Notes                                                |
|---|---------------------------------------------------|------------------------------------------------------|
| 1 | `--vault <name-or-path>` flag                     | Per-command override                                 |
| 2 | `PRODUCT_VAULT_PATH` env var                      | One-off shell override; also propagated to spawns    |
| 3 | `default` in `~/.open-team/config.json`           | Set via `oteam config vault default --set <name>`    |
| 4 | `~/Documents/product-vault`                       | Implicit fallback if no config exists                |

`oteam assign` adds two niceties on top:

- **AGT-NNN shorthand**: `oteam assign AGT-001` walks `<vault>/tickets/<state>/` for a file whose basename starts with `AGT-001-`.
- **Vault auto-detection from path**: passing a full path that lives inside a registered vault root makes that vault the active one for the run, even if it's not the default. The spawned `_role-run` then inherits `PRODUCT_VAULT_PATH=<that-vault>` so any follow-up `oteam pull/list/...` from the agent lands in the same vault.

## Migration from agentic-desktop

agentic-desktop now keeps only the PR-side modules (`GitHubPRs`, `AIReview*`, `ClaudeCodeService`, menu-bar shell). The Issues panel, Vault module, AgentAssignmentService, and Ingestors moved here.

Migration steps:

1. `npm install -g open-team` (or `npm link` from a local clone).
2. Either set `PRODUCT_VAULT_PATH` if your vault isn't at `~/Documents/product-vault`, or register it via `oteam config vault add <path>` (see [Config & multiple vaults](#config--multiple-vaults)).
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
