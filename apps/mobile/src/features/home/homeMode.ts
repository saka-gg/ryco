import type { EnvironmentId } from "@ryco/contracts";

// A node is an attribute of a row, not a mode the user is in — so Home has two
// modes and node management lives on the Connections route. `nodeScopeByMode`
// stays: scoping a list to one node is still a per-mode filter.
export type HomeMode = "inbox" | "projects";

export interface HomeModeState {
  readonly mode: HomeMode;
  readonly queryByMode: Readonly<Record<HomeMode, string>>;
  readonly nodeScopeByMode: Readonly<Record<HomeMode, EnvironmentId | null>>;
  readonly scrollOffsetByMode: Readonly<Record<HomeMode, number>>;
}

export type HomeModeAction =
  | { readonly type: "select-mode"; readonly mode: HomeMode }
  | { readonly type: "set-query"; readonly mode: HomeMode; readonly query: string }
  | {
      readonly type: "set-node-scope";
      readonly mode: HomeMode;
      readonly environmentId: EnvironmentId | null;
    }
  | { readonly type: "set-scroll-offset"; readonly mode: HomeMode; readonly offset: number };

export function createHomeModeState(initialMode: HomeMode = "inbox"): HomeModeState {
  return {
    mode: initialMode,
    queryByMode: { inbox: "", projects: "" },
    nodeScopeByMode: { inbox: null, projects: null },
    scrollOffsetByMode: { inbox: 0, projects: 0 },
  };
}

export function reduceHomeModeState(state: HomeModeState, action: HomeModeAction): HomeModeState {
  switch (action.type) {
    case "select-mode":
      return action.mode === state.mode ? state : { ...state, mode: action.mode };
    case "set-query": {
      const query = action.query;
      if (state.queryByMode[action.mode] === query) return state;
      return {
        ...state,
        queryByMode: { ...state.queryByMode, [action.mode]: query },
        scrollOffsetByMode: { ...state.scrollOffsetByMode, [action.mode]: 0 },
      };
    }
    case "set-node-scope": {
      if (state.nodeScopeByMode[action.mode] === action.environmentId) return state;
      return {
        ...state,
        nodeScopeByMode: {
          ...state.nodeScopeByMode,
          [action.mode]: action.environmentId,
        },
        scrollOffsetByMode: { ...state.scrollOffsetByMode, [action.mode]: 0 },
      };
    }
    case "set-scroll-offset": {
      const offset = Math.max(0, action.offset);
      if (state.scrollOffsetByMode[action.mode] === offset) return state;
      return {
        ...state,
        scrollOffsetByMode: { ...state.scrollOffsetByMode, [action.mode]: offset },
      };
    }
  }
}
