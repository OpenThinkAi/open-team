import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatProjectContextForPrompt,
  listProjects,
  projectFrontmatterTemplate,
  readProject,
} from "../src/lib/projects.ts";
import { runInit } from "../src/commands/project.ts";

const SAMPLE_README = `---
id: think-cli-v2
title: think-cli v2 — local-first redesign
status: in-progress
parent-project:
repos: [OpenThinkAi/think-cli]
---

# think-cli v2 — Architecture

The reframe: think today is positioned as "distributed shared memory for AI agents."

That pitch fights itself.
`;

function makeVault(): { vault: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "vault-projects-"));
  return { vault, cleanup: () => rmSync(vault, { recursive: true, force: true }) };
}

describe("readProject", () => {
  it("returns null when project folder doesn't exist", () => {
    const { vault, cleanup } = makeVault();
    try {
      assert.equal(readProject(vault, "nope"), null);
    } finally {
      cleanup();
    }
  });

  it("parses frontmatter, body, and siblings", () => {
    const { vault, cleanup } = makeVault();
    try {
      const dir = join(vault, "projects", "think-cli-v2");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "README.md"), SAMPLE_README);
      writeFileSync(join(dir, "01-local-fs-adapter.md"), "stub");
      writeFileSync(join(dir, "02-server-pivot.md"), "stub");

      const project = readProject(vault, "think-cli-v2");
      assert.ok(project);
      assert.equal(project.id, "think-cli-v2");
      assert.equal(project.title, "think-cli v2 — local-first redesign");
      assert.equal(project.status, "in-progress");
      assert.equal(project.parentProject, null);
      assert.deepEqual(project.repos, ["OpenThinkAi/think-cli"]);
      assert.equal(project.siblings.length, 2);
      assert.ok(
        project.siblings[0]!.endsWith("01-local-fs-adapter.md"),
        `unexpected sibling order: ${JSON.stringify(project.siblings)}`,
      );
      assert.match(project.body, /reframe/);
      assert.doesNotMatch(project.body, /^---/m);
    } finally {
      cleanup();
    }
  });
});

describe("listProjects", () => {
  it("returns empty array when projects/ is missing", () => {
    const { vault, cleanup } = makeVault();
    try {
      assert.deepEqual(listProjects(vault), []);
    } finally {
      cleanup();
    }
  });

  it("lists projects with READMEs and skips folders without one", () => {
    const { vault, cleanup } = makeVault();
    try {
      mkdirSync(join(vault, "projects", "alpha"), { recursive: true });
      writeFileSync(join(vault, "projects", "alpha", "README.md"), `---
id: alpha
title: Alpha
status: shipped
parent-project:
repos: []
---
body
`);
      mkdirSync(join(vault, "projects", "beta-no-readme"), { recursive: true });

      const projects = listProjects(vault);
      assert.equal(projects.length, 1);
      assert.equal(projects[0]!.id, "alpha");
    } finally {
      cleanup();
    }
  });
});

describe("formatProjectContextForPrompt", () => {
  it("includes the project id, title, status, and body", () => {
    const { vault, cleanup } = makeVault();
    try {
      const dir = join(vault, "projects", "think-cli-v2");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "README.md"), SAMPLE_README);
      writeFileSync(join(dir, "02-server-pivot.md"), "stub");
      const project = readProject(vault, "think-cli-v2")!;
      const out = formatProjectContextForPrompt(project);
      assert.match(out, /Project context: think-cli-v2/);
      assert.match(out, /think-cli v2 — local-first redesign/);
      assert.match(out, /status: in-progress/);
      assert.match(out, /reframe/);
      assert.match(out, /02-server-pivot\.md/);
    } finally {
      cleanup();
    }
  });

  it("handles a project with no siblings cleanly", () => {
    const { vault, cleanup } = makeVault();
    try {
      const dir = join(vault, "projects", "solo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "README.md"), `---
id: solo
title: Solo
status: planning
parent-project:
repos: []
---
body
`);
      const project = readProject(vault, "solo")!;
      const out = formatProjectContextForPrompt(project);
      assert.doesNotMatch(out, /Additional design docs/);
    } finally {
      cleanup();
    }
  });
});

describe("project init --from-doc", () => {
  it("scaffolds README.md without a sibling when --from-doc is omitted", () => {
    const { vault, cleanup } = makeVault();
    try {
      runInit("plain", { vault, edit: false });
      const project = readProject(vault, "plain");
      assert.ok(project);
      assert.ok(existsSync(project.readmePath));
      assert.deepEqual(project.siblings, []);
    } finally {
      cleanup();
    }
  });

  it("seeds the design doc as a discoverable sibling", () => {
    const { vault, cleanup } = makeVault();
    try {
      const docPath = join(vault, "incoming-design.md");
      writeFileSync(docPath, "# Design\n\nThe plan.\n");

      runInit("seeded", { vault, fromDoc: docPath, edit: false });

      const project = readProject(vault, "seeded");
      assert.ok(project);
      assert.equal(project.siblings.length, 1);
      const sibling = project.siblings[0]!;
      assert.ok(sibling.endsWith("incoming-design.md"), sibling);
      assert.match(readFileSync(sibling, "utf8"), /The plan\./);
    } finally {
      cleanup();
    }
  });

  it("renames a README.md source to design.md to avoid colliding with the scaffold", () => {
    const { vault, cleanup } = makeVault();
    try {
      const docPath = join(vault, "README.md");
      writeFileSync(docPath, "# External design doc\n");

      runInit("collide", { vault, fromDoc: docPath, edit: false });

      const project = readProject(vault, "collide");
      assert.ok(project);
      assert.equal(project.siblings.length, 1);
      assert.ok(project.siblings[0]!.endsWith("design.md"), project.siblings[0]);
      // Scaffolded README must be the template, not the source doc.
      assert.match(readFileSync(project.readmePath, "utf8"), /^id: collide$/m);
    } finally {
      cleanup();
    }
  });
});

describe("projectFrontmatterTemplate", () => {
  it("produces a parseable scaffold for a given id", () => {
    const text = projectFrontmatterTemplate("hello-world");
    assert.match(text, /^---/);
    assert.match(text, /^id: hello-world$/m);
    assert.match(text, /^status: planning$/m);
    assert.match(text, /^repos: \[\]$/m);
  });

  it("points at the canonical ticket-list command instead of a hand-maintained list", () => {
    const text = projectFrontmatterTemplate("hello-world");
    assert.match(text, /^## Tickets$/m);
    assert.match(text, /oteam project show hello-world --tickets/);
    // Drift-prone hand-maintained list shapes must not appear in the scaffold.
    assert.doesNotMatch(text, /^- \*\*AGT-/m);
  });

  it("includes an empty Notable shipped milestones subsection", () => {
    const text = projectFrontmatterTemplate("hello-world");
    assert.match(text, /^### Notable shipped milestones \(drift expected\)$/m);
  });

  it("guides future editors to delegate drift-prone lists to the CLI before adding inline sections", () => {
    const text = projectFrontmatterTemplate("hello-world");
    assert.match(text, /Conventions when editing this README/);
    assert.match(text, /Design-doc only/);
    assert.match(text, /belongs to a CLI command/);
    assert.match(text, /link to the command instead of hand-maintaining/);
  });
});
