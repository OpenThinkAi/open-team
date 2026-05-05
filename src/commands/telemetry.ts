import { Command } from "commander";
import {
  readRuns,
  recordPhase,
  summarize,
  tail,
  telemetryDir,
  type RunsLine,
  type SummaryRow,
} from "../lib/telemetry.ts";
import type { TokenUsage } from "../lib/claude-session.ts";

export function buildTelemetryCommand(): Command {
  const telemetry = new Command("telemetry").description(
    "Per-phase wall-clock + token telemetry for role-pipeline spawns",
  );

  telemetry
    .command("summary")
    .description(
      "Aggregate runs.jsonl by phase × model (count, mean wall-clock, mean tokens)",
    )
    .option("--days <n>", "Only include runs from the last N days", parsePositiveInt)
    .option("--phase <name>", "Filter by phase (product|spike|implementation|qa)")
    .option("--model <id>", "Filter by resolved model id")
    .action(
      (opts: { days?: number; phase?: string; model?: string }) => {
        const runs = readRuns();
        if (runs.length === 0) {
          process.stdout.write(
            `(no telemetry yet — ${telemetryDir()}/runs.jsonl is empty or missing)\n`,
          );
          return;
        }
        const rows = summarize(runs, opts);
        if (rows.length === 0) {
          process.stdout.write("(no rows match filters)\n");
          return;
        }
        process.stdout.write(formatSummary(rows) + "\n");
      },
    );

  telemetry
    .command("tail")
    .description("Print the last N telemetry lines (default 20)")
    .option("-n, --count <n>", "How many lines to print", parsePositiveInt, 20)
    .action((opts: { count: number }) => {
      const lines = tail(opts.count);
      if (lines.length === 0) {
        process.stdout.write(
          `(no telemetry yet — ${telemetryDir()}/runs.jsonl is empty or missing)\n`,
        );
        return;
      }
      for (const line of lines) {
        process.stdout.write(JSON.stringify(line) + "\n");
      }
    });

  // Hidden internal subcommand invoked by the runner's kitty wrapper after
  // `claude` exits. Users never call this directly. Documented as internal.
  telemetry
    .command("record", { hidden: true })
    .description("(internal) Record one phase's telemetry line")
    .requiredOption("--ticket <id>", "Ticket id (e.g. AGT-108)")
    .requiredOption("--phase <name>", "Phase name (product|spike|implementation|qa)")
    .requiredOption("--model <id>", "Resolved model id passed to claude")
    .requiredOption("--session <uuid>", "Session UUID passed to `claude --session-id`")
    .requiredOption("--started-at <iso>", "ISO timestamp captured before spawning claude")
    .requiredOption("--exit-code <n>", "claude's exit code", parseSignedInt)
    .option("--cwd <path>", "Working directory the spawn ran in (defaults to $PWD)")
    .action(
      (opts: {
        ticket: string;
        phase: string;
        model: string;
        session: string;
        startedAt: string;
        exitCode: number;
        cwd?: string;
      }) => {
        recordPhase({
          ticket: opts.ticket,
          phase: opts.phase,
          model: opts.model,
          sessionId: opts.session,
          startedAt: opts.startedAt,
          exitCode: opts.exitCode,
          cwd: opts.cwd ?? process.cwd(),
        });
      },
    );

  return telemetry;
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`oteam telemetry: expected a positive integer, got "${raw}"\n`);
    process.exit(2);
  }
  return n;
}

function parseSignedInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    process.stderr.write(`oteam telemetry: expected an integer, got "${raw}"\n`);
    process.exit(2);
  }
  return n;
}

export function formatSummary(rows: SummaryRow[]): string {
  const headers = ["phase", "model", "count", "mean_ms", "mean_in", "mean_out", "mean_cache_r", "mean_cache_w"];
  const data: string[][] = rows.map((r) => [
    r.phase,
    r.model,
    String(r.count),
    String(r.meanWallClockMs),
    formatTokenField(r.meanTokens, "input"),
    formatTokenField(r.meanTokens, "output"),
    formatTokenField(r.meanTokens, "cache-read"),
    formatTokenField(r.meanTokens, "cache-write"),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [fmt(headers), ...data.map(fmt)].join("\n");
}

function formatTokenField(tokens: TokenUsage, key: keyof TokenUsage): string {
  const v = tokens[key];
  return typeof v === "number" ? String(v) : "-";
}

// Re-exported for tests and dependents that want the same line shape.
export type { RunsLine };
