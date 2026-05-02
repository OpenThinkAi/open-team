import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
      model: "claude-opus-4-7",
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
    },
  })) {
    handleMessage(message);
  }
}

function handleMessage(message: unknown): void {
  if (!message || typeof message !== "object") return;
  const m = message as { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } }; message?: { content?: unknown }; subtype?: string; result?: unknown };

  if (m.type === "stream_event" && m.event) {
    const ev = m.event;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      process.stdout.write(ev.delta.text);
    }
    return;
  }

  if (m.type === "assistant" && m.message?.content) {
    return;
  }

  if (m.type === "result") {
    process.stdout.write("\n");
    return;
  }
}
