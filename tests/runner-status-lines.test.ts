import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inlineStartLine,
  kittySpawnLine,
  sentinelPathForTicket,
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

  it("kittySpawnLine appends the sentinel path when one is passed (AGT-049)", () => {
    const sentinel = sentinelPathForTicket("AGT-013");
    const line = kittySpawnLine(
      "AGT-013",
      "/tmp/open-team-issues/agt-013/repo",
      sentinel,
    );
    assert.equal(
      line,
      "oteam assign: spawned kitty window for AGT-013 (worktree at /tmp/open-team-issues/agt-013/repo) (sentinel /tmp/oteam-sentinel-agt-013.exit)",
    );
  });

  it("kittySpawnLine sentinel appears even when there's no worktree", () => {
    const line = kittySpawnLine(
      "AGT-013",
      null,
      sentinelPathForTicket("AGT-013"),
    );
    assert.equal(
      line,
      "oteam assign: spawned kitty window for AGT-013 (sentinel /tmp/oteam-sentinel-agt-013.exit)",
    );
  });

  it("sentinelPathForTicket lowercases the id and uses the .exit suffix", () => {
    assert.equal(
      sentinelPathForTicket("AGT-049"),
      "/tmp/oteam-sentinel-agt-049.exit",
    );
  });

  it("inlineStartLine names the ticket and signals start", () => {
    assert.equal(
      inlineStartLine("AGT-013"),
      "oteam assign: running inline for AGT-013; agent starting…",
    );
  });
});
