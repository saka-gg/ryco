import { describe, expect, it } from "vite-plus/test";

import { resolveMobileRepoRoot, resolveMobileUpdates } from "./env";

describe("mobile environment root", () => {
  it("resolves the monorepo root from apps/mobile/config", () => {
    expect(resolveMobileRepoRoot("file:///workspace/apps/mobile/config/env.ts")).toBe("/workspace");
  });
});

describe("over-the-air updates", () => {
  it("stay off without an EAS project", () => {
    expect(resolveMobileUpdates(undefined)).toEqual({
      updates: { enabled: false },
      projectId: null,
    });
    expect(resolveMobileUpdates("  ")).toEqual({ updates: { enabled: false }, projectId: null });
  });

  it("follow the named EAS project", () => {
    expect(resolveMobileUpdates("0f8a2c9e-1234-4abc-9def-0123456789ab")).toEqual({
      updates: {
        enabled: true,
        url: "https://u.expo.dev/0f8a2c9e-1234-4abc-9def-0123456789ab",
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
      },
      projectId: "0f8a2c9e-1234-4abc-9def-0123456789ab",
    });
  });

  it("refuses anything that is not a project id", () => {
    expect(() => resolveMobileUpdates("https://u.expo.dev/x")).toThrow(/RYCO_EAS_PROJECT_ID/u);
  });
});
