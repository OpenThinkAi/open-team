import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const candidatePaths = [
  join(moduleDir, "assign-ticket.md"),
  join(moduleDir, "..", "src", "role-pipeline", "assign-ticket.md"),
  join(moduleDir, "..", "..", "src", "role-pipeline", "assign-ticket.md"),
];

let cached: string | null = null;

export function loadRolePipelinePrompt(): string {
  if (cached !== null) return cached;
  for (const path of candidatePaths) {
    try {
      cached = readFileSync(path, "utf8");
      return cached;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `loadRolePipelinePrompt: assign-ticket.md not found at any of: ${candidatePaths.join(", ")}`,
  );
}

export function buildRolePipelineMessage(ticketPath: string): string {
  const prompt = loadRolePipelinePrompt();
  return prompt.replace(/\$ARGUMENTS/g, ticketPath);
}
