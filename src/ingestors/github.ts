import { execFileSync } from "node:child_process";
import {
  IngestorError,
  type Ingestor,
  type SourcePayload,
} from "./types.ts";

export class GitHubIngestor implements Ingestor {
  readonly type = "github";

  async fetch(ref: string): Promise<SourcePayload> {
    const { owner, repo, number } = parseRef(ref);
    const repoSlug = `${owner}/${repo}`;
    const path = `repos/${repoSlug}/issues/${number}`;
    let raw: string;
    try {
      raw = execFileSync("gh", ["api", path], { encoding: "utf8" });
    } catch (err) {
      throw new IngestorError(
        `gh api ${path} failed: ${(err as Error).message}`,
      );
    }
    const issue = JSON.parse(raw) as {
      title: string;
      body: string | null;
      html_url: string;
      number: number;
      user?: { login?: string };
    };
    return {
      type: "github",
      url: issue.html_url,
      id: `${repoSlug}#${issue.number}`,
      title: issue.title,
      body: issue.body ?? "",
      author: issue.user?.login,
      repo: repoSlug,
    };
  }
}

function parseRef(ref: string): { owner: string; repo: string; number: number } {
  const url = ref.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
  );
  if (url) {
    return { owner: url[1]!, repo: url[2]!, number: parseInt(url[3]!, 10) };
  }
  const slug = ref.match(/^([^/]+)\/([^/#]+)#(\d+)$/);
  if (slug) {
    return { owner: slug[1]!, repo: slug[2]!, number: parseInt(slug[3]!, 10) };
  }
  throw new IngestorError(
    `unrecognized github ref "${ref}" — expected owner/repo#NN or full issue URL`,
  );
}
