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
const EXPECTED_SKILLS = ["assign-ticket.md", "implement-project.md", "refine.md"];

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
});
