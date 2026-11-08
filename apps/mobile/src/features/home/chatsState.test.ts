import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chatsHasScope, chatsListKey, createChatsState, reduceChatsState } from "./chatsState";

const MAC = "mac" as EnvironmentId;

describe("Chats state", () => {
  it("starts on All with no scope", () => {
    const state = createChatsState();
    expect(state).toEqual({ filter: "all", nodeScope: null, projectScope: null });
    expect(chatsHasScope(state)).toBe(false);
  });

  it("keeps the same object for a no-op", () => {
    const state = createChatsState();
    expect(reduceChatsState(state, { type: "select-filter", filter: "all" })).toBe(state);
    expect(reduceChatsState(state, { type: "clear-filters" })).toBe(state);
  });

  it("drops the project when another machine is picked", () => {
    let state = reduceChatsState(createChatsState(), {
      type: "set-project-scope",
      projectKey: "mac:web",
    });
    state = reduceChatsState(state, { type: "set-node-scope", environmentId: MAC });
    expect(state).toMatchObject({ nodeScope: MAC, projectScope: null });
    expect(chatsHasScope(state)).toBe(true);
  });

  it("clears every filter at once, and keys the list by all three", () => {
    let state = reduceChatsState(createChatsState(), { type: "select-filter", filter: "done" });
    state = reduceChatsState(state, { type: "set-node-scope", environmentId: MAC });
    expect(chatsListKey(state)).toBe(JSON.stringify(["done", "mac", null]));
    expect(reduceChatsState(state, { type: "clear-filters" })).toEqual(createChatsState());
  });
});
