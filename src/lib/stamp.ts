import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StampServerConfig {
  host: string;
  port: number;
}

export function stampServerConfigPath(): string {
  return join(homedir(), ".stamp", "server.yml");
}

/**
 * Reads `~/.stamp/server.yml` and returns `{ host, port }`. Returns `null`
 * when the file is absent (the universal "stamp server is not configured on
 * this machine" signal). Throws when the file exists but is malformed —
 * silently falling back would mask a misconfiguration.
 *
 * The file is intentionally parsed with a minimal line-oriented parser
 * (rather than a full YAML dependency) since it only ever holds two scalar
 * keys; matches the awk-based pattern already used in `assign-ticket.md`.
 */
export function readStampServerConfig(): StampServerConfig | null {
  const path = stampServerConfigPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let host: string | undefined;
  let port: number | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(host|port):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2] ?? "";
    if (m[1] === "host") host = value;
    else if (m[1] === "port") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) port = n;
    }
  }
  if (!host || !port) {
    throw new Error(
      `${path} is missing required keys (host + port) — got host=${host ?? "(unset)"} port=${port ?? "(unset)"}`,
    );
  }
  return { host, port };
}

export function buildStampUrl(
  config: StampServerConfig,
  repoBasename: string,
): string {
  return `ssh://git@${config.host}:${config.port}/srv/git/${repoBasename}.git`;
}

export function buildGithubUrl(repoSlug: string): string {
  return `git@github.com:${repoSlug}.git`;
}
