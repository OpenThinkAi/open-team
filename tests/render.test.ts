import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTicket } from "../src/lib/render.ts";
import { parseTicket } from "../src/lib/vault.ts";

describe("renderTicket — PR-flavored payload", () => {
  it("renders linked-pr (not linked-github), pr-head-sha, and a Proposed Changes section", () => {
    const body = renderTicket({
      id: "AGT-100",
      payload: {
        type: "github",
        url: "https://github.com/OpenThinkAi/open-team/pull/42",
        id: "OpenThinkAi/open-team#42",
        title: "chore(deps): bump commander from 13.1.0 to 13.2.0",
        body: "Bumps commander to pick up a bugfix.",
        author: "dependabot[bot]",
        repo: "OpenThinkAi/open-team",
        pr: {
          headRef: "dependabot/npm_and_yarn/commander-13.2.0",
          baseRef: "main",
          headSHA: "abcdef1234567890",
          baseSHA: "1111111111111111",
          draft: false,
          mergeable: true,
          files: [
            { path: "package.json", status: "modified", additions: 1, deletions: 1 },
            { path: "package-lock.json", status: "modified", additions: 8, deletions: 8 },
          ],
        },
      },
      normalised: {
        problemStatement: "Bump commander to 13.2.0 to pick up a bugfix.",
        acceptanceCriteria: ["CI passes", "no unrelated changes"],
        labels: ["dependencies"],
      },
      todayISO: "2026-05-03",
      fetchedAtISO: "2026-05-03T00:00:00.000Z",
      project: "open-team",
    });

    // Frontmatter
    assert.match(body, /linked-github: \n/, "linked-github should be empty for a PR");
    assert.match(
      body,
      /linked-pr: https:\/\/github\.com\/OpenThinkAi\/open-team\/pull\/42/,
    );
    assert.match(body, /pr-head-sha: abcdef1234567890/);
    assert.match(body, /pr-head-ref: dependabot\/npm_and_yarn\/commander-13\.2\.0/);
    assert.match(body, /pr-base-ref: main/);

    // Proposed Changes section
    assert.match(body, /## Proposed Changes/);
    assert.match(body, /Branch: `dependabot\/npm_and_yarn\/commander-13\.2\.0` → `main`/);
    assert.match(body, /head: `abcdef1`/);
    assert.match(body, /Files changed \(2\):/);
    assert.match(body, /- `package\.json` — modified \(\+1 \/ -1\)/);
    assert.match(body, /- `package-lock\.json` — modified \(\+8 \/ -8\)/);

    // Comments stamp + checkout hint
    assert.match(body, /Filed via oteam pull github \(PR\)/);
    assert.match(body, /gh pr checkout 42 --branch AGT-100-/);
  });

  it("renders 'No file changes reported' when the file list is empty", () => {
    const body = renderTicket({
      id: "AGT-101",
      payload: {
        type: "github",
        url: "https://github.com/x/y/pull/1",
        id: "x/y#1",
        title: "Empty PR",
        body: "",
        repo: "x/y",
        pr: {
          headRef: "feat",
          baseRef: "main",
          headSHA: "deadbeefdeadbeef",
          baseSHA: "0000000000000000",
          draft: true,
          mergeable: null,
          files: [],
        },
      },
      normalised: {
        problemStatement: "An empty PR.",
        acceptanceCriteria: ["does nothing"],
        labels: [],
      },
      todayISO: "2026-05-03",
      fetchedAtISO: "2026-05-03T00:00:00.000Z",
      project: null,
    });
    assert.match(body, /## Proposed Changes/);
    assert.match(body, /draft · computing/);
    assert.match(body, /No file changes reported/);
  });
});

describe("renderTicket → parseTicket round-trip", () => {
  it("preserves quoted titles, URLs containing commas, and labels", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      const body = renderTicket({
        id: "AGT-099",
        payload: {
          type: "github",
          url: "https://github.com/owner/repo,with,commas/issues/9",
          id: "owner/repo#9",
          title: 'Title with "quotes" and a comma, here',
          body: "ignored for this test",
          author: "alice",
          repo: "owner/repo",
        },
        normalised: {
          problemStatement: "One sentence.",
          acceptanceCriteria: ["does X when Y", "shows Z"],
          labels: ["bug", "perf"],
        },
        todayISO: "2026-05-02",
        fetchedAtISO: "2026-05-02T10:00:00.000Z",
        project: "my-project",
      });
      const path = join(root, "AGT-099-x.md");
      writeFileSync(path, body);
      const t = parseTicket(path);
      assert.ok(t);
      assert.equal(t.id, "AGT-099");
      assert.equal(t.repo, "owner/repo");
      assert.equal(t.project, "my-project");
      assert.equal(t.linkedGitHub, "https://github.com/owner/repo,with,commas/issues/9");
      assert.deepEqual(t.labels, ["bug", "perf"]);
      assert.equal(t.source.type, "github");
      assert.equal(t.source.id, "owner/repo#9");
      assert.equal(t.source.url, "https://github.com/owner/repo,with,commas/issues/9");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
