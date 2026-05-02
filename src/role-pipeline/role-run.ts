import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROLE_PIPELINE_MODEL } from "../lib/models.ts";
import { buildRolePipelineMessage } from "./prompt.ts";

export interface RoleRunOptions {
  ticketPath: string;
}

export async function runRolePipeline(opts: RoleRunOptions): Promise<void> {
  const ticketPath = resolve(opts.ticketPath);
  if (!existsSync(ticketPath)) {
    process.stderr.write(`oteam _role-run: ticket not found at ${ticketPath}\n`);
    process.exit(2);
  }

  const prompt = buildRolePipelineMessage(ticketPath);

  for await (const message of query({
    prompt,
    options: {
      model: ROLE_PIPELINE_MODEL,
      permissionMode: "bypassPermissions",
      // SDK default `tools` is "inherit from parent". `_role-run` is a bare
      // Node process with no parent SDK context, so omitting resolves to
      // no tools — the agent narrates without invoking Bash/Read/etc.
      // Read/Write/Edit cover frontmatter + comments; Bash covers the
      // shell-driven flow (mv, gh, git, stamp, build/test); Glob/Grep
      // cover vault scans and call-site lookups; TodoWrite is standard
      // agentic scaffolding.
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite"],
      // The role pipeline is multi-phase (Phase 0 → 5 + iteration loops
      // for stamp review). The SDK's default maxTurns is too low for a
      // real run — bump generously; cost is bounded by the agent itself
      // STOPing at handoff boundaries.
      maxTurns: 200,
      includePartialMessages: true,
    },
  })) {
    handleMessage(message as unknown);
  }
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface SDKMessage {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: ContentBlock[] };
  subtype?: string;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  result?: string;
}

function handleMessage(message: unknown): void {
  if (!message || typeof message !== "object") return;
  const m = message as SDKMessage;

  // Streaming text deltas — print incrementally so the assistant's prose
  // appears as it's generated.
  if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
    const delta = m.event.delta;
    if (delta?.type === "text_delta" && delta.text) {
      process.stdout.write(delta.text);
    }
    return;
  }

  // Full assistant turn — extract tool_use blocks so the user can see what
  // the agent is actually doing. Text blocks are already covered by
  // stream_event above; printing them here would duplicate.
  if (m.type === "assistant" && Array.isArray(m.message?.content)) {
    for (const block of m.message.content) {
      if (block.type === "tool_use") {
        const summary = summariseToolInput(block.name ?? "?", block.input);
        process.stdout.write(`\n→ ${block.name ?? "?"}${summary}\n`);
      }
    }
    return;
  }

  // Final result — surface completion reason + turn count so the user
  // can tell "agent stopped because it's done" vs "agent hit max turns
  // mid-phase" vs "agent errored."
  if (m.type === "result") {
    const turns = m.num_turns ?? "?";
    const dur = m.duration_ms != null ? `${(m.duration_ms / 1000).toFixed(1)}s` : "?";
    if (m.subtype === "success") {
      process.stdout.write(`\n[done · ${turns} turns · ${dur}]\n`);
    } else {
      process.stdout.write(`\n[stopped · ${m.subtype} · ${turns} turns · ${dur}]\n`);
      if (m.is_error) process.exitCode = 1;
    }
    return;
  }
}

function summariseToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "()";
  const obj = input as Record<string, unknown>;

  // Tool-specific shorthand keeps the line short and informative.
  if (name === "Bash" && typeof obj.command === "string") {
    return `(${truncate(obj.command, 120)})`;
  }
  if ((name === "Read" || name === "Edit" || name === "Write") &&
      typeof obj.file_path === "string") {
    return `(${shortPath(obj.file_path)})`;
  }
  if (name === "Glob" && typeof obj.pattern === "string") {
    return `(${truncate(obj.pattern, 80)})`;
  }
  if (name === "Grep" && typeof obj.pattern === "string") {
    return `(${truncate(obj.pattern, 80)})`;
  }

  // Fallback: dump a truncated JSON of the input args.
  try {
    return `(${truncate(JSON.stringify(obj), 100)})`;
  } catch {
    return "(…)";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
