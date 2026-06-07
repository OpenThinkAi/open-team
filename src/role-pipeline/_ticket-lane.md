---
description: Shared per-ticket lane — the role-advancement mechanics + two gate-points used by /implement-project and /dispatch. Not a user-facing command; orchestrator skills read this and apply it per ticket.
---

# Shared ticket lane (internal)

This is **not a slash command you run directly.** It is the per-ticket engine that
`/implement-project` (many tickets, in waves) and `/dispatch` (one issue) both
follow, so the role mechanics live in exactly one place.

**Split of responsibility:**

- **This file owns:** the core subroutine (drive one role), the single-ticket role
  sequence, the two gate-*points*, and the return-marker interpretations.
- **The caller owns:** parallelism (one ticket vs a wave of concurrent subagents),
  **gate batching/presentation** (per-ticket for `/dispatch`; batched-per-wave for
  `/implement-project`), and the surrounding context (a project's dep-graph, or one
  ingested issue).

The caller's Hard Rules apply throughout — especially: **all role work runs as Task
subagents you dispatch** (never `claude` / `claude -p` / Agent SDK), **never push to
GitHub directly** (stamp is the gate; stamp mirrors), **3-attempt cap** on any
failing op, **tests run against the prepared clean worktree** (never the caller's
live working dir), and **`stamp review` is the one gated review call — it
runs on the **local** model by default (unmetered) and escalates to the
metered Anthropic backend only for large/cross-cutting diffs** (the backend
is chosen per-run by diff size via `STAMP_REVIEWER_BACKEND`; see
assign-ticket §5·0). Because `/refine` errs small, most tickets review
locally.

## The core subroutine — "drive one role for a ticket"

Every role advance uses this three-step subroutine.

1. **Prepare the workspace** (Bash, foreground — fast and deterministic):

   ```sh
   oteam assign AGT-XXX
   ```

   Parse the fenced ```` ```oteam:assignment ```` JSON block from stdout. You need
   `workspacePath`, `slashCommand`, `model`, `phase`, `systemPromptFile`, `envFiles`,
   and `telemetry`. If `oteam assign` exits non-zero or stderr shows a claim/clone
   error (already-claimed, issue-closed, clone-uri refused, stamp-enforce mismatch),
   that's an **exception** — surface it; do not dispatch.

2. **Dispatch a Task subagent** into the prepared worktree, **with
   `run_in_background: true`**. Use `subagent_type: general-purpose` and set the
   subagent's `model` to the block's `model`.

   **Why background, not foreground.** A role phase can run for many minutes — a
   full test suite, an iterating `stamp review`, a long implementation. A
   *foreground* dispatch blocks your turn for that entire phase, which freezes the
   user's interactive session start-to-finish (they can't type, can't kick off
   anything else). The point of the subagent here is **context isolation** — the
   phase's churn stays out of your context — **not** parallelism: a single
   ticket's pipeline is a sequential dependency chain, so there is no other
   conductor work to interleave anyway. Backgrounding gives up nothing and returns
   the session to the user: with `run_in_background: true` your turn ends the
   moment the subagent is launched, and the harness **re-invokes you with the
   subagent's final message when the phase completes**. (A phase running longer
   than ~5 min means the re-invocation reads your context past the prompt-cache
   TTL — a minor cost any long phase already pays; the session-responsiveness win
   dominates. Do **not** poll the background task with a timer — the completion
   re-invokes you automatically.)

   **Exception — the merge subagent (GATE-POINT 2) runs in the FOREGROUND.** The
   "backgrounding gives up nothing" reasoning holds for spike/impl (a single
   ticket's pipeline is sequential), but it breaks at the merge step. `stamp merge`
   is a long-lived child that itself spawns the required-check suite (e.g. a full
   vitest fork-pool) and any smoke container. If a *background* merge subagent
   returns early, flakes, or is retried under the 3-attempt cap, that `stamp merge`
   child is **orphaned, not reaped** — and the retry then launches a *second*
   `stamp merge` against the **same per-ticket worktree**, so two merges
   `checkout`+merge+reset on top of each other and corrupt the base (observed:
   four merge→reset cycles on one worktree, `origin/main` never advanced). Run the
   merge subagent **foreground** so your turn owns the merge child's full lifecycle
   and a retry can never overlap a still-running merge. See GATE-POINT 2 for the
   reap-before-retry rule.

   Prompt template:

   > Working directory: `<workspacePath>`. `cd` there first; never read or write
   > outside it.
   > Read the role-pipeline skill body and follow it for this ticket. **Subagents do
   > not expand slash commands**, so read the body file directly —
   > `$CLAUDE_CONFIG_DIR/commands/assign-ticket.md` if that env var is set, otherwise
   > `~/.claude/commands/assign-ticket.md`. The skill's `$ARGUMENTS` (the ticket
   > file) is the path inside `<slashCommand>` — i.e. `<ticketPath>`.
   > {If `systemPromptFile` is set:} First read `<systemPromptFile>` for extra
   > context (project README / heuristic hints).
   > {If `envFiles` is non-empty:} Before any build/install/test, source the env
   > files (guard each — some may not exist yet):
   > `set -a; for f in <envFiles>; do [ -r "$f" ] && . "$f"; done; set +a`.
   > Advance the ticket **exactly one role**, then STOP at the role-handoff boundary
   > per the skill's own rules. **Do not run `stamp merge` or push anything** — if
   > your role reaches the merge step, run `stamp review` only, then STOP and report
   > the review result as "ready to merge" (GREEN) or the blocking reasons (RED).
   > Return verbatim: (a) the STOP/PAUSED/BLOCKED marker line, (b) the comment you
   > appended to the ticket, and (c) role-specific payload — for a **spike**, the
   > plan and its S/M/L + H/M/L self-rating; for **implementation**, a one-paragraph
   > diff summary and the stamp review status.

3. **On completion (the harness re-invokes you with the result), record
   telemetry** (best-effort, foreground; never gate on it):

   ```sh
   oteam telemetry record --ticket AGT-XXX --phase <phase> --model <model> --session <telemetry.sessionId> --started-at <telemetry.startedAt> --exit-code 0 >/dev/null 2>&1 || true
   ```

   Skip when the block's `telemetry` is `null`.

Then branch on the subagent's returned marker (the STOP/PAUSED/BLOCKED line +
payload it returned). Each role advance is therefore its own turn: dispatch
(background) → yield → re-invoked on completion → telemetry + branch → dispatch
the next role.

## The single-ticket sequence

Run these in order for a ticket. The caller decides how many tickets are in flight
and how the two gate-points are presented.

### L1 — Product, then spike

Run the core subroutine for the **Product** role, then the **spike** role. Interpret:

- Product `✅ DONE — Refined`: advance to the spike.
- Product `⏸️ PAUSED — needs answers`: surface to the caller (Product can't proceed
  without input); the caller drops/holds this ticket until answered.
- Spike auto-proceeded (**S/H** rated): hold at "plan ready, no review needed" —
  caller carries it into the plan gate as **auto-approvable**.
- Spike `⏸️ PAUSED — Spike ready for plan review` (anything bigger than S/H): caller
  carries the plan into the plan gate.
- Any `STOP:` / `🛑 BLOCKED`: surface with the error.

### GATE-POINT 1 — PLAN GATE

**Caller-owned presentation.** The ticket must not advance to implementation until
its plan is approved. For each ticket present: one-line approach, scope/confidence
rating, open questions. Auto-rated **S/H** plans with no open questions may be listed
as auto-approved (still vetoable). On approval: append a
`### YYYY-MM-DD — Plan approved` comment, set `state: in-progress`, move the file to
`tickets/in-progress/`.

### L2 — Implementation

Run the core subroutine for the **implementation** role (subagent implements, tests
**against its prepared worktree**, runs `stamp review`, but **stops before
`stamp merge`**). Interpret:

- Implementation `⏸️ PAUSED — Implementation complete; stamp review GREEN, ready to
  merge`: carry into the merge gate. (Under an orchestrator that stops before merge,
  the implementation deliberately did **not** close the issue or archive — the merge
  step does that, via the skill's Phase 5 close-out.)
- Stamp review RED after the skill's review-round rule: surface the blocking reasons.
- Any architectural surprise in the diff: surface (exception).

### GATE-POINT 2 — MERGE GATE

**Caller-owned presentation.** Present the ready-to-merge ticket(s): one-paragraph
summary, target branch, review status. After approval, dispatch a final **merge
subagent** (core subroutine, but **foreground — `run_in_background: false`**, per the
merge-phase exception in the core subroutine; the instruction is: run `stamp merge`
+ the stamp push path per the skill's Phase 5, then **`oteam archive <id>`** (never raw `mv` — `oteam doctor` will flag bypasses)). After it lands on
`origin/main`, notify immediately: `🔔 AGT-XXX merged to <repo> as <sha>` + one
sentence on what it did. If a stamp-merge succeeds but the GitHub mirror push is
rejected, **SURFACE — never auto-reconcile** divergence.

**Merge-step failure handling (do not improvise).** `stamp merge` may exit non-zero
and **withhold the push** when a required_check goes red — the merge commit is built
locally but `main` is *not* advanced and *nothing* is pushed. This is a normal,
expected outcome (e.g. a load-flaked test suite), not a special case to route around:

- The merge subagent must **branch on `stamp merge`'s exit code** (§5a/§5c do this).
  On a withheld push it STOPs with `🛑 BLOCKED — stamp merge withheld: required_check
  '<name>' failed`, which counts against the **3-attempt cap**.
- **Never poll `origin` for a merge SHA `stamp merge` did not push.** A withheld push
  means that SHA will never appear; an `until`/unbounded `git ls-remote` wait hangs
  forever. Any wait in the merge path must be **bounded** (timeout + the attempt cap).
- **Reap before retry.** Because the merge subagent is foreground, its `stamp merge`
  child has already exited by the time it returns — but before re-dispatching a retry,
  the caller must confirm no `stamp merge` (or its test/smoke children) for this
  ticket's worktree is still alive. Two `stamp merge` runs against one worktree are
  never allowed. If a prior orphan is found, terminate it before retrying.
- A `🛑 BLOCKED — stamp merge withheld` marker is **retryable** within the 3-attempt
  cap (the trigger is usually a load-flaked check), but each retry is a **fresh,
  serialized** foreground merge — never a concurrent re-run.

> **Non-stamp repos:** if the ticket's repo is not stamp-gated, the merge subagent
> opens a traditional GitHub PR instead of `stamp merge`/push, and the ticket is
> archived as "PR open" pending human merge. (The merge gate still applies.)
