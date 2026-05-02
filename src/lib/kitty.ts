import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const SOCKET_BASENAME = "kitty-claudini";
const KNOWN_INSTANCES = ["personal", "work"] as const;
type Instance = (typeof KNOWN_INSTANCES)[number];

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function findKittyBinary(): string | null {
  const r = spawnSync("/usr/bin/env", ["which", "kitty"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const path = r.stdout.trim();
  return path.length > 0 ? path : null;
}

export function preferredKittyContext(
  repo: string | null,
  monitoredOrgs: string[],
): Instance {
  if (!repo) return "personal";
  const owner = repo.split("/")[0];
  if (!owner) return "personal";
  return monitoredOrgs.includes(owner) ? "work" : "personal";
}

export function findKittySocket(
  kittyPath: string,
  preferring?: Instance,
): string | null {
  const candidates: string[] = [];

  if (preferring) {
    candidates.push(`/tmp/${SOCKET_BASENAME}-${preferring}`);
  }
  for (const name of KNOWN_INSTANCES) {
    if (name !== preferring) {
      candidates.push(`/tmp/${SOCKET_BASENAME}-${name}`);
    }
  }
  candidates.push(`/tmp/${SOCKET_BASENAME}`);

  let pidSuffixed: string[] = [];
  try {
    const prefix = `${SOCKET_BASENAME}-`;
    pidSuffixed = readdirSync("/tmp")
      .filter((n) => n.startsWith(prefix))
      .map((n) => `/tmp/${n}`)
      .filter((p) => !candidates.includes(p));
  } catch {
    /* ignore */
  }
  if (preferring) {
    const preferredPrefix = `/tmp/${SOCKET_BASENAME}-${preferring}-`;
    candidates.push(...pidSuffixed.filter((p) => p.startsWith(preferredPrefix)));
    candidates.push(...pidSuffixed.filter((p) => !p.startsWith(preferredPrefix)));
  } else {
    candidates.push(...pidSuffixed);
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const socket = `unix:${path}`;
    const r = spawnSync(kittyPath, ["@", "--to", socket, "ls"], {
      encoding: "utf8",
    });
    if (r.status === 0) return socket;
  }
  return null;
}

export interface EnvPrefixOptions {
  vaultPath?: string;
}

export function envSourcingPrefix(
  workspace: Instance,
  repoBasename: string | null,
  repoSlug: string | null,
  extras: EnvPrefixOptions = {},
): string {
  const lines: string[] = [`export PATH="${augmentedPATH()}"`, "set -a"];
  lines.push(
    `[ -r "$HOME/.open-team/env-${workspace}" ] && . "$HOME/.open-team/env-${workspace}"`,
  );
  if (repoBasename && /^[A-Za-z0-9._-]+$/.test(repoBasename)) {
    const primary = `$HOME/Development/${repoBasename}`;
    lines.push(`[ -r "${primary}/.env" ] && . "${primary}/.env"`);
    lines.push(`[ -r "${primary}/.env.local" ] && . "${primary}/.env.local"`);
  }
  // repoSlug is "<owner>-<name>" (slashes already replaced + lowercased by the
  // caller in role-pipeline/runner.ts), so the regex must accept hyphens but
  // not slashes — otherwise the only legal slug ("owner/name") never matched
  // and this branch was unreachable.
  if (repoSlug && /^[a-z0-9._-]+$/.test(repoSlug)) {
    lines.push(
      `[ -r "$HOME/.open-team/env-${repoSlug}" ] && . "$HOME/.open-team/env-${repoSlug}"`,
    );
  }
  lines.push("set +a");
  // Override after env-file sourcing: the run-resolved vault wins over whatever
  // an env file might have set, so the spawned agent's `oteam pull/list/...`
  // calls land in the same vault this run is operating on.
  if (extras.vaultPath) {
    lines.push(`export PRODUCT_VAULT_PATH='${shellEscape(extras.vaultPath)}'`);
  }
  return lines.join("; ") + "; ";
}

export interface KittyLaunchOptions {
  socket: string;
  title: string;
  cwd: string;
  shellCmd: string;
  kittyPath: string;
}

export function kittyLaunch(opts: KittyLaunchOptions): {
  exitCode: number;
  stderr: string;
} {
  const args = [
    "@",
    "--to",
    opts.socket,
    "launch",
    "--type=os-window",
    "--os-window-title",
    opts.title,
    "--cwd",
    opts.cwd,
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    opts.shellCmd,
  ];
  const r = spawnSync(opts.kittyPath, args, { encoding: "utf8" });
  return { exitCode: r.status ?? -1, stderr: r.stderr ?? "" };
}

function augmentedPATH(): string {
  const home = process.env.HOME ?? "";
  const base = process.env.PATH ?? "/usr/bin:/bin";
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    "/Applications/kitty.app/Contents/MacOS",
    base,
  ].join(":");
}

export function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
