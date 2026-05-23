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

  const isPR = !!payload.pr;
  const linkedGitHub =
    payload.type === "github" && !isPR ? payload.url : "";
  const linkedPR = isPR ? payload.url : "";

  const frontmatterLines = [
    "---",
    `id: ${id}`,
    `title: "${safeTitle}"`,
    "state: triage",
    "team: product",
    `created: ${todayISO}`,
    `updated: ${todayISO}`,
    `project: ${input.project ?? ""}`,
    `repo: ${payload.repo ?? ""}`,
    "blocked-by: []",
    `linked-github: ${linkedGitHub}`,
    `linked-pr: ${linkedPR}`,
    "priority: medium",
    `labels: ${labels}`,
    `source: { type: ${payload.type}, url: "${safeURL}", id: "${safeID}", fetched-at: "${fetchedAtISO}" }`,
  ];
  if (payload.pr) {
    frontmatterLines.push(`pr-head-sha: ${payload.pr.headSHA}`);
    frontmatterLines.push(`pr-head-ref: ${payload.pr.headRef}`);
    frontmatterLines.push(`pr-base-ref: ${payload.pr.baseRef}`);
  }
  frontmatterLines.push("---");
  const frontmatter = frontmatterLines.join("\n");

  const acBullets = normalised.acceptanceCriteria
    .map((bullet, i) => `${i + 1}. ${bullet}`)
    .join("\n");

  const problem = `## Problem Statement\n\n${normalised.problemStatement}`;

  const ac = `## Acceptance Criteria\n\n${acBullets}`;

  const sections: string[] = [frontmatter, problem, ac];

  if (payload.pr) {
    sections.push(renderProposedChanges(payload.pr));
  }

  const spike = `## Spike\n\n<!--\nEngineering agent fills this in.\nSections to include:\n  - Hypothesised cause / approach\n  - Files to change\n  - Risks\n  - GAPS THAT BLOCK IMPLEMENTATION (call these out explicitly)\nSelf-rating at the bottom: scope (S/M/L) + confidence (H/M/L).\nS/H = auto-proceed. Anything bigger = pause for human plan review.\n-->`;
  sections.push(spike);

  const authorLine = payload.author ? `Reporter: @${payload.author}.` : "";
  const sourceKind = isPR ? `${payload.type} (PR)` : payload.type;
  const checkoutHint = payload.pr
    ? `\nTo take these changes through stamp:\n\n\`\`\`\ngh pr checkout ${prNumberFromID(payload.id)} --branch ${id}-${slugBranch(payload.title)}\n# review locally, then run the stamp flow on a feature branch off main\n\`\`\``
    : "";
  const comments =
    `## Comments\n\n### ${todayISO} — Filed via oteam pull ${sourceKind}\nIngested from ${payload.url} (${payload.id}). ${authorLine}`.trim() +
    checkoutHint;
  sections.push(comments);

  return sections.join("\n\n") + "\n";
}

function renderProposedChanges(pr: NonNullable<SourcePayload["pr"]>): string {
  const shortSHA = pr.headSHA.slice(0, 7);
  const mergeableLabel =
    pr.mergeable === null
      ? "computing"
      : pr.mergeable
        ? "mergeable"
        : "conflicts";
  const meta = `Branch: \`${pr.headRef}\` → \`${pr.baseRef}\` · head: \`${shortSHA}\` · ${pr.draft ? "draft" : "ready"} · ${mergeableLabel}`;

  if (pr.files.length === 0) {
    return `## Proposed Changes\n\n${meta}\n\n_No file changes reported._`;
  }

  const fileLines = pr.files
    .map(
      (f) =>
        `- \`${f.path}\` — ${f.status} (+${f.additions} / -${f.deletions})`,
    )
    .join("\n");

  return `## Proposed Changes\n\n${meta}\n\nFiles changed (${pr.files.length}):\n${fileLines}`;
}

function prNumberFromID(id: string): string {
  // Source IDs are formatted `owner/repo#NN`. Extract NN; fall back to the
  // raw id if the shape is unexpected so the hint is still useful.
  const hash = id.lastIndexOf("#");
  return hash >= 0 ? id.slice(hash + 1) : id;
}

function slugBranch(title: string): string {
  // Lightweight slug for the suggested branch name in the comment hint.
  // Mirrors the rules in lib/ticket-id.ts but doesn't import to avoid a cycle
  // and to keep the hint generation independent of the canonical slugger.
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "pr"
  );
}

export interface ManualRenderInput {
  id: string;
  title: string;
  todayISO: string;
  fetchedAtISO: string;
  team: string;
  project: string | null;
  repo: string | null;
  blockedBy: string[];
  priority: string;
  labels: string[];
}

export function renderManualTicket(input: ManualRenderInput): string {
  const safeTitle = input.title.replace(/"/g, '\\"');
  const labels =
    input.labels.length === 0 ? "[]" : `[${input.labels.join(", ")}]`;
  const blockedBy =
    input.blockedBy.length === 0 ? "[]" : `[${input.blockedBy.join(", ")}]`;

  const frontmatter = [
    "---",
    `id: ${input.id}`,
    `title: "${safeTitle}"`,
    "state: triage",
    `team: ${input.team}`,
    `created: ${input.todayISO}`,
    `updated: ${input.todayISO}`,
    `project: ${input.project ?? ""}`,
    `repo: ${input.repo ?? ""}`,
    `blocked-by: ${blockedBy}`,
    "linked-github: ",
    "linked-pr: ",
    `priority: ${input.priority}`,
    `labels: ${labels}`,
    `source: { type: manual, url: "", id: "", fetched-at: "${input.fetchedAtISO}" }`,
    "---",
  ].join("\n");

  const problem = `## Problem Statement\n\n<!-- Describe the problem this ticket addresses. The product agent fills this in during triage; refinement fleshes it out. -->`;

  const ac = `## Acceptance Criteria\n\n<!-- Numbered list of testable conditions. Filled in during refinement. -->`;

  const spike = `## Spike\n\n<!--\nEngineering agent fills this in.\nSections to include:\n  - Hypothesised cause / approach\n  - Files to change\n  - Risks\n  - GAPS THAT BLOCK IMPLEMENTATION (call these out explicitly)\nSelf-rating at the bottom: scope (S/M/L) + confidence (H/M/L).\nS/H = auto-proceed. Anything bigger = pause for human plan review.\n-->`;

  const comments = `## Comments\n\n### ${input.todayISO} — Filed via oteam ticket new\nFiled manually (no external source).`;

  return [frontmatter, problem, ac, spike, comments].join("\n\n") + "\n";
}
