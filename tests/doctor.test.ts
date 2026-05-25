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
import { runDoctor, type IssueClass } from "../src/commands/doctor.ts";

function ticket(
  id: string,
  state: string,
  opts: { project?: string; repo?: string | null; title?: string } = {},
): string {
  const repoLine =
    opts.repo === null ? "repo:" : `repo: ${opts.repo ?? "OpenThinkAi/open-team"}`;
  return `---
id: ${id}
title: "${opts.title ?? "t"}"
state: ${state}
team: engineering
created: 2026-05-01
updated: 2026-05-01
project: ${opts.project ?? "open-team"}
${repoLine}
blocked-by: []
linked-github:
linked-pr:
priority: medium
labels: []
source: { type: manual, url: "", id: "", fetched-at: "" }
---

## Problem Statement

body
`;
}

function projectReadme(id: string, status: string, repos: string[] = []): string {
  return `---
id: ${id}
title: ${id}
status: ${status}
parent-project:
repos: [${repos.join(", ")}]
---

# ${id}

body
`;
}

function seed(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  for (const s of ["triage", "refined", "in-progress", "blocked"]) {
    mkdirSync(join(root, "tickets", s), { recursive: true });
  }
  mkdirSync(join(root, "archive", "2026-05"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(root: string, rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function classes(root: string, fix = false): IssueClass[] {
  return runDoctor({ vault: root, fix }).issues.map((i) => i.class);
}

describe("oteam doctor — detection", () => {
  it("reports a clean vault with no issues", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/open-team/README.md", projectReadme("open-team", "in-progress"));
      write(root, "tickets/triage/AGT-001-a.md", ticket("AGT-001", "triage"));
      const result = runDoctor({ vault: root });
      assert.deepEqual(result.issues, []);
      assert.equal(result.errorCount, 0);
      assert.equal(result.unresolvedErrors, 0);
    } finally {
      cleanup();
    }
  });

  it("flags ghost tickets under tickets/archive/", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/open-team/README.md", projectReadme("open-team", "in-progress"));
      write(root, "tickets/triage/AGT-001-a.md", ticket("AGT-001", "triage"));
      write(root, "tickets/archive/2026-05/AGT-002-ghost.md", ticket("AGT-002", "refined"));
      assert.ok(classes(root).includes("ghost-archive"));
    } finally {
      cleanup();
    }
  });

  it("flags done tickets left in an active folder", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/open-team/README.md", projectReadme("open-team", "in-progress"));
      write(root, "tickets/triage/AGT-001-done.md", ticket("AGT-001", "done"));
      assert.ok(classes(root).includes("done-unarchived"));
    } finally {
      cleanup();
    }
  });

  it("flags state↔folder mismatch", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/open-team/README.md", projectReadme("open-team", "in-progress"));
      write(root, "tickets/triage/AGT-001-x.md", ticket("AGT-001", "refined"));
      assert.ok(classes(root).includes("state-folder-mismatch"));
    } finally {
      cleanup();
    }
  });

  it("flags duplicate IDs across tickets/ and archive/", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/open-team/README.md", projectReadme("open-team", "in-progress"));
      write(root, "tickets/triage/AGT-005-live.md", ticket("AGT-005", "triage"));
      write(root, "archive/2026-05/AGT-005-old.md", ticket("AGT-005", "done"));
      const dup = runDoctor({ vault: root }).issues.find((i) => i.class === "duplicate-id");
      assert.ok(dup, "duplicate-id reported");
      assert.equal(dup!.paths?.length, 2, "both paths captured in paths[]");
      assert.ok(!dup!.path.includes(", "), "path stays a single resolvable path");
    } finally {
      cleanup();
    }
  });

  it("flags malformed frontmatter", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "tickets/triage/AGT-009-broken.md", "---\ntitle: no id or state\n---\n");
      assert.ok(classes(root).includes("malformed-frontmatter"));
    } finally {
      cleanup();
    }
  });

  it("warns on blank repo when the project declares repos", () => {
    const { root, cleanup } = seed();
    try {
      write(
        root,
        "projects/withrepo/README.md",
        projectReadme("withrepo", "in-progress", ["OpenThinkAi/x"]),
      );
      write(
        root,
        "tickets/triage/AGT-001-norepo.md",
        ticket("AGT-001", "triage", { project: "withrepo", repo: null }),
      );
      const result = runDoctor({ vault: root });
      assert.ok(result.issues.some((i) => i.class === "missing-repo"));
      assert.ok(result.issues.find((i) => i.class === "missing-repo")?.severity === "warning");
    } finally {
      cleanup();
    }
  });

  it("warns on a project with 0 active tickets and a non-terminal status", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/stale/README.md", projectReadme("stale", "planning"));
      assert.ok(classes(root).includes("stale-project-status"));
    } finally {
      cleanup();
    }
  });

  it("does NOT flag a 0-active project whose status is terminal", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/finished/README.md", projectReadme("finished", "shipped"));
      assert.ok(!classes(root).includes("stale-project-status"));
    } finally {
      cleanup();
    }
  });
});

describe("oteam doctor --fix", () => {
  it("archives done-unarchived and relocates state-folder mismatches", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "projects/open-team/README.md", projectReadme("open-team", "in-progress"));
      write(root, "tickets/triage/AGT-010-done.md", ticket("AGT-010", "done"));
      write(root, "tickets/triage/AGT-011-mismatch.md", ticket("AGT-011", "refined"));
      write(root, "tickets/archive/2026-05/AGT-012-ghost.md", ticket("AGT-012", "in-progress"));

      const result = runDoctor({ vault: root, fix: true });

      assert.equal(result.fixedCount, 3, "all three fixable issues applied");
      assert.equal(result.unresolvedErrors, 0, "no unresolved errors after fix");

      // done ticket moved out of triage into top-level archive
      assert.ok(!existsSync(join(root, "tickets/triage/AGT-010-done.md")));
      const ym = new Date().toISOString().slice(0, 7);
      assert.ok(existsSync(join(root, "archive", ym, "AGT-010-done.md")));

      // mismatch relocated to its real state folder
      assert.ok(!existsSync(join(root, "tickets/triage/AGT-011-mismatch.md")));
      assert.ok(existsSync(join(root, "tickets/refined/AGT-011-mismatch.md")));

      // ghost relocated out of tickets/archive into top-level archive (state forced done)
      assert.ok(!existsSync(join(root, "tickets/archive/2026-05/AGT-012-ghost.md")));
      assert.ok(existsSync(join(root, "archive", ym, "AGT-012-ghost.md")));

      // a re-run is clean of those error classes
      const after = classes(root).filter(
        (c) =>
          c === "ghost-archive" ||
          c === "done-unarchived" ||
          c === "state-folder-mismatch",
      );
      assert.deepEqual(after, []);
    } finally {
      cleanup();
    }
  });

  it("flags a legacy qa-state ticket and --fix migrates it to in-progress", () => {
    const { root, cleanup } = seed();
    try {
      write(root, "tickets/triage/AGT-020-legacy.md", ticket("AGT-020", "qa"));
      const issue = runDoctor({ vault: root }).issues.find(
        (i) => i.class === "legacy-qa-state",
      );
      assert.ok(issue, "expected a legacy-qa-state issue");
      assert.equal(issue!.severity, "error");

      const fixed = runDoctor({ vault: root, fix: true });
      assert.equal(
        fixed.issues.find((i) => i.class === "legacy-qa-state")?.fixed,
        true,
      );
      assert.ok(
        existsSync(join(root, "tickets/in-progress/AGT-020-legacy.md")),
        "migrated into tickets/in-progress/",
      );
      const migrated = readFileSync(
        join(root, "tickets/in-progress/AGT-020-legacy.md"),
        "utf8",
      );
      assert.match(migrated, /^state: in-progress$/m);
    } finally {
      cleanup();
    }
  });
});
