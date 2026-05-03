import { execFileSync } from "node:child_process";
import type {
  Ingestor,
  PRFileChange,
  PRMetadata,
  SourcePayload,
} from "./types.ts";

interface GhIssueResponse {
  title: string;
  body: string | null;
  html_url: string;
  number: number;
  user?: { login?: string };
  pull_request?: { url?: string; html_url?: string } | null;
}

interface GhPullResponse {
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  draft?: boolean;
  mergeable: boolean | null;
}

interface GhPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export class GitHubIngestor implements Ingestor {
  readonly type = "github";

  async fetch(ref: string): Promise<SourcePayload> {
    const { owner, repo, number } = parseRef(ref);
    const repoSlug = `${owner}/${repo}`;
    const issuePath = `repos/${repoSlug}/issues/${number}`;

    const issue = parseJSON<GhIssueResponse>(ghApi(issuePath), issuePath);

    const payload: SourcePayload = {
      type: "github",
      url: issue.html_url,
      id: `${repoSlug}#${issue.number}`,
      title: issue.title,
      body: issue.body ?? "",
      author: issue.user?.login,
      repo: repoSlug,
    };

    // PRs are issues in GitHub's data model — the `pull_request` field on
    // the issue response is how we tell them apart. When present, fetch the
    // PR-specific endpoint and the file list so the ticket carries the
    // proposed change, not just the description.
    if (issue.pull_request) {
      payload.pr = await fetchPRMetadata(repoSlug, number);
    }

    return payload;
  }
}

async function fetchPRMetadata(
  repoSlug: string,
  number: number,
): Promise<PRMetadata> {
  const pullPath = `repos/${repoSlug}/pulls/${number}`;
  const filesPath = `repos/${repoSlug}/pulls/${number}/files?per_page=100`;

  const pull = parseJSON<GhPullResponse>(ghApi(pullPath), pullPath);
  const filesRaw = parseJSON<GhPullFile[]>(ghApi(filesPath), filesPath);

  const files: PRFileChange[] = filesRaw.map((f) => ({
    path: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));

  return {
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    headSHA: pull.head.sha,
    baseSHA: pull.base.sha,
    draft: pull.draft ?? false,
    mergeable: pull.mergeable,
    files,
  };
}

function ghApi(path: string): string {
  try {
    return execFileSync("gh", ["api", path], { encoding: "utf8" });
  } catch (err) {
    throw new Error(`gh api ${path} failed: ${(err as Error).message}`);
  }
}

function parseJSON<T>(raw: string, path: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `gh api ${path} returned non-JSON output: ${(err as Error).message}`,
    );
  }
}

export function parseRef(ref: string): {
  owner: string;
  repo: string;
  number: number;
} {
  const url = ref.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/,
  );
  if (url) {
    return { owner: url[1]!, repo: url[2]!, number: parseInt(url[3]!, 10) };
  }
  const slug = ref.match(/^([^/]+)\/([^/#]+)#(\d+)$/);
  if (slug) {
    return { owner: slug[1]!, repo: slug[2]!, number: parseInt(slug[3]!, 10) };
  }
  throw new Error(
    `unrecognized github ref "${ref}" — expected owner/repo#NN, an issue URL, or a pull URL`,
  );
}
