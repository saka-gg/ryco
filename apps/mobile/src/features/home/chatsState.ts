import type { EnvironmentId } from "@ryco/contracts";

import type { ChatsFilter } from "./chatsListModel";

// What Chats is narrowed to: the status chip, one machine (the picker at the
// top left) and one project (the filter menu). Scroll positions are not part
// of it: they change every frame and live in `homeScrollMemory.ts`.

export interface ChatsState {
  readonly filter: ChatsFilter;
  readonly nodeScope: EnvironmentId | null;
  /** `scopedProjectKey` of the one project listed, or null for all. */
  readonly projectScope: string | null;
}

export type ChatsAction =
  | { readonly type: "select-filter"; readonly filter: ChatsFilter }
  | { readonly type: "set-node-scope"; readonly environmentId: EnvironmentId | null }
  | { readonly type: "set-project-scope"; readonly projectKey: string | null }
  | { readonly type: "clear-filters" };

export function createChatsState(): ChatsState {
  return { filter: "all", nodeScope: null, projectScope: null };
}

export function reduceChatsState(state: ChatsState, action: ChatsAction): ChatsState {
  switch (action.type) {
    case "select-filter":
      return action.filter === state.filter ? state : { ...state, filter: action.filter };
    case "set-node-scope":
      // A project lives on one machine: picking another machine drops the project.
      return action.environmentId === state.nodeScope
        ? state
        : { ...state, nodeScope: action.environmentId, projectScope: null };
    case "set-project-scope":
      return action.projectKey === state.projectScope
        ? state
        : { ...state, projectScope: action.projectKey };
    case "clear-filters":
      return state.nodeScope === null && state.projectScope === null && state.filter === "all"
        ? state
        : createChatsState();
  }
}

/** Whether anything narrows the list beyond the status chip. */
export function chatsHasScope(state: ChatsState): boolean {
  return state.nodeScope !== null || state.projectScope !== null;
}

/** The key a list remembers its scroll position under: it remounts when this changes. */
export function chatsListKey(state: ChatsState): string {
  return JSON.stringify([state.filter, state.nodeScope, state.projectScope]);
}
