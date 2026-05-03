import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRef } from "../src/ingestors/github.ts";

describe("parseRef", () => {
  it("accepts owner/repo#NN form", () => {
    assert.deepEqual(parseRef("OpenThinkAi/open-team#42"), {
      owner: "OpenThinkAi",
      repo: "open-team",
      number: 42,
    });
  });

  it("accepts an issue URL", () => {
    assert.deepEqual(
      parseRef("https://github.com/OpenThinkAi/open-team/issues/42"),
      { owner: "OpenThinkAi", repo: "open-team", number: 42 },
    );
  });

  it("accepts a pull URL", () => {
    assert.deepEqual(
      parseRef("https://github.com/OpenThinkAi/open-team/pull/7"),
      { owner: "OpenThinkAi", repo: "open-team", number: 7 },
    );
  });

  it("rejects garbage", () => {
    assert.throws(() => parseRef("not-a-ref"), /unrecognized github ref/);
  });
});
