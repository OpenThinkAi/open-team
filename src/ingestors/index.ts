import { GitHubIngestor } from "./github.ts";
import { IngestorError, type Ingestor } from "./types.ts";

const REGISTRY: Record<string, () => Ingestor> = {
  github: () => new GitHubIngestor(),
};

export function getIngestor(type: string): Ingestor {
  const factory = REGISTRY[type];
  if (!factory) {
    throw new IngestorError(
      `unknown source "${type}" — supported: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return factory();
}

export { IngestorError } from "./types.ts";
export type { Ingestor, NormalisedTicket, SourcePayload } from "./types.ts";
