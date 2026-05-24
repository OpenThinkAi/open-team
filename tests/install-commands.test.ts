/**
 * Tests for AGT-426: oteam install-commands subcommand and installRolePipelineSlashCommand
 * structured result.
 *
 * Covers:
 * - installer returns per-file structured results (written/skipped/failed)
 * - idempotent re-run reports no writes (skipped, not written)
 * - a forced write failure surfaces in failed[] with an error
 * - index.ts registers the install-commands subcommand (BUNDLED check)
 * - package.json carries the postinstall hook
 */
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
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installRolePipelineSlashCommand,
  BUNDLED_COMMANDS,
} from "../src/role-pipeline/install-slash-command.ts";

let savedHome: string | undefined;
let savedConfigDir: string | undefined;
let fakeHome = "";

beforeEach(() => {
  savedHome = process.env.HOME;
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  // realpathSync collapses /var → /private/var on macOS so paths match
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "oteam-install-home-")));
  process.env.HOME = fakeHome;
  // Clear CLAUDE_CONFIG_DIR so it doesn't bleed across tests
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(fakeHome, { recursive: true, force: true });
});

// Helper: count bundled commands whose source exists on disk (i.e., built dist/).
// In dev mode (no build), sources may not exist — tests gracefully skip counts.
function countAvailableSrc(): number {
  return BUNDLED_COMMANDS.filter((c) => existsSync(c.src)).length;
}

describe("installRolePipelineSlashCommand — structured result (AGT-426)", () => {
  it("returns an object with written/skipped/failed arrays", () => {
    const result = installRolePipelineSlashCommand();
    assert.ok(Array.isArray(result.written), "result.written must be an array");
    assert.ok(Array.isArray(result.skipped), "result.skipped must be an array");
    assert.ok(Array.isArray(result.failed), "result.failed must be an array");
  });

  it("writes files on first run and reports them in written[]", () => {
    const available = countAvailableSrc();
    if (available === 0) {
      // No built sources available (dev without build) — skip count assertions
      return;
    }
    const result = installRolePipelineSlashCommand();
    const targetDir = join(fakeHome, ".claude", "commands");
    assert.ok(existsSync(targetDir), "~/.claude/commands/ should be created");
    // All available commands should appear as written (first run, fresh home)
    assert.equal(
      result.written.length,
      available,
      `expected ${available} written entries on first run`,
    );
    assert.equal(result.skipped.length, 0, "expected no skipped entries on first run");
    assert.equal(result.failed.length, 0, "expected no failures on first run");
  });

  it("is idempotent — re-run reports skipped[], not written[]", () => {
    const available = countAvailableSrc();
    if (available === 0) return;

    // First run
    installRolePipelineSlashCommand();
    // Second run — files already match
    const result = installRolePipelineSlashCommand();
    assert.equal(result.written.length, 0, "no writes expected on idempotent re-run");
    assert.equal(
      result.skipped.length,
      available,
      `expected ${available} skipped entries on re-run`,
    );
    assert.equal(result.failed.length, 0);
  });

  it("surfaces write failures in failed[] without aborting other files", () => {
    const available = countAvailableSrc();
    if (available < 2) return; // need at least two sources to observe partial failure

    const targetDir = join(fakeHome, ".claude", "commands");
    mkdirSync(targetDir, { recursive: true });

    // Make a specific target file unwritable by placing a read-only directory
    // where the file would go, so copyFileSync throws EISDIR.
    const firstDest = BUNDLED_COMMANDS.find((c) => existsSync(c.src))!.dest;
    const blockedPath = join(targetDir, firstDest);
    mkdirSync(blockedPath); // directory where a file is expected → EISDIR on copy

    const result = installRolePipelineSlashCommand();

    // The blocked file should appear in failed[]
    const failedEntry = result.failed.find((f) => f.dest === firstDest);
    assert.ok(failedEntry, `expected ${firstDest} in failed[]`);
    assert.ok(failedEntry.error instanceof Error, "error should be an Error instance");

    // Other files should still be written (best-effort — no fail-fast)
    // At minimum, overall count: written + skipped + failed = available * 1 target
    const total = result.written.length + result.skipped.length + result.failed.length;
    assert.ok(total >= available, "all available files should have a result entry");
  });

  it("result entries carry dir and dest fields", () => {
    const available = countAvailableSrc();
    if (available === 0) return;
    const result = installRolePipelineSlashCommand();
    const all = [...result.written, ...result.skipped];
    for (const entry of all) {
      assert.ok(typeof entry.dir === "string" && entry.dir.length > 0, "dir must be non-empty");
      assert.ok(typeof entry.dest === "string" && entry.dest.length > 0, "dest must be non-empty");
    }
  });
});

describe("install-commands subcommand registration (AGT-426)", () => {
  it("index.ts registers install-commands (visible in oteam --help output)", async () => {
    // Verify via the index source — Commander registers commands by name, and
    // the import must be present. We check the source text rather than spawning
    // the binary (no build required for this assertion).
    const indexSrc = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      indexSrc,
      /buildInstallCommandsCommand/,
      "index.ts must import/call buildInstallCommandsCommand",
    );
    assert.match(
      indexSrc,
      /install-commands/,
      "index.ts must reference the install-commands command name",
    );
  });
});

describe("package.json postinstall hook (AGT-426)", () => {
  it("carries a postinstall script that delegates to install-commands", () => {
    const pkg = JSON.parse(
      readFileSync(
        new URL("../package.json", import.meta.url),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    const postinstall = pkg.scripts["postinstall"];
    assert.ok(postinstall, "package.json must have a postinstall script");
    assert.match(
      postinstall,
      /node dist\/index\.js install-commands/,
      "postinstall must run node dist/index.js install-commands",
    );
    // Must not fail a global install on hiccup — || true
    assert.match(
      postinstall,
      /\|\| true/,
      "postinstall must use || true so a hiccup does not fail the global install",
    );
  });
});
