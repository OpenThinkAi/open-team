import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODELS,
  isPhase,
  PHASES,
  phaseForState,
  resolveRoleModel,
  ROLE_PIPELINE_MODEL,
  type ModelsConfig,
} from "../src/lib/models.ts";

describe("models: phaseForState", () => {
  it("maps every ticket state to the right phase or null", () => {
    assert.equal(phaseForState("triage"), "product");
    assert.equal(phaseForState("refined"), "spike");
    assert.equal(phaseForState("in-progress"), "implementation");
    assert.equal(phaseForState("qa"), "qa");
  });

  it("returns null for blocked/done (pipeline STOPs immediately)", () => {
    assert.equal(phaseForState("blocked"), null);
    assert.equal(phaseForState("done"), null);
  });

  it("returns null for unknown states (defensive — frontmatter parser already gated)", () => {
    assert.equal(phaseForState(""), null);
    assert.equal(phaseForState("not-a-real-state"), null);
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

  it("matches the AGT-106 baseline: Sonnet/Opus/Sonnet/Sonnet", () => {
    assert.equal(DEFAULT_MODELS.product, "claude-sonnet-4-6");
    assert.equal(DEFAULT_MODELS.spike, "claude-opus-4-7");
    assert.equal(DEFAULT_MODELS.implementation, "claude-sonnet-4-6");
    assert.equal(DEFAULT_MODELS.qa, "claude-sonnet-4-6");
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
    // "qa" is unset even though "spike" is pinned — phases resolve independently.
    assert.equal(resolveRoleModel("qa", models), fallback);
  });

  it("falls back when the entire models block is empty", () => {
    assert.equal(resolveRoleModel("triage", {}), fallback);
    assert.equal(resolveRoleModel("refined", {}), fallback);
    assert.equal(resolveRoleModel("in-progress", {}), fallback);
    assert.equal(resolveRoleModel("qa", {}), fallback);
  });

  it("falls back when models is undefined (legacy config / never-set)", () => {
    assert.equal(resolveRoleModel("triage", undefined), fallback);
  });

  it("falls back for blocked/done states regardless of pinned phases", () => {
    const models: ModelsConfig = {
      product: "claude-haiku-4-5",
      spike: "claude-opus-4-7",
      implementation: "claude-sonnet-4-6",
      qa: "claude-sonnet-4-6",
    };
    assert.equal(resolveRoleModel("blocked", models), fallback);
    assert.equal(resolveRoleModel("done", models), fallback);
  });

  it("each phase resolves independently (pinning one does not affect others)", () => {
    const models: ModelsConfig = { product: "claude-haiku-4-5" };
    assert.equal(resolveRoleModel("triage", models), "claude-haiku-4-5");
    assert.equal(resolveRoleModel("refined", models), fallback);
    assert.equal(resolveRoleModel("in-progress", models), fallback);
    assert.equal(resolveRoleModel("qa", models), fallback);
  });

  it("all four phases pinned → all four resolve to their pin (full-table case)", () => {
    const models: ModelsConfig = {
      product: "claude-haiku-4-5",
      spike: "claude-opus-4-7",
      implementation: "claude-sonnet-4-6",
      qa: "claude-sonnet-4-6",
    };
    assert.equal(resolveRoleModel("triage", models), "claude-haiku-4-5");
    assert.equal(resolveRoleModel("refined", models), "claude-opus-4-7");
    assert.equal(resolveRoleModel("in-progress", models), "claude-sonnet-4-6");
    assert.equal(resolveRoleModel("qa", models), "claude-sonnet-4-6");
  });
});
