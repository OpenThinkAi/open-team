import { createInterface } from "node:readline";

export interface PromptCloneUriResult {
  uri: string;
  recorded: boolean;
}

export interface PromptCloneUriOptions {
  /**
   * Whether the current process has an interactive TTY on stdin. Callers
   * compute this themselves (e.g. `process.stdin.isTTY`) so tests can inject
   * any value without OS-level TTY faking.
   */
  isTTY: boolean;
  /**
   * Injectable readline implementation. Default uses `node:readline`
   * `createInterface`. Tests inject a fake.
   */
  readLine?: (prompt: string) => Promise<string>;
}

/**
 * Prompt the user for a clone URI on first-encounter, or apply the
 * appropriate non-TTY fallback.
 *
 * The two callers have different non-TTY policies:
 * - `oteam assign` (non-TTY): throws `NoTTYError` so the runner can exit with
 *   the AC #4 remediation message. The user must pre-register the repo or
 *   provide a TTY.
 * - `oteam pull` (non-TTY): silently returns the `defaultUri` so the dispatch
 *   daemon keeps working. The asymmetry is intentional — assign refuses because
 *   the wrong URI would waste expensive agent work; pull just needs a record so
 *   future assigns can prompt at the right time.
 *
 * @param slug        `<owner>/<name>` — displayed in the prompt copy.
 * @param defaultUri  The URI shown/used as the default (usually the HTTPS GitHub URL).
 * @param opts        TTY state + injectable readline.
 * @param onNoTTY     `"refuse"` (assign) → throws; `"default"` (pull) → returns defaultUri silently.
 */
export async function promptCloneUri(
  slug: string,
  defaultUri: string,
  opts: PromptCloneUriOptions,
  onNoTTY: "refuse" | "default",
): Promise<PromptCloneUriResult> {
  if (!opts.isTTY) {
    if (onNoTTY === "refuse") {
      throw new NoTTYError(slug);
    }
    // "default": non-interactive pull path — record silently.
    return { uri: defaultUri, recorded: true };
  }

  const rl = opts.readLine ?? defaultReadLine;
  const raw = await rl(
    `Clone URI for ${slug}? (default: ${defaultUri})\n> `,
  );
  const trimmed = raw.trim();
  const uri = trimmed.length > 0 ? trimmed : defaultUri;
  return { uri, recorded: true };
}

export class NoTTYError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(
      [
        `oteam assign: no clone URI recorded for "${slug}" and stdin is not a TTY.`,
        `  Fix: run  oteam config repo add ${slug} <git-url>`,
        `  Or assign interactively (with a TTY) to be prompted once.`,
      ].join("\n"),
    );
    this.name = "NoTTYError";
    this.slug = slug;
  }
}

async function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
