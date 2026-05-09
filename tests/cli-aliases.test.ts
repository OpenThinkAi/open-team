/**
 * Tests for AC #3 (config workspace/vault subcommand alias) and
 * AC #6 (--workspace / --vault flag alias reaching the same code path).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigCommand } from "../src/commands/config.ts";
import { runTicketNew } from "../src/commands/ticket.ts";

// ---- Helpers ----------------------------------------------------------------

let savedHome: string | undefined;
let fakeHome = "";

function withFakeHome(): void {
  savedHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "oteam-alias-")));
  process.env.HOME = fakeHome;
}

function restoreHome(): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
  fakeHome = "";
}

interface CapturedOutput {
  out: string;
  err: string;
  exitCode: number | null;
}

async function invokeCLI(...args: string[]): Promise<CapturedOutput> {
  let out = "";
  let err = "";
  let exitCode: number | null = null;

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  (process.stdout as NodeJS.WriteStream).write = (chunk: unknown) => {
    out += String(chunk);
    return true;
  };
  (process.stderr as NodeJS.WriteStream).write = (chunk: unknown) => {
    err += String(chunk);
    return true;
  };
  (process as NodeJS.Process).exit = ((code?: number | string | null) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`__process_exit__${exitCode}`);
  }) as typeof process.exit;

  try {
    const cmd = buildConfigCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "oteam", ...args]);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith("__process_exit__")) {
      // captured
    } else if (
      e instanceof Error &&
      (e as { code?: string }).code === "commander.unknownCommand"
    ) {
      err += e.message;
      exitCode = 1;
    } else if (e instanceof Error) {
      throw e;
    }
  } finally {
    (process.stdout as NodeJS.WriteStream).write = origOut;
    (process.stderr as NodeJS.WriteStream).write = origErr;
    (process as NodeJS.Process).exit = origExit;
  }

  return { out, err, exitCode };
}

function makeWorkspace(): { workspace: string; cleanup: () => void } {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "oteam-ws-")));
  mkdirSync(join(workspace, "tickets"), { recursive: true });
  return { workspace, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

// ---- AC #3: config workspace / config vault subcommand alias ----------------

describe("oteam config workspace (AC #3)", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("workspace add registers a workspace", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      const { out, exitCode } = await invokeCLI("workspace", "add", workspace);
      assert.equal(exitCode, null);
      assert.match(out, /Registered/);
    } finally {
      cleanup();
    }
  });

  it("workspace list shows registered workspaces", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      await invokeCLI("workspace", "add", workspace);
      const { out, exitCode } = await invokeCLI("workspace", "list");
      assert.equal(exitCode, null);
      assert.match(out, new RegExp(workspace.replace(/\//g, "\\/")));
    } finally {
      cleanup();
    }
  });

  it("workspace list shows empty message when none registered", async () => {
    const { out } = await invokeCLI("workspace", "list");
    assert.match(out, /no workspaces registered/);
  });

  it("workspace remove unregisters a workspace", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      await invokeCLI("workspace", "add", workspace, "--name", "myws");
      const { out, exitCode } = await invokeCLI("workspace", "remove", "myws");
      assert.equal(exitCode, null);
      assert.match(out, /Removed/i);
    } finally {
      cleanup();
    }
  });

  it("workspace default --set switches the default", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      await invokeCLI("workspace", "add", workspace, "--name", "primary");
      const { out, exitCode } = await invokeCLI("workspace", "default", "--set", "primary");
      assert.equal(exitCode, null);
      assert.match(out, /Default is now "primary"/);
    } finally {
      cleanup();
    }
  });
});

describe("oteam config vault alias (AC #3) — hidden back-compat", () => {
  beforeEach(withFakeHome);
  afterEach(restoreHome);

  it("vault add registers the same way as workspace add", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      const { out: wsOut } = await invokeCLI("workspace", "add", workspace, "--name", "via-workspace");
      assert.match(wsOut, /Registered/);
    } finally {
      cleanup();
    }

    // Fresh home — register the same path via 'vault'
    restoreHome();
    withFakeHome();
    const { workspace: ws2, cleanup: cleanup2 } = makeWorkspace();
    try {
      const { out: vaultOut, exitCode } = await invokeCLI("vault", "add", ws2, "--name", "via-vault");
      assert.equal(exitCode, null);
      assert.match(vaultOut, /Registered/);
    } finally {
      cleanup2();
    }
  });

  it("vault list and workspace list show the same entries", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      await invokeCLI("workspace", "add", workspace, "--name", "shared");
      const { out: wsOut } = await invokeCLI("workspace", "list");
      const { out: vaultOut } = await invokeCLI("vault", "list");
      // Both should show the same workspace path
      assert.match(wsOut, /shared/);
      assert.match(vaultOut, /shared/);
    } finally {
      cleanup();
    }
  });
});

// ---- AC #6: --workspace / --vault flag alias same code path -----------------

describe("--workspace / --vault flag alias (AC #6)", () => {
  it("runTicketNew with vault option files a ticket", () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      const result = runTicketNew({ title: "Test via vault flag", vault: workspace });
      assert.equal(result.ticketID, "AGT-001");
      assert.match(result.path, /tickets\/triage\/AGT-001-test-via-vault-flag\.md$/);
    } finally {
      cleanup();
    }
  });

  it("runTicketNew with workspace option files the same ticket path shape", () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      const result = runTicketNew({ title: "Test via workspace flag", workspace });
      assert.equal(result.ticketID, "AGT-001");
      assert.match(result.path, /tickets\/triage\/AGT-001-test-via-workspace-flag\.md$/);
    } finally {
      cleanup();
    }
  });

  it("workspace option takes precedence over vault when both provided", () => {
    const { workspace: ws1, cleanup: c1 } = makeWorkspace();
    const { workspace: ws2, cleanup: c2 } = makeWorkspace();
    try {
      const result = runTicketNew({
        title: "Precedence test",
        workspace: ws1,
        vault: ws2,
      });
      // Should land in ws1 (workspace takes precedence)
      assert.ok(result.path.startsWith(ws1), `Expected path under ws1 (${ws1}), got: ${result.path}`);
    } finally {
      c1();
      c2();
    }
  });
});
