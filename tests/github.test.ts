import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIssueRef } from "../src/lib/github.ts";

describe("parseIssueRef", () => {
  it("parses canonical github issue URLs", () => {
    const r = parseIssueRef("https://github.com/myorg/my-app/issues/42");
    assert.deepEqual(r, { slug: "myorg/my-app", number: 42 });
  });

  it("parses http URLs", () => {
    const r = parseIssueRef("http://github.com/x/y/issues/1");
    assert.deepEqual(r, { slug: "x/y", number: 1 });
  });

  it("parses owner/repo#N short refs", () => {
    const r = parseIssueRef("OpenThinkAi/dispatch#7");
    assert.deepEqual(r, { slug: "OpenThinkAi/dispatch", number: 7 });
  });

  it("returns null for pull-request URLs", () => {
    // claim-on-assign is for issues only — PRs aren't ingested as tickets.
    assert.equal(
      parseIssueRef("https://github.com/x/y/pull/3"),
      null,
    );
  });

  it("returns null for unrecognisable input", () => {
    assert.equal(parseIssueRef(""), null);
    assert.equal(parseIssueRef("just a string"), null);
    assert.equal(parseIssueRef("https://gitlab.com/x/y/issues/1"), null);
  });
});
