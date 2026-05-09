import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, join } from "node:path";
import {
  DEFAULT_MODELS,
  isPhase,
  PHASES,
  type ModelsConfig,
  type Phase,
} from "./models.ts";

export interface StampConfig {
  /** Stamp server URL prefix, e.g. `ssh://git@host:port` (no trailing slash). */
  host: string;
  /** When true, `oteam assign` refuses repos not registered on the stamp server. */
  enforce: boolean;
}

/** A per-repo entry in the `repos` config map. */
export interface RepoEntry {
  /** The URI to clone from (also the `origin` after the clone). */
  "clone-uri": string;
  /** ISO timestamp of when this entry was first recorded. */
  added: string;
}

export interface TelemetryConfig {
  enabled: boolean;
}

/** AGT-099: global no-push toggle for the assign-side push step. */
export type PushFlag = "on" | "off";

export interface OteamConfig {
  vaults: Record<string, string>;
  default: string | null;
  /** Null/absent both mean "stamp integration is off". */
  stamp: StampConfig | null;
  /**
   * Per-repo clone URIs. Keys are `<owner>/<name>` (stored verbatim,
   * looked up case-insensitively). Empty object omitted from disk.
   */
  repos: Record<string, RepoEntry>;
  /**
   * Per-phase model overrides for the role pipeline. Always an object;
   * empty `{}` means "no overrides — every phase uses ROLE_PIPELINE_MODEL".
   * Empty objects are omitted from the on-disk JSON to keep the file tidy.
   */
  models: ModelsConfig;
  /**
   * AGT-107: when true (the default), the runner downshifts the Product
   * spawn to Haiku 4.5 if the ticket is `source.type: manual` AND its
   * `## Acceptance Criteria` is already populated. In-memory this lives as a
   * sibling of `models`; on-disk it's nested under `models.productDownshift`
   * per AC #3 to keep the config-file surface organised.
   */
  productDownshift: boolean;
  /**
   * AGT-108: per-phase wall-clock + token telemetry. Defaults to enabled.
   * Off means `recordPhase()` short-circuits — no JSONL writes occur.
   */
  telemetry: TelemetryConfig;
  /**
   * GitHub login that `oteam assign` claims an issue under (sets `assignees`
   * on the underlying GH issue) before driving the role pipeline. Empty
   * string means "no claim attempted" — backwards-compatible with configs
   * that predate this field. Set to enable double-pickup protection across
   * multiple agents/operators.
   *
   * Override per-invocation with the `OTEAM_BOT_IDENTITY` env var.
   */
  botIdentity: string;
  /**
   * AGT-099: global toggle for the assign-side push step. Default `"on"`.
   * When `"off"`, the role-pipeline body's Phase 4b push step skips the
   * outbound `git push` / `stamp push` and prints a status line directing
   * the user to push manually. Read at spawn time and injected into the
   * spawned agent's system prompt — the agent never reads config.json itself.
   */
  push: PushFlag;
}

/** AGT-107: the default for `productDownshift` — heuristic on. */
const DEFAULT_PRODUCT_DOWNSHIFT = true;

/** AGT-099: the default for `push` — outbound push enabled. */
const DEFAULT_PUSH: PushFlag = "on";

export interface ResolvedVault {
  name: string;
  path: string;
}

export function configDir(): string {
  return join(homedir(), ".open-team");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): OteamConfig {
  const path = configPath();
  if (!existsSync(path)) return emptyConfig();
  // existsSync already covers not-found; let real I/O errors (perms, etc.)
  // propagate so the user can fix them rather than silently falling back to
  // an empty config — which a subsequent writeConfig would then clobber.
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`config: ${path} is not valid JSON — ${msg}`);
  }
  return normalise(parsed);
}

export function writeConfig(config: OteamConfig): void {
  mkdirSync(configDir(), { recursive: true });
  // Strip empty `models` from the on-disk JSON so a fresh config that's
  // never had a phase pinned doesn't accumulate noise. Round-trip is
  // preserved because normalise() defaults a missing `models` key to `{}`.
  const onDisk: Record<string, unknown> = {
    vaults: config.vaults,
    default: config.default,
    stamp: config.stamp,
  };
  // Omit empty repos block from disk to keep a fresh config tidy.
  if (Object.keys(config.repos).length > 0) {
    onDisk.repos = config.repos;
  }
  // AGT-107: the in-memory `productDownshift` flag is serialised as a
  // sibling of the per-phase model overrides at `models.productDownshift`.
  // Build a single on-disk `models` object so the two surfaces co-locate
  // cleanly, but only emit the block when something deviates from defaults
  // (matches how empty `models` and default-on `telemetry` are omitted).
  const onDiskModels: Record<string, unknown> = { ...config.models };
  if (config.productDownshift !== DEFAULT_PRODUCT_DOWNSHIFT) {
    onDiskModels.productDownshift = config.productDownshift;
  }
  if (Object.keys(onDiskModels).length > 0) {
    onDisk.models = onDiskModels;
  }
  // Telemetry defaults to enabled, so omit the block from disk in that case
  // to keep a fresh config tidy (mirrors how empty `models` is omitted).
  if (!config.telemetry.enabled) {
    onDisk.telemetry = config.telemetry;
  }
  // botIdentity is opt-in (default empty); only persist when set.
  if (config.botIdentity.length > 0) {
    onDisk.botIdentity = config.botIdentity;
  }
  // AGT-099: push defaults to "on"; only persist when the user has flipped
  // it off. Mirrors how default-on telemetry is omitted from disk.
  if (config.push !== DEFAULT_PUSH) {
    onDisk.push = config.push;
  }
  const body = JSON.stringify(onDisk, null, 2) + "\n";
  writeFileSync(configPath(), body);
}

function emptyConfig(): OteamConfig {
  return {
    vaults: {},
    default: null,
    stamp: null,
    repos: {},
    models: {},
    productDownshift: DEFAULT_PRODUCT_DOWNSHIFT,
    telemetry: { enabled: true },
    botIdentity: "",
    push: DEFAULT_PUSH,
  };
}

export interface AddVaultResult {
  name: string;
  path: string;
  promotedToDefault: boolean;
}

export function addVault(
  rawPath: string,
  options: { name?: string } = {},
): AddVaultResult {
  const path = absolutise(rawPath);
  const config = readConfig();

  const existingName = findNameByPath(config, path);
  if (existingName) {
    if (options.name && options.name !== existingName) {
      throw new Error(
        `path ${path} is already registered as "${existingName}" — pass that name or remove it first`,
      );
    }
    return { name: existingName, path, promotedToDefault: false };
  }

  const name = options.name ?? deriveName(config, path);
  if (config.vaults[name] && config.vaults[name] !== path) {
    throw new Error(
      `name "${name}" already maps to ${config.vaults[name]} — pass --name <other>`,
    );
  }

  config.vaults[name] = path;
  let promoted = false;
  if (!config.default) {
    config.default = name;
    promoted = true;
  }
  writeConfig(config);
  return { name, path, promotedToDefault: promoted };
}

export interface RemoveVaultResult {
  name: string;
  clearedDefault: boolean;
}

export function removeVault(nameOrPath: string): RemoveVaultResult {
  const config = readConfig();
  const name = findEntry(config, nameOrPath);
  if (!name) {
    throw new Error(`no workspace registered as "${nameOrPath}"`);
  }
  delete config.vaults[name];
  let cleared = false;
  if (config.default === name) {
    config.default = null;
    cleared = true;
  }
  writeConfig(config);
  return { name, clearedDefault: cleared };
}

export function setDefault(nameOrPath: string): string {
  const config = readConfig();
  const name = findEntry(config, nameOrPath);
  if (!name) {
    throw new Error(`no workspace registered as "${nameOrPath}"`);
  }
  config.default = name;
  writeConfig(config);
  return name;
}

export function listVaults(): {
  vaults: ResolvedVault[];
  default: string | null;
} {
  const config = readConfig();
  const vaults = Object.entries(config.vaults).map(([name, path]) => ({
    name,
    path,
  }));
  vaults.sort((a, b) => a.name.localeCompare(b.name));
  return { vaults, default: config.default };
}

export function resolveByNameOrPath(
  nameOrPath: string,
  config: OteamConfig = readConfig(),
): ResolvedVault | null {
  const direct = config.vaults[nameOrPath];
  if (direct) return { name: nameOrPath, path: direct };

  if (nameOrPath.includes("/") || isAbsolute(nameOrPath)) {
    const abs = absolutise(nameOrPath);
    const name = findNameByPath(config, abs);
    if (name) return { name, path: abs };
    return { name: basename(abs), path: abs };
  }
  return null;
}

export function findVaultRootForPath(
  filePath: string,
  config: OteamConfig = readConfig(),
): ResolvedVault | null {
  const abs = absolutise(filePath);
  for (const [name, path] of Object.entries(config.vaults)) {
    if (abs === path || abs.startsWith(path.endsWith("/") ? path : path + "/")) {
      return { name, path };
    }
  }
  return null;
}

function normalise(parsed: unknown): OteamConfig {
  if (!parsed || typeof parsed !== "object") {
    return emptyConfig();
  }
  const obj = parsed as {
    vaults?: unknown;
    default?: unknown;
    stamp?: unknown;
    repos?: unknown;
    models?: unknown;
    telemetry?: unknown;
    botIdentity?: unknown;
    push?: unknown;
  };
  const vaults: Record<string, string> = {};
  if (obj.vaults && typeof obj.vaults === "object") {
    for (const [name, value] of Object.entries(obj.vaults as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) vaults[name] = value;
    }
  }
  const def =
    typeof obj.default === "string" && obj.default in vaults
      ? obj.default
      : null;
  return {
    vaults,
    default: def,
    stamp: normaliseStamp(obj.stamp),
    repos: normaliseRepos(obj.repos),
    models: normaliseModels(obj.models),
    productDownshift: normaliseProductDownshift(obj.models),
    telemetry: normaliseTelemetry(obj.telemetry),
    botIdentity: typeof obj.botIdentity === "string" ? obj.botIdentity.trim() : "",
    push: normalisePush(obj.push),
  };
}

function normalisePush(value: unknown): PushFlag {
  // AC #1 / #5: default "on". Only an explicit "off" flips the toggle;
  // absent / null / unrecognised string all read as the default. Idempotent
  // re-set is naturally satisfied because read-modify-write writes the same
  // value back when the input matches the current state.
  return value === "off" ? "off" : DEFAULT_PUSH;
}

function normaliseProductDownshift(value: unknown): boolean {
  // AC #3: default true. Only an explicit `false` flips it off; absent /
  // null / malformed all read as the default. The flag lives nested under
  // the on-disk `models` block per the prescribed surface.
  if (!value || typeof value !== "object") return DEFAULT_PRODUCT_DOWNSHIFT;
  const v = value as { productDownshift?: unknown };
  return v.productDownshift !== false;
}

function normaliseTelemetry(value: unknown): TelemetryConfig {
  // Default-on: absent / null / malformed → enabled. Only an explicit
  // `{ enabled: false }` flips the switch off, mirroring AC #7's "default on,
  // explicit opt-out" contract.
  if (!value || typeof value !== "object") return { enabled: true };
  const v = value as { enabled?: unknown };
  return { enabled: v.enabled !== false };
}

function normaliseModels(value: unknown): ModelsConfig {
  // AC #2 / #3: tolerate absent / malformed shapes. Unknown phase keys are
  // dropped; non-string or empty-string values are dropped. The end result
  // is always a clean ModelsConfig where every present field is a known
  // phase mapped to a non-empty string.
  if (!value || typeof value !== "object") return {};
  const out: ModelsConfig = {};
  for (const [phase, modelId] of Object.entries(value as Record<string, unknown>)) {
    if (!isPhase(phase)) continue;
    if (typeof modelId !== "string") continue;
    const trimmed = modelId.trim();
    if (trimmed.length === 0) continue;
    out[phase] = trimmed;
  }
  return out;
}

function normaliseStamp(value: unknown): StampConfig | null {
  // AC #3: tolerate absent / explicit null / present forms. Empty-host
  // shapes round-trip to null so a half-cleared block doesn't masquerade as
  // "stamp configured."
  if (value == null) return null;
  if (typeof value !== "object") return null;
  const s = value as { host?: unknown; enforce?: unknown };
  if (typeof s.host !== "string") return null;
  const host = s.host.trim();
  if (host.length === 0) return null;
  return { host: stripTrailingSlash(host), enforce: s.enforce === true };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** `<owner>/<name>` with no extra slashes. */
const REPO_SLUG_RE = /^[^/]+\/[^/]+$/;

function validateSlug(slug: string): void {
  if (!REPO_SLUG_RE.test(slug.trim())) {
    throw new Error(
      `invalid repo slug "${slug}" — expected <owner>/<name> (e.g. OpenThinkAi/open-team)`,
    );
  }
}

function normaliseRepos(value: unknown): Record<string, RepoEntry> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, RepoEntry> = {};
  for (const [slug, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!REPO_SLUG_RE.test(slug)) continue;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { "clone-uri"?: unknown; added?: unknown };
    if (typeof e["clone-uri"] !== "string" || e["clone-uri"].trim().length === 0) continue;
    if (typeof e.added !== "string") continue;
    out[slug] = { "clone-uri": e["clone-uri"].trim(), added: e.added };
  }
  return out;
}

export function getStampConfig(): StampConfig | null {
  return readConfig().stamp;
}

export function setStampHost(host: string): StampConfig {
  const trimmed = host.trim();
  if (trimmed.length === 0) {
    throw new Error("stamp host cannot be empty — pass a value like ssh://git@host:port");
  }
  const config = readConfig();
  const next: StampConfig = {
    host: stripTrailingSlash(trimmed),
    enforce: config.stamp?.enforce ?? false,
  };
  config.stamp = next;
  writeConfig(config);
  return next;
}

export function setStampEnforce(enforce: boolean): StampConfig {
  const config = readConfig();
  // G3: refuse to enable enforcement without a host. Silent fallback to
  // ~/.stamp/server.yml would re-couple oteam to stamp's filesystem; auto-
  // clearing the flag would silently change the user's intent. Loud error
  // forces them to either set a host or back out of the change.
  if (enforce && (!config.stamp || config.stamp.host.length === 0)) {
    throw new Error(
      "cannot set stamp.enforce on with no stamp.host — run 'oteam config stamp set --host <url>' first",
    );
  }
  const next: StampConfig = {
    host: config.stamp?.host ?? "",
    enforce,
  };
  config.stamp = next;
  writeConfig(config);
  return next;
}

/**
 * Atomic version of setStampHost+setStampEnforce — used by the init prompt
 * so a host+enforce update lands as a single config write rather than two
 * read-modify-write cycles.
 */
export function setStamp(input: { host: string; enforce: boolean }): StampConfig {
  const trimmed = input.host.trim();
  if (trimmed.length === 0) {
    throw new Error("stamp host cannot be empty — pass a value like ssh://git@host:port");
  }
  const next: StampConfig = {
    host: stripTrailingSlash(trimmed),
    enforce: input.enforce,
  };
  // The G3 guard collapses to "host non-empty" here; the trim above has
  // already enforced that. No additional check needed.
  const config = readConfig();
  config.stamp = next;
  writeConfig(config);
  return next;
}

export function clearStamp(): void {
  const config = readConfig();
  config.stamp = null;
  writeConfig(config);
}

export function getModels(): ModelsConfig {
  return readConfig().models;
}

export function setModel(phase: Phase, modelId: string): ModelsConfig {
  const trimmed = modelId.trim();
  // AC #3: validation surface is "non-empty string". Anything beyond that
  // (does the SDK actually accept this id?) defers to the SDK itself, which
  // surfaces a clear error at spawn time.
  if (trimmed.length === 0) {
    throw new Error(
      `model id for phase "${phase}" cannot be empty — pass a non-empty string`,
    );
  }
  if (!isPhase(phase)) {
    throw new Error(
      `unknown phase "${phase}" — supported: ${PHASES.join(", ")}`,
    );
  }
  const config = readConfig();
  config.models = { ...config.models, [phase]: trimmed };
  writeConfig(config);
  return config.models;
}

export type SeedModelsAction = "seeded" | "preserved";

export interface SeedModelsResult {
  action: SeedModelsAction;
  models: ModelsConfig;
}

/**
 * Seed `DEFAULT_MODELS` into the on-disk config when `models` is empty;
 * leave any existing block (even a single-phase one) untouched. Called by
 * `oteam init` so a fresh user gets the Sonnet/Opus baseline without
 * having to type four `oteam config models set` commands.
 *
 * "Empty" covers both shapes `normaliseModels` can produce: key absent in
 * the JSON (legacy / never-set) and explicit `models: {}` (user cleared
 * every override). Both deserve the defaults — anything non-empty is
 * preserved verbatim per AC #2.
 */
export function seedDefaultModelsIfEmpty(): SeedModelsResult {
  const config = readConfig();
  if (Object.keys(config.models).length > 0) {
    return { action: "preserved", models: config.models };
  }
  config.models = { ...DEFAULT_MODELS };
  writeConfig(config);
  return { action: "seeded", models: config.models };
}

export function getProductDownshift(): boolean {
  return readConfig().productDownshift;
}

export function setProductDownshift(enabled: boolean): boolean {
  const config = readConfig();
  config.productDownshift = enabled;
  writeConfig(config);
  return config.productDownshift;
}

export function getTelemetryEnabled(): boolean {
  return readConfig().telemetry.enabled;
}

export function setTelemetryEnabled(enabled: boolean): TelemetryConfig {
  const config = readConfig();
  config.telemetry = { enabled };
  writeConfig(config);
  return config.telemetry;
}

export function getPush(): PushFlag {
  return readConfig().push;
}

export function setPush(flag: PushFlag): PushFlag {
  const config = readConfig();
  config.push = flag;
  writeConfig(config);
  return config.push;
}

export function getBotIdentity(): string {
  return readConfig().botIdentity;
}

export function setBotIdentity(login: string): string {
  const trimmed = login.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "bot identity cannot be empty — pass a GitHub login (use `oteam config bot-identity clear` to remove)",
    );
  }
  const config = readConfig();
  config.botIdentity = trimmed;
  writeConfig(config);
  return trimmed;
}

export function clearBotIdentity(): void {
  const config = readConfig();
  config.botIdentity = "";
  writeConfig(config);
}

// ---------------------------------------------------------------------------
// Per-repo URI tracking (AGT-097)
// ---------------------------------------------------------------------------

/**
 * Look up a repo slug (case-insensitively). Returns null when not found.
 */
export function getRepoEntry(
  slug: string,
  config: OteamConfig = readConfig(),
): RepoEntry | null {
  const key = findRepoKey(config, slug);
  return key ? config.repos[key] ?? null : null;
}

/**
 * Add or update a repo entry. The slug is stored verbatim (case-insensitive
 * lookup reuses the existing key when one already exists).
 */
export function setRepoCloneUri(slug: string, cloneUri: string): RepoEntry {
  validateSlug(slug);
  const trimmedUri = cloneUri.trim();
  if (trimmedUri.length === 0) {
    throw new Error(
      `clone URI for "${slug}" cannot be empty — pass a valid git URL`,
    );
  }
  const config = readConfig();
  const existingKey = findRepoKey(config, slug);
  const key = existingKey ?? slug;
  const existing = existingKey ? config.repos[existingKey] : undefined;
  config.repos[key] = {
    "clone-uri": trimmedUri,
    added: existing?.added ?? new Date().toISOString(),
  };
  writeConfig(config);
  return config.repos[key]!;
}

export interface RepoListEntry {
  slug: string;
  entry: RepoEntry;
}

export function listRepoEntries(): RepoListEntry[] {
  const config = readConfig();
  return Object.entries(config.repos)
    .map(([slug, entry]) => ({ slug, entry }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Remove a repo entry. No-op if the slug is not present (idempotent per AC #2).
 */
export function removeRepoEntry(slug: string): boolean {
  const config = readConfig();
  const key = findRepoKey(config, slug);
  if (!key) return false;
  delete config.repos[key];
  writeConfig(config);
  return true;
}

/** Case-insensitive slug lookup — returns the stored key or null. */
function findRepoKey(
  config: OteamConfig,
  slug: string,
): string | null {
  const lower = slug.toLowerCase();
  for (const key of Object.keys(config.repos)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

/**
 * Resolve the effective bot identity for a single `oteam assign` invocation.
 * `OTEAM_BOT_IDENTITY` takes precedence over the persisted config; empty
 * string means "no claim attempted" — the caller skips the claim entirely.
 */
export function resolveBotIdentity(config: OteamConfig = readConfig()): string {
  const env = process.env.OTEAM_BOT_IDENTITY;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return config.botIdentity;
}

export function clearModel(phase: Phase): ModelsConfig {
  if (!isPhase(phase)) {
    throw new Error(
      `unknown phase "${phase}" — supported: ${PHASES.join(", ")}`,
    );
  }
  const config = readConfig();
  if (phase in config.models) {
    const next = { ...config.models };
    delete next[phase];
    config.models = next;
    writeConfig(config);
  }
  return config.models;
}

function findEntry(config: OteamConfig, nameOrPath: string): string | null {
  if (config.vaults[nameOrPath]) return nameOrPath;
  if (nameOrPath.includes("/") || isAbsolute(nameOrPath)) {
    const abs = absolutise(nameOrPath);
    return findNameByPath(config, abs);
  }
  return null;
}

function findNameByPath(config: OteamConfig, path: string): string | null {
  for (const [name, p] of Object.entries(config.vaults)) {
    if (p === path) return name;
  }
  return null;
}

function deriveName(config: OteamConfig, path: string): string {
  const base = basename(path) || "vault";
  if (!config.vaults[base]) return base;
  let n = 2;
  while (config.vaults[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}

function absolutise(rawPath: string): string {
  const expanded = rawPath.startsWith("~")
    ? join(homedir(), rawPath.slice(1).replace(/^\/+/, ""))
    : rawPath;
  return resolve(expanded);
}
