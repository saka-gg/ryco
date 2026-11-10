import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigationMock = vi.hoisted(() => ({ setOptions: vi.fn(), navigate: vi.fn() }));
const dispatchMock = vi.hoisted(() => vi.fn());
const directoryDemandMock = vi.hoisted(() => vi.fn());
const workspaceDiscoveryMock = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useEffect: () => undefined,
    useLayoutEffect: (effect: () => void) => effect(),
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(initial: T) => ({ current: initial }),
    useReducer: <T>(
      _reducer: unknown,
      initial: T,
      initializer: ((input: T) => unknown) | undefined,
    ) => [initializer ? initializer(initial) : initial, dispatchMock] as const,
    useState: <T>(initial: T | (() => T)) =>
      [typeof initial === "function" ? (initial as () => T)() : initial, vi.fn()] as const,
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  };
});
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => navigationMock,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 96 }));
vi.mock("zustand/react/shallow", () => ({ useShallow: (selector: unknown) => selector }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ededed" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
// Keep native menus, chips and safe-area hooks outside the Node test environment.
vi.mock("@react-native-menu/menu", () => ({ MenuView: "MenuView" }));
vi.mock("../../components/ChipBar", () => ({ ChipBar: "ChipBar" }));
vi.mock("../../components/FloatingActionButton", () => ({
  FloatingActionButton: "FloatingActionButton",
}));
vi.mock("../../components/HeaderIconButton", () => ({ HeaderIconButton: "HeaderIconButton" }));
vi.mock("../../components/MachinePickerButton", () => ({
  MachinePickerButton: "MachinePickerButton",
}));
vi.mock("../../navigation/tabs/TabScreenChrome", () => ({
  TabLargeTitle: "TabLargeTitle",
  useLargeTitleCollapse: () => ({ collapsed: false, onScroll: () => undefined }),
  useTabContentInsets: () => ({ top: 100, bottom: 83 }),
  useTabStackHeader: (header: unknown) => navigationMock.setOptions({ stackHeader: header }),
}));
vi.mock("../inbox/InboxScreen", () => ({ InboxScreen: "InboxScreen" }));
vi.mock("../../state/threadPins", () => ({ useThreadPins: () => ({}) }));
vi.mock("../projects/ProjectsScreen", () => ({ ProjectsScreen: "ProjectsScreen" }));
vi.mock("./NeedsVerificationSection", () => ({
  NeedsVerificationSection: "NeedsVerificationSection",
}));
vi.mock("./useHomeEnvironments", () => ({ useHomeEnvironments: () => [] }));
// The auto-settle hand-over writes through the connection layer; its decisions are the client runtime's.
vi.mock("./useAutoSettleRuleHandOver", () => ({ useAutoSettleRuleHandOver: () => undefined }));
// preferencesStore reaches expo-sqlite's KV store; it must stop at the module
// boundary in the node test environment.
vi.mock("../../state/preferencesStore", () => ({ usePreferences: () => ({}) }));
vi.mock("../../state/snoozeWokeSeen", () => ({
  markSnoozeWokeSeen: () => undefined,
  useSnoozeWokeSeen: () => ({}),
}));
vi.mock("../inbox/CustomSnoozeSheet", () => ({ CustomSnoozeSheetHost: "CustomSnoozeSheetHost" }));
vi.mock("../connection/useConnectionController", () => ({
  useSavedEnvironments: () => ({ rows: [], isLoading: false }),
}));
vi.mock("../../hostedHub/state", () => ({
  useMobileHostedConnectionsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedNodes: [], deliveryUnknownEnvironmentIds: [] }),
}));
vi.mock("../../hostedHub/directoryDemand", () => ({
  useDirectoryPresenceDemand: directoryDemandMock,
}));
vi.mock("./useHomeThreadPrefetch", () => ({ useHomeThreadPrefetch: () => () => undefined }));
vi.mock("./useHostedWorkspaceDiscovery", () => ({
  useHostedWorkspaceDiscovery: workspaceDiscoveryMock,
}));
vi.mock("../../state/homeData", () => ({
  useListedEnvironmentsWorkspaceData: () => ({ projects: [], worktrees: [], threads: [] }),
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
  readonly unstable_headerLeftItems?: (props: {
    readonly tintColor?: string;
    readonly canGoBack: boolean;
  }) => ReadonlyArray<{
    readonly type: string;
    readonly element?: ReactElement;
    readonly hidesSharedBackground?: boolean;
  }>;
  readonly headerRight?: () => ReactElement;
}

function headerLeftItems(options: HeaderOptions) {
  return options.unstable_headerLeftItems?.({ canGoBack: false }) ?? [];
}

function renderHeaderOptions(): HeaderOptions {
  HomeScreen();
  const calls = navigationMock.setOptions.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls.at(-1)?.[0] as { stackHeader: HeaderOptions } | undefined;
  if (last === undefined) throw new Error("no header options");
  return last.stackHeader;
}

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;

function findByType(node: unknown, type: string): Element | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  const element = node as Element;
  if (element.type === type) return element;
  for (const value of Object.values(element.props ?? {})) {
    const found = findByType(value, type);
    if (found) return found;
  }
  return null;
}

describe("Chats", () => {
  beforeEach(() => {
    navigationMock.setOptions.mockClear();
    navigationMock.navigate.mockClear();
    dispatchMock.mockClear();
    directoryDemandMock.mockClear();
    workspaceDiscoveryMock.mockClear();
  });

  it("holds directory presence and workspace discovery demand while focused", () => {
    HomeScreen();
    expect(directoryDemandMock).toHaveBeenCalledWith(true);
    expect(workspaceDiscoveryMock).toHaveBeenCalledWith(true);
  });

  it("keeps the small title empty while the large title shows, and fills both header sides", () => {
    const options = renderHeaderOptions();
    expect(options.title).toBe("");
    const left = headerLeftItems(options);
    expect(left).toHaveLength(1);
    // The picker draws its own pill, so it opts out of the bar's shared glass.
    expect(left[0]).toMatchObject({ type: "custom", hidesSharedBackground: true });
    expect(findByType(left[0]?.element, "MachinePickerButton")).not.toBeNull();
    expect(typeof options.headerRight).toBe("function");
  });

  it("opens Search from the header's search button", () => {
    const right = renderHeaderOptions().headerRight?.();
    const search = findByType(right, "HeaderIconButton") as ReactElement<{
      accessibilityLabel: string;
      onPress: () => void;
    }>;
    expect(search.props.accessibilityLabel).toBe("Search");
    search.props.onPress();
    expect(navigationMock.navigate).toHaveBeenCalledWith("Search");
  });

  it("narrows to a machine from the picker and opens Machines from it", () => {
    const picker = findByType(
      headerLeftItems(renderHeaderOptions())[0]?.element,
      "MachinePickerButton",
    ) as ReactElement<{
      onSelect: (environmentId: string | null) => void;
      onManage: () => void;
    }> | null;
    picker?.props.onSelect("machine-a");
    expect(dispatchMock).toHaveBeenCalledWith({
      type: "set-node-scope",
      environmentId: "machine-a",
    });
    picker?.props.onManage();
    expect(navigationMock.navigate).toHaveBeenCalledWith("Connections");
  });

  it("keys the list by chip and scope, so the Done chip opens with its shelf open", () => {
    const list = findByType(HomeScreen(), "InboxScreen") as ReactElement<{
      settledStartsOpen: boolean;
    }>;
    expect(list.key).toBe(JSON.stringify(["all", null, null]));
    expect(list.props.settledStartsOpen).toBe(false);
  });

  it("selects a status chip and starts a New task from the floating button", () => {
    const root = HomeScreen();
    const chips = findByType(root, "ChipBar") as ReactElement<{
      onSelect: (key: string) => void;
    }>;
    chips.props.onSelect("needs-you");
    expect(dispatchMock).toHaveBeenCalledWith({ type: "select-filter", filter: "needs-you" });
    const fab = findByType(root, "FloatingActionButton") as ReactElement<{
      accessibilityLabel: string;
      onPress: () => void;
      bottom: number;
    }>;
    expect(fab.props.accessibilityLabel).toBe("New task");
    expect(fab.props.bottom).toBe(83 + 16);
    fab.props.onPress();
    expect(navigationMock.navigate).toHaveBeenCalledWith("NewTask", { environmentId: undefined });
  });
});
