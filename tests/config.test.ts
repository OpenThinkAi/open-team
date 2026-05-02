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
    assert.deepEqual(r, { vaults: {}, default: null });
    assert.ok(!existsSync(cfg.configPath()));
  });
});
