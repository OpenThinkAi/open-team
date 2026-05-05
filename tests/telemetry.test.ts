import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTelemetryEnabled } from "../src/lib/config.ts";
import {
  readRuns,
  recordPhase,
  runsPath,
  summarize,
  tail,
  telemetryDir,
} from "../src/lib/telemetry.ts";
import { encodeProjectDir } from "../src/lib/claude-session.ts";

let savedHome: string | undefined;
let fakeHome = "";
let fakeClaudeConfig = "";
let savedClaudeConfig: string | undefined;
let savedTelemetryDir: string | undefined;

beforeEach(() => {
  // Sandbox $HOME so we never touch the real ~/.open-team/ during tests
  // (AGT-106 explicitly called this out as a regression risk).
  savedHome = process.env.HOME;
  savedClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  savedTelemetryDir = process.env.OTEAM_TELEMETRY_DIR;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "oteam-telemetry-home-")));
  process.env.HOME = fakeHome;
  delete process.env.OTEAM_TELEMETRY_DIR;
  fakeClaudeConfig = join(fakeHome, ".claude");
  process.env.CLAUDE_CONFIG_DIR = fakeClaudeConfig;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfig;
  if (savedTelemetryDir === undefined) delete process.env.OTEAM_TELEMETRY_DIR;
  else process.env.OTEAM_TELEMETRY_DIR = savedTelemetryDir;
  rmSync(fakeHome, { recursive: true, force: true });
});

function writeSyntheticSession(
  cwd: string,
  sessionId: string,
  body: string,
): void {
  const dir = join(fakeClaudeConfig, "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), body, "utf8");
}

describe("telemetry: recordPhase produces a valid runs.jsonl line (AC #8a)", () => {
  it("appends one line with token sums + outcome from the synthetic session", () => {
    const cwd = join(fakeHome, "workspace");
    mkdirSync(cwd, { recursive: true });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    writeSyntheticSession(
      cwd,
      sessionId,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "thinking..." }],
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 9000,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "✅ DONE — implementation complete" }],
            usage: {
              input_tokens: 30,
              output_tokens: 20,
              cache_read_input_tokens: 9100,
            },
          },
        }),
      ].join("\n"),
    );

    recordPhase({
      ticket: "AGT-108",
      phase: "implementation",
      model: "claude-sonnet-4-6",
      sessionId,
      startedAt: "2026-05-04T10:00:00.000Z",
      endedAt: "2026-05-04T10:05:42.000Z",
      exitCode: 0,
      cwd,
    });

    const runs = readRuns();
    assert.equal(runs.length, 1);
    const r = runs[0]!;
    assert.equal(r.ticket, "AGT-108");
    assert.equal(r.phase, "implementation");
    assert.equal(r.model, "claude-sonnet-4-6");
    assert.equal(r["started-at"], "2026-05-04T10:00:00.000Z");
    assert.equal(r["ended-at"], "2026-05-04T10:05:42.000Z");
    assert.equal(r["wall-clock-ms"], 5 * 60 * 1000 + 42 * 1000);
    assert.equal(r.outcome, "done");
    assert.equal(r.tokens.input, 230);
    assert.equal(r.tokens.output, 120);
    assert.equal(r.tokens["cache-write"], 50);
    assert.equal(r.tokens["cache-read"], 18100);
  });

  it("classifies non-zero exit code as failed regardless of marker", () => {
    const cwd = join(fakeHome, "workspace2");
    mkdirSync(cwd, { recursive: true });
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeSyntheticSession(
      cwd,
      sessionId,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "✅ DONE" }] },
      }),
    );
    recordPhase({
      ticket: "AGT-108",
      phase: "spike",
      model: "claude-opus-4-7",
      sessionId,
      startedAt: "2026-05-04T10:00:00.000Z",
      endedAt: "2026-05-04T10:00:01.000Z",
      exitCode: 130, // user closed kitty mid-session
      cwd,
    });
    const runs = readRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.outcome, "failed");
  });

  it("records 'unknown' outcome when no STOP banner and exit 0", () => {
    const cwd = join(fakeHome, "workspace3");
    mkdirSync(cwd, { recursive: true });
    const sessionId = "ffffffff-0000-1111-2222-333333333333";
    writeSyntheticSession(
      cwd,
      sessionId,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "still thinking" }] },
      }),
    );
    recordPhase({
      ticket: "AGT-108",
      phase: "qa",
      model: "claude-sonnet-4-6",
      sessionId,
      startedAt: "2026-05-04T10:00:00.000Z",
      endedAt: "2026-05-04T10:00:01.000Z",
      exitCode: 0,
      cwd,
    });
    const runs = readRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.outcome, "unknown");
  });

  it("records empty tokens when the session JSONL is missing (AC #3)", () => {
    const cwd = join(fakeHome, "workspace4");
    mkdirSync(cwd, { recursive: true });
    recordPhase({
      ticket: "AGT-108",
      phase: "product",
      model: "claude-sonnet-4-6",
      sessionId: "99999999-9999-9999-9999-999999999999",
      startedAt: "2026-05-04T10:00:00.000Z",
      endedAt: "2026-05-04T10:00:01.000Z",
      exitCode: 0,
      cwd,
    });
    const runs = readRuns();
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!.tokens, {});
    assert.equal(runs[0]!.outcome, "unknown");
  });
});

describe("telemetry: write failures are best-effort (AC #4 + AC #8b)", () => {
  it("does not throw when the telemetry dir is read-only", () => {
    const dir = telemetryDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500); // r-x, no write
    try {
      // No throw — captured to stderr instead.
      assert.doesNotThrow(() =>
        recordPhase({
          ticket: "AGT-108",
          phase: "spike",
          model: "claude-opus-4-7",
          sessionId: "abc-1",
          startedAt: "2026-05-04T10:00:00.000Z",
          endedAt: "2026-05-04T10:00:01.000Z",
          exitCode: 0,
          cwd: fakeHome,
        }),
      );
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("telemetry: summary aggregations are correct (AC #8c)", () => {
  function seedRuns(lines: object[]): void {
    mkdirSync(telemetryDir(), { recursive: true });
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(runsPath(), body, "utf8");
  }

  it("buckets by phase × model and reports count + means", () => {
    seedRuns([
      {
        ticket: "AGT-1",
        phase: "implementation",
        model: "claude-sonnet-4-6",
        "started-at": "2026-05-01T10:00:00Z",
        "ended-at": "2026-05-01T10:02:00Z",
        "wall-clock-ms": 120000,
        tokens: { input: 100, output: 50, "cache-read": 4000 },
        outcome: "done",
      },
      {
        ticket: "AGT-2",
        phase: "implementation",
        model: "claude-sonnet-4-6",
        "started-at": "2026-05-02T10:00:00Z",
        "ended-at": "2026-05-02T10:04:00Z",
        "wall-clock-ms": 240000,
        tokens: { input: 200, output: 100, "cache-read": 8000 },
        outcome: "paused",
      },
      {
        ticket: "AGT-3",
        phase: "spike",
        model: "claude-opus-4-7",
        "started-at": "2026-05-02T10:00:00Z",
        "ended-at": "2026-05-02T10:05:00Z",
        "wall-clock-ms": 300000,
        tokens: { input: 500, output: 200 },
        outcome: "done",
      },
    ]);
    const rows = summarize(readRuns());
    assert.equal(rows.length, 2);
    const impl = rows.find((r) => r.phase === "implementation")!;
    assert.equal(impl.count, 2);
    assert.equal(impl.meanWallClockMs, 180000);
    assert.equal(impl.meanTokens.input, 150);
    assert.equal(impl.meanTokens.output, 75);
    assert.equal(impl.meanTokens["cache-read"], 6000);
    assert.equal("cache-write" in impl.meanTokens, false);

    const spike = rows.find((r) => r.phase === "spike")!;
    assert.equal(spike.count, 1);
    assert.equal(spike.model, "claude-opus-4-7");
  });

  it("filters by phase, model, and days-window", () => {
    const today = Date.now();
    const twoDaysAgo = new Date(today - 2 * 86400_000).toISOString();
    const tenDaysAgo = new Date(today - 10 * 86400_000).toISOString();
    seedRuns([
      {
        ticket: "AGT-1",
        phase: "qa",
        model: "claude-sonnet-4-6",
        "started-at": twoDaysAgo,
        "ended-at": twoDaysAgo,
        "wall-clock-ms": 1000,
        tokens: { input: 10 },
        outcome: "done",
      },
      {
        ticket: "AGT-2",
        phase: "qa",
        model: "claude-sonnet-4-6",
        "started-at": tenDaysAgo,
        "ended-at": tenDaysAgo,
        "wall-clock-ms": 1000,
        tokens: { input: 10 },
        outcome: "done",
      },
      {
        ticket: "AGT-3",
        phase: "spike",
        model: "claude-opus-4-7",
        "started-at": twoDaysAgo,
        "ended-at": twoDaysAgo,
        "wall-clock-ms": 1000,
        tokens: { input: 10 },
        outcome: "done",
      },
    ]);
    const all = readRuns();
    assert.equal(summarize(all, { days: 7 }).length, 2);
    assert.equal(summarize(all, { phase: "qa" })[0]!.count, 2);
    assert.equal(summarize(all, { model: "claude-opus-4-7" })[0]!.count, 1);
    assert.equal(summarize(all, { days: 7, phase: "qa" })[0]!.count, 1);
  });

  it("tail returns the last N lines in order", () => {
    seedRuns(
      Array.from({ length: 5 }, (_, i) => ({
        ticket: `AGT-${i}`,
        phase: "qa",
        model: "claude-sonnet-4-6",
        "started-at": "2026-05-04T10:00:00Z",
        "ended-at": "2026-05-04T10:00:01Z",
        "wall-clock-ms": 1000,
        tokens: {},
        outcome: "done",
      })),
    );
    const last = tail(2);
    assert.equal(last.length, 2);
    assert.equal(last[0]!.ticket, "AGT-3");
    assert.equal(last[1]!.ticket, "AGT-4");
  });
});

describe("telemetry: opt-out fully suppresses writes (AC #7 + AC #8d)", () => {
  it("is a no-op when telemetry.enabled is false", () => {
    setTelemetryEnabled(false);
    const cwd = join(fakeHome, "workspace");
    mkdirSync(cwd, { recursive: true });
    recordPhase({
      ticket: "AGT-108",
      phase: "implementation",
      model: "claude-sonnet-4-6",
      sessionId: "abc-1",
      startedAt: "2026-05-04T10:00:00Z",
      endedAt: "2026-05-04T10:00:01Z",
      exitCode: 0,
      cwd,
    });
    assert.equal(existsSync(runsPath()), false);
  });
});

describe("telemetry: OTEAM_TELEMETRY_DIR override (AC #6)", () => {
  it("redirects writes to the env-supplied directory", () => {
    const altDir = join(fakeHome, "elsewhere");
    process.env.OTEAM_TELEMETRY_DIR = altDir;
    try {
      const cwd = join(fakeHome, "workspace");
      mkdirSync(cwd, { recursive: true });
      recordPhase({
        ticket: "AGT-108",
        phase: "spike",
        model: "claude-opus-4-7",
        sessionId: "uuid-x",
        startedAt: "2026-05-04T10:00:00Z",
        endedAt: "2026-05-04T10:00:01Z",
        exitCode: 0,
        cwd,
      });
      const body = readFileSync(join(altDir, "runs.jsonl"), "utf8");
      assert.match(body, /"ticket":"AGT-108"/);
      // Default location should NOT have been touched.
      assert.equal(
        existsSync(join(fakeHome, ".open-team", "telemetry", "runs.jsonl")),
        false,
      );
    } finally {
      delete process.env.OTEAM_TELEMETRY_DIR;
    }
  });
});
