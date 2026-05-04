import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapWorkspace,
  defaultWorkspacePath,
  SENTINEL_FILENAME,
  WORKSPACE_SUBDIRS,
  WorkspaceConflictError,
} from "../src/lib/workspace-tree.ts";

let savedHome: string | undefined;
let fakeHome = "";

beforeEach(() => {
  savedHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "oteam-ws-tree-")));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("bootstrapWorkspace", () => {
  it("creates the full tree, sentinel, and 00-meta/README.md when target is missing", () => {
    const target = join(fakeHome, "openteam");
    const result = bootstrapWorkspace(target);

    assert.equal(result.outcome, "created");
    assert.equal(result.path, target);

    for (const sub of WORKSPACE_SUBDIRS) {
      assert.ok(existsSync(join(target, sub)), `missing ${sub}`);
    }
    assert.ok(existsSync(join(target, "00-meta", "README.md")));
    assert.ok(existsSync(join(target, SENTINEL_FILENAME)));

    // Sentinel content is intentionally JSON so we can evolve it later.
    const sentinel = JSON.parse(
      readFileSync(join(target, SENTINEL_FILENAME), "utf8"),
    );
    assert.equal(sentinel.version, 1);
  });

  it("returns already-initialised on a path that already has the sentinel", () => {
    const target = join(fakeHome, "openteam");
    bootstrapWorkspace(target);
    const sentinelBefore = readFileSync(
      join(target, SENTINEL_FILENAME),
      "utf8",
    );

    const second = bootstrapWorkspace(target);
    assert.equal(second.outcome, "already-initialised");

    const sentinelAfter = readFileSync(
      join(target, SENTINEL_FILENAME),
      "utf8",
    );
    assert.equal(sentinelAfter, sentinelBefore, "sentinel must not be rewritten");
  });

  it("treats an empty directory as 'create here' (not a conflict)", () => {
    const target = join(fakeHome, "openteam");
    mkdirSync(target);
    const result = bootstrapWorkspace(target);
    assert.equal(result.outcome, "created");
    assert.ok(existsSync(join(target, SENTINEL_FILENAME)));
  });

  it("ignores leading dotfiles when computing the conflict list", () => {
    // A bare .DS_Store shouldn't block bootstrap. Documented in the spike's
    // risks: dotfiles are invisible enough that the user wouldn't be
    // surprised by silent merge.
    const target = join(fakeHome, "openteam");
    mkdirSync(target);
    writeFileSync(join(target, ".DS_Store"), "");

    const result = bootstrapWorkspace(target);
    assert.equal(result.outcome, "created");
    assert.ok(existsSync(join(target, "tickets", "triage")));
  });

  it("throws WorkspaceConflictError listing the conflicting paths when target is non-empty and unmarked", () => {
    const target = join(fakeHome, "openteam");
    mkdirSync(target);
    writeFileSync(join(target, "random.txt"), "hi\n");
    writeFileSync(join(target, "another.md"), "hi\n");

    let caught: unknown;
    try {
      bootstrapWorkspace(target);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof WorkspaceConflictError);
    const e = caught as WorkspaceConflictError;
    assert.equal(e.path, target);
    const names = [...e.conflictingPaths].sort();
    assert.deepEqual(names, ["another.md", "random.txt"]);
    assert.match(e.message, /random\.txt/);
    assert.match(e.message, /another\.md/);
    assert.equal(existsSync(join(target, SENTINEL_FILENAME)), false);
    assert.equal(existsSync(join(target, "tickets")), false);
  });

  it("expands ~/ to $HOME", () => {
    const result = bootstrapWorkspace("~/openteam");
    assert.equal(result.path, join(fakeHome, "openteam"));
  });
});

describe("defaultWorkspacePath", () => {
  it("returns ~/openteam under the current $HOME", () => {
    assert.equal(defaultWorkspacePath(), join(fakeHome, "openteam"));
  });
});
