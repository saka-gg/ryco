vi.mock("../nodes/DeviceIconPicker", () => ({
  DeviceIconPickerSheet: () => null,
  deviceIconChoiceLabel: () => "Automatic",
  useDeviceIconEditable: () => ({ editable: false, choice: null }),
}));
vi.mock("../../components/DeviceIcon", () => ({
  DeviceAvatar: () => null,
  DeviceIcon: () => null,
  EnvironmentMachineIcon: () => null,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../settings/machine/useMachineSettings", () => ({
  useMachineSettings: () => ({ config: null, readOnlyReason: null }),
}));
vi.mock("react-native-reanimated", () => {
  const Animated = { View: "AnimatedView", ScrollView: "AnimatedScrollView" };
  return {
    default: Animated,
    ...Animated,
    Easing: { bezier: () => (value: number) => value },
    runOnJS: (fn: unknown) => fn,
    useAnimatedStyle: () => ({}),
    useAnimatedScrollHandler: () => undefined,
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ get: () => value, set: () => undefined }),
    withTiming: (value: unknown) => value,
  };
});
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubState } from "@ryco/client-runtime/authorization";

// The Machines route. The screen is invoked as a plain
// function with react-native mocked (no React renderer exists in this suite);
// the hosted section below it renders for real, so the hosted controller spies
// are a genuine tripwire on machine-row interactions.

const navigationMock = vi.hoisted(() => ({ navigate: vi.fn() }));
const actionsMock = vi.hoisted(() => ({
  reconnectSavedEnvironment: vi.fn(() => Promise.resolve()),
  disconnectSavedEnvironment: vi.fn(() => Promise.resolve()),
  removeSavedEnvironment: vi.fn(() => Promise.resolve()),
  renameSavedEnvironment: vi.fn(),
  setSavedEnvironmentEnabled: vi.fn(() => Promise.resolve()),
}));
const rowsMock = vi.hoisted(() => ({
  rows: [] as ReadonlyArray<unknown>,
}));
const hostedMock = vi.hoisted(() => ({
  available: false,
  ensureMobileHostedSession: vi.fn(() => Promise.resolve()),
  controller: {
    selectNode: vi.fn(),
    returnToDirectory: vi.fn(),
    refreshDirectory: vi.fn(),
    retrySelectedNode: vi.fn(),
  },
}));
const mountEffects = vi.hoisted(() => [] as Array<() => void>);
const directoryDemandMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() =>
  vi.fn((request: { readonly onConfirm: () => void }) => request.onConfirm()),
);
const threadsStoreMock = vi.hoisted(() => ({
  setActiveEnvironmentId: vi.fn(),
}));

vi.mock("react-native", () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  useColorScheme: () => "dark",
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // Supports React's lazy-initializer form, which `useHostedModeAvailable`
    // uses — the hosted section below the device rows renders for real here.
    useState: <T>(initial: T | (() => T)) =>
      [typeof initial === "function" ? (initial as () => T)() : initial, () => undefined] as const,
    useEffect: (effect: () => void) => mountEffects.push(effect),
    // The §13 channel-status projection the hosted pill reads. There is no
    // dispatcher in this renderer, and the snapshot is all a render needs.
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  };
});
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => navigationMock,
}));
vi.mock("../../hostedHub/directoryDemand", () => ({
  useDirectoryPresenceDemand: directoryDemandMock,
}));
vi.mock("../../components/ConfirmDialogHost", () => ({ showConfirmDialog: confirmMock }));
vi.mock("../../components/NavigationHeaderButton", () => ({
  NavigationHeaderButton: "NavigationHeaderButton",
}));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000000" }));
vi.mock("../../state/threadsRuntime", () => {
  const state = {
    activeEnvironmentId: null,
    setActiveEnvironmentId: threadsStoreMock.setActiveEnvironmentId,
  };
  return {
    useStore: Object.assign((selector: (input: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock("./useConnectionController", () => ({
  useSavedEnvironments: () => ({ rows: rowsMock.rows, isLoading: false }),
  useConnectionActions: () => actionsMock,
}));
vi.mock("../../hostedHub/useLinkedDirectAccess", () => ({
  useMobileLinkedDirectAccess: () => ({ linked: {}, linking: {}, directRoute: {}, notice: {} }),
  addMobileDirectAccessLazily: vi.fn(),
  removeMobileDirectAccessLazily: vi.fn(),
}));
vi.mock("../../hostedHub/state", () => ({
  useMobileHostedConnectionsStore: () => [],
  ensureMobileHostedSession: hostedMock.ensureMobileHostedSession,
  ensureMobileHostedDeviceKey: () => Promise.resolve(hostedMock.available),
  isMobileHostedModeAvailable: () => hostedMock.available,
  subscribeMobileHostedModeAvailability: () => () => undefined,
  hostedHubController: hostedMock.controller,
  useHostedHubStore: (selector: (state: HostedHubState) => unknown) =>
    selector(hostedState as HostedHubState),
}));
// The hosted pill's settling hook owns a `useRef` tracker and this renderer
// invokes components as plain functions with no dispatcher; pass the derived
// pair through unchanged (the step machine is covered in
// settledHostedStatus.test.ts).
vi.mock("../hostedHub/useSettledHostedStatus", () => ({
  useSettledHostedStatus: (input: { indicator: unknown; statusText: unknown }) => ({
    indicator: input.indicator,
    statusText: input.statusText,
  }),
}));
vi.mock("../home/useAuthoritativeNodeTrust", () => ({
  useAuthoritativeNodeTrust: () => new Map(),
}));

const hostedState: HostedHubState = {
  bootstrapAvailable: false,
  accountStatus: "signed-out",
  account: null,
  session: null,
  directoryStatus: "idle",
  nodes: [],
  selectedNode: null,
  selectionStatus: "none",
  effectiveRole: null,
  transportStatus: "idle",
  sessionStatus: "closed",
  sessionEstablished: false,
  sessionRecoveredAfterUnknown: false,
  browserStatus: "current",
  recoveryCodes: [],
  errorMessage: null,
  generation: 0,
};

import { ConnectionsRouteScreen } from "./ConnectionsRouteScreen";

function savedRow(
  environmentId: string,
  label: string,
  connectionState: "connected" | "disconnected" | "error" = "connected",
  switchedOff = false,
) {
  return {
    record: { environmentId, label, httpBaseUrl: "https://mac.local:44342" },
    runtime: { connectionState, authState: "authenticated", role: "owner" },
    tone: { label: "Connected", pillClassName: "bg-success-bg", textClassName: "text-success" },
    statusLabel: switchedOff ? "Switched off" : "Connected",
    switchedOff,
  };
}

function render(element: unknown): ReadonlyArray<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(element)) return element.flatMap(render);
  if (typeof element !== "object" || element === null) return [];
  const node = element as ReactElement<Record<string, unknown>>;
  if (!("props" in node)) return [];
  if (typeof node.type === "function") {
    const component = node.type as (props: Record<string, unknown>) => unknown;
    return render(component(node.props));
  }
  return [node, ...render(node.props?.children)];
}

function texts(element: unknown): ReadonlyArray<string> {
  return render(element)
    .filter((candidate) => candidate.type === "Text")
    .map((candidate) => String(candidate.props.children));
}

/** Every tappable host element, paired with the text it renders. */
function buttons(element: unknown): ReadonlyArray<{ label: string; press: () => void }> {
  return render(element)
    .filter((candidate) => candidate.type === "Pressable" && candidate.props.onPress !== undefined)
    .map((candidate) => ({
      label: texts(candidate.props.children).join(" ").trim(),
      press: candidate.props.onPress as () => void,
    }));
}

/** A control by its accessible name, as VoiceOver reads it. */
function control(element: unknown, name: string): ReactElement<Record<string, unknown>> {
  const found = render(element).find((candidate) => candidate.props.accessibilityLabel === name);
  if (!found) throw new Error(`no control named ${name}`);
  return found;
}

function press(element: unknown, name: string): void {
  const found = control(element, name);
  expect(found.props.disabled, name).not.toBe(true);
  (found.props.onPress as () => void)();
}

/** The sheet opened on one machine's page, as `connections?environmentId=…` does. */
function machinePage(environmentId = "env-1") {
  return ConnectionsRouteScreen({ route: { params: { environmentId } } } as never);
}

const machines = () => ConnectionsRouteScreen({ route: { params: undefined } } as never);

beforeEach(() => {
  navigationMock.navigate.mockClear();
  actionsMock.reconnectSavedEnvironment.mockClear();
  actionsMock.disconnectSavedEnvironment.mockClear();
  actionsMock.removeSavedEnvironment.mockClear();
  actionsMock.renameSavedEnvironment.mockClear();
  actionsMock.setSavedEnvironmentEnabled.mockClear();
  confirmMock.mockClear();
  hostedMock.ensureMobileHostedSession.mockClear();
  hostedMock.controller.selectNode.mockClear();
  hostedMock.controller.returnToDirectory.mockClear();
  hostedMock.controller.refreshDirectory.mockClear();
  hostedMock.controller.retrySelectedNode.mockClear();
  mountEffects.length = 0;
  directoryDemandMock.mockClear();
  hostedMock.available = false;
  threadsStoreMock.setActiveEnvironmentId.mockClear();
  rowsMock.rows = [savedRow("env-1", "Studio Mac")];
});

describe("Machines — the list", () => {
  it("holds directory presence demand while focused", () => {
    machines();
    expect(directoryDemandMock).toHaveBeenCalledWith(true);
  });

  it("labels both planes as separate sections", () => {
    const rendered = texts(machines());
    expect(rendered).toContain("Paired directly");
    expect(rendered).toContain("Hub nodes");
  });

  it("keeps the direct pairing CTA", () => {
    buttons(machines())
      .find((button) => button.label === "Pair directly")
      ?.press();
    expect(navigationMock.navigate).toHaveBeenCalledWith("ConnectionsNew");
  });

  it("lists a machine as one row that only opens its page", () => {
    const tree = machines();
    const row = control(tree, "Studio Mac, Connected · LAN · mac.local:44342");
    expect(row.props.accessibilityHint).toBe("Opens the machine's page");
    (row.props.onPress as () => void)();
    // No action button in the list itself: everything else is on the machine's page.
    expect(buttons(tree).map((button) => button.label)[0]).toBe("Pair directly");
    expect(buttons(tree)).toHaveLength(2);
    expect(threadsStoreMock.setActiveEnvironmentId).not.toHaveBeenCalled();
    expect(actionsMock.disconnectSavedEnvironment).not.toHaveBeenCalled();
  });

  it("still renders the empty state with no saved environments", () => {
    rowsMock.rows = [];
    const rendered = texts(machines());
    expect(rendered).toContain("No machines paired directly");
    expect(rendered).toContain("Pair directly");
  });
});

describe("Machines — a machine's page", () => {
  it("uses, disconnects and forgets a machine from its buttons, Forget asking first", () => {
    const tree = machinePage();
    expect(control(tree, "Back to Machines").props.accessibilityRole).toBe("button");
    press(tree, "Use Studio Mac");
    press(tree, "Disconnect Studio Mac");
    press(tree, "Forget Studio Mac");
    expect(threadsStoreMock.setActiveEnvironmentId).toHaveBeenCalledWith("env-1");
    expect(actionsMock.disconnectSavedEnvironment).toHaveBeenCalledWith("env-1");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toMatchObject({
      title: "Forget Studio Mac?",
      confirmText: "Forget",
      destructive: true,
    });
    expect(actionsMock.removeSavedEnvironment).toHaveBeenCalledWith("env-1");
  });

  it("retries a failed direct connection", () => {
    rowsMock.rows = [savedRow("env-1", "Studio Mac", "error")];
    press(machinePage(), "Retry Studio Mac");
    expect(actionsMock.reconnectSavedEnvironment).toHaveBeenCalledWith("env-1");
  });

  it("switches a machine off without forgetting it", () => {
    const toggle = control(machinePage(), "Switched on");
    expect(toggle.props.value).toBe(true);
    (toggle.props.onValueChange as () => void)();
    expect(actionsMock.setSavedEnvironmentEnabled).toHaveBeenCalledWith("env-1", false);
    expect(actionsMock.removeSavedEnvironment).not.toHaveBeenCalled();
  });

  it("offers a switched-off machine only Switch on, Rename and Access among its buttons", () => {
    rowsMock.rows = [savedRow("env-1", "Studio Mac", "disconnected", true)];
    const tree = machinePage();
    expect(texts(tree)).toContain("Switched off");
    expect(control(tree, "Disconnect Studio Mac").props.disabled).toBe(true);
    press(tree, "Switch on Studio Mac");
    expect(actionsMock.setSavedEnvironmentEnabled).toHaveBeenCalledWith("env-1", true);
    press(tree, "Rename Studio Mac");
    press(tree, "Access Studio Mac");
    expect(navigationMock.navigate).toHaveBeenCalledWith("MachineAccess", {
      environmentId: "env-1",
    });
  });

  it("leads to the machine's own settings and access", () => {
    const tree = machinePage();
    press(tree, "Providers");
    press(tree, "System");
    press(tree, "Pairing links & clients");
    expect(navigationMock.navigate).toHaveBeenCalledWith("SettingsMachineProviders", {
      environmentId: "env-1",
    });
    expect(navigationMock.navigate).toHaveBeenCalledWith("SettingsMachineSystem", {
      environmentId: "env-1",
    });
    expect(navigationMock.navigate).toHaveBeenCalledWith("MachineAccess", {
      environmentId: "env-1",
    });
  });

  it("dims the device icon with its reason unless a connected owner may change it", () => {
    const tree = machinePage();
    expect(control(tree, "Device icon, Automatic").props.disabled).toBe(true);
    expect(texts(tree)).toContain("Connect as the device owner to change its icon.");
  });
});

describe("two-plane isolation (direct → hosted)", () => {
  it("never calls a hosted controller method while using a directly paired machine", () => {
    for (const available of [false, true]) {
      hostedMock.available = available;
      const tree = machinePage();
      buttons(tree)
        .find((button) => button.label === "Pair directly")
        ?.press();
      for (const name of ["Use Studio Mac", "Disconnect Studio Mac", "Forget Studio Mac"]) {
        press(tree, name);
      }
    }
    expect(threadsStoreMock.setActiveEnvironmentId).toHaveBeenCalledTimes(2);
    expect(hostedMock.controller.selectNode).not.toHaveBeenCalled();
    expect(hostedMock.controller.returnToDirectory).not.toHaveBeenCalled();
    expect(hostedMock.controller.refreshDirectory).not.toHaveBeenCalled();
    expect(hostedMock.controller.retrySelectedNode).not.toHaveBeenCalled();
  });
});
