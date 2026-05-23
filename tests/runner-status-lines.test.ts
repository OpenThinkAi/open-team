import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assignmentBlock,
  assignmentSummary,
  resolveEnvFiles,
  type AssignmentContext,
} from "../src/role-pipeline/runner.ts";

function ctx(overrides: Partial<AssignmentContext> = {}): AssignmentContext {
  return {
    ticketId: "AGT-013",
    ticketPath: "/ws/tickets/refined/AGT-013-foo.md",
    state: "refined",
    phase: "spike",
    vaultPath: "/ws",
    workspacePath: "/tmp/open-team-issues/agt-013/repo",
    originUrl: "ssh://git@stamp.example/srv/git/foo.git",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    baseShaFile: "/tmp/open-team-issues/agt-013/base-sha",
    envFiles: [],
    model: "claude-opus-4-7",
    slashCommand: "/assign-ticket /ws/tickets/refined/AGT-013-foo.md",
    systemPromptFile: null,
    haikuDownshift: false,
    telemetry: null,
    ...overrides,
  };
}

describe("runner: assignment summary", () => {
  it("names the ticket, phase, worktree, and model", () => {
    const out = assignmentSummary(ctx());
    assert.match(out, /prepared AGT-013 \(spike phase\)/);
    assert.match(out, /worktree: \/tmp\/open-team-issues\/agt-013\/repo/);
    assert.match(out, /model:\s+claude-opus-4-7/);
    assert.match(out, /dispatch a subagent to run/);
  });

  it("omits the worktree line for workspace-only tickets", () => {
    const out = assignmentSummary(ctx({ workspacePath: null }));
    assert.doesNotMatch(out, /worktree:/);
  });

  it("falls back to state in the header when phase is null", () => {
    const out = assignmentSummary(ctx({ phase: null, state: "blocked" }));
    assert.match(out, /prepared AGT-013 \(blocked phase\)/);
  });
});

describe("runner: resolveEnvFiles", () => {
  const home = homedir();

  it("lists primary .env/.env.local + per-repo secrets file, lowercased", () => {
    assert.deepEqual(resolveEnvFiles("OpenThinkAi/open-team"), [
      join(home, "Development", "open-team", ".env"),
      join(home, "Development", "open-team", ".env.local"),
      join(home, ".open-team", "env-openthinkai-open-team"),
    ]);
  });

  it("drops path components that fail the charset guard (shell-metachar defence)", () => {
    assert.deepEqual(resolveEnvFiles("owner/re;po"), []);
  });
});

describe("runner: assignment block", () => {
  it("emits a fenced oteam:assignment block that round-trips to the context", () => {
    const c = ctx();
    const block = assignmentBlock(c);
    assert.match(block, /^```oteam:assignment\n/);
    assert.match(block, /\n```$/);
    const json = block
      .replace(/^```oteam:assignment\n/, "")
      .replace(/\n```$/, "");
    assert.deepEqual(JSON.parse(json), c);
  });
});
