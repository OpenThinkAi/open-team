/**
 * Guards that the role-pipeline slash-command skills are (a) registered in the
 * installer's BUNDLED_COMMANDS list, (b) present as source `.md` files with the
 * required frontmatter, and (c) copied into dist/ by the package.json build
 * script. The registration list and the build-copy step are two hand-maintained
 * lists that must stay in sync; this test fails loudly if a new skill is added
 * to one but not the other. Added with /refine (issue #16).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_COMMANDS } from "../src/role-pipeline/install-slash-command.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..");
const roleDir = join(repoRoot, "src", "role-pipeline");

// The skills we expect to ship. Keep in lockstep with BUNDLED_COMMANDS.
// `_ticket-lane.md` is the shared per-ticket body (not a user-facing command),
// but it is bundled + installed alongside the commands so it must appear here.
const EXPECTED_SKILLS = [
  "assign-ticket.md",
  "implement-project.md",
  "dispatch.md",
  "refine.md",
  "_ticket-lane.md",
];

function readBuildScript(): string {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { scripts: { build: string } };
  return pkg.scripts.build;
}

describe("role-pipeline skill registration (issue #16)", () => {
  it("registers exactly the expected skills in BUNDLED_COMMANDS", () => {
    const dests = BUNDLED_COMMANDS.map((c) => c.dest).sort();
    assert.deepEqual(dests, [...EXPECTED_SKILLS].sort());
  });

  it("registers /refine in BUNDLED_COMMANDS", () => {
    const refine = BUNDLED_COMMANDS.find((c) => c.dest === "refine.md");
    assert.ok(refine, "expected refine.md in BUNDLED_COMMANDS");
    assert.match(refine.src, /refine\.md$/);
  });

  it("copies every registered skill into dist/ via the build script", () => {
    const build = readBuildScript();
    for (const dest of EXPECTED_SKILLS) {
      const expected = `cp src/role-pipeline/${dest} dist/${dest}`;
      assert.ok(
        build.includes(expected),
        `package.json build script must copy ${dest} to dist/ (missing: "${expected}")`,
      );
    }
  });

  it("ships refine.md with the required, accurate frontmatter", () => {
    const body = readFileSync(join(roleDir, "refine.md"), "utf8");
    assert.match(body, /^---\n/, "refine.md must open with YAML frontmatter");
    // description present and non-trivial
    assert.match(body, /\ndescription: .+\n/);
    // argument-hint must advertise the doc-path-or-project-id duality
    assert.match(body, /\nargument-hint: <design-doc-path \| project-id>\n/);
  });

  it("keeps the billing invariant explicit in refine.md (in-session, no SDK/-p)", () => {
    const body = readFileSync(join(roleDir, "refine.md"), "utf8");
    assert.match(body, /subscription/i);
    assert.match(body, /claude -p/);
    assert.match(body, /Agent SDK/);
  });

  it("uses $ARGUMENTS (not positional $N) in refine.md", () => {
    const body = readFileSync(join(roleDir, "refine.md"), "utf8");
    assert.match(body, /\$ARGUMENTS/);
    // Positional skill args are stripped by arg-substitution — must not appear
    // as a bare reference token.
    assert.doesNotMatch(body, /\$1\b/);
  });

  it("calls the #15 scaffolding primitives in refine.md", () => {
    const body = readFileSync(join(roleDir, "refine.md"), "utf8");
    assert.match(body, /oteam ticket new/);
    assert.match(body, /--blocked-by/);
    assert.match(body, /oteam project init/);
    assert.match(body, /--from-doc/);
    // closes the loop into the orchestrator
    assert.match(body, /\/implement-project/);
  });

  it("ships dispatch.md with required frontmatter (description + issue-ref hint)", () => {
    const body = readFileSync(join(roleDir, "dispatch.md"), "utf8");
    assert.match(body, /^---\n/, "dispatch.md must open with YAML frontmatter");
    assert.match(body, /\ndescription: .+\n/);
    assert.match(body, /\nargument-hint: <owner\/repo#number>\n/);
  });

  it("keeps the billing invariant explicit in dispatch.md (subscription, no SDK/-p)", () => {
    const body = readFileSync(join(roleDir, "dispatch.md"), "utf8");
    assert.match(body, /subscription/i);
    assert.match(body, /claude -p/);
    assert.match(body, /Agent SDK/);
  });

  it("uses $ARGUMENTS (not positional $N) in dispatch.md", () => {
    const body = readFileSync(join(roleDir, "dispatch.md"), "utf8");
    assert.match(body, /\$ARGUMENTS/);
    assert.doesNotMatch(body, /\$1\b/);
  });

  it("encodes the untrusted-input rule and composes the shared lane in dispatch.md", () => {
    const body = readFileSync(join(roleDir, "dispatch.md"), "utf8");
    // the issue body is data, not instructions (safety audit precedes work)
    assert.match(body, /attacker-controlled/i);
    // composes the shared lane rather than forking the back-half
    assert.match(body, /_ticket-lane\.md/);
    // validation precedes ticket creation
    assert.match(body, /oteam pull github/);
  });

  it("ships the shared _ticket-lane.md body with the core subroutine", () => {
    const body = readFileSync(join(roleDir, "_ticket-lane.md"), "utf8");
    assert.match(body, /^---\n/, "_ticket-lane.md must open with YAML frontmatter");
    assert.match(body, /oteam assign/);
    assert.match(body, /GATE-POINT 1/);
    assert.match(body, /GATE-POINT 2/);
  });
});

describe("role-pipeline closeout archive enforcement (AGT-448)", () => {
  /**
   * Regression guards: assign-ticket.md Phase 5 Step 2 must use `oteam archive`
   * as the ONLY sanctioned closeout move. The "or mv to archive/YYYY-MM/" wording
   * was the loophole that produced AGT-244/249 and AGT-372–375 drift.
   *
   * Positive: `oteam archive` must be present in Phase 5.
   * Negative: the "or mv to archive/" alternative must NOT appear.
   * The negative assertion is intentionally narrow so it doesn't false-positive
   * on a rewrite that preserves the intent correctly — the positive assertion
   * is the primary guard.
   */
  it("assign-ticket.md Phase 5 Step 2 uses oteam archive as the archive command", () => {
    const body = readFileSync(join(roleDir, "assign-ticket.md"), "utf8");
    // Positive: the authoritative archive command must appear
    assert.match(
      body,
      /oteam archive <id>/,
      "assign-ticket.md must use 'oteam archive <id>' as the archive command in Phase 5 Step 2",
    );
  });

  it("assign-ticket.md Phase 5 Step 2 does NOT offer raw mv as an archive alternative", () => {
    const body = readFileSync(join(roleDir, "assign-ticket.md"), "utf8");
    // Negative: the "or mv to archive/YYYY-MM/" loophole must not appear
    // (this pattern matched the exact wording that allowed agents to bypass oteam archive)
    assert.doesNotMatch(
      body,
      /or [`']?mv[`']? to [`']?archive\//i,
      "assign-ticket.md must NOT offer 'mv to archive/' as an alternative to 'oteam archive'",
    );
  });

  it("assign-ticket.md Phase 5 includes a step to refresh the installed pipeline copy", () => {
    const body = readFileSync(join(roleDir, "assign-ticket.md"), "utf8");
    assert.match(
      body,
      /oteam install-commands/,
      "assign-ticket.md Phase 5 must include 'oteam install-commands' to refresh running conductors",
    );
  });

  it("_ticket-lane.md GATE-POINT 2 names oteam archive explicitly", () => {
    const body = readFileSync(join(roleDir, "_ticket-lane.md"), "utf8");
    assert.match(
      body,
      /oteam archive/,
      "_ticket-lane.md GATE-POINT 2 must name 'oteam archive' rather than just 'archive'",
    );
  });

  it("implement-project.md merge gate names oteam archive explicitly", () => {
    const body = readFileSync(join(roleDir, "implement-project.md"), "utf8");
    assert.match(
      body,
      /oteam archive/,
      "implement-project.md merge gate must name 'oteam archive' rather than just 'archive'",
    );
  });
});
