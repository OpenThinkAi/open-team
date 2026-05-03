import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";

function makeDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oteam-init-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("oteam init", () => {
  it("creates AGENTS.md and CLAUDE.md when neither exists", async () => {
    const { dir, cleanup } = makeDir();
    try {
      const result = await runInit({ dir, yes: true });
      assert.equal(result.agents.result, "created");
      assert.equal(result.claude.result, "created");

      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      assert.match(agents, /oteam:begin/);
      assert.match(agents, /oteam:end/);
      assert.match(agents, /vault-driven role pipeline/);
      assert.match(claude, /oteam:begin/);
      assert.match(claude, /AGENTS\.md/);
    } finally {
      cleanup();
    }
  });

  it("is idempotent: re-running updates the marked block in place without growing the file", async () => {
    const { dir, cleanup } = makeDir();
    try {
      await runInit({ dir, yes: true });
      const firstAgents = readFileSync(join(dir, "AGENTS.md"), "utf8");

      const result = await runInit({ dir, yes: true });
      const secondAgents = readFileSync(join(dir, "AGENTS.md"), "utf8");

      assert.equal(result.agents.result, "updated");
      assert.equal(firstAgents, secondAgents);

      // Sentinel markers must each appear exactly once.
      const beginCount = secondAgents.match(/oteam:begin/g)?.length ?? 0;
      const endCount = secondAgents.match(/oteam:end/g)?.length ?? 0;
      assert.equal(beginCount, 1);
      assert.equal(endCount, 1);
    } finally {
      cleanup();
    }
  });

  it("appends a wrapped block when the existing file has no markers and preserves prior content", async () => {
    const { dir, cleanup } = makeDir();
    try {
      const existing = "# My existing AGENTS.md\n\nProject-specific guidance.\n";
      writeFileSync(join(dir, "AGENTS.md"), existing, "utf8");

      const result = await runInit({ dir, yes: true });
      assert.equal(result.agents.result, "appended");

      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      assert.ok(agents.startsWith(existing), "prior content should be preserved at the top");
      assert.match(agents, /oteam:begin/);
      assert.match(agents, /oteam:end/);
    } finally {
      cleanup();
    }
  });

  it("refreshes appended block on second run (appended → updated)", async () => {
    const { dir, cleanup } = makeDir();
    try {
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# Pre-existing\n\nOriginal text.\n",
        "utf8",
      );

      const first = await runInit({ dir, yes: true });
      assert.equal(first.agents.result, "appended");

      const second = await runInit({ dir, yes: true });
      assert.equal(second.agents.result, "updated");

      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      assert.ok(agents.includes("Original text."));
      assert.equal(agents.match(/oteam:begin/g)?.length ?? 0, 1);
    } finally {
      cleanup();
    }
  });

  it("returns the resolved file paths", async () => {
    const { dir, cleanup } = makeDir();
    try {
      const result = await runInit({ dir, yes: true });
      assert.equal(result.agents.path, join(dir, "AGENTS.md"));
      assert.equal(result.claude.path, join(dir, "CLAUDE.md"));
      assert.ok(existsSync(result.agents.path));
      assert.ok(existsSync(result.claude.path));
    } finally {
      cleanup();
    }
  });
});
