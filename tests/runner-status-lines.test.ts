import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inlineStartLine,
  kittySpawnLine,
} from "../src/role-pipeline/runner.ts";

describe("runner: status lines", () => {
  it("kittySpawnLine names ticket and worktree path when one was prepared", () => {
    const line = kittySpawnLine("AGT-013", "/tmp/open-team-issues/agt-013/repo");
    assert.equal(
      line,
      "oteam assign: spawned kitty window for AGT-013 (worktree at /tmp/open-team-issues/agt-013/repo)",
    );
  });

  it("kittySpawnLine omits the worktree suffix for vault-only tickets", () => {
    const line = kittySpawnLine("AGT-013", null);
    assert.equal(line, "oteam assign: spawned kitty window for AGT-013");
  });

  it("inlineStartLine names the ticket and signals start", () => {
    assert.equal(
      inlineStartLine("AGT-013"),
      "oteam assign: running inline for AGT-013; agent starting…",
    );
  });
});
