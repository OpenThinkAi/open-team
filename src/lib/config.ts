import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, join } from "node:path";

export interface OteamConfig {
  vaults: Record<string, string>;
  default: string | null;
}

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
  if (!existsSync(path)) return { vaults: {}, default: null };
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
  const body = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(configPath(), body);
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
    throw new Error(`no vault registered as "${nameOrPath}"`);
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
    throw new Error(`no vault registered as "${nameOrPath}"`);
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
  if (!parsed || typeof parsed !== "object") return { vaults: {}, default: null };
  const obj = parsed as { vaults?: unknown; default?: unknown };
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
  return { vaults, default: def };
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
