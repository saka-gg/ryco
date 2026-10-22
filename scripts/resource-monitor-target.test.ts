import { describe, expect, it } from "vite-plus/test";

import { resourceMonitorBuildTarget } from "./resource-monitor-target.ts";

describe("resource monitor packaging targets", () => {
  it("resolves one explicit target per platform and architecture", () => {
    expect(resourceMonitorBuildTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    // The npm CLI still ships an Intel Mac monitor even though the desktop app does not.
    expect(resourceMonitorBuildTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(resourceMonitorBuildTarget("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
    expect(resourceMonitorBuildTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
  });

  it("rejects unsupported and inherited object keys before running builds", () => {
    for (const [platform, architecture] of [
      ["darwin", "universal"],
      ["linux", "universal"],
      ["darwin", "ia32"],
      ["toString", "x64"],
      ["darwin", "constructor"],
    ]) {
      expect(() => resourceMonitorBuildTarget(platform!, architecture!)).toThrow(
        "Unsupported resource monitor target",
      );
    }
  });
});
