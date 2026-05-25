# open-team

Source-agnostic workspace-driven role pipeline for driving Claude agents against tickets. Lifts the "Assign to agent" + role-pipeline flow out of agentic-desktop's Swift code into a standalone npm CLI.

> **Zero-SDK / on-subscription.** `oteam` invokes no Claude programmatically — it ships **no** `@anthropic-ai/claude-agent-sdk` dependency and never runs `claude -p`. `oteam assign` *prepares* a ticket's workspace and emits an assignment context; the role work runs as **Task subagents inside your interactive Claude Code session**, so it draws on your subscription rather than the metered Agent SDK credit. See [Role-pipeline state machine](#role-pipeline-state-machine).

## Install

Requires Node `>=22.5.0`.

```sh
npm install -g @openthink/team
```

Or install from a local clone for development:

```sh
git clone git@github.com:OpenThinkAi/open-team.git
cd open-team
npm install
npm run build
npm link
```

## Status

`@openthink/team` is **published to npm** — latest `1.2.0`, installable via the [Install](#install) section above. New versions publish automatically when a reviewed version bump lands on `main`; see [Releases](#releases) for the release ritual and the publish gate.

## Quick start

```sh
oteam init
```

Creates `~/openteam/` with the workspace tree below, drops a `.oteam-workspace` sentinel, registers it in `~/.open-team/config.json` (promoting it to default if no default is set), seeds per-phase model defaults (see [Per-phase model selection](#per-phase-model-selection) for the table), and writes the oteam guidance block to `~/AGENTS.md` and `~/CLAUDE.md`. Re-running `oteam init` against an already-initialised path is a clean no-op; running against a non-empty unmarked directory exits non-zero rather than silently merging. Existing per-phase model customisation is preserved across re-runs — defaults are only seeded when the `models` block is absent or empty (run `oteam config models show` to see the current state).

Flags:

- `oteam init --dir <path>` (or `-w, --workspace <path>`) — workspace location, default `~/openteam/`.
- `oteam init --docs-dir <path>` — where to write `AGENTS.md` / `CLAUDE.md`, default `$HOME`.
- `oteam init -y` — skip the interactive workspace-path prompt.

> **Breaking change vs. earlier `oteam` builds:** `--dir` used to mean "where to write `AGENTS.md`/`CLAUDE.md`". It now means the workspace location. Use the new `--docs-dir` flag for the previous behaviour.

## Workspace setup

`open-team` reads from a workspace directory (no Obsidian required). Layout:

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

For the simplest single-workspace setup, run `oteam init` (creates and registers `~/openteam/`). To use an existing tree, register it via `oteam config workspace add <path>` or set `PRODUCT_VAULT_PATH`. For multiple workspaces (personal + work, etc.) see [Config & multiple workspaces](#config--multiple-workspaces).

## Subcommands

```sh
oteam pull <source> <ref>             # ingest external item → tickets/triage/
oteam pull --project <name> ...       # tag the new ticket with a project
oteam assign <ticket-or-id>           # prepare workspace + emit assignment context (full path or AGT-NNN)
oteam list [--state <state>]          # list active tickets
oteam list --project <name>           # filter by project frontmatter
oteam archive <ticket-id>             # move done ticket to archive/YYYY-MM/ + reap workspace
oteam config workspace add <path>     # register a workspace under a name
oteam config workspace list           # show registered workspaces + default
oteam config stamp set --host <url>   # configure stamp host post-init
oteam config stamp set --enforce on   # require repos be stamp-registered
oteam config stamp clear              # remove the stamp block
oteam config stamp show               # print current stamp config
oteam config models set <phase> <id>  # pin a model per role-pipeline phase
oteam config models clear <phase>     # remove a per-phase override
oteam config models show              # print current per-phase overrides
oteam config telemetry set on|off     # toggle per-phase telemetry recording
oteam config telemetry show           # print telemetry on/off state
oteam telemetry summary [--days N] [--phase X] [--model Y]
oteam telemetry tail [-n 20]          # last N telemetry lines (raw JSONL)
```

Most commands accept `--workspace <name-or-path>` (or the back-compat alias `--vault`) to operate on a specific workspace.

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

Each ingestor pulls a payload from its source then runs a **deterministic** normaliser (`src/lib/normalise.ts`) that maps the source into a triage-shape ticket: the source body becomes the Problem Statement (the title when the body is empty), Acceptance Criteria start empty. No LLM call happens at pull time — the Product/refinement role shapes the rough import into a 1–2 sentence problem statement plus testable AC later, in-session (see [Role-pipeline state machine](#role-pipeline-state-machine)). This is what keeps `oteam` zero-SDK.

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

The pipeline body lives at `src/role-pipeline/assign-ticket.md` and is bundled into `dist/`. `oteam assign` (`src/role-pipeline/runner.ts`) installs the bundled body into every reachable Claude profile (`~/.claude/commands/`, `~/.claude-personal/commands/`, `$CLAUDE_CONFIG_DIR/commands/`, etc.) so an in-session agent can resolve `/assign-ticket`, then does the deterministic prep (claim the GH issue, clone the worktree, resolve the per-phase model, compose any system-prompt context) and prints an **assignment context** to stdout — a human summary plus a fenced ```` ```oteam:assignment ```` JSON block (`workspacePath`, `model`, `slashCommand`, `phase`, `envFiles`, …).

`oteam assign` **does not run Claude.** An interactive Claude Code parent — typically the [`/implement-project`](src/role-pipeline/implement-project.md) orchestrator — parses that block and dispatches a **Task subagent** into the prepared worktree to run `/assign-ticket`. Because the parent is an interactive session, the subagent draws on your subscription, not the metered Agent SDK credit. (The `--inline` flag is accepted but a deprecated no-op — there is no longer anything to spawn.)

Requires the `claude` CLI on PATH for the slash-command install path (https://claude.com/claude-code).

### Clone resolution (stamp integration)

For repo-bound tickets (`repo:` frontmatter set), `oteam assign` clones an isolated agent worktree during prep and reports its path in the assignment context. The cloned worktree has exactly one remote — `origin` — and shares no `.git/objects` with any clone you keep elsewhere on disk, so the subagent can never push back into your daily checkout by accident.

Where the clone comes from is governed by oteam config (`~/.open-team/config.json`, `stamp` block):

| `stamp` config                                 | Mode      | Clone source                                           | Behaviour                                                                                       |
|------------------------------------------------|-----------|--------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| absent / `null`                                | plain     | `git@github.com:<repo>.git`                            | Default. No stamp config files are read. `oteam` works against any git repo.                    |
| `{ host, enforce: false }`                     | soft      | `git@github.com:<repo>.git`                            | Stamp host is recorded for tooling that asks for it; `oteam assign` does not gate.              |
| `{ host, enforce: true }`                      | enforce   | `<host>/srv/git/<basename>.git` (the stamp server)     | The clone IS the gate: clone failure exits non-zero before the assignment context is emitted.    |

`oteam init` walks you through setting `stamp.host` and `stamp.enforce` interactively. Re-running `oteam init` pre-fills the prompts; press enter to keep current values. Pass `oteam init --skip-stamp` to skip the prompts on a re-run when you only want to refresh the workspace tree or docs blocks.

You can edit the stamp config any time after init:

```sh
oteam config stamp show               # print current host + enforce
oteam config stamp set --host <url>   # set or update the stamp host
oteam config stamp set --enforce on   # turn the per-repo gate on (host required)
oteam config stamp set --enforce off  # … or back off
oteam config stamp clear              # remove the stamp block entirely
```

Stale workspaces from prior assigns are GC'd during prep: any `/tmp/open-team-issues/agt-N/` directory whose ticket id has no matching ticket in the active workspace is `rm -rf`'d before the new clone. The current run's workspace is also `rm -rf`'d before its clone, so re-assigns are hermetic.

## Per-phase model selection

Each role-pipeline phase can run on a different Claude model. `oteam assign` reads `models[phase]` from `~/.open-team/config.json` during prep and reports the resolved id in the assignment context's `model` field; the orchestrator sets its dispatched subagent's model to that value. Phase resolution from the ticket's `state:`:

| ticket state   | phase            |
|----------------|------------------|
| `triage`       | `product`        |
| `refined`      | `spike`          |
| `in-progress`  | `implementation` |
| `qa`           | `qa`             |

`oteam init` seeds these defaults if no `models` block exists yet:

| phase            | default model        | rationale                                                       |
|------------------|----------------------|-----------------------------------------------------------------|
| `product`        | `claude-sonnet-4-6`  | synthesis when the input is rough; cheaper than Opus            |
| `spike`          | `claude-opus-4-7`    | design judgment, gap-spotting, scope rating                     |
| `implementation` | `claude-sonnet-4-6`  | multi-file edits + stamp round-trips                            |
| `qa`             | `claude-sonnet-4-6`  | catching AC mismatches against the running system               |

Inspect the current state with `oteam config models show`. Override with:

```sh
oteam config models set spike claude-opus-4-7
oteam config models set implementation claude-sonnet-4-6
oteam config models show         # one phase per line; "(unset)" for unpinned phases
oteam config models clear spike  # falls back to the role-pipeline default
```

Each field is independent. Unset phases fall back to the role-pipeline default (currently `claude-opus-4-7`); validation is "non-empty string", and Claude Code rejects unknown ids when the subagent is dispatched. Re-running `oteam init` against a config that already has any per-phase model set leaves the entire `models` block alone — your customisation wins. A spike that auto-proceeds to implementation within one subagent keeps the spike-phase model (one model per dispatch).

## Telemetry

Each role advance records one JSON line capturing wall-clock + token usage to `~/.open-team/telemetry/runs.jsonl` via `oteam telemetry record`, which the orchestrator calls after a role subagent returns (using the `telemetry` handle in the assignment context). The intent is data-driven model tuning — the per-phase defaults above are educated guesses, and the only way to know whether Sonnet QA actually catches what Opus QA does is to measure both.

> **Note (zero-SDK transition):** per-subagent token accounting is being reworked. The previous mechanism pinned `--session-id` on a spawned `claude` process and parsed its JSONL; with in-session subagents that path no longer applies, so token fields may be partial until the rework lands. Wall-clock, phase, model, and outcome are recorded reliably.

Each line looks like:

```json
{ "ticket": "AGT-108", "phase": "implementation", "model": "claude-sonnet-4-6",
  "started-at": "2026-05-04T10:00:00.000Z", "ended-at": "2026-05-04T10:05:42.000Z",
  "wall-clock-ms": 342000,
  "tokens": { "input": 230, "output": 120, "cache-read": 18100, "cache-write": 50 },
  "outcome": "done" }
```

`outcome` is one of `done` / `paused` / `failed` / `unknown`, classified from the STOP banner the role-pipeline body emits (`✅ DONE` / `⏸️ PAUSED` / `🛑 BLOCKED`). A non-zero `claude` exit pins the outcome to `failed` regardless of marker.

Inspect:

```sh
oteam telemetry tail            # last 20 lines (raw JSONL)
oteam telemetry summary         # aggregate by phase × model
oteam telemetry summary --days 7
oteam telemetry summary --phase implementation --model claude-sonnet-4-6
```

Knobs:

- `OTEAM_TELEMETRY_DIR=<path>` overrides the default `~/.open-team/telemetry/` location.
- `oteam config telemetry set off` opts out — no JSONL writes occur. Re-enable with `oteam config telemetry set on`. Default is on.
- Telemetry is best-effort: a write failure (read-only dir, missing session file, malformed log) writes one line to stderr and does not fail the role-pipeline phase. Token fields the agent SDK doesn't expose are omitted from the line rather than recorded as zero.

## Config & multiple workspaces

`open-team` supports any number of named workspaces via `~/.open-team/config.json`. The on-disk key is `vaults` for back-compat with earlier builds; conceptually these are workspaces. Register them with:

```sh
oteam config workspace add ~/Documents/my-workspace           # auto-name "my-workspace"; first add becomes default
oteam config workspace add ~/Documents/work-workspace --name work
oteam config workspace list
oteam config workspace default --set work
oteam config workspace remove work                            # clears default if it pointed here
```

The `oteam config vault ...` form also works as a silent back-compat alias (`oteam config vault add` and `oteam config workspace add` register the same thing).

Paths are resolved to absolute at `add` time, so the registration survives `cd`. Removing the default workspace clears `default` and forces an explicit `--workspace` on every subsequent command until you set a new one — there is no silent promotion.

### Resolution precedence (most-specific wins)

| # | Source                                                    | Notes                                                         |
|---|-----------------------------------------------------------|---------------------------------------------------------------|
| 1 | `--workspace <name-or-path>` flag (or `--vault` alias)    | Per-command override                                          |
| 2 | `PRODUCT_VAULT_PATH` env var                              | One-off shell override                                        |
| 3 | `default` in `~/.open-team/config.json`                   | Set via `oteam config workspace default --set <name>`         |
| 4 | `~/Documents/product-vault`                               | Implicit fallback if no config exists                         |

`oteam assign` adds two niceties on top:

- **AGT-NNN shorthand**: `oteam assign AGT-001` walks `<workspace>/tickets/<state>/` for a file whose basename starts with `AGT-001-`.
- **Workspace auto-detection from path**: passing a full path that lives inside a registered workspace root makes that workspace the active one for the run, even if it's not the default. The resolved workspace path is reported in the assignment context (`vaultPath`) so the subagent's follow-up `oteam pull/list/...` calls land in the same workspace.

## Claim-on-assign (preventing double-pickup)

When multiple operators or agents work the same workspace, two of them can race on the same ticket — both run `oteam assign` and both spin up role pipelines against the same GitHub issue. To prevent that, `oteam assign` can claim the underlying GH issue (sets `assignees`) before driving the pipeline:

```sh
oteam config bot-identity set <github-login>      # e.g. your own login, or a dedicated bot account
oteam config bot-identity show
oteam config bot-identity clear                   # disable claim-on-assign
```

When `botIdentity` is set, every `oteam assign` run on a github-sourced ticket does the following pre-flight before any expensive setup:

1. GET the issue from `source.url`.
2. If state is `closed` → exit 1 (refuses to drive the pipeline on resolved work).
3. If already assigned to someone other than `botIdentity` → exit 1 (someone else has it).
4. PATCH `assignees: [botIdentity]`. Re-read the response.
5. If assignees came back empty, the operator's `gh` token has no push access on the repo (GitHub silently drops assignee changes without it) → exit 1 with a hint.
6. If assignees != `[botIdentity]` (race with another writer) → exit 1.
7. Otherwise the claim is held; proceed.

When `botIdentity` is empty (the default), the pre-flight is skipped — backwards-compatible with configs that predate the field.

Per-invocation override: `OTEAM_BOT_IDENTITY=<login> oteam assign …`. Useful when one operator runs occasionally under a different identity (e.g. testing with a personal account) without rewriting the persisted config.

Manual tickets (`source.type: manual`) and tickets with no parseable GH URL skip the claim entirely — there's nothing to claim.

## Migration from agentic-desktop

agentic-desktop now keeps only the PR-side modules (`GitHubPRs`, `AIReview*`, `ClaudeCodeService`, menu-bar shell). The Issues panel, Vault module, AgentAssignmentService, and Ingestors moved here.

Migration steps:

1. `npm install -g @openthink/team` (or `npm link` from a local clone).
2. Either set `PRODUCT_VAULT_PATH` if your workspace isn't at `~/Documents/product-vault`, or register it via `oteam config workspace add <path>` (see [Config & multiple workspaces](#config--multiple-workspaces)).
3. Delete `~/Library/Application Support/AgenticDesktop/vault-assignments.json` (panel-indicator state, no longer used).
4. Use `oteam pull github <ref>` instead of clicking "Assign to agent" on the Issues panel.

## Releases

Releases go through the **same stamp-reviewed flow as any other change** — there are no unsigned direct release commits on `main`. To cut a release:

1. From an up-to-date `main`, branch `release/vX.Y.Z` (next patch unless a larger bump is warranted).
2. Bump `version` in `package.json`, refresh `package-lock.json` (`npm install`), commit.
3. `stamp review --diff main..release/vX.Y.Z` → fix to green → `stamp status --diff main..release/vX.Y.Z` (gate open).
4. `git checkout main && stamp merge release/vX.Y.Z --into main && stamp push main`.

Publishing is automatic: [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on every push to `main` and publishes to npm via **Trusted Publishing (OIDC — no `NPM_TOKEN`)** when, and only when, `package.json`'s `version` is not already on the registry. The deliberate gate on a publish is therefore the **reviewed version bump** in step 2 — a publish cannot happen without one landing through stamp review. A push to `main` that doesn't change the version is a no-op for the publish job. (If `package.json` ever carries `"private": true`, the workflow no-ops entirely.)

The role pipeline automates steps 1–4 as **Phase 4.5 (Release follow-up)** in [`src/role-pipeline/assign-ticket.md`](src/role-pipeline/assign-ticket.md) for any open-team ticket whose change is user-facing.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```

The repo is stamp-protected. See `AGENTS.md` and `CLAUDE.md` for the required `stamp review` / `stamp merge` flow.
