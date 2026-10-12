import type { EnvironmentId } from "@ryco/contracts";

// A node is an attribute of a row, not a mode the user is in — so Home has two
// modes and node management lives on the Connections route. `nodeScopeByMode`
// stays: scoping a list to one node is still a per-mode filter.
export type HomeMode = "inbox" | "projects";

export interface HomeModeState {
  readonly mode: HomeMode;
  readonly queryByMode: Readonly<Record<HomeMode, string>>;
  readonly nodeScopeByMode: Readonly<Record<HomeMode, EnvironmentId | null>>;
}

export type HomeModeAction =
  | { readonly type: "select-mode"; readonly mode: HomeMode }
  | { readonly type: "set-query"; readonly mode: HomeMode; readonly query: string }
  | {
      readonly type: "set-node-scope";
      readonly mode: HomeMode;
      readonly environmentId: EnvironmentId | null;
    };

// Scroll positions are not part of this state: they change on every scroll
// frame and are kept outside React in `homeScrollMemory.ts`.

export function createHomeModeState(initialMode: HomeMode = "inbox"): HomeModeState {
  return {
    mode: initialMode,
    queryByMode: { inbox: "", projects: "" },
    nodeScopeByMode: { inbox: null, projects: null },
  };
}

export function reduceHomeModeState(state: HomeModeState, action: HomeModeAction): HomeModeState {
  switch (action.type) {
    case "select-mode":
      return action.mode === state.mode ? state : { ...state, mode: action.mode };
    case "set-query": {
      const query = action.query;
      if (state.queryByMode[action.mode] === query) return state;
      return { ...state, queryByMode: { ...state.queryByMode, [action.mode]: query } };
    }
    case "set-node-scope": {
      if (state.nodeScopeByMode[action.mode] === action.environmentId) return state;
      return {
        ...state,
        nodeScopeByMode: {
          ...state.nodeScopeByMode,
          [action.mode]: action.environmentId,
        },
      };
    }
  }
}
