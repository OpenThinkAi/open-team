// Centralised model IDs. Update here when bumping; nothing else in the tree
// should hardcode a Claude model string.
//
// ROLE_PIPELINE_MODEL is the fallback used when the user has not pinned a
// per-phase model in `~/.open-team/config.json`'s `models` block.
export const ROLE_PIPELINE_MODEL = "claude-opus-4-7";

// AGT-107: when the heuristic fires (manual + populated AC + downshift on),
// Product spawns on Haiku 4.5 instead of `models.product`. Haiku handles the
// structural-cleanup case the heuristic exists to detect; the configured
// Product model still drives every other path.
export const HAIKU_PRODUCT_MODEL = "claude-haiku-4-5";

export const PHASES = ["product", "spike", "implementation", "qa"] as const;
export type Phase = (typeof PHASES)[number];

export type ModelsConfig = Partial<Record<Phase, string>>;

// Defaults seeded by `oteam init` when no `models` block exists in
// `~/.open-team/config.json`. The Sonnet/Opus split routes the bread-and-
// butter phases (Product/Implementation/QA) to Sonnet 4.6 and reserves
// Opus 4.7 for the spike, where design judgment earns its keep. AGT-107
// layers a Haiku downshift on Product when the ticket is well-formed;
// this constant is the unconditional baseline.
export const DEFAULT_MODELS: Required<ModelsConfig> = {
  product: "claude-sonnet-4-6",
  spike: "claude-opus-4-7",
  implementation: "claude-sonnet-4-6",
  qa: "claude-sonnet-4-6",
};

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

/**
 * AGT-107 predicate: does the ticket body contain a populated
 * `## Acceptance Criteria` section?
 *
 * "Populated" = at least one numbered bullet (`1.`, `2.`, …) of substantive
 * content. HTML-comment placeholders (the manual-ticket template emits one)
 * read as empty. Anything else outside the AC section is ignored — only the
 * lines under the heading until the next `## ` heading or EOF count.
 */
export function acceptanceCriteriaIsPopulated(body: string): boolean {
  const lines = body.split("\n");
  let inSection = false;
  let inHtmlComment = false;
  const numberedBullet = /^\s*\d+\.\s+\S/;
  for (const line of lines) {
    if (!inSection) {
      // Heading match is loose on whitespace so a stray trailing space
      // doesn't hide the section.
      if (/^##\s+Acceptance Criteria\s*$/.test(line)) {
        inSection = true;
      }
      continue;
    }
    // Next top-level heading ends the section.
    if (/^##\s+/.test(line)) return false;
    // Track HTML-comment blocks so a template comment with a `1.` inside it
    // doesn't accidentally count. Single-line `<!-- … -->` opens and closes
    // on the same iteration; multi-line opens stay sticky until `-->`.
    let scan = line;
    while (scan.length > 0) {
      if (inHtmlComment) {
        const close = scan.indexOf("-->");
        if (close === -1) {
          scan = "";
          break;
        }
        scan = scan.slice(close + 3);
        inHtmlComment = false;
      } else {
        const open = scan.indexOf("<!--");
        if (open === -1) break;
        // Anything before `<!--` on this line is real content; check it
        // for a numbered bullet before consuming the comment.
        const before = scan.slice(0, open);
        if (numberedBullet.test(before)) return true;
        const rest = scan.slice(open + 4);
        const close = rest.indexOf("-->");
        if (close === -1) {
          inHtmlComment = true;
          scan = "";
          break;
        }
        scan = rest.slice(close + 3);
      }
    }
    if (inHtmlComment) continue;
    if (numberedBullet.test(scan)) return true;
  }
  return false;
}

export interface ResolveModelForTicketArgs {
  state: string;
  sourceType: string;
  body: string;
  productDownshift: boolean;
  models: ModelsConfig | undefined;
}

/**
 * AGT-107: layer the Haiku-downshift heuristic over `resolveRoleModel`.
 *
 * The heuristic fires only on the Product phase (`state === "triage"`) when
 * `source.type` is `manual`, the user has not disabled it, and the ticket
 * body's `## Acceptance Criteria` section is already populated. Every other
 * code path delegates to `resolveRoleModel` unchanged so AGT-105/106
 * invariants hold.
 */
export function resolveModelForTicket(args: ResolveModelForTicketArgs): string {
  if (
    args.state === "triage" &&
    args.sourceType === "manual" &&
    args.productDownshift &&
    acceptanceCriteriaIsPopulated(args.body)
  ) {
    return HAIKU_PRODUCT_MODEL;
  }
  return resolveRoleModel(args.state, args.models);
}
