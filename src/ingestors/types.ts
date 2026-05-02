export interface SourcePayload {
  type: string;
  url: string;
  id: string;
  title: string;
  body: string;
  author?: string;
  repo?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalisedTicket {
  problemStatement: string;
  acceptanceCriteria: string[];
  labels: string[];
}

export interface Ingestor {
  readonly type: string;
  fetch(ref: string): Promise<SourcePayload>;
}

export class IngestorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestorError";
  }
}
