import { describe, expect, it } from "vitest";

import { nodeBrowserBaseCapability, nodeBrowserSandboxDisabled } from "./NodeBrowser.ts";

const base = (env: Record<string, string>, isRoot: boolean) =>
  nodeBrowserBaseCapability({ env, isRoot, platform: "linux", arch: "x64" });

describe("node browser sandbox", () => {
  it("keeps Chrome's sandbox on unless node tabs opt out on their own", () => {
    expect(base({}, false)).toEqual({ available: true });
    // The HTML preview's switch never reaches node tabs, which open any site.
    expect(nodeBrowserSandboxDisabled({ RYCO_HTML_PREVIEW_NO_SANDBOX: "1" })).toBe(false);
    expect(base({ RYCO_HTML_PREVIEW_NO_SANDBOX: "1" }, false)).toEqual({ available: true });
    expect(base({ RYCO_HTML_PREVIEW_NO_SANDBOX: "1" }, true)).toEqual({
      available: false,
      reason: "root-without-sandbox",
    });
  });

  it("reports tabs without the sandbox so clients can warn", () => {
    expect(nodeBrowserSandboxDisabled({ RYCO_NODE_BROWSER_NO_SANDBOX: "true" })).toBe(true);
    expect(base({ RYCO_NODE_BROWSER_NO_SANDBOX: "1" }, false)).toEqual({
      available: true,
      sandbox: false,
    });
    expect(base({ RYCO_NODE_BROWSER_NO_SANDBOX: "1" }, true)).toEqual({
      available: true,
      sandbox: false,
    });
  });
});
