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

  let sawResult = false;
  for await (const message of query({
    prompt,
    options: {
      model: ROLE_PIPELINE_MODEL,
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
    },
  })) {
    if (handleMessage(message as unknown)) sawResult = true;
  }
  if (!sawResult) process.stdout.write("\n");
}

interface StreamEventDelta {
  type?: string;
  text?: string;
}

interface StreamEvent {
  type?: string;
  delta?: StreamEventDelta;
}

interface SDKMessage {
  type?: string;
  event?: StreamEvent;
}

function handleMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as SDKMessage;
  if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
    const delta = m.event.delta;
    if (delta?.type === "text_delta" && delta.text) {
      process.stdout.write(delta.text);
    }
    return false;
  }
  if (m.type === "result") {
    process.stdout.write("\n");
    return true;
  }
  return false;
}
