import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTicket } from "../src/lib/render.ts";
import { parseTicket } from "../src/lib/vault.ts";

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
