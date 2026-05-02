import { GitHubIngestor } from "./github.ts";
import type { Ingestor } from "./types.ts";

const REGISTRY: Record<string, () => Ingestor> = {
  github: () => new GitHubIngestor(),
};

export function getIngestor(type: string): Ingestor {
  const factory = REGISTRY[type];
  if (!factory) {
    throw new Error(
      `unknown source "${type}" — supported: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return factory();
}

export type { Ingestor, NormalisedTicket, SourcePayload } from "./types.ts";
