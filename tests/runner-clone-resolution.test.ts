import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NoTTYError, promptCloneUri } from "../src/lib/prompt-clone-uri.ts";
import { StampEnforceError } from "../src/role-pipeline/runner.ts";

describe("NoTTYError", () => {
  it("has the right name and slug field", () => {
    const err = new NoTTYError("OpenThinkAi/open-team");
    assert.equal(err.name, "NoTTYError");
    assert.equal(err.slug, "OpenThinkAi/open-team");
    assert.ok(err instanceof Error);
  });

  it("message names the slug and shows remediation", () => {
    const err = new NoTTYError("Acme/widget");
    assert.match(err.message, /Acme\/widget/);
    assert.match(err.message, /oteam config repo add/);
  });
});

describe("StampEnforceError", () => {
  it("has the right name, slug, and uri fields", () => {
    const err = new StampEnforceError({
      slug: "OpenThinkAi/open-team",
      uri: "git@github.com:OpenThinkAi/open-team.git",
      stampHost: "ssh://git@stamp.example.com:22000",
    });
    assert.equal(err.name, "StampEnforceError");
    assert.equal(err.slug, "OpenThinkAi/open-team");
    assert.equal(err.uri, "git@github.com:OpenThinkAi/open-team.git");
    assert.ok(err instanceof Error);
  });

  it("message names slug, uri, stampHost, and shows remediations", () => {
    const err = new StampEnforceError({
      slug: "Acme/widget",
      uri: "git@github.com:Acme/widget.git",
      stampHost: "ssh://git@stamp.acme.com:22000",
    });
    assert.match(err.message, /Acme\/widget/);
    assert.match(err.message, /git@github\.com:Acme\/widget\.git/);
    assert.match(err.message, /ssh:\/\/git@stamp\.acme\.com:22000/);
    assert.match(err.message, /oteam config repo set/);
    assert.match(err.message, /--no-stamp/);
  });
});

describe("promptCloneUri", () => {
  it("returns defaultUri silently on non-TTY + 'default' policy", async () => {
    const result = await promptCloneUri(
      "OpenThinkAi/open-team",
      "https://github.com/OpenThinkAi/open-team.git",
      { isTTY: false },
      "default",
    );
    assert.equal(result.uri, "https://github.com/OpenThinkAi/open-team.git");
    assert.equal(result.recorded, true);
  });

  it("throws NoTTYError on non-TTY + 'refuse' policy", async () => {
    await assert.rejects(
      () =>
        promptCloneUri(
          "OpenThinkAi/open-team",
          "https://github.com/OpenThinkAi/open-team.git",
          { isTTY: false },
          "refuse",
        ),
      NoTTYError,
    );
  });

  it("uses the typed answer when one is provided", async () => {
    const result = await promptCloneUri(
      "OpenThinkAi/open-team",
      "https://github.com/OpenThinkAi/open-team.git",
      {
        isTTY: true,
        readLine: async () => "ssh://git@stamp.example.com:22000/srv/git/open-team.git",
      },
      "refuse",
    );
    assert.equal(result.uri, "ssh://git@stamp.example.com:22000/srv/git/open-team.git");
  });

  it("falls back to defaultUri when the user presses enter with no input", async () => {
    const result = await promptCloneUri(
      "OpenThinkAi/open-team",
      "https://github.com/OpenThinkAi/open-team.git",
      {
        isTTY: true,
        readLine: async () => "   ",
      },
      "refuse",
    );
    assert.equal(result.uri, "https://github.com/OpenThinkAi/open-team.git");
  });
});
