import { describe, expect, it } from "vite-plus/test";
import { externalBridgeLaunchArgs } from "./externalBridgeLaunch.ts";

describe("externalBridgeLaunchArgs", () => {
  const entry = "/Ryco.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";

  it.each(["pair", "serve"])("dispatches an installed %s bridge without a GUI", (action) => {
    const args = [entry, "mcp", action, "--integration", "integration-a", "--state-dir", "/data"];
    expect(externalBridgeLaunchArgs(["/Ryco", ...args], entry)).toEqual(args);
  });

  it("does not dispatch normal app launches, links, arbitrary scripts, or server commands", () => {
    for (const args of [
      [],
      ["ryco://auth/callback"],
      ["/untrusted/script.mjs", "mcp", "serve"],
      [entry, "serve"],
      [entry, "mcp", "unknown"],
    ]) {
      expect(externalBridgeLaunchArgs(["/Ryco", ...args], entry)).toBeNull();
    }
  });
});
