import { readFileSync } from "node:fs";
import { join } from "node:path";

// Claude Code persists per-session JSONL at
// `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`. The
// encoding rule is "replace every '/' with '-'", with no other escaping —
// so `/private/tmp/repo` becomes `-private-tmp-repo`. AGT-108 telemetry
// reads back from that file once `claude --session-id <uuid>` exits.

export interface TokenUsage {
  input?: number;
  output?: number;
  "cache-read"?: number;
  "cache-write"?: number;
}

export type SessionOutcome = "done" | "paused" | "failed" | null;

export interface ParsedSession {
  tokens: TokenUsage;
  outcome: SessionOutcome;
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function findSessionFile(
  claudeConfigDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(
    claudeConfigDir,
    "projects",
    encodeProjectDir(cwd),
    `${sessionId}.jsonl`,
  );
}

export function parseSessionFile(path: string): ParsedSession {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { tokens: {}, outcome: null };
  }
  return parseSessionJsonl(raw);
}

/**
 * Return the text from the last assistant turn in a JSONL session file, or
 * null if the file is absent, empty, or contains no assistant messages. Used
 * by the inline runner to surface the completion summary when stdout was
 * wedged by a child subprocess that outlived the agent turn (AC 3 of AGT-236).
 */
export function lastAssistantText(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let last = "";
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "assistant") continue;
    const m = (e.message ?? {}) as Record<string, unknown>;
    const text = extractAssistantText(m.content);
    if (text.length > 0) last = text;
  }
  return last.length > 0 ? last : null;
}

export function parseSessionJsonl(raw: string): ParsedSession {
  const tokens: TokenUsage = {};
  let lastAssistantText = "";

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // Tolerate non-JSON noise (mid-write truncation, fixture comments).
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "assistant") continue;
    const message = e.message;
    if (!message || typeof message !== "object") continue;
    const m = message as Record<string, unknown>;

    if (m.usage && typeof m.usage === "object") {
      const u = m.usage as Record<string, unknown>;
      addIfFinite(tokens, "input", u.input_tokens);
      addIfFinite(tokens, "output", u.output_tokens);
      addIfFinite(tokens, "cache-write", u.cache_creation_input_tokens);
      addIfFinite(tokens, "cache-read", u.cache_read_input_tokens);
    }

    const text = extractAssistantText(m.content);
    if (text.length > 0) lastAssistantText = text;
  }

  return { tokens, outcome: detectOutcome(lastAssistantText) };
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      out += (out.length > 0 ? "\n" : "") + p.text;
    }
  }
  return out;
}

function detectOutcome(text: string): SessionOutcome {
  // STOP markers are emitted by the role-pipeline slash command body
  // (src/role-pipeline/assign-ticket.md). The agent guarantees one of the
  // three banners on a successful finish; "unknown" is recorded by the
  // caller when none of these match.
  if (text.includes("✅ DONE")) return "done";
  if (text.includes("⏸️ PAUSED")) return "paused";
  if (text.includes("🛑 BLOCKED")) return "failed";
  return null;
}

function addIfFinite(
  target: TokenUsage,
  key: keyof TokenUsage,
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  target[key] = (target[key] ?? 0) + value;
}
