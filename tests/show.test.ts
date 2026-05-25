import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShow } from "../src/commands/show.ts";

const TICKET = `---
id: AGT-077
title: "Show me the ticket"
state: refined
team: engineering
created: 2026-05-01
updated: 2026-05-10
project: open-team
repo: OpenThinkAi/open-team
linked-github: https://github.com/OpenThinkAi/open-team/issues/9
linked-pr:
priority: high
labels: [bug, feature]
source: { type: github, url: "https://github.com/OpenThinkAi/open-team/issues/9", id: "OpenThinkAi/open-team#9", fetched-at: "2026-05-01T00:00:00Z" }
---

## Problem Statement

Body text.

## Comments

### 2026-05-01 — Filed via /file-ticket
First comment.

### 2026-05-10 — Engineering — spike
Second and most recent comment.
Has a second line.
`;

function seed(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "vault-show-"));
  mkdirSync(join(root, "tickets", "refined"), { recursive: true });
  mkdirSync(join(root, "archive", "2026-04"), { recursive: true });
  writeFileSync(join(root, "tickets", "refined", "AGT-077-show.md"), TICKET);
  writeFileSync(
    join(root, "archive", "2026-04", "AGT-009-old.md"),
    TICKET.replace("AGT-077", "AGT-009").replace("state: refined", "state: done"),
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("runShow", () => {
  it("prints frontmatter fields and the most recent comment for an AGT id", () => {
    const { root, cleanup } = seed();
    try {
      const out = runShow({ vault: root, idOrPath: "AGT-077" });
      assert.match(out, /id\s+AGT-077/);
      assert.match(out, /title\s+Show me the ticket/); // quotes stripped
      assert.match(out, /state\s+refined/);
      assert.match(out, /repo\s+OpenThinkAi\/open-team/);
      assert.match(out, /priority\s+high/);
      assert.match(out, /labels\s+\[bug, feature\]/);
      // most recent comment shown, not the first
      assert.match(out, /### 2026-05-10 — Engineering — spike/);
      assert.match(out, /Has a second line\./);
      assert.doesNotMatch(out, /First comment\./);
    } finally {
      cleanup();
    }
  });

  it("omits empty frontmatter fields (linked-pr)", () => {
    const { root, cleanup } = seed();
    try {
      const out = runShow({ vault: root, idOrPath: "AGT-077" });
      assert.doesNotMatch(out, /^linked-pr/m);
    } finally {
      cleanup();
    }
  });

  it("finds a ticket under archive/YYYY-MM/", () => {
    const { root, cleanup } = seed();
    try {
      const out = runShow({ vault: root, idOrPath: "AGT-009" });
      assert.match(out, /id\s+AGT-009/);
      assert.match(out, /state\s+done/);
    } finally {
      cleanup();
    }
  });

  it("accepts a full file path", () => {
    const { root, cleanup } = seed();
    try {
      const path = join(root, "tickets", "refined", "AGT-077-show.md");
      const out = runShow({ vault: root, idOrPath: path });
      assert.match(out, /id\s+AGT-077/);
    } finally {
      cleanup();
    }
  });

  it("throws naming the searched roots on unknown id", () => {
    const { root, cleanup } = seed();
    try {
      let caught: Error | null = null;
      try {
        runShow({ vault: root, idOrPath: "AGT-999" });
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught, "expected throw");
      assert.match(caught!.message, /no ticket file matching AGT-999/);
      assert.match(caught!.message, /tickets/);
      assert.match(caught!.message, /archive/);
    } finally {
      cleanup();
    }
  });

  it("rejects a non-id, non-existent path", () => {
    const { root, cleanup } = seed();
    try {
      assert.throws(
        () => runShow({ vault: root, idOrPath: "not-a-real-thing" }),
        /neither an AGT-NNN id nor an existing file path/,
      );
    } finally {
      cleanup();
    }
  });
});
