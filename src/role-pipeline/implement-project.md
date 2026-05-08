---
description: Drive every ticket in a vault project through the role-pipeline to done with minimal human intervention. Argument is a project id (e.g. `think-cli-v2`). Surface only architectural surprises, alarming findings, or user-action gates.
argument-hint: <project-id>
---

You are running an **autonomous-orchestration loop** against a single project in the vault. The user invoked `/implement-project <project-id>` because they want every active ticket in that project driven through the role-pipeline (Product → Engineering spike → Engineering implementation → QA → archive) with as little human gating as possible. Your job is to be the orchestrator that decides what to fire next, watches results, makes taste-level calls, and surfaces only what truly needs the human.

**Argument**: `$ARGUMENTS` — a single project id matching a folder under `<vault>/projects/<id>/` (e.g. `think-cli-v2`). The user's vault path comes from the active oteam config; you do not need to resolve it manually.

## Hard rules — read first

1. **Stop conditions are tight. Everything else is yours.** Surface to the human only on:
   - **Architectural decisions surfaced by unknown findings during build** — implementation reveals something that meaningfully changes the design (e.g. "the API doesn't actually support what we assumed").
   - **Something so off or confusing it's alarming.** Trust the gut. Divergent histories, unexplained CI failures, missing remotes, weird auth states — surface them.
   - **User-action gates** — tickets where the work is for the operator (e.g. migrate a Railway deployment, configure GH branch protection, sign a credential). You can't proxy these. Surface and wait.
   - **Spike-time questions that require the user's roadmap or values** — not "default 100 vs 1000," but "single-tenant vs multi-tenant" if the design doc didn't already decide.

   Do NOT stop for: file naming, test fixture shape, comment voice, choosing between equally-good library options, small refactors, ordering of independent sub-steps. Exercise judgment.

2. **Push to main is self-authorized when stamp's three reviewers approve.** Do not ping the user before pushing. The stamp gate is the approval mechanism. After every push to `origin/main`, immediately notify the user with a single-line update: `🔔 AGT-XXX pushed to <repo> as <sha>` plus a one-sentence summary of what the work did.

3. **Never push to GitHub directly from an agent worktree.** Work goes through stamp; stamp mirrors to GitHub. If a worktree somehow ends up with a github remote and an agent pushes there, the stamp server's view of main and GitHub's view diverge, and reconciliation is painful (cherry-pick + re-stamp + force-push). Insist on stamp-only push paths.

4. **Background long runs, inline short ones.**
   - **Inline:** Product passes, QA passes, anything < ~3 minutes.
   - **Background** (`run_in_background: true` on the Bash tool): Engineering spikes, implementations, anything that involves real LLM thinking + code edits. The user's session stays free; you get a notification when the task completes.

5. **Sequential by default; parallel only when truly independent AND no shared push surface.** Two parallel implementations that both push to main create the parallelization race that bit us during the AGT-025/026 reconciliation. Only run in parallel when (a) the tickets touch disjoint files and (b) they won't both land on main in the same minute. When in doubt, sequential.

6. **3-attempt cap on any failing operation.** Three failures → STOP and surface the error.

## Phase 0 — Pre-flight

Resolve the project. Run:

```sh
oteam project show <project-id> --tickets
```

If that errors, STOP — print `🛑 BLOCKED — project <id> not found in vault` and surface the candidates from `oteam project list`.

Read the project README and every sibling design doc:

```sh
PROJECT_DIR="$(oteam project show <project-id> | grep '^  readme:' | awk '{print $2}' | xargs dirname)"
cat "$PROJECT_DIR/README.md"
ls "$PROJECT_DIR/"
# read each sibling .md as needed for context
```

Build the dependency graph from ticket comments (each ticket usually names "Sequencing: blocked by AGT-XXX" or "depends on AGT-YYY"). Identify:

- Active tickets (state ≠ done): the work to do.
- Done tickets: assume their content is in main.
- User-action tickets (the kind where engineering can't proceed without the operator doing something offline): mark these as gates.
- Deferred / parking-lot tickets (their own comment usually says so): exclude from the chain unless the user says otherwise.

## Phase 1 — Confirm the chain with the user

Print a short plan to the user (no walls of text):

- The active ticket list, in proposed execution order.
- Sequencing notes (which depend on which; which can run in parallel; which are user-gates).
- Anything explicitly excluded (deferred tickets) and why.

Ask one question: "Run this chain with the standard autonomous-orchestration rules? Or override anything?"

If the user says go (or equivalent), proceed. If they push back on the plan, adjust and re-confirm. Do not start firing without explicit go-ahead on the chain shape.

## Phase 2 — Drive each ticket

For each non-user-gate ticket, in dependency order:

### 2.0 — Brief on prior retros for this ticket's repo

**Gated on `repo:` being non-empty.** Read the ticket's `repo:` frontmatter field. If it is empty or absent, skip this step silently — vault-internal tickets have no cortex to brief from.

Derive the cortex name from the `repo:` value using the **same rule pinned in AGT-173/174**: take the path component after the slash, lowercased. Examples: `OpenThinkAi/open-team` → `open-team`, `Anglepoint-Engineering/ui-host` → `ui-host`. The cortex name is sourced from validated frontmatter, so it is safe as a literal in shell.

Run `think brief` and capture stdout. **Do not gate on exit code or empty output** — every failure mode (missing binary, cortex not found, non-zero exit, empty cortex) is non-fatal; the orchestrator proceeds without the brief:

```sh
think brief --cortex <derived-cortex-name> 2>&1 || true
```

Treat the captured output as a clearly-labelled background section in your working context: `## Prior context for ticket AGT-XXX (<repo>)`. It is background, not actionable directives — lessons to weigh when deciding how to drive this ticket, not a re-litigation of its spike. If `think` is missing, exits non-zero, or the cortex has no promoted retros yet, note `no prior retros yet for <repo>` and proceed normally.

**Fetch at most once per ticket per orchestrator run.** This step runs here at the 2.0 entry point; do not re-fetch in 2b, 2c, or 2d for the same ticket. The spawned `oteam assign` agent runs its own `think brief` via AGT-174 — do not forward this orchestrator's brief output into the spawn; that would double-fetch.

### 2a. Product pass (inline, short)

```sh
oteam assign --inline AGT-XXX
```

If Product returns `✅ DONE — Refined; ready for Engineering spike`, proceed. If `⏸️ PAUSED — Ticket needs answers before Product can refine`, surface to the user — Product can't proceed without their input.

### 2b. Engineering spike (background)

```sh
oteam assign --inline AGT-XXX  # with run_in_background: true on the Bash tool
```

When the background task notification arrives, read the task's output file. Three possible outcomes:

- **Spike auto-proceeded to implementation (S/H rated, no plan review needed):** continue to 2d.
- **Spike paused for plan review (M+ scope or has gaps):** read the spike. Decide on each open question:
  - If it's taste-level (file names, fixture shape, default values, sequencing of independent substeps): make the call yourself. Append a `### YYYY-MM-DD — Plan approved` comment to the ticket noting your decisions and the rationale. Advance the ticket frontmatter to `state: in-progress`, move the file to `tickets/in-progress/`, then re-fire `oteam assign --inline AGT-XXX` (background).
  - If it's an architectural decision the design doc doesn't answer: surface to the user. Quote the spike's question. Wait.
- **Spike failed (`STOP:` error of some kind):** surface to the user with the error.

### 2c. Implementation (background)

The agent does the work, runs stamp review, stamp merge, push. When the background task notification arrives:

- Read the task output.
- If it pushed to `origin/main`: notify the user immediately with a one-line `🔔 AGT-XXX pushed to <repo> as <sha>` plus a one-sentence summary.
- If it stamp-merged but the mirror push to GitHub was rejected (the AGT-026 case): SURFACE — divergence is alarming, never auto-reconcile.
- If stamp gate stayed closed (review never converged): surface the last review's `changes_requested` reasoning to the user.
- If implementation completed but didn't push (no main push needed, e.g. test-only changes that the agent decided to leave on a branch): note in the user-facing summary.

### 2d. QA pass (inline, short)

```sh
oteam assign --inline AGT-XXX
```

QA verifies the AC against the merged code and archives the ticket. If QA returns `✅ DONE — QA approved; archived`, mark the ticket complete in your internal chain and move to the next ticket. If QA bounces back with `changes_requested`, fire the engineering implementation again (background) with the QA feedback noted in a comment.

### 2e. User-action tickets

When the chain reaches a user-action ticket:

- Stop driving.
- Surface the ticket to the user with: title, what they need to do (concrete steps, ideally copy-pasteable commands), and why it's blocking.
- Wait. Do not proceed past it until the user signs off (either by archiving it or telling you "done, move on").

## Phase 3 — Post-completion

When every active ticket in the chain is archived:

- Print a summary: tickets shipped (with SHAs), elapsed time, anything noteworthy that happened during the run.
- Offer to bump the project's `status:` frontmatter to `shipped` in `<project>/README.md`, if every active ticket is archived and the user hasn't otherwise indicated more work is incoming.
- Ask if there are any follow-up tickets to file (issues that surfaced during the run that didn't get filed yet).

Then stop. Do not chain into the next project automatically; the user picks what to do next.

## Output discipline

- One status update per state transition. Don't narrate every Bash call.
- Always notify on push to `origin/main` (single line, immediate).
- When surfacing a stop condition: name the ticket, name the issue, propose the resolution paths, ask one question. No walls of text.
- Use the user's preferred voice from feedback memory: terse, technical, no marketing.

## Things that are explicitly NOT your job

- Filing new tickets unsolicited (use `oteam ticket new` if a clear bug surfaces during the run, but only file when the issue is concrete and unrelated to the chain you're driving — don't bloat the chain).
- Reconciling stamp/GitHub divergence — surface immediately, do not auto-merge or auto-force-push.
- Rewriting design docs mid-run — if the design doc is wrong, surface that and wait.
- Pushing to feature branches that haven't been stamp-reviewed — stamp is the gate.
