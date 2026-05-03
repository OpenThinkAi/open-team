import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGithubUrl, buildStampUrl, readStampServerConfig } from "../src/lib/stamp.ts";

const ORIGINAL_HOME = process.env.HOME;

describe("readStampServerConfig", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "stamp-home-"));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("returns null when ~/.stamp/server.yml is missing", () => {
    assert.equal(readStampServerConfig(), null);
  });

  it("parses host and port from a well-formed file", () => {
    mkdirSync(join(fakeHome, ".stamp"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".stamp", "server.yml"),
      "host: roundhouse.proxy.rlwy.net\nport: 45830\n",
    );
    assert.deepEqual(readStampServerConfig(), {
      host: "roundhouse.proxy.rlwy.net",
      port: 45830,
    });
  });

  it("ignores extra keys and trailing whitespace", () => {
    mkdirSync(join(fakeHome, ".stamp"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".stamp", "server.yml"),
      "# comment\nhost: example.com   \nport: 22\nuser: ignored\n",
    );
    assert.deepEqual(readStampServerConfig(), {
      host: "example.com",
      port: 22,
    });
  });

  it("throws when host is missing", () => {
    mkdirSync(join(fakeHome, ".stamp"), { recursive: true });
    writeFileSync(join(fakeHome, ".stamp", "server.yml"), "port: 45830\n");
    assert.throws(() => readStampServerConfig(), /missing required keys/);
  });

  it("throws when port is missing", () => {
    mkdirSync(join(fakeHome, ".stamp"), { recursive: true });
    writeFileSync(join(fakeHome, ".stamp", "server.yml"), "host: example.com\n");
    assert.throws(() => readStampServerConfig(), /missing required keys/);
  });

  it("throws when port is not a positive integer", () => {
    mkdirSync(join(fakeHome, ".stamp"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".stamp", "server.yml"),
      "host: example.com\nport: not-a-number\n",
    );
    assert.throws(() => readStampServerConfig(), /missing required keys/);
  });
});

describe("buildStampUrl", () => {
  it("builds the canonical ssh URL", () => {
    assert.equal(
      buildStampUrl({ host: "roundhouse.proxy.rlwy.net", port: 45830 }, "think-cli"),
      "ssh://git@roundhouse.proxy.rlwy.net:45830/srv/git/think-cli.git",
    );
  });
});

describe("buildGithubUrl", () => {
  it("builds an ssh github URL from a slug", () => {
    assert.equal(
      buildGithubUrl("OpenThinkAi/think-cli"),
      "git@github.com:OpenThinkAi/think-cli.git",
    );
  });
});
