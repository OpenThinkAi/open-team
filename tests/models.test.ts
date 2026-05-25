import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acceptanceCriteriaIsPopulated,
  DEFAULT_MODELS,
  HAIKU_PRODUCT_MODEL,
  isPhase,
  PHASES,
  phaseForState,
  resolveModelForTicket,
  resolveRoleModel,
  ROLE_PIPELINE_MODEL,
  type ModelsConfig,
} from "../src/lib/models.ts";

describe("models: phaseForState", () => {
  it("maps every ticket state to the right phase or null", () => {
    assert.equal(phaseForState("triage"), "product");
    assert.equal(phaseForState("refined"), "spike");
    assert.equal(phaseForState("in-progress"), "implementation");
  });

  it("returns null for blocked/done (pipeline STOPs immediately)", () => {
    assert.equal(phaseForState("blocked"), null);
    assert.equal(phaseForState("done"), null);
  });

  it("returns null for unknown states (defensive — frontmatter parser already gated)", () => {
    assert.equal(phaseForState(""), null);
    assert.equal(phaseForState("not-a-real-state"), null);
    assert.equal(phaseForState("qa"), null); // qa removed — no longer a state/phase
  });
});

describe("models: isPhase", () => {
  it("accepts every member of PHASES", () => {
    for (const p of PHASES) {
      assert.equal(isPhase(p), true);
    }
  });

  it("rejects strings outside PHASES", () => {
    assert.equal(isPhase(""), false);
    assert.equal(isPhase("triage"), false); // state, not phase
    assert.equal(isPhase("Product"), false); // case-sensitive
  });
});

describe("models: DEFAULT_MODELS (AGT-106)", () => {
  it("covers every phase exactly once with non-empty model ids", () => {
    const keys = Object.keys(DEFAULT_MODELS).sort();
    assert.deepEqual(keys, [...PHASES].sort());
    for (const phase of PHASES) {
      assert.equal(typeof DEFAULT_MODELS[phase], "string");
      assert.ok(DEFAULT_MODELS[phase].length > 0);
    }
  });

  it("matches the AGT-106 baseline: Sonnet/Opus/Sonnet", () => {
    assert.equal(DEFAULT_MODELS.product, "claude-sonnet-4-6");
    assert.equal(DEFAULT_MODELS.spike, "claude-opus-4-7");
    assert.equal(DEFAULT_MODELS.implementation, "claude-sonnet-4-6");
  });
});

describe("models: resolveRoleModel (AC #5 — per-spawn model selection)", () => {
  const fallback = ROLE_PIPELINE_MODEL;

  it("returns the pinned model for the matching phase", () => {
    const models: ModelsConfig = { spike: "claude-opus-4-7" };
    assert.equal(resolveRoleModel("refined", models), "claude-opus-4-7");
  });

  it("falls back to ROLE_PIPELINE_MODEL when the phase is unset (AC #2)", () => {
    const models: ModelsConfig = { spike: "claude-opus-4-7" };
    // implementation is unset even though "spike" is pinned — phases resolve independently.
    assert.equal(resolveRoleModel("in-progress", models), fallback);
  });

  it("falls back when the entire models block is empty", () => {
    assert.equal(resolveRoleModel("triage", {}), fallback);
    assert.equal(resolveRoleModel("refined", {}), fallback);
    assert.equal(resolveRoleModel("in-progress", {}), fallback);
  });

  it("falls back when models is undefined (legacy config / never-set)", () => {
    assert.equal(resolveRoleModel("triage", undefined), fallback);
  });

  it("falls back for blocked/done states regardless of pinned phases", () => {
    const models: ModelsConfig = {
      product: "claude-haiku-4-5",
      spike: "claude-opus-4-7",
      implementation: "claude-sonnet-4-6",
    };
    assert.equal(resolveRoleModel("blocked", models), fallback);
    assert.equal(resolveRoleModel("done", models), fallback);
  });

  it("each phase resolves independently (pinning one does not affect others)", () => {
    const models: ModelsConfig = { product: "claude-haiku-4-5" };
    assert.equal(resolveRoleModel("triage", models), "claude-haiku-4-5");
    assert.equal(resolveRoleModel("refined", models), fallback);
    assert.equal(resolveRoleModel("in-progress", models), fallback);
  });

  it("all three phases pinned → all three resolve to their pin (full-table case)", () => {
    const models: ModelsConfig = {
      product: "claude-haiku-4-5",
      spike: "claude-opus-4-7",
      implementation: "claude-sonnet-4-6",
    };
    assert.equal(resolveRoleModel("triage", models), "claude-haiku-4-5");
    assert.equal(resolveRoleModel("refined", models), "claude-opus-4-7");
    assert.equal(resolveRoleModel("in-progress", models), "claude-sonnet-4-6");
  });
});

describe("models: acceptanceCriteriaIsPopulated (AGT-107 predicate)", () => {
  it("returns false when the section is missing entirely", () => {
    assert.equal(
      acceptanceCriteriaIsPopulated(
        "## Problem Statement\n\nSomething.\n",
      ),
      false,
    );
  });

  it("returns false on the manual-template HTML-comment placeholder", () => {
    const body = [
      "## Problem Statement",
      "",
      "<!-- Describe the problem -->",
      "",
      "## Acceptance Criteria",
      "",
      "<!-- Numbered list of testable conditions. Filled in during refinement. -->",
      "",
      "## Spike",
    ].join("\n");
    assert.equal(acceptanceCriteriaIsPopulated(body), false);
  });

  it("returns true on a single numbered bullet of substantive content", () => {
    const body = [
      "## Acceptance Criteria",
      "",
      "1. Runner inspects each ticket immediately before the Product spawn.",
      "",
    ].join("\n");
    assert.equal(acceptanceCriteriaIsPopulated(body), true);
  });

  it("returns true on a multi-bullet AC", () => {
    const body = [
      "## Acceptance Criteria",
      "",
      "1. First bullet.",
      "2. Second bullet.",
      "3. Third bullet.",
    ].join("\n");
    assert.equal(acceptanceCriteriaIsPopulated(body), true);
  });

  it("ignores bullets in HTML comments even when they look numbered", () => {
    const body = [
      "## Acceptance Criteria",
      "",
      "<!--",
      "1. This is example content the template suggested.",
      "2. Not real AC.",
      "-->",
      "",
    ].join("\n");
    assert.equal(acceptanceCriteriaIsPopulated(body), false);
  });

  it("finds the AC section even when other headings precede it", () => {
    const body = [
      "## Problem Statement",
      "",
      "Some prose.",
      "",
      "## Notes",
      "",
      "More prose.",
      "",
      "## Acceptance Criteria",
      "",
      "1. The bullet.",
    ].join("\n");
    assert.equal(acceptanceCriteriaIsPopulated(body), true);
  });

  it("stops scanning at the next ## heading (bullets after AC don't count)", () => {
    const body = [
      "## Acceptance Criteria",
      "",
      "<!-- placeholder -->",
      "",
      "## Spike",
      "",
      "1. This bullet lives under Spike, not AC.",
    ].join("\n");
    assert.equal(acceptanceCriteriaIsPopulated(body), false);
  });

  it("doesn't trigger on plain prose under the heading", () => {
    const body = [
      "## Acceptance Criteria",
      "",
      "TBD.",
    ].join("\n");
    assert.equal(acceptanceCriteriaIsPopulated(body), false);
  });
});

describe("models: resolveModelForTicket (AGT-107)", () => {
  const populatedAC =
    "## Acceptance Criteria\n\n1. Foo\n2. Bar\n";
  const emptyAC =
    "## Acceptance Criteria\n\n<!-- Numbered list of testable conditions. Filled in during refinement. -->\n";
  const baselineModels: ModelsConfig = {
    product: "claude-sonnet-4-6",
    spike: "claude-opus-4-7",
    implementation: "claude-sonnet-4-6",
  };

  it("downshifts to Haiku on manual + populated-AC + triage + downshift on (AC #1)", () => {
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "manual",
        body: populatedAC,
        productDownshift: true,
        models: baselineModels,
      }),
      HAIKU_PRODUCT_MODEL,
    );
  });

  it("does not downshift on manual + empty-AC (AC #1 negative)", () => {
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "manual",
        body: emptyAC,
        productDownshift: true,
        models: baselineModels,
      }),
      "claude-sonnet-4-6",
    );
  });

  it("does not downshift on github-source tickets even with populated AC (AC #2)", () => {
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "github",
        body: populatedAC,
        productDownshift: true,
        models: baselineModels,
      }),
      "claude-sonnet-4-6",
    );
  });

  it("does not downshift on linear-source tickets (AC #2)", () => {
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "linear",
        body: populatedAC,
        productDownshift: true,
        models: baselineModels,
      }),
      "claude-sonnet-4-6",
    );
  });

  it("off-switch wins: productDownshift=false → models.product even on manual + populated AC (AC #3)", () => {
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "manual",
        body: populatedAC,
        productDownshift: false,
        models: baselineModels,
      }),
      "claude-sonnet-4-6",
    );
  });

  it("off-switch with no Product pin falls back to ROLE_PIPELINE_MODEL", () => {
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "manual",
        body: populatedAC,
        productDownshift: false,
        models: {},
      }),
      ROLE_PIPELINE_MODEL,
    );
  });

  it("non-triage states delegate to resolveRoleModel regardless of AC shape", () => {
    for (const state of ["refined", "in-progress"]) {
      assert.equal(
        resolveModelForTicket({
          state,
          sourceType: "manual",
          body: populatedAC,
          productDownshift: true,
          models: baselineModels,
        }),
        resolveRoleModel(state, baselineModels),
      );
    }
  });

  it("blocked/done states delegate to resolveRoleModel (no role agent runs)", () => {
    for (const state of ["blocked", "done"]) {
      assert.equal(
        resolveModelForTicket({
          state,
          sourceType: "manual",
          body: populatedAC,
          productDownshift: true,
          models: baselineModels,
        }),
        ROLE_PIPELINE_MODEL,
      );
    }
  });

  it("manual + populated AC but downshift off + no Product pin → ROLE_PIPELINE_MODEL", () => {
    // Confirms the off-switch routes through resolveRoleModel exactly, no
    // accidental haiku side-channel.
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "manual",
        body: populatedAC,
        productDownshift: false,
        models: undefined,
      }),
      ROLE_PIPELINE_MODEL,
    );
  });

  it("default manual-ticket template (AC placeholder only) does not trigger", () => {
    // Belt-and-braces: the renderManualTicket emits exactly this AC body. If
    // someone changes that template in a way that starts to look "populated"
    // to the predicate, this test should be the canary.
    const body = [
      "---",
      "id: AGT-999",
      "---",
      "",
      "## Problem Statement",
      "",
      "<!-- Describe the problem this ticket addresses. -->",
      "",
      "## Acceptance Criteria",
      "",
      "<!-- Numbered list of testable conditions. Filled in during refinement. -->",
      "",
      "## Spike",
    ].join("\n");
    assert.equal(
      resolveModelForTicket({
        state: "triage",
        sourceType: "manual",
        body,
        productDownshift: true,
        models: baselineModels,
      }),
      "claude-sonnet-4-6",
    );
  });
});
