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

function withFakeHome(): string {
  const fakeHome = mkdtempSync(join(tmpdir(), "oteam-home-"));
  process.env.HOME = fakeHome;
  return fakeHome;
}

const STAMP_URI = "ssh://git@stamp.example.com:22000/srv/git/open-team.git";
const GITHUB_URI = "git@github.com:OpenThinkAi/open-team.git";

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

  it("clones from the supplied cloneUri on success", () => {
    fakeHome = withFakeHome();
    const calls: FakeCloneCall[] = [];
    const out = prepareAgentWorkspace({
      ticketId: "AGT-001",
      repoSlug: "OpenThinkAi/open-team",
      cloneUri: STAMP_URI,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }, calls),
      rootDir,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, STAMP_URI);
    assert.equal(calls[0]!.dest, join(rootDir, "agt-001", "repo"));
    assert.equal(out.path, join(rootDir, "agt-001", "repo"));
    assert.equal(out.originUrl, STAMP_URI);
    assert.ok(existsSync(out.path));
  });

  it("works with a GitHub SSH URI", () => {
    fakeHome = withFakeHome();
    const calls: FakeCloneCall[] = [];
    const out = prepareAgentWorkspace({
      ticketId: "AGT-004",
      repoSlug: "OpenThinkAi/plain",
      cloneUri: GITHUB_URI,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }, calls),
      rootDir,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, GITHUB_URI);
    assert.equal(out.originUrl, GITHUB_URI);
  });

  it("throws a plain Error when the clone fails", () => {
    fakeHome = withFakeHome();
    let caught: unknown;
    try {
      prepareAgentWorkspace({
        ticketId: "AGT-003",
        repoSlug: "OpenThinkAi/local-only",
        cloneUri: STAMP_URI,
        cloneRunner: recordCloneRunner(
          { status: 128, stderr: "fatal: repository not found\n" },
        ),
        rootDir,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /clone failed/);
    assert.match((caught as Error).message, /fatal: repository not found/);
  });

  it("rm -rf's a prior workspace before re-cloning (hermetic re-runs)", () => {
    fakeHome = withFakeHome();
    const ticketDir = join(rootDir, "agt-005");
    mkdirSync(join(ticketDir, "repo"), { recursive: true });
    writeFileSync(join(ticketDir, "repo", "stale.txt"), "from a prior run\n");

    const out = prepareAgentWorkspace({
      ticketId: "AGT-005",
      repoSlug: "OpenThinkAi/foo",
      cloneUri: STAMP_URI,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }),
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

  it("never touches $HOME/Development", () => {
    fakeHome = withFakeHome();
    prepareAgentWorkspace({
      ticketId: "AGT-006",
      repoSlug: "OpenThinkAi/x",
      cloneUri: STAMP_URI,
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
    fakeHome = withFakeHome();
    mkdirSync(join(rootDir, "agt-013", "repo"), { recursive: true });
    mkdirSync(join(rootDir, "agt-014", "repo"), { recursive: true });
    mkdirSync(join(rootDir, "agt-007", "repo"), { recursive: true });
    mkdirSync(join(rootDir, "stamp-cli-fix"), { recursive: true });

    prepareAgentWorkspace({
      ticketId: "AGT-007",
      repoSlug: "OpenThinkAi/x",
      cloneUri: STAMP_URI,
      cloneRunner: recordCloneRunner({ status: 0, stderr: "" }),
      activeTicketIds: new Set(["agt-007"]),
      rootDir,
    });

    assert.equal(existsSync(join(rootDir, "agt-013")), false, "orphan agt-013 should be swept");
    assert.equal(existsSync(join(rootDir, "agt-014")), false, "orphan agt-014 should be swept");
    assert.equal(existsSync(join(rootDir, "agt-007", "repo")), true);
    assert.equal(existsSync(join(rootDir, "stamp-cli-fix")), true, "non-ticket dirs should not be swept");
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
    const calls: FakeCloneCall[] = [];
    const sentinel = join(rootDir, "should-not-be-touched");
    mkdirSync(sentinel);
    assert.throws(
      () =>
        prepareAgentWorkspace({
          ticketId: "../../.ssh",
          repoSlug: "OpenThinkAi/x",
          cloneUri: GITHUB_URI,
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
            cloneUri: GITHUB_URI,
            cloneRunner: recordCloneRunner({ status: 0, stderr: "" }),
            rootDir,
          }),
        /refusing to operate on non-AGT ticket id/,
        `expected throw for ticketId="${bad}"`,
      );
    }
  });
});
