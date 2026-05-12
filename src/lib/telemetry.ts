import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findSessionFile,
  parseSessionFile,
  type SessionOutcome,
  type TokenUsage,
} from "./claude-session.ts";
import { getTelemetryEnabled } from "./config.ts";

export type Outcome = "done" | "paused" | "failed" | "unknown";

export interface RunsLine {
  ticket: string;
  phase: string;
  model: string;
  "started-at": string;
  "ended-at": string;
  "wall-clock-ms": number;
  tokens: TokenUsage;
  outcome: Outcome;
}

export interface RecordPhaseInput {
  ticket: string;
  phase: string;
  model: string;
  sessionId: string;
  startedAt: string;
  /** Defaults to `new Date().toISOString()` at record time. */
  endedAt?: string;
  /** `claude` exit status; non-zero pins outcome to "failed". */
  exitCode: number;
  /**
   * Working directory the spawn ran in. Used to resolve the session JSONL
   * (`$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl`).
   */
  cwd: string;
}

/**
 * Resolve the telemetry directory. Order of precedence:
 *   1. `$OTEAM_TELEMETRY_DIR` (AC #6)
 *   2. `$HOME/.open-team/telemetry/`
 */
export function telemetryDir(): string {
  const override = process.env.OTEAM_TELEMETRY_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".open-team", "telemetry");
}

export function runsPath(dir: string = telemetryDir()): string {
  return join(dir, "runs.jsonl");
}

/**
 * Append one telemetry line for a completed role-pipeline phase.
 *
 * Best-effort per AC #4: any error (config unreadable, session JSONL absent,
 * write EACCES, opt-out) writes one line to stderr and returns. The caller's
 * exit code is preserved unchanged.
 */
export function recordPhase(input: RecordPhaseInput): void {
  try {
    if (!getTelemetryEnabled()) return;

    const endedAt = input.endedAt ?? new Date().toISOString();
    const wallClockMs = computeWallClockMs(input.startedAt, endedAt);

    const sessionFile = findSessionFile(
      resolveClaudeConfigDir(),
      input.cwd,
      input.sessionId,
    );

    let tokens: TokenUsage = {};
    let markerOutcome: SessionOutcome = null;
    if (existsSync(sessionFile)) {
      const parsed = parseSessionFile(sessionFile);
      tokens = parsed.tokens;
      markerOutcome = parsed.outcome;
      if (Object.keys(tokens).length === 0) {
        process.stderr.write(
          `oteam: telemetry: session file found but no token data parsed — ${sessionFile}\n`,
        );
      }
    } else {
      process.stderr.write(
        `oteam: telemetry: session file not found — ${sessionFile}\n`,
      );
    }

    const outcome: Outcome =
      input.exitCode !== 0
        ? "failed"
        : markerOutcome ?? "unknown";

    const line: RunsLine = {
      ticket: input.ticket,
      phase: input.phase,
      model: input.model,
      "started-at": input.startedAt,
      "ended-at": endedAt,
      "wall-clock-ms": wallClockMs,
      tokens,
      outcome,
    };

    const dir = telemetryDir();
    mkdirSync(dir, { recursive: true });
    // O_APPEND on a regular file gives us non-interleaved writes for
    // single-system_call appends like this one — concurrent agents writing
    // to the same `runs.jsonl` won't tear each other's lines.
    appendFileSync(runsPath(dir), JSON.stringify(line) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`oteam: telemetry record failed: ${msg}\n`);
  }
}

function resolveClaudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.length > 0) return env;
  return join(homedir(), ".claude");
}

function computeWallClockMs(startedAt: string, endedAt: string): number {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

export function readRuns(dir: string = telemetryDir()): RunsLine[] {
  const path = runsPath(dir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: RunsLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed as RunsLine);
    } catch {
      // Skip malformed lines — best-effort read mirrors best-effort write.
    }
  }
  return out;
}

export interface SummaryFilter {
  /** Only include lines whose `started-at` is within the last N days. */
  days?: number;
  phase?: string;
  model?: string;
}

export interface SummaryRow {
  phase: string;
  model: string;
  count: number;
  meanWallClockMs: number;
  meanTokens: TokenUsage;
}

export function summarize(
  runs: RunsLine[],
  filter: SummaryFilter = {},
): SummaryRow[] {
  const filtered = applyFilter(runs, filter);
  // Bucket on a space-joined key. Phase is a fixed enum
  // (product|spike|implementation|qa) and model ids are SDK-issued slugs;
  // neither contains whitespace, so the join is unambiguous in practice.
  // The structured-value bucket below preserves the original phase/model
  // strings so the rendered row is not reconstructed from a split.
  type Bucket = { phase: string; model: string; rows: RunsLine[] };
  const buckets = new Map<string, Bucket>();
  for (const r of filtered) {
    const key = `${r.phase} ${r.model}`;
    const bucket = buckets.get(key) ?? { phase: r.phase, model: r.model, rows: [] };
    bucket.rows.push(r);
    buckets.set(key, bucket);
  }
  const rows: SummaryRow[] = [];
  for (const bucket of buckets.values()) {
    rows.push({
      phase: bucket.phase,
      model: bucket.model,
      count: bucket.rows.length,
      meanWallClockMs: meanWallClock(bucket.rows),
      meanTokens: meanTokens(bucket.rows),
    });
  }
  rows.sort(
    (a, b) =>
      a.phase.localeCompare(b.phase) || a.model.localeCompare(b.model),
  );
  return rows;
}

function applyFilter(runs: RunsLine[], filter: SummaryFilter): RunsLine[] {
  let cutoffMs: number | null = null;
  if (typeof filter.days === "number" && filter.days > 0) {
    cutoffMs = Date.now() - filter.days * 24 * 60 * 60 * 1000;
  }
  return runs.filter((r) => {
    if (filter.phase && r.phase !== filter.phase) return false;
    if (filter.model && r.model !== filter.model) return false;
    if (cutoffMs !== null) {
      const t = Date.parse(r["started-at"]);
      if (!Number.isFinite(t) || t < cutoffMs) return false;
    }
    return true;
  });
}

function meanWallClock(rows: RunsLine[]): number {
  if (rows.length === 0) return 0;
  const sum = rows.reduce((acc, r) => acc + (r["wall-clock-ms"] ?? 0), 0);
  return Math.round(sum / rows.length);
}

function meanTokens(rows: RunsLine[]): TokenUsage {
  const keys: (keyof TokenUsage)[] = [
    "input",
    "output",
    "cache-read",
    "cache-write",
  ];
  const out: TokenUsage = {};
  for (const k of keys) {
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const v = r.tokens?.[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    // Per AC #3, fields absent on the source rows stay absent in summary —
    // averaging over zero samples would invent a number we don't have.
    if (n > 0) out[k] = Math.round(sum / n);
  }
  return out;
}

export function tail(n: number, dir: string = telemetryDir()): RunsLine[] {
  const all = readRuns(dir);
  if (n <= 0) return [];
  return all.slice(-n);
}
