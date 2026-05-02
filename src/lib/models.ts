// Centralised model IDs. Update here when bumping; nothing else in the tree
// should hardcode a Claude model string.
//
// ROLE_PIPELINE_MODEL is passed as `claude --model <id>` when oteam spawns
// the role-pipeline session (kitty or inline). The user can override
// per-session inside that claude REPL via /model.
//
// NORMALISER_MODEL is the one-shot LLM call inside ingestors that turns an
// unstructured source body into a vault-shape ticket. Intentionally cheaper
// — it's a text-to-text job with no tools.
export const ROLE_PIPELINE_MODEL = "claude-opus-4-7";
export const NORMALISER_MODEL = "claude-sonnet-4-6";
