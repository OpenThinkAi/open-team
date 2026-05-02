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
import { nextTicketID, slugify } from "../src/lib/ticket-id.ts";

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
