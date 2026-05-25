---
description: Drive every ticket in a workspace project through the role-pipeline to done from a single interactive session, fanning work out to Task subagents. Argument is a project id (e.g. `think-cli-v2`). Two human gates: plan approval (after spike) and merge approval (before push), batched per wave.
argument-hint: <project-id>
---

You are the **in-session orchestrator** for one workspace project. You run inside the user's interactive Claude Code session, so every token you and your subagents spend draws on the user's **subscription**, not the metered Agent SDK credit. You drive each active ticket through the role pipeline (Product → Engineering spike → Engineering implementation → merge close-out → archive) by **dispatching Task subagents** — never by spawning `claude`, calling `claude -p`, or touching the Agent SDK.

**Argument**: `$ARGUMENTS` — a single project id matching a folder under `<workspace>/projects/<id>/` (e.g. `think-cli-v2`). The workspace path comes from the active oteam config; you do not resolve it manually.

## Hard rules — read first

1. **Billing invariant: all role work runs as Task subagents you dispatch.** Never run `oteam assign --inline` expecting it to *run* the role — as of the zero-SDK conversion `oteam assign` only *prepares* the workspace and prints an `oteam:assignment` block. You parse that block and dispatch a subagent into the prepared worktree. Never spawn `claude`, `claude -p`, or the Agent SDK from any tool call. Subagents inherit your interactive (subscription) bucket; a spawned process or `-p` would not.

2. **Two human gates, batched per wave. Everything else is your call.**
   - **Plan gate** — after the spike(s) in a wave produce plans, present them together and get approval before any implementation.
   - **Merge gate** — after implementation + stamp review go GREEN, present the ready-to-merge set for the wave and get approval before any `stamp merge`/push.
   - Make taste-level calls yourself: file naming, fixture shape, comment voice, equally-good library choices, ordering of independent substeps. Do not gate on those.

3. **Surface immediately (exceptions, not gates):** architectural surprises found mid-build, alarming states (divergent histories, unexplained CI failures, missing remotes, weird auth), user-action tickets (work only the operator can do), and spike questions that need the user's roadmap/values (e.g. single- vs multi-tenant) the design doc didn't answer. Surface and wait.

4. **Parallelism is by wave.** Tickets in the same wave run as **concurrent subagents — dispatch them in a single message with multiple Task calls**, each with **`run_in_background: true`** (per the lane's core subroutine, so the user's session isn't frozen for the whole wave). Your turn ends once the wave is launched; the harness re-invokes you as **each** ticket's phase completes, so collect completions as they arrive and only present a wave's **batched** plan/merge gate once **every** ticket in the wave has reported. Sequence waves on dependencies. A ticket's worktree must be cut from *post-merge* main, so only run `oteam assign` for a ticket **at the start of its wave**, never all upfront.

5. **Never push to GitHub directly from a worktree.** Work goes through stamp; stamp mirrors to GitHub. If a worktree ends up with a github remote and a subagent pushes there, the stamp server's main and GitHub's main diverge and reconciliation is painful. Insist on stamp-only push paths.

6. **3-attempt cap on any failing operation.** Three failures → STOP and surface.

7. **`stamp review` is the one gated review call — usually unmetered too.** It runs on the **local** model by default and escalates to the metered Anthropic backend only for large/cross-cutting diffs (chosen per-run by diff size via `STAMP_REVIEWER_BACKEND`; see assign-ticket §5·0). It is low-frequency and gated — do not route around it, and let §5·0 pick the backend. Everything else you and your subagents do is on subscription.

## The per-ticket lane

The mechanics of advancing one ticket — the **core subroutine** ("drive one role":
`oteam assign` → parse the `oteam:assignment` block → dispatch a Task subagent →
record telemetry), the role sequence, and the return-marker interpretations — live in
the **shared ticket lane**, so `/dispatch` and this skill share one source of truth.
Read it once up front and apply it per ticket:
`$CLAUDE_CONFIG_DIR/commands/_ticket-lane.md` if that env var is set, otherwise
`~/.claude/commands/_ticket-lane.md`.

**This skill owns what the lane delegates to the caller:** the dependency graph, wave
grouping, running a wave's tickets as **concurrent subagents**, and **batching the two
gate-points across the wave** (Phases 2b and 2d). The lane owns everything per-ticket.

## Phase 0 — Pre-flight

Resolve the project:

```sh
oteam project show <project-id> --tickets
```

If that errors, STOP — print `🛑 BLOCKED — project <id> not found in workspace` and list candidates from `oteam project list`.

Read the project README and sibling design docs:

```sh
# (sed, not awk $2 — skill arg-substitution eats `$2` in a skill body)
PROJECT_DIR="$(oteam project show <project-id> | grep '^  readme:' | sed 's#.*: *##' | xargs dirname)"
cat "$PROJECT_DIR/README.md"
ls "$PROJECT_DIR/"
```

Build the dependency graph. **Read each ticket's structured `blocked-by:` frontmatter field — it is the source of truth.** It is an inline array of AGT ids (e.g. `blocked-by: [AGT-012, AGT-013]`); an empty `[]` means no dependencies. Parse it deterministically — do **not** LLM-infer it from prose. The ticket file's path comes from `oteam project show <project-id> --tickets`; read the frontmatter directly, e.g.:

```sh
# (sed, not awk $2 — skill arg-substitution eats `$2` in a skill body)
grep '^blocked-by:' "<ticket-file>.md" | sed 's#^blocked-by: *##'
```

Back-compat for older tickets: if a ticket has **no** `blocked-by:` field (legacy tickets filed before the field existed), fall back to scanning its comments for free-text dependency notes ("Sequencing: blocked by AGT-XXX" / "depends on AGT-YYY"). Prefer the structured field whenever it is present.

Then **group it into waves**: a wave is the set of active tickets whose dependencies are all already merged. Tickets within a wave run in parallel; waves run in sequence. Mark user-action tickets as gates and exclude deferred/parking-lot tickets unless told otherwise.

## Phase 1 — Confirm the waves

Print a short plan (no walls):

- The waves, in order, with the tickets in each.
- Which ticket depends on which (why the waves split where they do).
- User-action gates and excluded tickets, with one-line reasons.

Ask one question: "Run these waves with plan + merge gates? Or override anything?" Wait for go-ahead. Adjust and re-confirm if they push back. Do not start firing without an explicit go.

## Phase 2 — Drive wave by wave

For each wave, in order:

### 2.0 — Brief on prior retros (once per ticket, gated on `repo:`)

For each ticket in the wave with a non-empty `repo:`, derive the cortex name as the path component after the slash, lowercased (`OpenThinkAi/open-team` → `open-team`), and capture:

```sh
think brief --cortex <derived-cortex-name> 2>&1 || true
```

Treat the output as background context (`## Prior context for AGT-XXX (<repo>)`), not directives. Non-fatal on every failure mode; note `no prior retros yet for <repo>` and proceed. Fetch at most once per ticket per run; the subagents run their own `think brief` via the skill, so don't forward yours into the dispatch.

### 2a — Product, then spike (parallel across the wave)

For each ticket in the wave, follow the lane's **L1 (Product, then spike)**, driving
the tickets as concurrent subagents across the wave. The lane defines the
return-marker interpretations; carry each ticket's spike outcome (auto-proceed `S/H`,
or paused-for-review) into the plan gate.

### 2b — PLAN GATE (batched per wave)

This is the lane's **GATE-POINT 1**, batched across the wave. Once every ticket in the wave has a plan, present them **together**:

- For each: ticket, one-line approach, scope/confidence rating, and any open questions.
- Resolve taste-level questions yourself and say so. Surface only roadmap/architectural questions for the user.
- Auto-rated S/H plans with no open questions: list them as "auto-approved" but still let the user veto in the same turn.

Ask once: "Approve these plans? (or call out changes)". On approval, for each ticket append a `### YYYY-MM-DD — Plan approved` comment, advance `state: in-progress`, move the file to `tickets/in-progress/`.

### 2c — Implementation + review (parallel across the wave)

For each approved ticket, follow the lane's **L2 (Implementation)** as concurrent
subagents across the wave (impl + tests against the worktree + `stamp review`, stopping
before merge). The lane defines the return-marker interpretations and the
3-attempt re-dispatch rule. Surface any architectural surprise in a diff.

### 2d — MERGE GATE (batched per wave)

This is the lane's **GATE-POINT 2**, batched across the wave. Once every ticket in the wave is GREEN (stamp review passed), present the ready-to-merge set **together**: ticket, one-paragraph summary, target branch, review status. Ask once: "Approve merges for this wave?"

On approval, for each ticket dispatch a final **merge subagent** (core subroutine, but the instruction is: run `stamp merge` + the stamp push path per the skill's Phase 5, then archive). After each lands on `origin/main`, notify immediately: `🔔 AGT-XXX merged to <repo> as <sha>` + one sentence on what it did. If a stamp-merge succeeds but the GitHub mirror push is rejected, **SURFACE — never auto-reconcile** divergence.

### 2e — User-action tickets

When a wave contains a user-action ticket: stop driving it, surface (title, concrete copy-pasteable steps, why it blocks), and wait until the user archives it or says "done, move on." Do not advance dependents until it clears.

## Phase 3 — Post-completion

When every active ticket is archived:

- Print a summary: tickets shipped (with SHAs), waves run, anything noteworthy.
- Offer to bump the project's `status:` to `shipped` in `<project>/README.md` if all active tickets are archived and no more work is signalled.
- Ask if any follow-up tickets surfaced during the run that should be filed (`oteam ticket new`).

Then stop. Don't auto-chain into another project.

## Output discipline

- One status update per state transition / per gate. Don't narrate every Bash call or subagent dispatch.
- Notify immediately on each merge to `origin/main` (single line).
- When surfacing an exception: name the ticket, name the issue, propose resolution paths, ask one question. No walls.
- Terse, technical, no marketing.

## Explicitly NOT your job

- Spawning `claude` / `claude -p` / the Agent SDK for any role work — subagents only (Hard rule 1).
- Filing tickets unsolicited (use `oteam ticket new` only for a concrete, unrelated bug found mid-run).
- Reconciling stamp/GitHub divergence — surface, never auto-merge or force-push.
- Rewriting design docs mid-run — surface and wait.
- Pushing feature branches that haven't passed stamp review — stamp is the gate.
