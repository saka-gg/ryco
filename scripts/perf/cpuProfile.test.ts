import { assert, describe, it } from "@effect/vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDistSourceResolver, summarizeCpuProfile, type CdpCpuProfile } from "./cpuProfile.ts";

const frame = (functionName: string, url = "", lineNumber = 0, columnNumber = 0) => ({
  functionName,
  url,
  lineNumber,
  columnNumber,
});

// Samples every 100 µs: idle, idle, boot chunk ×3, GC, app chunk ×2 (last runs to endTime).
const PROFILE: CdpCpuProfile = {
  nodes: [
    { id: 1, callFrame: frame("(root)") },
    { id: 2, callFrame: frame("(idle)") },
    { id: 3, callFrame: frame("decode", "http://127.0.0.1:4000/assets/boot-AbCdEf12.js", 0, 5) },
    { id: 4, callFrame: frame("(garbage collector)") },
    { id: 5, callFrame: frame("render", "http://127.0.0.1:4000/assets/app-AbCdEf12.js?v=1", 0, 0) },
  ],
  startTime: 1_000,
  endTime: 1_900,
  samples: [2, 2, 3, 3, 3, 4, 5, 5],
  timeDeltas: [0, 100, 100, 100, 100, 100, 100, 100],
};

describe("summarizeCpuProfile", () => {
  it("attributes each sample interval to its frame and separates idle time", () => {
    const summary = summarizeCpuProfile(PROFILE);

    assert.equal(summary.durationMs, 0.9);
    assert.closeTo(summary.idleMs, 0.2, 1e-9);
    assert.closeTo(summary.busyMs, 0.7, 1e-9);
    assert.deepStrictEqual(
      summary.topSelfTime.map((entry) => [entry.source, Math.round(entry.selfMs * 1000)]),
      [
        ["boot-AbCdEf12.js", 300],
        ["app-AbCdEf12.js", 300],
        ["(garbage collector)", 100],
      ],
    );
  });

  it("names source files through the dist's hidden source maps", () => {
    const assetsDir = mkdtempSync(path.join(os.tmpdir(), "ryco-cpu-profile-"));
    try {
      // Line 0: column 0 → source 0, column 4 → source 1.
      writeFileSync(
        path.join(assetsDir, "boot-AbCdEf12.js.map"),
        JSON.stringify({
          version: 3,
          sources: [
            "../../src/environments/runtime/service.ts",
            "../../../../node_modules/.bun/effect@4.0.2/node_modules/effect/dist/Schema.js",
          ],
          mappings: "AAAA,ICAA",
        }),
      );
      const summary = summarizeCpuProfile(PROFILE, {
        resolveSource: createDistSourceResolver(assetsDir),
      });

      assert.deepStrictEqual(
        summary.topSelfTime.map((entry) => entry.source),
        ["node_modules/effect/dist/Schema.js", "app-AbCdEf12.js", "(garbage collector)"],
      );
    } finally {
      rmSync(assetsDir, { recursive: true, force: true });
    }
  });
});
