import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractFrontmatter,
  parseLabels,
  parseSource,
} from "../src/lib/frontmatter.ts";

describe("extractFrontmatter", () => {
  it("parses a minimal block", () => {
    const out = extractFrontmatter("---\nid: AGT-001\ntitle: hi\n---\nbody");
    assert.deepEqual(out, { id: "AGT-001", title: "hi" });
  });

  it("returns null when no leading ---", () => {
    assert.equal(extractFrontmatter("nope"), null);
  });

  it("returns null when no closing ---", () => {
    assert.equal(extractFrontmatter("---\nid: X\n"), null);
  });
});

describe("parseLabels", () => {
  it("parses inline arrays", () => {
    assert.deepEqual(parseLabels("[a, b, c]"), ["a", "b", "c"]);
  });

  it("strips quotes", () => {
    assert.deepEqual(parseLabels(`["a", 'b']`), ["a", "b"]);
  });

  it("returns [] for malformed input", () => {
    assert.deepEqual(parseLabels("not-an-array"), []);
    assert.deepEqual(parseLabels("[]"), []);
  });
});

describe("parseSource", () => {
  it("returns manual default for missing input", () => {
    const s = parseSource(undefined);
    assert.equal(s.type, "manual");
    assert.equal(s.url, null);
  });

  it("parses inline-flow with quoted URL containing commas", () => {
    const s = parseSource(
      `{ type: github, url: "https://x.com/foo,bar", id: "owner/repo#42", fetched-at: "2026-04-30T12:00:00Z" }`,
    );
    assert.equal(s.type, "github");
    assert.equal(s.url, "https://x.com/foo,bar");
    assert.equal(s.id, "owner/repo#42");
    assert.ok(s.fetchedAt instanceof Date);
  });

  it("treats malformed payload as manual", () => {
    const s = parseSource("not-an-object");
    assert.equal(s.type, "manual");
  });
});
