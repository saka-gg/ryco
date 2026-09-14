import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigationMock = vi.hoisted(() => ({ setOptions: vi.fn(), navigate: vi.fn() }));
const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => undefined,
    useLayoutEffect: (effect: () => void) => effect(),
    useMemo: <T>(factory: () => T) => factory(),
    useReducer: <T>(
      _reducer: unknown,
      initial: T,
      initializer: ((input: T) => unknown) | undefined,
    ) => [initializer ? initializer(initial) : initial, dispatchMock] as const,
    useState: <T>(initial: T) => [initial, vi.fn()] as const,
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  };
});
vi.mock("@react-navigation/native", () => ({ useNavigation: () => navigationMock }));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 96 }));
vi.mock("zustand/react/shallow", () => ({ useShallow: (selector: unknown) => selector }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ededed" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/RycoWordmark", () => ({ RycoWordmark: "RycoWordmark" }));
// Keep native glass, menus, and safe-area hooks outside the Node test environment.
vi.mock("../../components/HomeBottomToolbar", () => ({ HomeBottomToolbar: "HomeBottomToolbar" }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView",
}));
vi.mock("../../components/HomeModeControl", () => ({ HomeModeControl: "HomeModeControl" }));
vi.mock("../../components/NodeScopeControl", () => ({ NodeScopeControl: "NodeScopeControl" }));
vi.mock("../inbox/InboxScreen", () => ({ InboxScreen: "InboxScreen" }));
vi.mock("../projects/ProjectsScreen", () => ({ ProjectsScreen: "ProjectsScreen" }));
vi.mock("./NeedsVerificationSection", () => ({
  NeedsVerificationSection: "NeedsVerificationSection",
}));
vi.mock("./useHomeEnvironments", () => ({ useHomeEnvironments: () => [] }));
// useNodeTrust reaches the E2EE trust store singleton and the hosted runtime
// config at module scope; preferencesStore reaches expo-sqlite's KV store.
// Both must stop at the module boundary in the node test environment.
vi.mock("./useNodeTrust", () => ({ useNodeTrust: () => null }));
vi.mock("../../state/preferencesStore", () => ({ usePreferences: () => ({}) }));
vi.mock("../connection/useConnectionController", () => ({
  useSavedEnvironments: () => ({ rows: [], isLoading: false }),
}));
vi.mock("../../hostedHub/state", () => ({
  useMobileHostedConnectionsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedNodes: [], deliveryUnknownEnvironmentIds: [] }),
}));
vi.mock("../../state/homeData", () => ({
  useHomeWorkspaceData: () => ({ projects: [], worktrees: [], threads: [] }),
}));
vi.mock("../../state/messageQueueStore", () => ({
  useMessageQueueStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ queuesByThreadKey: {} }),
}));
vi.mock("../../state/threadsRuntime", () => ({
  useStore: Object.assign((selector?: (state: unknown) => unknown) => selector?.({}), {
    getState: () => ({ setActiveEnvironmentId: () => undefined }),
  }),
  selectCacheHydratedEnvironmentIds: () => [],
}));

import { HomeScreen } from "./HomeScreen";

interface HeaderOptions {
  readonly title?: string;
  readonly headerLeft?: () => ReactElement;
  readonly headerRight?: () => ReactElement;
}

function renderHeaderOptions(): HeaderOptions {
  HomeScreen();
  const calls = navigationMock.setOptions.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]?.[0] as HeaderOptions;
}

describe("C1 Home header", () => {
  beforeEach(() => {
    navigationMock.setOptions.mockClear();
    navigationMock.navigate.mockClear();
    dispatchMock.mockClear();
  });

  it("labels the initial workspace Inbox and registers both header sides", () => {
    const options = renderHeaderOptions();
    expect(options.title).toBe("Inbox");
    expect(typeof options.headerLeft).toBe("function");
    expect(typeof options.headerRight).toBe("function");
  });

  it("renders the R-only compact mark in a 44-point Inbox button", () => {
    const element = renderHeaderOptions().headerLeft?.() as ReactElement<{
      accessibilityRole: string;
      accessibilityLabel: string;
      className: string;
      children: ReactElement<{ compact: boolean }>;
    }>;
    expect(element.type).toBe("Pressable");
    expect(element.props.accessibilityRole).toBe("button");
    expect(element.props.accessibilityLabel).toBe("Open Inbox");
    expect(element.props.className).toContain("h-11");
    expect(element.props.className).toContain("w-11");
    expect(element.props.children.type).toBe("RycoWordmark");
    expect(element.props.children.props.compact).toBe(true);
  });

  it("keeps only Settings in the header", () => {
    const element = renderHeaderOptions().headerRight?.() as ReactElement<{
      className: string;
      accessibilityLabel: string;
    }>;
    expect(element.props.accessibilityLabel).toBe("Settings");
    expect(element.props.className).toContain("h-11");
    expect(element.props.className).toContain("w-11");
  });

  it("switches the R button to Inbox without opening another navigation layer", () => {
    const element = renderHeaderOptions().headerLeft?.() as ReactElement<{
      onPress: () => void;
    }>;
    element.props.onPress();

    expect(dispatchMock).toHaveBeenCalledWith({ type: "select-mode", mode: "inbox" });
    expect(navigationMock.navigate).not.toHaveBeenCalled();
  });

  it("opens Settings straight from the header", () => {
    const element = renderHeaderOptions().headerRight?.() as ReactElement<{
      onPress: () => void;
    }>;
    element.props.onPress();

    expect(navigationMock.navigate).toHaveBeenCalledWith("SettingsSheet");
  });

  it("wires bottom search, machine filtering, and New Task into the current view", () => {
    const root = HomeScreen() as ReactElement<{
      children: ReactElement<{ children: ReadonlyArray<ReactElement | null> }>;
    }>;
    const toolbar = root.props.children.props.children.find(
      (child) => child?.type === "HomeBottomToolbar",
    ) as ReactElement<{
      query: string;
      searchLabel: string;
      onQueryChange: (query: string) => void;
      onSelectMachine: (environmentId: string | null) => void;
      onNewTask: () => void;
    }>;
    expect(toolbar.props.searchLabel).toBe("Search Inbox");
    expect(toolbar.props.query).toBe("");
    toolbar.props.onQueryChange("fix");
    expect(dispatchMock).toHaveBeenCalledWith({ type: "set-query", mode: "inbox", query: "fix" });
    toolbar.props.onSelectMachine("machine-a");
    expect(dispatchMock).toHaveBeenCalledWith({
      type: "set-node-scope",
      mode: "inbox",
      environmentId: "machine-a",
    });
    toolbar.props.onNewTask();
    expect(navigationMock.navigate).toHaveBeenCalledWith("NewTask", { environmentId: undefined });
  });
});
