import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId } from "@ryco/contracts";

import { createHomeModeState, reduceHomeModeState } from "./homeMode";

describe("Home mode state", () => {
  it("starts in Inbox with independent empty state for every mode", () => {
    expect(createHomeModeState()).toEqual({
      mode: "inbox",
      queryByMode: { inbox: "", projects: "" },
      nodeScopeByMode: { inbox: null, projects: null },
      scrollOffsetByMode: { inbox: 0, projects: 0 },
    });
  });

  it("preserves query, node scope, and scroll position when modes change", () => {
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
    state = reduceHomeModeState(state, {
      type: "set-scroll-offset",
      mode: "inbox",
      offset: 418,
    });
    state = reduceHomeModeState(state, { type: "select-mode", mode: "projects" });
    state = reduceHomeModeState(state, { type: "select-mode", mode: "inbox" });

    expect(state.mode).toBe("inbox");
    expect(state.queryByMode.inbox).toBe("auth");
    expect(state.nodeScopeByMode.inbox).toBe(environmentId);
    expect(state.scrollOffsetByMode.inbox).toBe(418);
    expect(state.queryByMode.projects).toBe("");
  });

  it("normalizes negative scroll offsets and reuses unchanged state", () => {
    const state = createHomeModeState();
    const unchanged = reduceHomeModeState(state, { type: "select-mode", mode: "inbox" });
    const normalized = reduceHomeModeState(state, {
      type: "set-scroll-offset",
      mode: "projects",
      offset: -20,
    });

    expect(unchanged).toBe(state);
    expect(normalized).toBe(state);
  });

  it("starts changed search results at the top without moving the other mode", () => {
    const state = {
      ...createHomeModeState(),
      scrollOffsetByMode: { inbox: 418, projects: 230 },
    };
    const searched = reduceHomeModeState(state, {
      type: "set-query",
      mode: "projects",
      query: "node",
    });
    expect(searched.scrollOffsetByMode).toEqual({ inbox: 418, projects: 0 });
    const scoped = reduceHomeModeState(state, {
      type: "set-node-scope",
      mode: "inbox",
      environmentId: "node-a" as EnvironmentId,
    });
    expect(scoped.scrollOffsetByMode).toEqual({ inbox: 0, projects: 230 });
  });
});
