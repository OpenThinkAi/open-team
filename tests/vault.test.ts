import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findTicketFileByID,
  isAgtId,
  parseTicket,
  readAllTickets,
  resolveVault,
} from "../src/lib/vault.ts";
import { runList } from "../src/commands/list.ts";

const SAMPLE = `---
id: AGT-042
title: "Sample ticket title"
state: refined
team: engineering
created: 2026-04-30
updated: 2026-05-01
project: open-team
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
      assert.equal(t.project, "open-team");
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

describe("isAgtId", () => {
  it("matches AGT-001 / AGT-1234", () => {
    assert.equal(isAgtId("AGT-001"), true);
    assert.equal(isAgtId("AGT-1234"), true);
  });
  it("rejects full filenames and lowercase", () => {
    assert.equal(isAgtId("AGT-001-foo.md"), false);
    assert.equal(isAgtId("agt-001"), false);
    assert.equal(isAgtId("/abs/path"), false);
  });
});

describe("findTicketFileByID", () => {
  it("finds a ticket across state subfolders", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-find-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      mkdirSync(join(root, "tickets", "in-progress"), { recursive: true });
      writeFileSync(join(root, "tickets", "triage", "AGT-001-foo.md"), "x");
      writeFileSync(
        join(root, "tickets", "in-progress", "AGT-002-bar.md"),
        "x",
      );
      const path = findTicketFileByID(root, "AGT-002");
      assert.equal(path, join(root, "tickets", "in-progress", "AGT-002-bar.md"));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("throws with candidate list on multi-match", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-find-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      mkdirSync(join(root, "tickets", "refined"), { recursive: true });
      writeFileSync(join(root, "tickets", "triage", "AGT-001-a.md"), "x");
      writeFileSync(join(root, "tickets", "refined", "AGT-001-b.md"), "x");
      assert.throws(
        () => findTicketFileByID(root, "AGT-001"),
        /multiple files match AGT-001/,
      );
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("throws with states tried on zero matches", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-find-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      mkdirSync(join(root, "tickets", "refined"), { recursive: true });
      let caught: Error | null = null;
      try {
        findTicketFileByID(root, "AGT-099");
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught, "expected throw");
      assert.match(caught!.message, /no ticket file matching AGT-099/);
      assert.match(caught!.message, /triage/);
      assert.match(caught!.message, /refined/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("throws when tickets/ does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-find-"));
    try {
      assert.throws(
        () => findTicketFileByID(root, "AGT-001"),
        /no tickets\//,
      );
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("rejects non-AGT-NNN inputs", () => {
    assert.throws(() => findTicketFileByID("/x", "not-an-id"), /not an AGT-NNN id/);
  });
});

describe("resolveVault precedence", () => {
  let savedHome: string | undefined;
  let savedEnvVault: string | undefined;
  let fakeHome = "";

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedEnvVault = process.env.PRODUCT_VAULT_PATH;
    fakeHome = mkdtempSync(join(tmpdir(), "oteam-home-"));
    process.env.HOME = fakeHome;
    delete process.env.PRODUCT_VAULT_PATH;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedEnvVault === undefined) delete process.env.PRODUCT_VAULT_PATH;
    else process.env.PRODUCT_VAULT_PATH = savedEnvVault;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("flag wins over env over config default", async () => {
    const flagPath = join(fakeHome, "from-flag");
    const envPath = join(fakeHome, "from-env");
    const cfgPath = join(fakeHome, "from-config");
    mkdirSync(flagPath);
    mkdirSync(envPath);
    mkdirSync(cfgPath);

    const config = {
      vaults: { d: cfgPath, f: flagPath },
      default: "d",
      stamp: null,
      models: {},
      productDownshift: true,
      telemetry: { enabled: true },
      botIdentity: "",
    };
    process.env.PRODUCT_VAULT_PATH = envPath;

    assert.equal(
      resolveVault({ flagValue: "f", config }).path,
      flagPath,
      "flag wins",
    );

    assert.equal(
      resolveVault({ config }).path,
      envPath,
      "env wins over config default when no flag",
    );

    delete process.env.PRODUCT_VAULT_PATH;
    assert.equal(
      resolveVault({ config }).path,
      cfgPath,
      "config default applies when no flag and no env",
    );

    assert.equal(
      resolveVault({ config: { vaults: {}, default: null, stamp: null, models: {}, productDownshift: true, telemetry: { enabled: true }, botIdentity: "" } }).name,
      "(implicit)",
      "implicit fallback when nothing configured",
    );
  });

  it("flag accepts an absolute path that's not registered", () => {
    const r = resolveVault({
      flagValue: "/absolute/somewhere",
      config: { vaults: {}, default: null, stamp: null, models: {}, productDownshift: true, telemetry: { enabled: true }, botIdentity: "" },
    });
    assert.equal(r.path, "/absolute/somewhere");
  });

  it("flag throws on bare unknown name", () => {
    assert.throws(
      () =>
        resolveVault({
          flagValue: "ghost",
          config: { vaults: {}, default: null, stamp: null, models: {}, productDownshift: true, telemetry: { enabled: true }, botIdentity: "" },
        }),
      /not a registered name and not a path/,
    );
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

describe("runList --project", () => {
  it("filters by project frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      writeFileSync(
        join(root, "tickets", "triage", "AGT-001-a.md"),
        SAMPLE.replace("AGT-042", "AGT-001"),
      );
      writeFileSync(
        join(root, "tickets", "triage", "AGT-002-b.md"),
        SAMPLE
          .replace("AGT-042", "AGT-002")
          .replace("project: open-team", "project: candlesight"),
      );
      const out = runList({ vault: root, project: "open-team" });
      assert.match(out, /AGT-001/);
      assert.doesNotMatch(out, /AGT-002/);
      const empty = runList({ vault: root, project: "ghost" });
      assert.equal(empty, "(no tickets)");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("runList — extended filters", () => {
  function seedVault(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "vault-list-"));
    mkdirSync(join(root, "tickets", "triage"), { recursive: true });
    mkdirSync(join(root, "tickets", "qa"), { recursive: true });
    mkdirSync(join(root, "archive", "2026-04"), { recursive: true });

    writeFileSync(
      join(root, "tickets", "triage", "AGT-010-stamp.md"),
      SAMPLE
        .replace("AGT-042", "AGT-010")
        .replace('"Sample ticket title"', '"discuss: STAMP_REQUIRE_HUMAN_MERGE default"')
        .replace("project: open-team", "project: stamp-cli-hardening")
        .replace("priority: high", "priority: high")
        .replace("labels: [foo, bar]", "labels: [security, harden]"),
    );
    writeFileSync(
      join(root, "tickets", "qa", "AGT-011-other.md"),
      SAMPLE
        .replace("AGT-042", "AGT-011")
        .replace("state: refined", "state: qa")
        .replace('"Sample ticket title"', '"unrelated qa ticket"')
        .replace("repo: OpenThinkAi/open-team", "repo: OpenThinkAi/think")
        .replace("priority: high", "priority: medium")
        .replace("labels: [foo, bar]", "labels: [bug]"),
    );
    writeFileSync(
      join(root, "archive", "2026-04", "AGT-009-old.md"),
      SAMPLE
        .replace("AGT-042", "AGT-009")
        .replace("state: refined", "state: done")
        .replace('"Sample ticket title"', '"old archived stamp work"')
        .replace("project: open-team", "project: stamp-cli-hardening"),
    );
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("--repo is case-insensitive", () => {
    const { root, cleanup } = seedVault();
    try {
      const out = runList({ vault: root, repo: "openthinkai/OPEN-team" });
      assert.match(out, /AGT-010/);
      assert.doesNotMatch(out, /AGT-011/);
    } finally {
      cleanup();
    }
  });

  it("--project is case-insensitive", () => {
    const { root, cleanup } = seedVault();
    try {
      const out = runList({ vault: root, project: "STAMP-CLI-Hardening" });
      assert.match(out, /AGT-010/);
      assert.doesNotMatch(out, /AGT-011/);
    } finally {
      cleanup();
    }
  });

  it("--team filters by team frontmatter", () => {
    const { root, cleanup } = seedVault();
    try {
      const out = runList({ vault: root, team: "ENGINEERING" });
      assert.match(out, /AGT-010/);
      assert.match(out, /AGT-011/);
    } finally {
      cleanup();
    }
  });

  it("--priority and --label can stack", () => {
    const { root, cleanup } = seedVault();
    try {
      const out = runList({
        vault: root,
        priority: "High",
        label: ["security"],
      });
      assert.match(out, /AGT-010/);
      assert.doesNotMatch(out, /AGT-011/);
    } finally {
      cleanup();
    }
  });

  it("--label requires ALL provided labels (AND match)", () => {
    const { root, cleanup } = seedVault();
    try {
      const both = runList({ vault: root, label: ["security", "harden"] });
      assert.match(both, /AGT-010/);
      const missing = runList({
        vault: root,
        label: ["security", "nope"],
      });
      assert.equal(missing, "(no tickets)");
    } finally {
      cleanup();
    }
  });

  it("--match does case-insensitive title substring", () => {
    const { root, cleanup } = seedVault();
    try {
      const out = runList({ vault: root, match: "STAMP" });
      assert.match(out, /AGT-010/);
      assert.doesNotMatch(out, /AGT-011/);
    } finally {
      cleanup();
    }
  });

  it("--grep matches the ticket body", () => {
    const { root, cleanup } = seedVault();
    try {
      const out = runList({ vault: root, grep: "BODY HERE" });
      assert.match(out, /AGT-010/);
      assert.match(out, /AGT-011/);
      const none = runList({ vault: root, grep: "no-such-string-anywhere" });
      assert.equal(none, "(no tickets)");
    } finally {
      cleanup();
    }
  });

  it("--source filters by source.type", () => {
    const { root, cleanup } = seedVault();
    try {
      const github = runList({ vault: root, source: "GITHUB" });
      assert.match(github, /AGT-010/);
      const manual = runList({ vault: root, source: "manual" });
      assert.equal(manual, "(no tickets)");
    } finally {
      cleanup();
    }
  });

  it("--include-archived also includes archive/ and done state", () => {
    const { root, cleanup } = seedVault();
    try {
      const noArchive = runList({ vault: root, project: "stamp-cli-hardening" });
      assert.match(noArchive, /AGT-010/);
      assert.doesNotMatch(noArchive, /AGT-009/);

      const withArchive = runList({
        vault: root,
        project: "stamp-cli-hardening",
        includeArchived: true,
      });
      assert.match(withArchive, /AGT-010/);
      assert.match(withArchive, /AGT-009/);
    } finally {
      cleanup();
    }
  });
});
