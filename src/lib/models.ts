// Centralised model IDs. Update here when bumping; nothing else in the tree
// should hardcode a Claude model string.
//
// ROLE_PIPELINE_MODEL is the fallback used when the user has not pinned a
// per-phase model in `~/.open-team/config.json`'s `models` block.
//
// NORMALISER_MODEL is the one-shot LLM call inside ingestors that turns an
// unstructured source body into a vault-shape ticket. Intentionally cheaper
// — it's a text-to-text job with no tools.
export const ROLE_PIPELINE_MODEL = "claude-opus-4-7";
export const NORMALISER_MODEL = "claude-sonnet-4-6";

export const PHASES = ["product", "spike", "implementation", "qa"] as const;
export type Phase = (typeof PHASES)[number];

export type ModelsConfig = Partial<Record<Phase, string>>;

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

/**
 * Map a ticket's `state:` to the role-pipeline phase that runs against it.
 * `blocked` and `done` have no role agent — the slash-command body STOPs
 * immediately on those states, so the model picked here doesn't actually
 * drive any work; we still return null so the caller can fall back to
 * ROLE_PIPELINE_MODEL rather than panicking.
 */
export function phaseForState(state: string): Phase | null {
  switch (state) {
    case "triage":
      return "product";
    case "refined":
      return "spike";
    case "in-progress":
      return "implementation";
    case "qa":
      return "qa";
    default:
      return null;
  }
}

/**
 * Resolve the model id to pass to `claude --model` for a spawn against a
 * ticket in `state`. Per-phase override wins; absent → ROLE_PIPELINE_MODEL.
 *
 * Auto-proceed within a single spawn (spike → implementation when the spike
 * self-rates S/H) keeps the spike-phase model — there's no way to swap a
 * model mid-session at the CLI level. Documented limitation; AGT-106/107
 * layer on heuristics that build on this foundation.
 */
export function resolveRoleModel(
  state: string,
  models: ModelsConfig | undefined,
): string {
  const phase = phaseForState(state);
  if (!phase) return ROLE_PIPELINE_MODEL;
  const pinned = models?.[phase];
  if (pinned && pinned.length > 0) return pinned;
  return ROLE_PIPELINE_MODEL;
}
