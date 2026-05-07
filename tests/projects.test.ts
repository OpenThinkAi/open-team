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
import {
  formatProjectContextForPrompt,
  listProjects,
  projectFrontmatterTemplate,
  readProject,
} from "../src/lib/projects.ts";

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
});
