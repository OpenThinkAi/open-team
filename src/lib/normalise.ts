import type { NormalisedTicket, SourcePayload } from "../ingestors/types.ts";

/**
 * Deterministically map a raw source payload into a triage-shape ticket.
 *
 * Pull is intentionally LLM-free as of the zero-SDK conversion: the
 * refinement role (assign-ticket.md, Product phase) shapes the rough import
 * into a 1–2 sentence Problem Statement + testable Acceptance Criteria
 * in-session, on the subscription bucket — not via the metered Agent SDK at
 * pull time. Pull just carries the source text across verbatim so nothing is
 * lost before refinement runs.
 *
 * Problem Statement = the source body (or the title when the body is empty).
 * Acceptance Criteria start empty; the refinement role fills them. Labels
 * start empty; carrying the source's own labels across is a future follow-up.
 */
export function normaliseSource(payload: SourcePayload): NormalisedTicket {
  const body = payload.body?.trim();
  return {
    problemStatement: body && body.length > 0 ? body : payload.title,
    acceptanceCriteria: [],
    labels: [],
  };
}
