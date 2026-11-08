import { CommonActions, type NavigationProp, type NavigationState } from "@react-navigation/native";
import type { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";

import {
  resolveWorkspaceSelection,
  type WorkspaceSelectionRoute,
} from "../lib/adaptive-navigation";
import { useStore } from "../state/threadsRuntime";
import { WORKSPACE_OVERLAY_ROUTE_NAMES } from "./mvpRouteConfig";

const OVERLAY_ROUTE_NAMES: ReadonlySet<string> = new Set(WORKSPACE_OVERLAY_ROUTE_NAMES);

/** What `useNavigation()` returns by default. */
type RootNavigation = Omit<NavigationProp<ReactNavigation.RootParamList>, "getState"> & {
  getState(): NavigationState | undefined;
};

/**
 * The app's root stack. A tab's screen holds the tab navigator, whose state
 * names tabs, not the screens and sheets above them.
 */
function rootNavigationOf(navigation: RootNavigation): RootNavigation {
  let root = navigation;
  for (let parent = root.getParent(); parent !== undefined; parent = root.getParent()) {
    root = parent as RootNavigation;
  }
  return root;
}

function selectOverSheets(
  from: RootNavigation,
  route: WorkspaceSelectionRoute,
  navigate: (navigation: RootNavigation) => void,
): void {
  const navigation = rootNavigationOf(from);
  const selection = resolveWorkspaceSelection({
    state: navigation.getState(),
    overlayRouteNames: OVERLAY_ROUTE_NAMES,
    route,
  });
  if (selection.type === "navigate") {
    navigate(navigation);
  } else if (selection.type === "reset") {
    // Routes without a key get a fresh one, so a replaced thread mounts anew.
    navigation.dispatch(
      CommonActions.reset(selection.state as Parameters<typeof CommonActions.reset>[0]),
    );
  }
}

/**
 * Opens a thread from wherever the app is: an inbox row, a thread jump or a
 * command-palette pick. Open sheets close, the back stack beneath them stays,
 * and an open thread is replaced rather than stacked (`resolveWorkspaceSelection`).
 * With nothing over Home this is the plain push a row tap always was.
 */
export function openThread(
  navigation: RootNavigation,
  thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    /** Opens the thread scrolled to this message (a message search hit). */
    readonly messageId?: string | undefined;
  },
): void {
  useStore.getState().setActiveEnvironmentId(thread.environmentId);
  const params = {
    environmentId: thread.environmentId,
    threadId: thread.threadId,
    ...(thread.messageId ? { messageId: thread.messageId } : {}),
  };
  selectOverSheets(navigation, { name: "Thread", params }, (root) =>
    root.navigate("Thread", params),
  );
}

/** Opens a project's screen the same way: over closed sheets, keeping the back stack. */
export function openProject(
  navigation: RootNavigation,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): void {
  const params = { environmentId: project.environmentId, projectId: project.projectId };
  selectOverSheets(navigation, { name: "Project", params }, (root) =>
    root.navigate("Project", params),
  );
}
