import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId } from "@ryco/contracts";

import { createHomeModeState, reduceHomeModeState } from "./homeMode";

describe("Home mode state", () => {
  it("starts in Inbox with independent empty state for every mode", () => {
    expect(createHomeModeState()).toEqual({
      mode: "inbox",
      queryByMode: { inbox: "", projects: "" },
      nodeScopeByMode: { inbox: null, projects: null },
    });
  });

  it("preserves query and node scope when modes change", () => {
    const environmentId = "node-a" as EnvironmentId;
    let state = createHomeModeState();

    state = reduceHomeModeState(state, {
      type: "set-query",
      mode: "inbox",
      query: "auth",
    });
    state = reduceHomeModeState(state, {
      type: "set-node-scope",
      mode: "inbox",
      environmentId,
    });
    state = reduceHomeModeState(state, { type: "select-mode", mode: "projects" });
    state = reduceHomeModeState(state, { type: "select-mode", mode: "inbox" });

    expect(state.mode).toBe("inbox");
    expect(state.queryByMode.inbox).toBe("auth");
    expect(state.nodeScopeByMode.inbox).toBe(environmentId);
    expect(state.queryByMode.projects).toBe("");
  });

  it("reuses unchanged state", () => {
    const state = createHomeModeState();
    expect(reduceHomeModeState(state, { type: "select-mode", mode: "inbox" })).toBe(state);
    expect(reduceHomeModeState(state, { type: "set-query", mode: "inbox", query: "" })).toBe(state);
    expect(
      reduceHomeModeState(state, { type: "set-node-scope", mode: "projects", environmentId: null }),
    ).toBe(state);
  });
});
