import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeProjectDir,
  findSessionFile,
  parseSessionJsonl,
} from "../src/lib/claude-session.ts";

describe("claude-session: encodeProjectDir", () => {
  it("replaces every / with - (Claude Code's per-project directory rule)", () => {
    assert.equal(
      encodeProjectDir("/private/tmp/open-team-issues/agt-108/repo"),
      "-private-tmp-open-team-issues-agt-108-repo",
    );
  });
});

describe("claude-session: findSessionFile", () => {
  it("composes the per-session JSONL path Claude Code writes to", () => {
    const path = findSessionFile(
      "/Users/x/.claude",
      "/tmp/x",
      "abc-123",
    );
    assert.equal(path, "/Users/x/.claude/projects/-tmp-x/abc-123.jsonl");
  });
});

describe("claude-session: parseSessionJsonl", () => {
  it("sums usage tokens across assistant messages", () => {
    const fixture = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "thinking..." }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 4000,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "✅ DONE — refined" }],
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 4100,
          },
        },
      }),
    ].join("\n");

    const parsed = parseSessionJsonl(fixture);
    assert.equal(parsed.tokens.input, 120);
    assert.equal(parsed.tokens.output, 55);
    assert.equal(parsed.tokens["cache-write"], 10);
    assert.equal(parsed.tokens["cache-read"], 8100);
    assert.equal(parsed.outcome, "done");
  });

  it("omits absent token fields rather than zero-filling (AC #3)", () => {
    const fixture = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "..." }],
        usage: { input_tokens: 5 },
      },
    });
    const parsed = parseSessionJsonl(fixture);
    assert.equal(parsed.tokens.input, 5);
    assert.equal("output" in parsed.tokens, false);
    assert.equal("cache-read" in parsed.tokens, false);
    assert.equal("cache-write" in parsed.tokens, false);
  });

  it("classifies outcome from the final assistant message's STOP marker", () => {
    const cases = [
      { marker: "✅ DONE — shipped", expected: "done" as const },
      { marker: "⏸️ PAUSED — needs review", expected: "paused" as const },
      { marker: "🛑 BLOCKED — stamp red", expected: "failed" as const },
    ];
    for (const c of cases) {
      const fixture = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: c.marker }] },
      });
      const parsed = parseSessionJsonl(fixture);
      assert.equal(parsed.outcome, c.expected, c.marker);
    }
  });

  it("returns null outcome when no STOP banner is present", () => {
    const fixture = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "still thinking" }] },
    });
    assert.equal(parseSessionJsonl(fixture).outcome, null);
  });

  it("tolerates blank lines and malformed JSONL noise without throwing", () => {
    const fixture = [
      "",
      "not-valid-json",
      JSON.stringify({ type: "assistant", message: { content: "✅ DONE — refined", usage: { input_tokens: 1 } } }),
      "",
    ].join("\n");
    const parsed = parseSessionJsonl(fixture);
    assert.equal(parsed.tokens.input, 1);
    assert.equal(parsed.outcome, "done");
  });
});
