import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";
import {
  configDir,
  configPath,
  getModels,
  getStampConfig,
  listVaults,
  setModel,
} from "../src/lib/config.ts";
import { DEFAULT_MODELS } from "../src/lib/models.ts";
import { SENTINEL_FILENAME } from "../src/lib/workspace-tree.ts";

let savedHome: string | undefined;
let fakeHome = "";

beforeEach(() => {
  savedHome = process.env.HOME;
  // realpathSync collapses /var → /private/var on macOS so paths persisted
  // by the code (which call resolve()) match the values we compare against.
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "oteam-init-home-")));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("oteam init — workspace bootstrap", () => {
  it("creates ~/openteam tree, sentinel, and registers it as default on first run", async () => {
    const result = await runInit({ yes: true });

    const expected = join(fakeHome, "openteam");
    assert.equal(result.workspace.path, expected);
    assert.equal(result.workspace.outcome, "created");
    assert.equal(result.workspace.registeredAs, "openteam");
    assert.equal(result.workspace.promotedToDefault, true);

    for (const sub of [
      "tickets/triage",
      "tickets/refined",
      "tickets/in-progress",
      "tickets/qa",
      "tickets/blocked",
      "projects",
      "archive",
    ]) {
      assert.ok(existsSync(join(expected, sub)), `missing ${sub}`);
    }
    assert.ok(existsSync(join(expected, "00-meta", "README.md")));
    assert.ok(existsSync(join(expected, SENTINEL_FILENAME)));

    const vaults = listVaults();
    assert.equal(vaults.default, "openteam");
    assert.equal(vaults.vaults[0]?.path, expected);
  });

  it("respects --dir <path> as the workspace location", async () => {
    const customWorkspace = join(fakeHome, "elsewhere");
    const result = await runInit({ dir: customWorkspace, yes: true });
    assert.equal(result.workspace.path, customWorkspace);
    assert.equal(result.workspace.outcome, "created");
    assert.ok(existsSync(join(customWorkspace, "tickets", "triage")));
  });

  it("treats --workspace as an alias of --dir", async () => {
    const customWorkspace = join(fakeHome, "alias-target");
    const result = await runInit({ workspace: customWorkspace, yes: true });
    assert.equal(result.workspace.path, customWorkspace);
    assert.ok(existsSync(join(customWorkspace, SENTINEL_FILENAME)));
  });

  it("rejects conflicting --dir and --workspace values", async () => {
    await assert.rejects(
      () =>
        runInit({
          dir: join(fakeHome, "a"),
          workspace: join(fakeHome, "b"),
          yes: true,
        }),
      /--dir and --workspace disagree/,
    );
  });

  it("is idempotent: re-running on an initialised workspace is a no-op (already-initialised)", async () => {
    const first = await runInit({ yes: true });
    assert.equal(first.workspace.outcome, "created");

    const beforeSentinel = readFileSync(
      join(first.workspace.path, SENTINEL_FILENAME),
      "utf8",
    );

    const second = await runInit({ yes: true });
    assert.equal(second.workspace.outcome, "already-initialised");
    assert.equal(second.workspace.registeredAs, "openteam");
    assert.equal(second.workspace.promotedToDefault, false);

    const afterSentinel = readFileSync(
      join(first.workspace.path, SENTINEL_FILENAME),
      "utf8",
    );
    assert.equal(afterSentinel, beforeSentinel, "sentinel must not be rewritten");
  });

  it("refuses to merge into a non-empty unmarked directory", async () => {
    const target = join(fakeHome, "openteam");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stranger.txt"), "hi\n");

    await assert.rejects(
      () => runInit({ yes: true }),
      (err: unknown) => {
        if (!(err instanceof Error)) return false;
        return (
          /refusing to initialise/.test(err.message) &&
          /stranger\.txt/.test(err.message)
        );
      },
    );
    // Nothing touched inside the target except what was already there.
    assert.equal(existsSync(join(target, "tickets")), false);
    assert.equal(existsSync(join(target, SENTINEL_FILENAME)), false);
  });

  it("does not promote to default if a default is already registered", async () => {
    const preExisting = join(fakeHome, "Documents", "product-vault");
    mkdirSync(preExisting, { recursive: true });
    // Register the pre-existing vault first so it owns the default slot.
    const { addVault } = await import("../src/lib/config.ts");
    addVault(preExisting);

    const result = await runInit({ yes: true });
    assert.equal(result.workspace.promotedToDefault, false);
    assert.equal(result.workspace.currentDefault, "product-vault");
  });

  it("writes AGENTS.md and CLAUDE.md to $HOME by default and adds the marked block", async () => {
    const result = await runInit({ yes: true });

    assert.equal(result.agents.path, join(fakeHome, "AGENTS.md"));
    assert.equal(result.claude.path, join(fakeHome, "CLAUDE.md"));
    assert.equal(result.agents.result, "created");
    assert.equal(result.claude.result, "created");

    const agents = readFileSync(result.agents.path, "utf8");
    const claude = readFileSync(result.claude.path, "utf8");
    assert.match(agents, /oteam:begin/);
    assert.match(agents, /oteam:end/);
    assert.match(agents, /workspace-driven role pipeline/);
    assert.match(claude, /oteam:begin/);
    assert.match(claude, /AGENTS\.md/);
  });

  it("is idempotent on the docs block: re-running updates in place", async () => {
    await runInit({ yes: true });
    const firstAgents = readFileSync(join(fakeHome, "AGENTS.md"), "utf8");

    const result = await runInit({ yes: true });
    const secondAgents = readFileSync(join(fakeHome, "AGENTS.md"), "utf8");

    assert.equal(result.agents.result, "updated");
    assert.equal(firstAgents, secondAgents);

    const beginCount = secondAgents.match(/oteam:begin/g)?.length ?? 0;
    const endCount = secondAgents.match(/oteam:end/g)?.length ?? 0;
    assert.equal(beginCount, 1);
    assert.equal(endCount, 1);
  });

  it("appends the block when an existing AGENTS.md has no markers, preserving prior content", async () => {
    const existing = "# My existing AGENTS.md\n\nProject-specific guidance.\n";
    writeFileSync(join(fakeHome, "AGENTS.md"), existing, "utf8");

    const result = await runInit({ yes: true });
    assert.equal(result.agents.result, "appended");

    const agents = readFileSync(join(fakeHome, "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith(existing));
    assert.match(agents, /oteam:begin/);
    assert.match(agents, /oteam:end/);
  });

  it("honours --docs-dir <path> for power users", async () => {
    const docsDir = join(fakeHome, "alt-docs");
    mkdirSync(docsDir, { recursive: true });

    const result = await runInit({ docsDir, yes: true });
    assert.equal(result.agents.path, join(docsDir, "AGENTS.md"));
    assert.equal(result.claude.path, join(docsDir, "CLAUDE.md"));
    assert.ok(existsSync(result.agents.path));
    assert.ok(existsSync(result.claude.path));
    // $HOME must NOT have received the docs when --docs-dir is set.
    assert.equal(existsSync(join(fakeHome, "AGENTS.md")), false);
  });
});

describe("oteam init — stamp prompts (AGT-096)", () => {
  // All tests pass `dir` so the workspace-path prompt doesn't block on
  // stdin. We can't pass `yes: true` because that short-circuits the stamp
  // step entirely (which is exactly what the first test below verifies).
  function init(extra: Parameters<typeof runInit>[0] = {}) {
    return runInit({ dir: join(fakeHome, "openteam"), ...extra });
  }

  it("--yes skips stamp prompts and leaves stamp config null", async () => {
    const result = await init({ yes: true });
    assert.equal(result.stamp.action, "skipped");
    assert.equal(getStampConfig(), null);
  });

  it("--skip-stamp skips prompts and leaves any existing stamp block alone", async () => {
    // Pre-set a stamp block so we can assert --skip-stamp doesn't touch it.
    const { setStampHost, setStampEnforce } = await import("../src/lib/config.ts");
    setStampHost("ssh://git@stamp.example.com:22000");
    setStampEnforce(true);

    const result = await init({ skipStamp: true });
    assert.equal(result.stamp.action, "skipped");
    assert.deepEqual(getStampConfig(), {
      host: "ssh://git@stamp.example.com:22000",
      enforce: true,
    });
  });

  it("first init writes a stamp block when stampHost is supplied (AC #1, #3)", async () => {
    const result = await init({
      stampHost: "ssh://git@stamp.example.com:22000",
      stampEnforce: false,
    });
    assert.equal(result.stamp.action, "set");
    assert.deepEqual(getStampConfig(), {
      host: "ssh://git@stamp.example.com:22000",
      enforce: false,
    });
  });

  it("first init with stampHost + stampEnforce: true writes enforce on (AC #2)", async () => {
    const result = await init({
      stampHost: "ssh://git@stamp.example.com:22000",
      stampEnforce: true,
    });
    assert.equal(result.stamp.action, "set");
    assert.equal(getStampConfig()?.enforce, true);
  });

  it("re-init with empty stampHost keeps the existing host (AC #4 pre-fill)", async () => {
    await init({
      stampHost: "ssh://git@first.example.com:22000",
      stampEnforce: true,
    });
    // Empty string means "user pressed enter to keep current."
    const result = await init({ stampHost: "", stampEnforce: true });
    assert.equal(result.stamp.action, "unchanged");
    assert.equal(getStampConfig()?.host, "ssh://git@first.example.com:22000");
    assert.equal(getStampConfig()?.enforce, true);
  });

  it("re-init can flip enforce without touching host (AC #4)", async () => {
    await init({
      stampHost: "ssh://git@stamp.example.com:22000",
      stampEnforce: true,
    });
    const result = await init({ stampHost: "", stampEnforce: false });
    assert.equal(result.stamp.action, "set");
    assert.equal(getStampConfig()?.host, "ssh://git@stamp.example.com:22000");
    assert.equal(getStampConfig()?.enforce, false);
  });

  it("empty stampHost on first init leaves stamp config null (AC #1 leave-blank)", async () => {
    const result = await init({ stampHost: "" });
    assert.equal(result.stamp.action, "unchanged");
    assert.equal(getStampConfig(), null);
  });
});

describe("oteam init — default per-phase models (AGT-106)", () => {
  it("AC #1: fresh init seeds DEFAULT_MODELS into the config", async () => {
    const result = await runInit({ yes: true });
    assert.equal(result.models.action, "seeded");
    assert.deepEqual(result.models.models, DEFAULT_MODELS);
    assert.deepEqual(getModels(), DEFAULT_MODELS);
  });

  it("AC #2: existing models block is preserved on re-init", async () => {
    // First init seeds defaults; user then customises one phase.
    await runInit({ yes: true });
    setModel("spike", "claude-opus-4-6");
    const userPick = getModels();

    const result = await runInit({ yes: true });
    assert.equal(result.models.action, "preserved");
    assert.deepEqual(getModels(), userPick);
  });

  it("AC #2: a fully-customised block survives re-init verbatim", async () => {
    await runInit({ yes: true });
    setModel("product", "claude-haiku-4-5");
    setModel("spike", "claude-opus-4-6");
    setModel("implementation", "claude-haiku-4-5");
    setModel("qa", "claude-haiku-4-5");
    const customised = getModels();

    const result = await runInit({ yes: true });
    assert.equal(result.models.action, "preserved");
    assert.deepEqual(getModels(), customised);
  });

  it("AC #3: existing config without a models block gets defaults written, other fields untouched", async () => {
    // Pre-write a legacy-shaped config (vaults + stamp present, no models).
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        vaults: {},
        default: null,
        stamp: { host: "ssh://git@stamp.example.com:22000", enforce: true },
      }),
    );

    const result = await runInit({ yes: true });
    assert.equal(result.models.action, "seeded");
    assert.deepEqual(getModels(), DEFAULT_MODELS);
    // stamp must survive the write
    assert.deepEqual(getStampConfig(), {
      host: "ssh://git@stamp.example.com:22000",
      enforce: true,
    });
  });

  it("AC #6 idempotency: re-running on a freshly-seeded config does not rewrite", async () => {
    await runInit({ yes: true });
    const first = readFileSync(configPath(), "utf8");
    const result = await runInit({ yes: true });
    assert.equal(result.models.action, "preserved");
    const second = readFileSync(configPath(), "utf8");
    assert.equal(first, second);
  });
});
