import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigCommand } from "../src/commands/config.ts";

// ---- Helpers ----------------------------------------------------------------

let savedHome: string | undefined;
let fakeHome = "";

function withFakeHome(): void {
  savedHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "oteam-repo-cli-")));
  process.env.HOME = fakeHome;
}

function restoreHome(): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
  fakeHome = "";
}

interface CapturedOutput {
  out: string;
  err: string;
  exitCode: number | null;
}

async function invokeCLI(...args: string[]): Promise<CapturedOutput> {
  let out = "";
  let err = "";
  let exitCode: number | null = null;

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  // Capture stdout/stderr writes (both string and Buffer forms).
  (process.stdout as NodeJS.WriteStream).write = (chunk: unknown) => {
    out += String(chunk);
    return true;
  };
  (process.stderr as NodeJS.WriteStream).write = (chunk: unknown) => {
    err += String(chunk);
    return true;
  };
  // Capture exit code but don't actually exit.
  (process as NodeJS.Process).exit = ((code?: number | string | null) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`__process_exit__${exitCode}`);
  }) as typeof process.exit;

  try {
    // buildConfigCommand() returns the "config" command. Parse args as if they
    // are subcommands of "config" — so the first real arg is the sub-subcommand
    // name ("repo", "vault", etc.), not "config" again.
    const cmd = buildConfigCommand();
    cmd.exitOverride(); // prevent Commander from calling process.exit on errors
    await cmd.parseAsync(["node", "oteam", ...args]);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith("__process_exit__")) {
      // already captured
    } else if (
      e instanceof Error &&
      (e as { code?: string }).code === "commander.unknownCommand"
    ) {
      err += e.message;
      exitCode = 1;
    } else if (e instanceof Error) {
      throw e;
    }
  } finally {
    (process.stdout as NodeJS.WriteStream).write = origOut;
    (process.stderr as NodeJS.WriteStream).write = origErr;
    (process as NodeJS.Process).exit = origExit;
  }

  return { out, err, exitCode };
}

// ---- Tests ------------------------------------------------------------------

describe("oteam config repo add", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("records a new repo entry and prints confirmation", async () => {
    const { out, exitCode } = await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "git@github.com:OpenThinkAi/open-team.git",
    );
    assert.equal(exitCode, null);
    assert.match(out, /OpenThinkAi\/open-team/);
    assert.match(out, /git@github\.com:OpenThinkAi\/open-team\.git/);
  });

  it("second add overwrites the URI (idempotent upsert)", async () => {
    await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "git@github.com:OpenThinkAi/open-team.git",
    );
    const { out } = await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "ssh://git@stamp.example.com:22000/srv/git/open-team.git",
    );
    assert.match(out, /ssh:\/\/git@stamp\.example\.com/);
  });
});

describe("oteam config repo set", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("updates the clone URI for an existing entry", async () => {
    await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "git@github.com:OpenThinkAi/open-team.git",
    );
    const { out, exitCode } = await invokeCLI(
      "repo",
      "set",
      "OpenThinkAi/open-team",
      "--clone-uri",
      "ssh://git@stamp.example.com:22000/srv/git/open-team.git",
    );
    assert.equal(exitCode, null);
    assert.match(out, /ssh:\/\/git@stamp\.example\.com/);
  });

  it("errors when --clone-uri is not passed", async () => {
    const { err, exitCode } = await invokeCLI(
      "repo",
      "set",
      "OpenThinkAi/open-team",
    );
    assert.ok(exitCode !== null && exitCode > 0);
    assert.match(err, /--clone-uri/);
  });
});

describe("oteam config repo show", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("prints entry details after add", async () => {
    await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "git@github.com:OpenThinkAi/open-team.git",
    );
    const { out, exitCode } = await invokeCLI("repo", "show", "OpenThinkAi/open-team");
    assert.equal(exitCode, null);
    assert.match(out, /clone-uri:/);
    assert.match(out, /git@github\.com:OpenThinkAi\/open-team\.git/);
    assert.match(out, /added:/);
  });

  it("prints a not-found message for an unknown slug", async () => {
    const { out } = await invokeCLI("repo", "show", "OpenThinkAi/missing");
    assert.match(out, /no entry for/);
  });

  it("is case-insensitive", async () => {
    await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "git@github.com:OpenThinkAi/open-team.git",
    );
    const { out } = await invokeCLI("repo", "show", "openthinkAI/OPEN-TEAM");
    assert.match(out, /git@github\.com:OpenThinkAi\/open-team\.git/);
  });
});

describe("oteam config repo list", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("shows empty message when no repos registered", async () => {
    const { out } = await invokeCLI("repo", "list");
    assert.match(out, /no repos registered/);
  });

  it("shows all registered repos", async () => {
    await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "git@github.com:OpenThinkAi/open-team.git",
    );
    await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/stamp-cli",
      "git@github.com:OpenThinkAi/stamp-cli.git",
    );
    const { out } = await invokeCLI("repo", "list");
    assert.match(out, /OpenThinkAi\/open-team/);
    assert.match(out, /OpenThinkAi\/stamp-cli/);
  });
});

describe("oteam config repo remove", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("removes an existing entry", async () => {
    await invokeCLI(
      "repo",
      "add",
      "OpenThinkAi/open-team",
      "git@github.com:OpenThinkAi/open-team.git",
    );
    const { out: removeOut } = await invokeCLI("repo", "remove", "OpenThinkAi/open-team");
    assert.match(removeOut, /removed/i);

    const { out: showOut } = await invokeCLI("repo", "show", "OpenThinkAi/open-team");
    assert.match(showOut, /no entry for/);
  });

  it("is idempotent — removing a nonexistent slug doesn't error", async () => {
    const { out, exitCode } = await invokeCLI("repo", "remove", "OpenThinkAi/missing");
    assert.equal(exitCode, null);
    assert.match(out, /nothing to remove/i);
  });
});

describe("oteam config push (AGT-099)", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("show prints the default 'on' description before any set", async () => {
    const { out, exitCode } = await invokeCLI("push", "show");
    assert.equal(exitCode, null);
    assert.match(out, /^push: on \(default\)/);
    assert.match(out, /assigns push to origin after merge/);
  });

  it("set off then show prints the 'off' description", async () => {
    const { out: setOut, exitCode } = await invokeCLI("push", "set", "off");
    assert.equal(exitCode, null);
    assert.match(setOut, /push off/);
    const { out: showOut } = await invokeCLI("push", "show");
    assert.match(showOut, /^push: off/);
    assert.match(showOut, /user pushes manually/);
  });

  it("set on after off flips back and show reflects it", async () => {
    await invokeCLI("push", "set", "off");
    const { out } = await invokeCLI("push", "set", "on");
    assert.match(out, /push on/);
    const { out: showOut } = await invokeCLI("push", "show");
    assert.match(showOut, /^push: on \(default\)/);
  });

  it("set is idempotent — repeating the same value does not error (AC #5)", async () => {
    const { exitCode: first } = await invokeCLI("push", "set", "on");
    const { exitCode: second } = await invokeCLI("push", "set", "on");
    assert.equal(first, null);
    assert.equal(second, null);
  });

  it("rejects an unrecognised value", async () => {
    const { err, exitCode } = await invokeCLI("push", "set", "wat");
    assert.ok(exitCode !== null && exitCode > 0);
    assert.match(err, /expected on\|off/);
  });
});
