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
import * as cfg from "../src/lib/config.ts";
import { DEFAULT_MODELS } from "../src/lib/models.ts";

let savedHome: string | undefined;
let fakeHome = "";

beforeEach(() => {
  savedHome = process.env.HOME;
  // realpathSync collapses /var → /private/var on macOS so paths persisted
  // by the code (which call resolve()) match the values we compare against.
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "oteam-home-")));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("config: addVault", () => {
  it("registers a vault, derives name from basename, sets default on first add", async () => {
    const vaultDir = join(fakeHome, "Documents", "product-vault");
    mkdirSync(vaultDir, { recursive: true });

    const result = cfg.addVault(vaultDir);
    assert.equal(result.name, "product-vault");
    assert.equal(result.path, vaultDir);
    assert.equal(result.promotedToDefault, true);

    const persisted = JSON.parse(readFileSync(cfg.configPath(), "utf8"));
    assert.deepEqual(persisted.vaults, { "product-vault": vaultDir });
    assert.equal(persisted.default, "product-vault");
  });

  it("collides on a taken name → suggests --name <other>", async () => {
    const a = join(fakeHome, "a");
    const b = join(fakeHome, "b");
    mkdirSync(a);
    mkdirSync(b);
    cfg.addVault(a, { name: "personal" });
    assert.throws(
      () => cfg.addVault(b, { name: "personal" }),
      /already maps to/,
    );
  });

  it("re-adding a path is idempotent and does not change default", async () => {
    const a = join(fakeHome, "a");
    const b = join(fakeHome, "b");
    mkdirSync(a);
    mkdirSync(b);
    cfg.addVault(a, { name: "personal" });
    cfg.addVault(b, { name: "work" });
    const r = cfg.addVault(a);
    assert.equal(r.name, "personal");
    assert.equal(r.promotedToDefault, false);
    assert.equal(cfg.listVaults().default, "personal");
  });

  it("auto-numbers a colliding basename when --name not passed", async () => {
    const a = join(fakeHome, "x", "vault");
    const b = join(fakeHome, "y", "vault");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const r1 = cfg.addVault(a);
    const r2 = cfg.addVault(b);
    assert.equal(r1.name, "vault");
    assert.equal(r2.name, "vault-2");
  });

  it("resolves relative paths to absolute at add time", async () => {
    const vaultDir = join(fakeHome, "rel-target");
    mkdirSync(vaultDir);
    const cwd = process.cwd();
    process.chdir(fakeHome);
    try {
      const r = cfg.addVault("./rel-target");
      assert.equal(r.path, vaultDir);
    } finally {
      process.chdir(cwd);
    }
  });

  it("expands ~/ to the home dir", async () => {
    const vaultDir = join(fakeHome, "tilde-target");
    mkdirSync(vaultDir);
    const r = cfg.addVault("~/tilde-target");
    assert.equal(r.path, vaultDir);
  });
});

describe("config: removeVault", () => {
  it("clears default when removing the default vault", async () => {
    const a = join(fakeHome, "a");
    const b = join(fakeHome, "b");
    mkdirSync(a);
    mkdirSync(b);
    cfg.addVault(a, { name: "personal" });
    cfg.addVault(b, { name: "work" });
    assert.equal(cfg.listVaults().default, "personal");

    const r = cfg.removeVault("personal");
    assert.equal(r.clearedDefault, true);
    assert.equal(cfg.listVaults().default, null);
  });

  it("does not clear default when removing a non-default", async () => {
    const a = join(fakeHome, "a");
    const b = join(fakeHome, "b");
    mkdirSync(a);
    mkdirSync(b);
    cfg.addVault(a, { name: "personal" });
    cfg.addVault(b, { name: "work" });

    const r = cfg.removeVault("work");
    assert.equal(r.clearedDefault, false);
    assert.equal(cfg.listVaults().default, "personal");
  });

  it("can remove by absolute path", async () => {
    const a = join(fakeHome, "a");
    mkdirSync(a);
    cfg.addVault(a, { name: "personal" });
    const r = cfg.removeVault(a);
    assert.equal(r.name, "personal");
  });

  it("throws on unknown name", async () => {
    assert.throws(() => cfg.removeVault("nope"), /no vault registered/);
  });
});

describe("config: setDefault", () => {
  it("updates the default", async () => {
    const a = join(fakeHome, "a");
    const b = join(fakeHome, "b");
    mkdirSync(a);
    mkdirSync(b);
    cfg.addVault(a, { name: "personal" });
    cfg.addVault(b, { name: "work" });
    cfg.setDefault("work");
    assert.equal(cfg.listVaults().default, "work");
  });

  it("throws on unknown name", async () => {
    assert.throws(() => cfg.setDefault("nope"), /no vault registered/);
  });
});

describe("config: resolveByNameOrPath", () => {
  it("resolves a registered name", async () => {
    const a = join(fakeHome, "a");
    mkdirSync(a);
    cfg.addVault(a, { name: "personal" });
    const r = cfg.resolveByNameOrPath("personal");
    assert.deepEqual(r, { name: "personal", path: a });
  });

  it("resolves an unregistered absolute path", async () => {
    const r = cfg.resolveByNameOrPath("/some/absolute/path");
    assert.equal(r?.path, "/some/absolute/path");
  });

  it("returns null for an unknown bare name (no slash)", async () => {
    const r = cfg.resolveByNameOrPath("nope");
    assert.equal(r, null);
  });
});

describe("config: findVaultRootForPath", () => {
  it("returns the registered vault when the path lives inside it", async () => {
    const root = join(fakeHome, "vault-root");
    mkdirSync(join(root, "tickets", "triage"), { recursive: true });
    cfg.addVault(root, { name: "personal" });
    const ticket = join(root, "tickets", "triage", "AGT-001-x.md");
    writeFileSync(ticket, "x");
    const r = cfg.findVaultRootForPath(ticket);
    assert.deepEqual(r, { name: "personal", path: root });
  });

  it("returns null when the path is outside any registered vault", async () => {
    const root = join(fakeHome, "vault-root");
    mkdirSync(root);
    cfg.addVault(root, { name: "personal" });
    const r = cfg.findVaultRootForPath(join(fakeHome, "other", "x.md"));
    assert.equal(r, null);
  });

  it("does not match a sibling whose name is a prefix", async () => {
    const a = join(fakeHome, "vault");
    const b = join(fakeHome, "vault-extra");
    mkdirSync(a);
    mkdirSync(b);
    cfg.addVault(a, { name: "a" });
    const r = cfg.findVaultRootForPath(join(b, "x.md"));
    assert.equal(r, null);
  });
});

describe("config: malformed config file", () => {
  it("throws a useful error on invalid JSON", async () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(cfg.configPath(), "not valid json");
    assert.throws(() => cfg.readConfig(), /not valid JSON/);
  });

  it("ignores a default that points at an unregistered name", async () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({ vaults: {}, default: "ghost" }),
    );
    assert.equal(cfg.readConfig().default, null);
  });
});

describe("config: empty state", () => {
  it("readConfig returns empty when the file does not exist", async () => {
    const r = cfg.readConfig();
    assert.deepEqual(r, {
      vaults: {},
      default: null,
      stamp: null,
      models: {},
      telemetry: { enabled: true },
    });
    assert.ok(!existsSync(cfg.configPath()));
  });
});

describe("config: stamp normalise tolerance (AC #3)", () => {
  it("absent stamp key → stamp: null", async () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(cfg.configPath(), JSON.stringify({ vaults: {}, default: null }));
    assert.equal(cfg.readConfig().stamp, null);
  });

  it("explicit stamp: null → stamp: null", async () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({ vaults: {}, default: null, stamp: null }),
    );
    assert.equal(cfg.readConfig().stamp, null);
  });

  it("present block round-trips host + enforce", async () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({
        vaults: {},
        default: null,
        stamp: { host: "ssh://git@stamp.example.com:22000", enforce: true },
      }),
    );
    assert.deepEqual(cfg.readConfig().stamp, {
      host: "ssh://git@stamp.example.com:22000",
      enforce: true,
    });
  });

  it("strips trailing slash from stamp.host on read", async () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({
        vaults: {},
        default: null,
        stamp: { host: "ssh://git@stamp.example.com:22000/", enforce: false },
      }),
    );
    assert.equal(cfg.readConfig().stamp?.host, "ssh://git@stamp.example.com:22000");
  });

  it("treats stamp with empty host as null (half-cleared block)", async () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({
        vaults: {},
        default: null,
        stamp: { host: "", enforce: true },
      }),
    );
    assert.equal(cfg.readConfig().stamp, null);
  });
});

describe("config: stamp helpers (AC #5)", () => {
  it("setStampHost writes a fresh stamp block (enforce defaults to false)", async () => {
    const next = cfg.setStampHost("ssh://git@stamp.example.com:22000");
    assert.deepEqual(next, {
      host: "ssh://git@stamp.example.com:22000",
      enforce: false,
    });
    assert.deepEqual(cfg.readConfig().stamp, next);
  });

  it("setStampHost preserves existing enforce on update", async () => {
    cfg.setStampHost("ssh://git@a:1");
    cfg.setStampEnforce(true);
    const next = cfg.setStampHost("ssh://git@b:2");
    assert.equal(next.enforce, true);
  });

  it("setStampHost rejects empty value", async () => {
    assert.throws(() => cfg.setStampHost("   "), /cannot be empty/);
  });

  it("setStampEnforce(true) rejects when no host is set (G3)", async () => {
    assert.throws(() => cfg.setStampEnforce(true), /stamp\.enforce on with no stamp\.host/);
  });

  it("setStampEnforce(false) is allowed even with no host", async () => {
    const next = cfg.setStampEnforce(false);
    assert.equal(next.enforce, false);
  });

  it("clearStamp removes the stamp block", async () => {
    cfg.setStampHost("ssh://git@a:1");
    cfg.clearStamp();
    assert.equal(cfg.readConfig().stamp, null);
  });

  it("getStampConfig returns the same object as readConfig().stamp", async () => {
    cfg.setStampHost("ssh://git@a:1");
    assert.deepEqual(cfg.getStampConfig(), cfg.readConfig().stamp);
  });

  it("setStampHost preserves vaults + default (config round-trip)", async () => {
    const vaultDir = join(fakeHome, "v");
    mkdirSync(vaultDir);
    cfg.addVault(vaultDir, { name: "personal" });
    cfg.setStampHost("ssh://git@x:1");
    const persisted = JSON.parse(readFileSync(cfg.configPath(), "utf8"));
    assert.equal(persisted.vaults.personal, vaultDir);
    assert.equal(persisted.default, "personal");
    assert.equal(persisted.stamp.host, "ssh://git@x:1");
  });
});

describe("config: per-phase models (AGT-105)", () => {
  it("setModel persists a single phase override and getModels reads it back", () => {
    cfg.setModel("product", "claude-haiku-4-5");
    assert.deepEqual(cfg.getModels(), { product: "claude-haiku-4-5" });
  });

  it("each phase resolves independently — pinning one does not affect others", () => {
    cfg.setModel("spike", "claude-opus-4-7");
    cfg.setModel("qa", "claude-sonnet-4-6");
    assert.deepEqual(cfg.getModels(), {
      spike: "claude-opus-4-7",
      qa: "claude-sonnet-4-6",
    });
  });

  it("setModel rejects empty / whitespace-only model ids (AC #3)", () => {
    assert.throws(() => cfg.setModel("product", ""), /cannot be empty/);
    assert.throws(() => cfg.setModel("product", "   "), /cannot be empty/);
  });

  it("setModel trims surrounding whitespace from the model id", () => {
    cfg.setModel("product", "  claude-haiku-4-5  ");
    assert.deepEqual(cfg.getModels(), { product: "claude-haiku-4-5" });
  });

  it("clearModel removes one phase but leaves the others intact", () => {
    cfg.setModel("spike", "claude-opus-4-7");
    cfg.setModel("qa", "claude-sonnet-4-6");
    const after = cfg.clearModel("spike");
    assert.deepEqual(after, { qa: "claude-sonnet-4-6" });
    assert.deepEqual(cfg.getModels(), { qa: "claude-sonnet-4-6" });
  });

  it("clearModel on an unset phase is a no-op", () => {
    cfg.setModel("qa", "claude-sonnet-4-6");
    const after = cfg.clearModel("product");
    assert.deepEqual(after, { qa: "claude-sonnet-4-6" });
  });

  it("setModel rewrites in place when the same phase is set twice", () => {
    cfg.setModel("product", "claude-haiku-4-5");
    cfg.setModel("product", "claude-sonnet-4-6");
    assert.deepEqual(cfg.getModels(), { product: "claude-sonnet-4-6" });
  });

  it("empty models block is omitted from the on-disk JSON (clean default)", () => {
    cfg.setStampHost("ssh://git@x:1");
    cfg.setModel("product", "claude-haiku-4-5");
    cfg.clearModel("product");
    const persisted = JSON.parse(readFileSync(cfg.configPath(), "utf8"));
    assert.equal(persisted.models, undefined);
  });

  it("on-disk JSON contains only the set phases (AC #1 shape)", () => {
    cfg.setModel("product", "claude-haiku-4-5");
    cfg.setModel("spike", "claude-opus-4-7");
    const persisted = JSON.parse(readFileSync(cfg.configPath(), "utf8"));
    assert.deepEqual(persisted.models, {
      product: "claude-haiku-4-5",
      spike: "claude-opus-4-7",
    });
  });

  it("normalise drops unknown phase keys and non-string values", () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({
        vaults: {},
        default: null,
        models: {
          product: "claude-haiku-4-5",
          bogus: "ignored",
          spike: 42,
          qa: "",
          implementation: "claude-sonnet-4-6",
        },
      }),
    );
    assert.deepEqual(cfg.readConfig().models, {
      product: "claude-haiku-4-5",
      implementation: "claude-sonnet-4-6",
    });
  });

  it("missing models key normalises to {} (legacy config compat)", () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({ vaults: {}, default: null }),
    );
    assert.deepEqual(cfg.readConfig().models, {});
  });

  it("setModel preserves vaults + default + stamp (config round-trip)", () => {
    const vaultDir = join(fakeHome, "v");
    mkdirSync(vaultDir);
    cfg.addVault(vaultDir, { name: "personal" });
    cfg.setStampHost("ssh://git@x:1");
    cfg.setModel("spike", "claude-opus-4-7");
    const persisted = JSON.parse(readFileSync(cfg.configPath(), "utf8"));
    assert.equal(persisted.vaults.personal, vaultDir);
    assert.equal(persisted.default, "personal");
    assert.equal(persisted.stamp.host, "ssh://git@x:1");
    assert.equal(persisted.models.spike, "claude-opus-4-7");
  });
});

describe("config: seedDefaultModelsIfEmpty (AGT-106)", () => {
  it("writes DEFAULT_MODELS into a fresh config (AC #1/#3)", () => {
    const result = cfg.seedDefaultModelsIfEmpty();
    assert.equal(result.action, "seeded");
    assert.deepEqual(result.models, DEFAULT_MODELS);
    assert.deepEqual(cfg.getModels(), DEFAULT_MODELS);
  });

  it("preserves a non-empty single-phase models block (AC #2)", () => {
    cfg.setModel("spike", "claude-opus-4-7");
    const result = cfg.seedDefaultModelsIfEmpty();
    assert.equal(result.action, "preserved");
    assert.deepEqual(result.models, { spike: "claude-opus-4-7" });
    assert.deepEqual(cfg.getModels(), { spike: "claude-opus-4-7" });
  });

  it("preserves a non-empty fully-customised models block (AC #2)", () => {
    cfg.setModel("product", "claude-haiku-4-5");
    cfg.setModel("spike", "claude-opus-4-6");
    cfg.setModel("implementation", "claude-haiku-4-5");
    cfg.setModel("qa", "claude-haiku-4-5");
    const before = cfg.getModels();
    const result = cfg.seedDefaultModelsIfEmpty();
    assert.equal(result.action, "preserved");
    assert.deepEqual(cfg.getModels(), before);
  });

  it("seeds when an existing config has no models key at all (AC #3)", () => {
    // Simulate a legacy config: vaults + stamp, no models field.
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({ vaults: {}, default: null, stamp: null }),
    );
    const result = cfg.seedDefaultModelsIfEmpty();
    assert.equal(result.action, "seeded");
    assert.deepEqual(cfg.getModels(), DEFAULT_MODELS);
  });

  it("seeds when an existing config has an explicit empty models block", () => {
    mkdirSync(cfg.configDir(), { recursive: true });
    writeFileSync(
      cfg.configPath(),
      JSON.stringify({ vaults: {}, default: null, stamp: null, models: {} }),
    );
    const result = cfg.seedDefaultModelsIfEmpty();
    assert.equal(result.action, "seeded");
    assert.deepEqual(cfg.getModels(), DEFAULT_MODELS);
  });

  it("idempotency: a second call after seeding preserves the seed", () => {
    cfg.seedDefaultModelsIfEmpty();
    const second = cfg.seedDefaultModelsIfEmpty();
    assert.equal(second.action, "preserved");
    assert.deepEqual(cfg.getModels(), DEFAULT_MODELS);
  });

  it("preserves vaults + default + stamp when seeding", () => {
    const vaultDir = join(fakeHome, "v");
    mkdirSync(vaultDir);
    cfg.addVault(vaultDir, { name: "personal" });
    cfg.setStampHost("ssh://git@x:1");
    cfg.seedDefaultModelsIfEmpty();
    const persisted = JSON.parse(readFileSync(cfg.configPath(), "utf8"));
    assert.equal(persisted.vaults.personal, vaultDir);
    assert.equal(persisted.default, "personal");
    assert.equal(persisted.stamp.host, "ssh://git@x:1");
    assert.equal(persisted.models.spike, "claude-opus-4-7");
  });
});
