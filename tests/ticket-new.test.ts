import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTicketNew } from "../src/commands/ticket.ts";
import {
  extractFrontmatter,
  parseLabels,
  parseSource,
} from "../src/lib/frontmatter.ts";
import { parseTicket } from "../src/lib/vault.ts";

function makeVault(): { vault: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "vault-ticket-new-"));
  mkdirSync(join(vault, "tickets"), { recursive: true });
  return { vault, cleanup: () => rmSync(vault, { recursive: true, force: true }) };
}

function readTicket(filePath: string): {
  fm: Record<string, string>;
  body: string;
} {
  const raw = readFileSync(filePath, "utf8");
  const fm = extractFrontmatter(raw) ?? {};
  return { fm, body: raw };
}

describe("oteam ticket new", () => {
  it("writes AGT-001 with proper frontmatter into <vault>/tickets/triage/", () => {
    const { vault, cleanup } = makeVault();
    try {
      const result = runTicketNew({
        title: "Improve onboarding flow",
        vault,
      });

      assert.equal(result.ticketID, "AGT-001");
      assert.match(result.path, /tickets\/triage\/AGT-001-improve-onboarding-flow\.md$/);

      const { fm, body } = readTicket(result.path);
      assert.equal(fm.id, "AGT-001");
      assert.equal(fm.title, '"Improve onboarding flow"');
      assert.equal(fm.state, "triage");
      assert.equal(fm.team, "product");
      assert.equal(fm.priority, "medium");
      assert.equal(fm.project, "");
      assert.equal(fm.repo, "");
      assert.equal(fm["blocked-by"], "[]");
      assert.equal(parseLabels(fm["blocked-by"] ?? "[]").length, 0);
      assert.equal(fm["linked-github"], "");
      assert.equal(parseLabels(fm.labels ?? "[]").length, 0);

      const source = parseSource(fm.source);
      assert.equal(source.type, "manual");
      assert.equal(source.url, null);
      assert.equal(source.id, null);

      assert.match(body, /## Problem Statement/);
      assert.match(body, /## Acceptance Criteria/);
      assert.match(body, /## Spike/);
      assert.match(body, /Filed via oteam ticket new/);
    } finally {
      cleanup();
    }
  });

  it("writes the project field when --project is provided", () => {
    const { vault, cleanup } = makeVault();
    try {
      const result = runTicketNew({
        title: "Ship growth playbook v2",
        project: "growth-v2",
        vault,
      });
      const { fm } = readTicket(result.path);
      assert.equal(fm.project, "growth-v2");
    } finally {
      cleanup();
    }
  });

  it("writes the repo field when --repo is provided", () => {
    const { vault, cleanup } = makeVault();
    try {
      const result = runTicketNew({
        title: "Wire repo frontmatter",
        repo: "OpenThinkAi/open-team",
        vault,
      });
      const { fm } = readTicket(result.path);
      assert.equal(fm.repo, "OpenThinkAi/open-team");
    } finally {
      cleanup();
    }
  });

  it("rejects a --repo that isn't an owner/name slug", () => {
    const { vault, cleanup } = makeVault();
    try {
      assert.throws(
        () => runTicketNew({ title: "Bad repo", repo: "not-a-slug", vault }),
        /owner\/name slug/,
      );
    } finally {
      cleanup();
    }
  });

  it("records a single --blocked-by as a structured list that round-trips", () => {
    const { vault, cleanup } = makeVault();
    try {
      const result = runTicketNew({
        title: "Depends on one thing",
        blockedBy: ["AGT-012"],
        vault,
      });
      const { fm } = readTicket(result.path);
      assert.equal(fm["blocked-by"], "[AGT-012]");
      assert.deepEqual(parseLabels(fm["blocked-by"] ?? "[]"), ["AGT-012"]);

      const ticket = parseTicket(result.path);
      assert.ok(ticket);
      assert.deepEqual(ticket.blockedBy, ["AGT-012"]);
    } finally {
      cleanup();
    }
  });

  it("records repeated --blocked-by as a structured list that round-trips", () => {
    const { vault, cleanup } = makeVault();
    try {
      const result = runTicketNew({
        title: "Depends on two things",
        blockedBy: ["AGT-012", "AGT-013"],
        vault,
      });
      const { fm } = readTicket(result.path);
      assert.equal(fm["blocked-by"], "[AGT-012, AGT-013]");

      const ticket = parseTicket(result.path);
      assert.ok(ticket);
      assert.deepEqual(ticket.blockedBy, ["AGT-012", "AGT-013"]);
    } finally {
      cleanup();
    }
  });

  it("rejects a --blocked-by value that isn't an AGT-NNN id", () => {
    const { vault, cleanup } = makeVault();
    try {
      assert.throws(
        () =>
          runTicketNew({ title: "Bad dep", blockedBy: ["nope"], vault }),
        /AGT-NNN id/,
      );
    } finally {
      cleanup();
    }
  });

  it("respects --team, --priority, and --label", () => {
    const { vault, cleanup } = makeVault();
    try {
      const result = runTicketNew({
        title: "Audit auth surface",
        team: "security",
        priority: "high",
        labels: ["auth", "audit"],
        vault,
      });
      const { fm } = readTicket(result.path);
      assert.equal(fm.team, "security");
      assert.equal(fm.priority, "high");
      assert.deepEqual(parseLabels(fm.labels ?? "[]"), ["auth", "audit"]);
    } finally {
      cleanup();
    }
  });

  it("increments past existing tickets in the vault", () => {
    const { vault, cleanup } = makeVault();
    try {
      // Seed an existing ticket so the next ID is AGT-008.
      const seedDir = join(vault, "tickets", "refined");
      mkdirSync(seedDir, { recursive: true });
      writeFileSync(
        join(seedDir, "AGT-007-existing.md"),
        "---\nid: AGT-007\n---\n",
        "utf8",
      );

      const result = runTicketNew({ title: "Next thing", vault });
      assert.equal(result.ticketID, "AGT-008");
    } finally {
      cleanup();
    }
  });

  it("rejects an empty title", () => {
    const { vault, cleanup } = makeVault();
    try {
      assert.throws(() => runTicketNew({ title: "   ", vault }), /must not be empty/);
    } finally {
      cleanup();
    }
  });

  it("rejects a title with no alphanumeric characters", () => {
    const { vault, cleanup } = makeVault();
    try {
      assert.throws(
        () => runTicketNew({ title: "!!!", vault }),
        /empty slug/,
      );
    } finally {
      cleanup();
    }
  });

  it("creates the triage directory if missing", () => {
    const { vault, cleanup } = makeVault();
    try {
      // No tickets/triage/ pre-created.
      const result = runTicketNew({ title: "First ticket", vault });
      assert.match(result.path, /tickets\/triage\/AGT-001-first-ticket\.md$/);
    } finally {
      cleanup();
    }
  });
});
