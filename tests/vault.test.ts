import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTicket, readAllTickets } from "../src/lib/vault.ts";

const SAMPLE = `---
id: AGT-042
title: "Sample ticket title"
state: refined
team: engineering
created: 2026-04-30
updated: 2026-05-01
repo: OpenThinkAi/open-team
linked-github: https://github.com/x/y/issues/9
linked-pr:
priority: high
labels: [foo, bar]
source: { type: github, url: "https://github.com/x/y/issues/9", id: "x/y#9", fetched-at: "2026-04-30T12:00:00Z" }
---

## Problem Statement

body here
`;

describe("parseTicket", () => {
  it("round-trips a known ticket", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      const path = join(root, "AGT-042-x.md");
      writeFileSync(path, SAMPLE);
      const t = parseTicket(path);
      assert.ok(t);
      assert.equal(t.id, "AGT-042");
      assert.equal(t.numericID, 42);
      assert.equal(t.title, "Sample ticket title");
      assert.equal(t.state, "refined");
      assert.equal(t.team, "engineering");
      assert.equal(t.repo, "OpenThinkAi/open-team");
      assert.equal(t.linkedGitHub, "https://github.com/x/y/issues/9");
      assert.equal(t.linkedPR, null);
      assert.equal(t.priority, "high");
      assert.deepEqual(t.labels, ["foo", "bar"]);
      assert.equal(t.source.type, "github");
      assert.equal(t.source.id, "x/y#9");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("returns null for missing required fields", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      const path = join(root, "broken.md");
      writeFileSync(path, "---\ntitle: no id\n---\n");
      assert.equal(parseTicket(path), null);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("readAllTickets", () => {
  it("reads tickets across state subfolders, skips archive", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      mkdirSync(join(root, "tickets", "refined"), { recursive: true });
      writeFileSync(join(root, "tickets", "triage", "AGT-001-a.md"), SAMPLE.replace("AGT-042", "AGT-001"));
      writeFileSync(join(root, "tickets", "refined", "AGT-002-b.md"), SAMPLE.replace("AGT-042", "AGT-002"));
      const tickets = readAllTickets(root);
      assert.equal(tickets.length, 2);
      const ids = tickets.map((t) => t.id).sort();
      assert.deepEqual(ids, ["AGT-001", "AGT-002"]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
