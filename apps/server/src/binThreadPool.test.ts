// @effect-diagnostics nodeBuiltinImport:off - reads the entry points' sources.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("server libuv pool size", () => {
  const bin = source("./bin.ts");

  it("sizes the pool like the desktop backend's", () => {
    const server = /process\.env\.UV_THREADPOOL_SIZE = "(\d+)";/u.exec(bin)?.[1];
    const desktop = /DESKTOP_BACKEND_UV_THREADPOOL_SIZE = "(\d+)";/u.exec(
      source("../../desktop/src/backendLauncher.ts"),
    )?.[1];
    expect(server).toBeDefined();
    expect(server).toBe(desktop);
  });

  it("sets it before the entry runs anything", () => {
    // Everything above the compile cache call only declares; it is the first statement that runs.
    const assignment = bin.indexOf("process.env.UV_THREADPOOL_SIZE = ");
    expect(assignment).toBeGreaterThan(0);
    expect(assignment).toBeLessThan(bin.indexOf("\nenableCompileCacheBestEffort();"));
  });
});
