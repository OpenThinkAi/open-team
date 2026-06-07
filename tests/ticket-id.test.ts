import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextTicketID, slugify, idExistsInVault, issueTicketID } from "../src/lib/ticket-id.ts";

describe("slugify", () => {
  it("lowercases + collapses non-alphanumerics", () => {
    assert.equal(
      slugify("Stamp CLI should exit non-zero when no reviewers configured"),
      "stamp-cli-should-exit-non-zero-when-no-reviewers-c",
    );
  });

  it("strips leading/trailing hyphens", () => {
    assert.equal(slugify("--Hello--"), "hello");
  });

  it("strips emoji-only suffix", () => {
    assert.equal(slugify("Add dark mode 🌙"), "add-dark-mode");
  });

  it("truncates to 50 chars without trailing hyphen", () => {
    const s = slugify("a".repeat(60));
    assert.equal(s.length, 50);
    assert.ok(!s.endsWith("-"));
  });
});

describe("nextTicketID", () => {
  it("returns AGT-001 when vault has no tickets", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      assert.equal(nextTicketID(root), "AGT-001");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("returns max+1 padded across tickets/ and archive/", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "tickets", "refined"), { recursive: true });
      mkdirSync(join(root, "archive", "2026-04"), { recursive: true });
      writeFileSync(join(root, "tickets", "refined", "AGT-002-x.md"), "");
      writeFileSync(join(root, "archive", "2026-04", "AGT-007-y.md"), "");
      assert.equal(nextTicketID(root), "AGT-008");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("idExistsInVault", () => {
  it("returns false for empty vault", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      assert.equal(idExistsInVault(root, "AGT-007"), false);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("returns true when same numeric ID exists under tickets/ with a different slug", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "tickets", "in-progress"), { recursive: true });
      writeFileSync(join(root, "tickets", "in-progress", "AGT-007-other-slug.md"), "");
      // Should detect numeric collision regardless of slug
      assert.equal(idExistsInVault(root, "AGT-007"), true);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("returns true when same numeric ID exists under archive/", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "archive", "2026-04"), { recursive: true });
      writeFileSync(join(root, "archive", "2026-04", "AGT-007-archived.md"), "");
      assert.equal(idExistsInVault(root, "AGT-007"), true);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("returns false when only a different numeric ID exists", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      mkdirSync(join(root, "tickets", "triage"), { recursive: true });
      writeFileSync(join(root, "tickets", "triage", "AGT-006-other.md"), "");
      assert.equal(idExistsInVault(root, "AGT-007"), false);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("issueTicketID", () => {
  it("issues AGT-001 in an empty vault", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      const triageDir = join(root, "tickets", "triage");
      mkdirSync(triageDir, { recursive: true });
      const { id, path } = issueTicketID(root, triageDir, "my-ticket", (id) => `id: ${id}\n`);
      assert.equal(id, "AGT-001");
      assert.ok(path.endsWith("AGT-001-my-ticket.md"));
      assert.equal(readFileSync(path, "utf8"), "id: AGT-001\n");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("bumps past an existing same-ID file with a different slug under a different state folder", () => {
    // AC #3: when the computed next ID already exists on disk, yields next free ID
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      const triageDir = join(root, "tickets", "triage");
      const inProgressDir = join(root, "tickets", "in-progress");
      mkdirSync(triageDir, { recursive: true });
      mkdirSync(inProgressDir, { recursive: true });
      // nextTicketID would return AGT-001 on an otherwise empty vault, but
      // AGT-001 already exists under in-progress with a different slug.
      writeFileSync(join(inProgressDir, "AGT-001-different-slug.md"), "existing");
      const { id, path } = issueTicketID(root, triageDir, "new-slug", (id) => `id: ${id}\n`);
      assert.equal(id, "AGT-002");
      assert.ok(path.endsWith("AGT-002-new-slug.md"));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("bumps past an existing same-ID file under archive/ — AC #2", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      const triageDir = join(root, "tickets", "triage");
      const archiveDir = join(root, "archive", "2026-04");
      mkdirSync(triageDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });
      // Seed AGT-001 in archive so it's considered already taken
      writeFileSync(join(archiveDir, "AGT-001-archived.md"), "archived");
      const { id } = issueTicketID(root, triageDir, "fresh-ticket", (id) => `id: ${id}\n`);
      assert.equal(id, "AGT-002");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("issues the correct ID when a lower ID exists but the next slot is free — AC #3", () => {
    // Covers AC #3: computed next ID = 8, and AGT-008 already exists → bumps to AGT-009
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    try {
      const triageDir = join(root, "tickets", "triage");
      const refinedDir = join(root, "tickets", "refined");
      mkdirSync(triageDir, { recursive: true });
      mkdirSync(refinedDir, { recursive: true });
      writeFileSync(join(refinedDir, "AGT-007-existing.md"), "");
      // nextTicketID returns AGT-008; seed AGT-008 so issueTicketID must bump
      writeFileSync(join(triageDir, "AGT-008-collision.md"), "");
      const { id } = issueTicketID(root, triageDir, "next-free", (id) => `id: ${id}\n`);
      assert.equal(id, "AGT-009");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
