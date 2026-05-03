export interface SourcePayload {
  type: string;
  url: string;
  id: string;
  title: string;
  body: string;
  author?: string;
  repo?: string;
  metadata?: Record<string, unknown>;
  pr?: PRMetadata;
}

export interface PRFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PRMetadata {
  headRef: string;
  baseRef: string;
  headSHA: string;
  baseSHA: string;
  draft: boolean;
  // GitHub returns `null` for `mergeable` while it computes the merge result.
  mergeable: boolean | null;
  files: PRFileChange[];
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
