# open-team

Source-agnostic vault-driven role pipeline for spawning Claude agents against tickets. Lifts the "Assign to agent" + role-pipeline flow out of agentic-desktop's Swift code into a standalone npm CLI.

## Install

Requires Node `>=22.5.0`.

```sh
npm install -g @openthink/team   # once published; see "Status" below
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

## Quick start

```sh
oteam init
```

Creates `~/openteam/` with the workspace tree below, drops a `.oteam-workspace` sentinel, registers it in `~/.open-team/config.json` (promoting it to default if no default is set), and writes the oteam guidance block to `~/AGENTS.md` and `~/CLAUDE.md`. Re-running `oteam init` against an already-initialised path is a clean no-op; running against a non-empty unmarked directory exits non-zero rather than silently merging.

Flags:

- `oteam init --dir <path>` (or `-w, --workspace <path>`) — workspace location, default `~/openteam/`.
- `oteam init --docs-dir <path>` — where to write `AGENTS.md` / `CLAUDE.md`, default `$HOME`.
- `oteam init -y` — skip the interactive workspace-path prompt.

> **Breaking change vs. earlier `oteam` builds:** `--dir` used to mean "where to write `AGENTS.md`/`CLAUDE.md`". It now means the workspace location. Use the new `--docs-dir` flag for the previous behaviour.

## Workspace setup

`open-team` reads from a workspace directory ("vault" is Obsidian's word; oteam doesn't depend on Obsidian). Layout:

```
openteam/
├── .oteam-workspace          # sentinel — written by `oteam init`
├── 00-meta/README.md
├── tickets/
│   ├── triage/  refined/  in-progress/  qa/  blocked/
├── projects/
└── archive/<YYYY-MM>/
```

A ticket's `state:` frontmatter must always match its containing folder under `tickets/`.

For the simplest single-workspace setup, run `oteam init` (creates and registers `~/openteam/`). To use an existing tree, register it via `oteam config vault add <path>` or set `PRODUCT_VAULT_PATH`. For multiple workspaces (personal + work, etc.) see [Config & multiple vaults](#config--multiple-vaults).

## Subcommands

```sh
oteam pull <source> <ref>             # ingest external item → tickets/triage/
oteam pull --project <name> ...       # tag the new ticket with a project
oteam assign <ticket-or-id>           # drive role pipeline (full path or AGT-NNN)
oteam assign --inline <path>          # … or run inline in current terminal
oteam assign --no-stamp <id>          # one-shot override of stamp.enforce (clones from GitHub)
oteam list [--state <state>]          # list active tickets
oteam list --project <name>           # filter by project frontmatter
oteam archive <ticket-id>             # move done ticket to archive/YYYY-MM/
oteam config vault add <path>         # register a vault under a name
oteam config vault list               # show registered vaults + default
oteam config stamp set --host <url>   # configure stamp host post-init
oteam config stamp set --enforce on   # require repos be stamp-registered
oteam config stamp clear              # remove the stamp block
oteam config stamp show               # print current stamp config
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

### Spawn-time clone modes (stamp integration)

For repo-bound tickets (`repo:` frontmatter set), `oteam assign` clones an isolated agent worktree before spawning and points the spawned session's cwd at it. The cloned worktree has exactly one remote — `origin` — and shares no `.git/objects` with any clone you keep elsewhere on disk, so the agent can never push back into your daily checkout by accident.

Where the clone comes from is governed by oteam config (`~/.open-team/config.json`, `stamp` block):

| `stamp` config                                 | Mode      | Clone source                                           | Behaviour                                                                                       |
|------------------------------------------------|-----------|--------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| absent / `null`                                | no-stamp  | `git@github.com:<repo>.git`                            | Default. No stamp config files are read. `oteam` works against any git repo.                    |
| `{ host, enforce: false }`                     | soft      | `git@github.com:<repo>.git`                            | Stamp host is recorded for tooling that asks for it; `oteam assign` does not gate.              |
| `{ host, enforce: true }`                      | enforce   | `<host>/srv/git/<basename>.git` (the stamp server)     | The clone IS the gate: clone failure exits non-zero before any spawn. AGT-050 behaviour.        |

`oteam init` walks you through setting `stamp.host` and `stamp.enforce` interactively. Re-running `oteam init` pre-fills the prompts; press enter to keep current values. Pass `oteam init --skip-stamp` to skip the prompts on a re-run when you only want to refresh the workspace tree or docs blocks.

You can edit the stamp config any time after init:

```sh
oteam config stamp show               # print current host + enforce
oteam config stamp set --host <url>   # set or update the stamp host
oteam config stamp set --enforce on   # turn the per-repo gate on (host required)
oteam config stamp set --enforce off  # … or back off
oteam config stamp clear              # remove the stamp block entirely
```

`oteam assign --no-stamp` is a per-run override: it forces the github clone path even when `stamp.enforce: true` is set. The persistent setting is `oteam config stamp set --enforce off`; `--no-stamp` is convenient when you want to spawn a one-off agent without touching config.

> **Migration note.** Earlier `oteam` builds read `~/.stamp/server.yml` directly. This version does not — to keep the AGT-050 stamp gate in place after upgrade, run `oteam init` and paste the host (or `oteam config stamp set --host <url> --enforce on`).

Stale workspaces from prior assigns are GC'd at spawn time: any `/tmp/open-team-issues/agt-N/` directory whose ticket id has no matching ticket in the active vault is `rm -rf`'d before the new clone. The current run's workspace is also `rm -rf`'d before its clone, so re-assigns are hermetic.

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

1. `npm install -g @openthink/team` (or `npm link` from a local clone).
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
