import type { NormalisedTicket, SourcePayload } from "../ingestors/types.ts";

export interface RenderInput {
  id: string;
  payload: SourcePayload;
  normalised: NormalisedTicket;
  todayISO: string;
  fetchedAtISO: string;
  project?: string | null;
}

export function renderTicket(input: RenderInput): string {
  const { id, payload, normalised, todayISO, fetchedAtISO } = input;
  const safeTitle = payload.title.replace(/"/g, '\\"');
  const safeURL = payload.url.replace(/"/g, '\\"');
  const safeID = payload.id.replace(/"/g, '\\"');
  const labels =
    normalised.labels.length === 0
      ? "[]"
      : `[${normalised.labels.join(", ")}]`;

  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: "${safeTitle}"`,
    "state: triage",
    "team: product",
    `created: ${todayISO}`,
    `updated: ${todayISO}`,
    `project: ${input.project ?? ""}`,
    `repo: ${payload.repo ?? ""}`,
    `linked-github: ${payload.type === "github" ? payload.url : ""}`,
    "linked-pr: ",
    "priority: medium",
    `labels: ${labels}`,
    `source: { type: ${payload.type}, url: "${safeURL}", id: "${safeID}", fetched-at: "${fetchedAtISO}" }`,
    "---",
  ].join("\n");

  const acBullets = normalised.acceptanceCriteria
    .map((bullet, i) => `${i + 1}. ${bullet}`)
    .join("\n");

  const problem = `## Problem Statement\n\n${normalised.problemStatement}`;

  const ac = `## Acceptance Criteria\n\n${acBullets}`;

  const spike = `## Spike\n\n<!--\nEngineering agent fills this in.\nSections to include:\n  - Hypothesised cause / approach\n  - Files to change\n  - Risks\n  - GAPS THAT BLOCK IMPLEMENTATION (call these out explicitly)\nSelf-rating at the bottom: scope (S/M/L) + confidence (H/M/L).\nS/H = auto-proceed. Anything bigger = pause for human plan review.\n-->`;

  const authorLine = payload.author
    ? `Reporter: @${payload.author}.`
    : "";
  const comments = `## Comments\n\n### ${todayISO} — Filed via oteam pull ${payload.type}\nIngested from ${payload.url} (${payload.id}). ${authorLine}`.trim();

  return [frontmatter, problem, ac, spike, comments].join("\n\n") + "\n";
}
