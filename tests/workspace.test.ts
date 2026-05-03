import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gcOrphanWorkspaces,
  prepareAgentWorkspace,
  StampGateError,
  type CloneResult,
  type CloneRunner,
} from "../src/lib/workspace.ts";

const ORIGINAL_HOME = process.env.HOME;

interface FakeCloneCall {
  url: string;
  dest: string;
}

function recordCloneRunner(
  result: CloneResult,
  calls: FakeCloneCall[] = [],
): CloneRunner {
  return (url, dest) => {
    calls.push({ url, dest });
    if (result.status === 0) {
      // Materialise the dest dir so downstream callers see the same shape a
      // real `git clone` would leave behind.
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "README.md"), "stub clone\n");
    }
    return result;
  };
}

function withFakeStampHome(host: string, port: number): string {
  const fakeHome = mkdtempSync(join(tmpdir(), "stamp-home-"));
  mkdirSync(join(fakeHome, ".stamp"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".stamp", "server.yml"),
    `host: ${host}\nport: ${port}\n`,
  );
  process.env.HOME = fakeHome;
  return fakeHome;
}

describe("prepareAgentWorkspace", () => {
  let fakeHome: string | null = null;
  let rootDir: string;

  beforeEach(() => {
    fakeHome = null;
    rootDir = mkdtempSync(join(tmpdir(), "oteam-ws-"));
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("clones from the stamp URL when stamp is configured and clone succeeds", () => {
    fakeHome = withFakeStampHome("stamp.example.com", 22000);
    const calls: FakeCloneCall[] = [];
    const out = prepareAgentWorkspace({
      ticketId: "AGT-001",
      repoSlug: "OpenThinkAi/think-cli",
      noStamp: false,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }, calls),
      rootDir,
    });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(
      call.url,
      "ssh://git@stamp.example.com:22000/srv/git/think-cli.git",
    );
    assert.equal(call.dest, join(rootDir, "agt-001", "repo"));
    assert.equal(out.path, join(rootDir, "agt-001", "repo"));
    assert.equal(out.source, "stamp");
    assert.equal(
      out.originUrl,
      "ssh://git@stamp.example.com:22000/srv/git/think-cli.git",
    );
    assert.ok(existsSync(out.path));
  });

  it("throws StampGateError when ~/.stamp/server.yml is missing", () => {
    fakeHome = mkdtempSync(join(tmpdir(), "stamp-home-no-config-"));
    process.env.HOME = fakeHome;
    const calls: FakeCloneCall[] = [];
    let caught: unknown;
    try {
      prepareAgentWorkspace({
        ticketId: "AGT-002",
        repoSlug: "OpenThinkAi/no-config",
        noStamp: false,
        cloneRunner: recordCloneRunner({ status: 0, stderr: "" }, calls),
        rootDir,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof StampGateError);
    assert.equal(calls.length, 0, "no clone should be attempted");
    const msg = (caught as StampGateError).message;
    assert.match(msg, /OpenThinkAi\/no-config/);
    assert.match(msg, /not stamp-governed/);
    assert.match(msg, /stamp provision no-config/);
    assert.match(msg, /--no-stamp/);
  });

  it("throws StampGateError when the stamp clone fails", () => {
    fakeHome = withFakeStampHome("stamp.example.com", 22000);
    const calls: FakeCloneCall[] = [];
    let caught: unknown;
    try {
      prepareAgentWorkspace({
        ticketId: "AGT-003",
        repoSlug: "OpenThinkAi/local-only",
        noStamp: false,
        cloneRunner: recordCloneRunner(
          { status: 128, stderr: "fatal: repository not found\n" },
          calls,
        ),
        rootDir,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof StampGateError);
    assert.equal(calls.length, 1);
    const msg = (caught as StampGateError).message;
    assert.match(msg, /OpenThinkAi\/local-only/);
    assert.match(msg, /git clone exited 128/);
    assert.match(msg, /repository not found/);
  });

  it("falls back to GitHub when --no-stamp is set", () => {
    // No stamp config at all — --no-stamp should not even consult it.
    fakeHome = mkdtempSync(join(tmpdir(), "stamp-home-no-config-"));
    process.env.HOME = fakeHome;
    const calls: FakeCloneCall[] = [];
    const out = prepareAgentWorkspace({
      ticketId: "AGT-004",
      repoSlug: "OpenThinkAi/plain",
      noStamp: true,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }, calls),
      rootDir,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "git@github.com:OpenThinkAi/plain.git");
    assert.equal(out.source, "github");
  });

  it("rm -rf's a prior workspace before re-cloning (hermetic re-runs)", () => {
    fakeHome = withFakeStampHome("stamp.example.com", 22000);
    const ticketDir = join(rootDir, "agt-005");
    mkdirSync(join(ticketDir, "repo"), { recursive: true });
    writeFileSync(join(ticketDir, "repo", "stale.txt"), "from a prior run\n");

    const calls: FakeCloneCall[] = [];
    const out = prepareAgentWorkspace({
      ticketId: "AGT-005",
      repoSlug: "OpenThinkAi/foo",
      noStamp: false,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }, calls),
      rootDir,
    });
    assert.equal(out.path, join(ticketDir, "repo"));
    assert.equal(
      existsSync(join(ticketDir, "repo", "stale.txt")),
      false,
      "stale file from a prior run must not survive",
    );
    assert.equal(
      readFileSync(join(out.path, "README.md"), "utf8"),
      "stub clone\n",
    );
  });

  it("never touches $HOME/Development (AC #4 byte-equal smoke)", () => {
    // We can't directly assert on the user's real ~/Development, but we can
    // assert the function reads/writes only paths under HOME/.stamp and the
    // explicit rootDir. Spying on those is enough: a fake HOME with NO
    // ~/Development inside it would crash if the prep tried to read that
    // path. (And the explicit rootDir is well outside $HOME.)
    fakeHome = withFakeStampHome("stamp.example.com", 22000);
    // Intentionally leave HOME without Development/ — if the impl stays
    // disciplined, this still succeeds.
    prepareAgentWorkspace({
      ticketId: "AGT-006",
      repoSlug: "OpenThinkAi/x",
      noStamp: false,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }),
      rootDir,
    });
    assert.equal(
      existsSync(join(fakeHome, "Development")),
      false,
      "prepareAgentWorkspace must not create $HOME/Development",
    );
  });

  it("runs the GC sweep when activeTicketIds is provided", () => {
    fakeHome = withFakeStampHome("stamp.example.com", 22000);
    // Seed two stale workspaces and one matching the active set.
    mkdirSync(join(rootDir, "agt-013", "repo"), { recursive: true });
    mkdirSync(join(rootDir, "agt-014", "repo"), { recursive: true });
    mkdirSync(join(rootDir, "agt-007", "repo"), { recursive: true });
    mkdirSync(join(rootDir, "stamp-cli-fix"), { recursive: true });

    prepareAgentWorkspace({
      ticketId: "AGT-007",
      repoSlug: "OpenThinkAi/x",
      noStamp: false,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }),
      activeTicketIds: new Set(["agt-007"]),
      rootDir,
    });

    assert.equal(
      existsSync(join(rootDir, "agt-013")),
      false,
      "orphan agt-013 should be swept",
    );
    assert.equal(
      existsSync(join(rootDir, "agt-014")),
      false,
      "orphan agt-014 should be swept",
    );
    // agt-007 is recreated (active + this run's target), so it must exist.
    assert.equal(existsSync(join(rootDir, "agt-007", "repo")), true);
    // Non-AGT dirs are left alone — only `agt-N+` are swept.
    assert.equal(
      existsSync(join(rootDir, "stamp-cli-fix")),
      true,
      "non-ticket dirs should not be swept",
    );
  });
});

describe("gcOrphanWorkspaces", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "oteam-gc-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("removes only AGT-shaped dirs whose id is not in activeTicketIds", () => {
    mkdirSync(join(rootDir, "agt-001"), { recursive: true });
    mkdirSync(join(rootDir, "agt-042"), { recursive: true });
    mkdirSync(join(rootDir, "agt-099"), { recursive: true });
    mkdirSync(join(rootDir, "scratch"), { recursive: true });

    const removed = gcOrphanWorkspaces(rootDir, new Set(["agt-042"]));
    const removedBasenames = removed.map((p) => p.split("/").pop()).sort();
    assert.deepEqual(removedBasenames, ["agt-001", "agt-099"]);
    assert.equal(existsSync(join(rootDir, "agt-001")), false);
    assert.equal(existsSync(join(rootDir, "agt-042")), true);
    assert.equal(existsSync(join(rootDir, "agt-099")), false);
    assert.equal(existsSync(join(rootDir, "scratch")), true);
  });

  it("returns [] when the root dir doesn't exist", () => {
    rmSync(rootDir, { recursive: true, force: true });
    assert.deepEqual(gcOrphanWorkspaces(rootDir, new Set()), []);
  });
});

describe("prepareAgentWorkspace input validation", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "oteam-ws-validate-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("refuses to operate on a non-AGT ticket id (path-traversal guard)", () => {
    // Frontmatter could carry a malicious id like "../../.ssh"; the guard
    // throws before any rmSync gets near a path the user didn't intend.
    const calls: FakeCloneCall[] = [];
    const sentinel = join(rootDir, "should-not-be-touched");
    mkdirSync(sentinel);
    assert.throws(
      () =>
        prepareAgentWorkspace({
          ticketId: "../../.ssh",
          repoSlug: "OpenThinkAi/x",
          noStamp: true,
          cloneRunner: recordCloneRunner({ status: 0, stderr: "" }, calls),
          rootDir,
        }),
      /refusing to operate on non-AGT ticket id/,
    );
    assert.equal(calls.length, 0, "no clone should be attempted");
    assert.equal(
      existsSync(sentinel),
      true,
      "sibling dir must remain untouched after a refused call",
    );
  });

  it("refuses ticket ids that don't match AGT-NNN exactly", () => {
    for (const bad of ["agt-001", "AGT-", "AGT-001x", "AGT_001", " AGT-1"]) {
      assert.throws(
        () =>
          prepareAgentWorkspace({
            ticketId: bad,
            repoSlug: "OpenThinkAi/x",
            noStamp: true,
            cloneRunner: recordCloneRunner({ status: 0, stderr: "" }),
            rootDir,
          }),
        /refusing to operate on non-AGT ticket id/,
        `expected throw for ticketId="${bad}"`,
      );
    }
  });
});
