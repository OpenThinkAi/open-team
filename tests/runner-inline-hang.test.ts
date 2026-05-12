import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { killGroupAfterGrace } from "../src/role-pipeline/runner.ts";
import { lastAssistantText } from "../src/lib/claude-session.ts";

// ---------------------------------------------------------------------------
// killGroupAfterGrace
// ---------------------------------------------------------------------------

describe("killGroupAfterGrace: no survivors", () => {
  it("returns [] immediately when the process group is already empty", async () => {
    const killed: number[] = [];
    const result = await killGroupAfterGrace(
      99999,
      5_000,
      {
        listFn: () => [],
        killFn: (pid) => killed.push(pid),
        pollMs: 10,
      },
    );
    assert.deepEqual(result, []);
    assert.deepEqual(killed, []);
  });

  it("returns [] when processes clear before the grace period expires", async () => {
    let calls = 0;
    const result = await killGroupAfterGrace(
      99999,
      5_000,
      {
        // Return pids on the first poll, empty on the second — simulates
        // the group clearing on its own within the grace window.
        listFn: () => (++calls <= 1 ? [42001] : []),
        pollMs: 10,
      },
    );
    assert.deepEqual(result, []);
  });
});

describe("killGroupAfterGrace: survivors killed after grace", () => {
  it("kills survivors and returns their PIDs when grace expires with pids still alive", async () => {
    const fakePids = [42100, 42101];
    const killed: number[] = [];
    const result = await killGroupAfterGrace(
      99999,
      50,
      {
        // Always return the same pids (they never exit on their own)
        listFn: () => [...fakePids],
        killFn: (pid) => killed.push(pid),
        pollMs: 200,
      },
    );
    assert.deepEqual(result, fakePids);
    assert.deepEqual(killed, fakePids);
  });
});

// ---------------------------------------------------------------------------
// lastAssistantText (session JSONL summary recovery — AC 3)
// ---------------------------------------------------------------------------

function writeFixtureJsonl(name: string, lines: object[]): string {
  const dir = join(tmpdir(), "oteam-test-sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return path;
}

describe("lastAssistantText", () => {
  it("returns null for a nonexistent file", () => {
    assert.equal(
      lastAssistantText("/tmp/oteam-test-sessions/no-such-file-xyz.jsonl"),
      null,
    );
  });

  it("returns null for a file with no assistant messages", () => {
    const path = writeFixtureJsonl("no-assistant", [
      { type: "user", message: { content: "go" } },
    ]);
    assert.equal(lastAssistantText(path), null);
  });

  it("returns the last assistant text from a session file", () => {
    const path = writeFixtureJsonl("has-assistant", [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "thinking…" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "✅ DONE — refined; ready for Engineering spike" }],
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      },
    ]);
    assert.equal(
      lastAssistantText(path),
      "✅ DONE — refined; ready for Engineering spike",
    );
  });

  it("tolerates blank lines and malformed JSON in the session file", () => {
    const dir = join(tmpdir(), "oteam-test-sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "noisy.jsonl");
    const lines = [
      "",
      "not-json",
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "⏸️ PAUSED — needs review" }] },
      }),
      "",
    ].join("\n");
    writeFileSync(path, lines, "utf8");
    assert.equal(lastAssistantText(path), "⏸️ PAUSED — needs review");
  });

  it("returns null for an empty session file", () => {
    const dir = join(tmpdir(), "oteam-test-sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "", "utf8");
    assert.equal(lastAssistantText(path), null);
  });
});
