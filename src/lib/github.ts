import { spawnSync } from "node:child_process";

export interface IssueRef {
  slug: string;
  number: number;
}

export type IssueClaim =
  | { ok: true; assignees: string[] }
  | { ok: false; reason: "issue-closed" }
  | { ok: false; reason: "already-claimed"; assignees: string[] }
  | { ok: false; reason: "no-write-access" }
  | { ok: false; reason: "api-error"; error: string };

interface GhIssueLite {
  state: "open" | "closed";
  assignees?: { login?: string }[];
}

/**
 * Parse a github issue reference. Accepts the same shapes as the github
 * ingestor (`https://github.com/owner/repo/issues/N` or `owner/repo#N`).
 * Returns null when the input is unrecognisable — callers decide whether
 * that's fatal or a "no claim attempted" no-op.
 */
export function parseIssueRef(ref: string): IssueRef | null {
  const url = ref.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
  );
  if (url) {
    return { slug: `${url[1]}/${url[2]}`, number: parseInt(url[3]!, 10) };
  }
  const slug = ref.match(/^([^/]+\/[^/#]+)#(\d+)$/);
  if (slug) {
    return { slug: slug[1]!, number: parseInt(slug[2]!, 10) };
  }
  return null;
}

/**
 * Atomically claim a GH issue for `identity`.
 *
 *   1. GET /repos/<slug>/issues/<n>.
 *   2. If state=closed → bail (issue-closed).
 *   3. If already assigned to someone other than identity → bail (already-claimed).
 *   4. PATCH assignees: [identity].
 *   5. Inspect PATCH response. If assignees came back empty, the operator's
 *      gh token doesn't have push access (GitHub silently drops assignee
 *      changes without it) → bail (no-write-access). If assignees != [identity]
 *      another writer raced us → bail (already-claimed).
 *
 * The race window between step 1 and step 4 is tiny but non-zero. The
 * post-PATCH verification catches the case where two callers both saw the
 * issue unassigned and both PATCHed.
 */
export function claimGitHubIssue(
  slug: string,
  issueNumber: number,
  identity: string,
): IssueClaim {
  const getR = ghJSON(["api", `repos/${slug}/issues/${issueNumber}`]);
  if (!getR.ok) return { ok: false, reason: "api-error", error: getR.error };

  const issue = getR.value as GhIssueLite;
  if (issue.state === "closed") return { ok: false, reason: "issue-closed" };

  const existing = collectAssignees(issue);
  if (existing.length > 0 && !existing.includes(identity)) {
    return { ok: false, reason: "already-claimed", assignees: existing };
  }

  const body = JSON.stringify({ assignees: [identity] });
  const patchR = ghJSON(
    [
      "api",
      `repos/${slug}/issues/${issueNumber}`,
      "-X",
      "PATCH",
      "--input",
      "-",
    ],
    body,
  );
  if (!patchR.ok) return { ok: false, reason: "api-error", error: patchR.error };

  const updated = patchR.value as GhIssueLite;
  if (updated.state === "closed") return { ok: false, reason: "issue-closed" };

  const after = collectAssignees(updated);
  if (after.length === 0) return { ok: false, reason: "no-write-access" };
  if (after.length !== 1 || after[0] !== identity) {
    return { ok: false, reason: "already-claimed", assignees: after };
  }

  return { ok: true, assignees: after };
}

function collectAssignees(issue: GhIssueLite): string[] {
  if (!issue.assignees) return [];
  const out: string[] = [];
  for (const a of issue.assignees) {
    if (typeof a?.login === "string" && a.login.length > 0) out.push(a.login);
  }
  return out;
}

type GhResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function ghJSON(args: string[], input?: string): GhResult {
  const r = spawnSync("gh", args, { encoding: "utf8", input });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) {
    return { ok: false, error: r.stderr || `gh exited ${r.status}` };
  }
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, error: `gh returned non-JSON: ${(e as Error).message}` };
  }
}
