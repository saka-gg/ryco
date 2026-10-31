export type AdaptiveNavigationAction = "push" | "replace" | "set-params";

const BASE_THREAD_ROUTE_PATTERN = /^\/threads\/[^/]+\/[^/]+\/?$/;

export function isBaseThreadRoute(pathname: string): boolean {
  return BASE_THREAD_ROUTE_PATTERN.test(pathname);
}

/**
 * A persistent sidebar selects a peer destination in place. A compact list
 * drills into a new destination so the native back stack remains available.
 * From Home the selection pushes (never replaces) so Home stays beneath the
 * thread — collapsing back to a compact width keeps a sane back stack.
 */
export function resolveThreadSelectionNavigationAction(input: {
  readonly usesSplitView: boolean;
  readonly pathname: string;
}): AdaptiveNavigationAction {
  if (!input.usesSplitView || input.pathname === "/") {
    return "push";
  }

  return isBaseThreadRoute(input.pathname) ? "set-params" : "replace";
}

/**
 * On regular-width layouts, the file browser and preview occupy one workspace
 * destination. Replacing the browser route keeps a single back step to chat.
 * Compact layouts retain the browser as the previous stack screen.
 */
export function resolveFileSelectionNavigationAction(input: {
  readonly hasPersistentFileInspector: boolean;
}): AdaptiveNavigationAction {
  return input.hasPersistentFileInspector ? "replace" : "push";
}

interface StackRouteLike {
  readonly key: string;
  readonly name: string;
  readonly params?: object | undefined;
}

interface StackStateLike {
  readonly index: number;
  readonly routes: ReadonlyArray<StackRouteLike>;
}

/** A workspace destination: a thread or a project, with its params. */
export interface WorkspaceSelectionRoute {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
}

export type WorkspaceSelection<TState extends StackStateLike> =
  /** A plain `navigate` does it: nothing covers the screen it pushes from. */
  | { readonly type: "navigate" }
  /** The destination is already open with nothing over it. */
  | { readonly type: "none" }
  | {
      readonly type: "reset";
      readonly state: Omit<TState, "index" | "routes"> & {
        readonly index: number;
        readonly routes: ReadonlyArray<StackRouteLike | WorkspaceSelectionRoute>;
      };
    };

function isSameDestination(route: StackRouteLike, target: WorkspaceSelectionRoute): boolean {
  if (route.name !== target.name) return false;
  const params = (route.params ?? {}) as Readonly<Record<string, unknown>>;
  return Object.entries(target.params).every(([key, value]) => params[key] === value);
}

/**
 * How to open a thread or project from wherever the app is, as one stack
 * update: a thread jump (Command-1…9) or a command-palette pick can happen
 * while sheets are open.
 *
 * The sheets close and the back stack beneath them stays. The destination then
 * replaces an open one of its kind (threads are peers, so switching does not
 * pile them up and Back still leads to the list), or is pushed on any other
 * screen.
 */
export function resolveWorkspaceSelection<TState extends StackStateLike>(input: {
  readonly state: TState | undefined;
  readonly overlayRouteNames: ReadonlySet<string>;
  readonly route: WorkspaceSelectionRoute;
}): WorkspaceSelection<TState> {
  const state = input.state;
  if (state === undefined) return { type: "navigate" };
  let workspaceIndex = Math.min(state.index, state.routes.length - 1);
  while (
    workspaceIndex >= 0 &&
    input.overlayRouteNames.has(state.routes[workspaceIndex]?.name ?? "")
  ) {
    workspaceIndex -= 1;
  }
  const workspace = state.routes[workspaceIndex];
  if (workspace === undefined) return { type: "navigate" };
  const covered = workspaceIndex < state.index;

  if (workspace.name === input.route.name) {
    if (isSameDestination(workspace, input.route)) {
      return covered
        ? {
            type: "reset",
            state: {
              ...state,
              index: workspaceIndex,
              routes: state.routes.slice(0, workspaceIndex + 1),
            },
          }
        : { type: "none" };
    }
    return {
      type: "reset",
      state: {
        ...state,
        index: workspaceIndex,
        routes: [...state.routes.slice(0, workspaceIndex), input.route],
      },
    };
  }
  if (!covered) return { type: "navigate" };
  return {
    type: "reset",
    state: {
      ...state,
      index: workspaceIndex + 1,
      routes: [...state.routes.slice(0, workspaceIndex + 1), input.route],
    },
  };
}
