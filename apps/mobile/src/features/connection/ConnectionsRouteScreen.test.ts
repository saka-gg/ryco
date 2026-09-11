vi.mock("../nodes/DeviceIconPicker", () => ({ DeviceIconPicker: () => null }));
vi.mock("../../components/DeviceIcon", () => ({
  DeviceIcon: () => null,
  EnvironmentMachineIcon: () => null,
}));
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
const confirmMock = vi.hoisted(() =>
  vi.fn((request: { readonly onConfirm: () => void }) => request.onConfirm()),
);
const threadsStoreMock = vi.hoisted(() => ({
  setActiveEnvironmentId: vi.fn(),
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
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
vi.mock("@react-navigation/native", () => ({ useNavigation: () => navigationMock }));
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
vi.mock("../../hostedHub/state", () => ({
  ensureMobileHostedSession: hostedMock.ensureMobileHostedSession,
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
) {
  return {
    record: { environmentId, label, httpBaseUrl: "https://mac.local:44342" },
    runtime: { connectionState, authState: "authenticated", role: "owner" },
    tone: { label: "Connected", pillClassName: "bg-success-bg", textClassName: "text-success" },
    statusLabel: "Connected",
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

beforeEach(() => {
  navigationMock.navigate.mockClear();
  actionsMock.reconnectSavedEnvironment.mockClear();
  actionsMock.disconnectSavedEnvironment.mockClear();
  actionsMock.removeSavedEnvironment.mockClear();
  actionsMock.renameSavedEnvironment.mockClear();
  confirmMock.mockClear();
  hostedMock.ensureMobileHostedSession.mockClear();
  hostedMock.controller.selectNode.mockClear();
  hostedMock.controller.returnToDirectory.mockClear();
  hostedMock.controller.refreshDirectory.mockClear();
  hostedMock.controller.retrySelectedNode.mockClear();
  mountEffects.length = 0;
  hostedMock.available = false;
  threadsStoreMock.setActiveEnvironmentId.mockClear();
  rowsMock.rows = [savedRow("env-1", "Studio Mac")];
});

describe("Machines — direct plane", () => {
  it("labels both planes as separate sections", () => {
    const rendered = texts(ConnectionsRouteScreen());
    expect(rendered).toContain("Paired directly");
    expect(rendered).toContain("Hub nodes");
  });

  it("keeps the direct pairing CTA", () => {
    buttons(ConnectionsRouteScreen())
      .find((button) => button.label === "Pair directly")
      ?.press();
    expect(navigationMock.navigate).toHaveBeenCalledWith("ConnectionsNew");
  });

  it("selects, disconnects, and forgets a saved environment through direct actions", () => {
    const tree = ConnectionsRouteScreen();
    buttons(tree)
      .find((button) => button.label === "Use")
      ?.press();
    buttons(tree)
      .find((button) => button.label === "Disconnect")
      ?.press();
    buttons(tree)
      .find((button) => button.label === "Forget")
      ?.press();
    expect(threadsStoreMock.setActiveEnvironmentId).toHaveBeenCalledWith("env-1");
    expect(actionsMock.disconnectSavedEnvironment).toHaveBeenCalledWith("env-1");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(actionsMock.removeSavedEnvironment).toHaveBeenCalledWith("env-1");
  });

  it("retries a failed direct connection", () => {
    rowsMock.rows = [savedRow("env-1", "Studio Mac", "error")];
    buttons(ConnectionsRouteScreen())
      .find((button) => button.label === "Retry")
      ?.press();
    expect(actionsMock.reconnectSavedEnvironment).toHaveBeenCalledWith("env-1");
  });

  it("still renders the empty state with no saved environments", () => {
    rowsMock.rows = [];
    const rendered = texts(ConnectionsRouteScreen());
    expect(rendered).toContain("No machines paired directly");
    expect(rendered).toContain("Pair directly");
  });
});

describe("Machines — hosted mode absent", () => {
  it("keeps direct actions isolated from the unavailable Hub section", () => {
    const tree = ConnectionsRouteScreen();
    expect(texts(tree)).toContain("Studio Mac");
    const labels = buttons(tree).map((button) => button.label);
    // Settings is no longer here — it moved to the Home header gear. The row
    // verbs stay in the transport register; only the CTA took wave 4's noun.
    expect(labels).toEqual(["Pair directly", "Use", "Disconnect", "Rename", "Forget"]);
    expect(texts(tree)).toContain("Hub nodes unavailable");
  });
});

describe("two-plane isolation (direct → hosted)", () => {
  it("never calls a hosted controller method while using the directly paired section", () => {
    for (const available of [false, true]) {
      hostedMock.available = available;
      const tree = ConnectionsRouteScreen();
      for (const label of ["Pair directly", "Use", "Disconnect", "Forget"]) {
        buttons(tree)
          .find((button) => button.label === label)
          ?.press();
      }
    }
    expect(threadsStoreMock.setActiveEnvironmentId).toHaveBeenCalledTimes(2);
    expect(hostedMock.controller.selectNode).not.toHaveBeenCalled();
    expect(hostedMock.controller.returnToDirectory).not.toHaveBeenCalled();
    expect(hostedMock.controller.refreshDirectory).not.toHaveBeenCalled();
    expect(hostedMock.controller.retrySelectedNode).not.toHaveBeenCalled();
  });
});
