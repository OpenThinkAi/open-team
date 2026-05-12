import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildKittySpawnTail } from "../src/role-pipeline/runner.ts";

describe("buildKittySpawnTail (AGT-049)", () => {
  it("captures $? into EC and writes it to the sentinel even without telemetry", () => {
    const tail = buildKittySpawnTail({
      sentinelPath: "/tmp/oteam-sentinel-agt-049.exit",
      telemetry: null,
    });
    assert.match(tail, /^; EC=\$\?; printf '%s\\n' "\$EC" > '\/tmp\/oteam-sentinel-agt-049\.exit' \|\| true; exit "\$EC"$/);
  });

  it("folds telemetry record between sentinel write and final exit when present", () => {
    const tail = buildKittySpawnTail({
      sentinelPath: "/tmp/oteam-sentinel-agt-049.exit",
      telemetry: {
        oteamPath: "/usr/local/bin/oteam",
        ticketId: "AGT-049",
        phase: "implementation",
        model: "claude-sonnet-4-6",
        sessionId: "11111111-2222-3333-4444-555555555555",
        startedAt: "2026-05-11T18:00:00.000Z",
      },
    });
    // Sentinel write comes before telemetry; both come before `exit "$EC"`.
    const sentinelIdx = tail.indexOf("oteam-sentinel-agt-049.exit");
    const telemetryIdx = tail.indexOf("telemetry record");
    const exitIdx = tail.lastIndexOf('exit "$EC"');
    assert.ok(sentinelIdx > 0 && telemetryIdx > sentinelIdx && exitIdx > telemetryIdx,
      `expected sentinel < telemetry < exit, got idx ${sentinelIdx}/${telemetryIdx}/${exitIdx} in:\n${tail}`);
    // Telemetry-record call still preserves the AGT-108 best-effort guard.
    assert.match(tail, />\/dev\/null 2>&1 \|\| true/);
    // EC is captured exactly once so claude's status survives both writes.
    assert.equal((tail.match(/EC=\$\?/g) ?? []).length, 1);
  });

  it("sentinel write is guarded with || true so a redirect failure doesn't mask $EC", () => {
    const tail = buildKittySpawnTail({
      sentinelPath: "/tmp/oteam-sentinel-agt-049.exit",
      telemetry: null,
    });
    // The sentinel `printf … > path || true` runs before `exit "$EC"`, so a
    // read-only /tmp can't blow up the wrapper shell and lose claude's code.
    assert.match(tail, /printf '%s\\n' "\$EC" > '\S+' \|\| true; exit "\$EC"/);
  });

  it("shell-escapes single quotes inside the sentinel path", () => {
    const tail = buildKittySpawnTail({
      sentinelPath: "/tmp/weird'quote.exit",
      telemetry: null,
    });
    // shellEscape replaces ' with '\'' so a quote in the path can't break out
    // of the surrounding single quotes.
    assert.ok(tail.includes(`'/tmp/weird'\\''quote.exit'`),
      `expected escaped path, got:\n${tail}`);
  });
});
