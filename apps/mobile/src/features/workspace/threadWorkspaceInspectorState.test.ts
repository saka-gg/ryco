import { describe, expect, it } from "vite-plus/test";

import { releaseOwnedThreadWorkspaceInspector } from "./threadWorkspaceInspectorState";

describe("thread workspace inspector ownership", () => {
  it("does not let stale native-route cleanup clear the current focused inspector", () => {
    const staleOwner = Symbol("stale");
    const currentOwner = Symbol("current");
    const current = { owner: currentOwner, kind: "files" as const, value: "current" };

    expect(releaseOwnedThreadWorkspaceInspector(current, staleOwner)).toBe(current);
    expect(releaseOwnedThreadWorkspaceInspector(current, currentOwner)).toBeNull();
  });

  it("leaves an already empty column empty", () => {
    expect(releaseOwnedThreadWorkspaceInspector(null, Symbol("any"))).toBeNull();
  });
});
