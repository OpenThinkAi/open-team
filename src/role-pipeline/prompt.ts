import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
// `dist/index.js` and `dist/assign-ticket.md` ship side-by-side post-build
// (see package.json `build` script). In `tsx` dev runs the file is at the
// source location next to this module. Both resolve via the same join.
const PROMPT_PATH = join(moduleDir, "assign-ticket.md");

let cached: string | null = null;

export function loadRolePipelinePrompt(): string {
  if (cached !== null) return cached;
  cached = readFileSync(PROMPT_PATH, "utf8");
  return cached;
}

export function buildRolePipelineMessage(ticketPath: string): string {
  const prompt = loadRolePipelinePrompt();
  return prompt.replace(/\$ARGUMENTS/g, ticketPath);
}
