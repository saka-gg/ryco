import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  deriveHostedConnectionStatusIndicator,
  HOSTED_CONNECTION_STATUS_INDICATORS,
  type HostedHubNode,
  type HostedE2eeChannelStatus,
  type HostedHubState,
} from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";

// No React renderer exists in this suite (react-native cannot be transformed
// under node), so the section is exercised two ways: the pure model function
// directly, and the view invoked as a plain function with react-native mocked.

const hostedMock = vi.hoisted(() => ({
  available: true,
  e2eeStatus: "unavailable" as HostedE2eeChannelStatus,
  state: undefined as HostedHubState | undefined,
  controller: {
    selectNode: vi.fn(),
    returnToDirectory: vi.fn(),
    refreshDirectory: vi.fn(),
    retrySelectedNode: vi.fn(),
  },
}));
const acquireNodeMock = vi.hoisted(() => vi.fn(async () => undefined));

// Tripwires on the direct plane, in two layers.
//
// `loaded` records that a mock factory ran at all: vitest invokes a factory
// only when something actually imports that module, so a direct-plane module
// appearing anywhere in this section's import graph — directly or transitively
// — flips the flag. `trap` then makes every export throw on contact, so a
// render or press that somehow reached one fails loudly instead of quietly
// coupling the planes.
const tripwire = vi.hoisted(() => {
  const hits: string[] = [];
  const loaded: string[] = [];
  const trap = (name: string) => {
    loaded.push(name);
    return new Proxy(
      {},
      {
        get: (_target, key) => {
          hits.push(`${name}.${String(key)}`);
          throw new Error(`direct plane touched: ${name}.${String(key)}`);
        },
      },
    );
  };
  return { hits, loaded, trap };
});

vi.mock("../nodes/DeviceRenameSheet", () => ({ DeviceRenameSheet: () => null }));

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View", Text: "Text" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [initial, vi.fn()],
    useEffect: (effect: () => void) => mountEffects.push(effect),
  };
});
const mountEffects = vi.hoisted(() => [] as Array<() => void>);
vi.mock("@react-navigation/native", () => ({ useNavigation: () => navigationMock }));
const navigationMock = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("../../hostedHub/state", () => ({
  hostedHubController: hostedMock.controller,
  useHostedHubStore: (selector: (state: HostedHubState) => unknown) =>
    selector(hostedMock.state as HostedHubState),
}));
vi.mock("../../hostedHub/acquireNode", () => ({
  acquireMobileHostedNode: acquireNodeMock,
}));
// The availability seam is shared with the other hosted surfaces; it owns the
// `ensureMobileHostedSession()` call and its own state, so it is mocked here
// rather than re-implemented.
vi.mock("./useHostedMode", () => ({ useHostedModeAvailable: () => hostedMock.available }));
// The §13 projection seam, for the same reason: this renderer invokes function
// components directly, so a `useSyncExternalStore` hook has no dispatcher.
vi.mock("../e2ee/useMobileE2eeSession", () => ({
  useMobileE2eeChannelStatus: () => hostedMock.e2eeStatus,
}));
vi.mock("../e2ee/useMobileNativeE2eeEnrollment", () => ({
  useMobileNativeE2eeEnrollmentStatus: () => "ready",
}));
vi.mock("../home/useAuthoritativeNodeTrust", () => ({
  useAuthoritativeNodeTrust: (targets: ReadonlyArray<{ readonly environmentId: string }>) =>
    new Map(targets.map((target) => [target.environmentId, "verified"])),
}));
// The settling seam (`settledHostedStatus`), mocked for the same reason: it
// owns a `useRef`/`useSyncExternalStore` tracker and this renderer invokes
// components as plain functions with no dispatcher. The step machine itself is
// covered in `settledHostedStatus.test.ts`; what matters here is that the
// section feeds it the derived pair plus the selection identity, and renders
// whatever it hands back.
vi.mock("./useSettledHostedStatus", () => ({
  useSettledHostedStatus: (input: SettledHostedStatusInput) => {
    settledMock.observed.push(input);
    return settledMock.settled ?? { indicator: input.indicator, statusText: input.statusText };
  },
}));
const settledMock = vi.hoisted(() => ({
  observed: [] as Array<{ readonly selectionKey: string | null; readonly statusText: string }>,
  settled: undefined as SettledHostedStatus | undefined,
}));

vi.mock("../../connection/catalog", () => {
  const guard = tripwire.trap("connection/catalog");
  return { createMobileEnvironmentCatalog: () => guard, mobileEnvironmentCatalog: guard };
});
vi.mock("../../connection/environmentDriver", () => {
  const guard = tripwire.trap("connection/environmentDriver");
  return { createMobileEnvironmentDriver: () => guard };
});
vi.mock("../../runtime/bootstrap", () => {
  const guard = tripwire.trap("runtime/bootstrap");
  return { createMobileConnectionRegistry: () => guard, initializeMobileRuntime: () => guard };
});
vi.mock("../../providers/ConnectionRegistryProvider", () => {
  const guard = tripwire.trap("providers/ConnectionRegistryProvider");
  return { useConnectionRegistry: () => guard, useConnectionCatalog: () => guard };
});
vi.mock("../connection/useConnectionController", () => {
  const guard = tripwire.trap("features/connection/useConnectionController");
  return { useSavedEnvironments: () => guard, useConnectionActions: () => guard };
});
vi.mock("../../platform/secretKv", () => {
  const guard = tripwire.trap("platform/secretKv");
  return { mobileSecretKV: guard, createMobileSecretKV: () => guard };
});

import {
  canSelectHubNode,
  deriveHubNodeSectionModel,
  HubNodeSection,
  type HubNodeSectionModel,
} from "./HubNodeSection";
import {
  hostedSelectionKey,
  type SettledHostedStatus,
  type SettledHostedStatusInput,
} from "./settledHostedStatus";

function node(overrides: Partial<HostedHubNode> = {}): HostedHubNode {
  return {
    id: "node-1",
    environmentId: "env-1" as EnvironmentId,
    label: "Studio Mac",
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1.0.0",
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: null,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant-1", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
    ...overrides,
  };
}

function state(overrides: Partial<HostedHubState> = {}): HostedHubState {
  return {
    bootstrapAvailable: false,
    accountStatus: "authenticated",
    account: null,
    session: null,
    directoryStatus: "ready",
    nodes: [node()],
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
    ...overrides,
  };
}

function model(
  overrides: Partial<HostedHubState> = {},
  options: { readonly available?: boolean; readonly e2eeStatus?: HostedE2eeChannelStatus } = {},
): HubNodeSectionModel {
  return deriveHubNodeSectionModel({
    state: state(overrides),
    available: options.available ?? true,
    e2eeStatus: options.e2eeStatus ?? "unavailable",
    actions: hostedMock.controller,
    onSignIn: navigationMock.navigate,
  });
}

/**
 * Minimal depth-first renderer: function components are invoked with their
 * props (every component in this tree is hook-free presentation), host elements
 * are collected. Stands in for a React renderer, which this suite cannot run.
 */
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

function pressables(element: unknown): ReadonlyArray<ReactElement<Record<string, unknown>>> {
  return render(element).filter((candidate) => candidate.type === "Pressable");
}

beforeEach(() => {
  hostedMock.controller.selectNode.mockClear();
  hostedMock.controller.returnToDirectory.mockClear();
  hostedMock.controller.refreshDirectory.mockClear();
  hostedMock.controller.retrySelectedNode.mockClear();
  acquireNodeMock.mockClear();
  hostedMock.available = true;
  navigationMock.navigate.mockClear();
  mountEffects.length = 0;
  tripwire.hits.length = 0;
  settledMock.observed.length = 0;
  settledMock.settled = undefined;
});

describe("Hub node selection guard", () => {
  it("mirrors the controller's fail-closed guard", () => {
    expect(canSelectHubNode(state(), node())).toBe(true);
    expect(canSelectHubNode(state({ directoryStatus: "stale" }), node())).toBe(false);
    expect(canSelectHubNode(state({ browserStatus: "suspended" }), node())).toBe(false);
    expect(canSelectHubNode(state(), node({ revokedAt: 1 }))).toBe(false);
    // Epoch-zero revocation is still a revocation (stricter than a truthiness test).
    expect(canSelectHubNode(state(), node({ revokedAt: 0 }))).toBe(false);
  });

  it("disables the row when the directory is not ready", () => {
    for (const directoryStatus of ["idle", "loading", "stale"] as const) {
      const row = model({ directoryStatus }).rows[0];
      expect(row?.disabled).toBe(true);
      expect(row?.onPress).toBeUndefined();
    }
  });

  it("disables the row when the browser is not current", () => {
    for (const browserStatus of [
      "suspended",
      "offline",
      "checking-access",
      "synchronizing",
      "stale",
    ] as const) {
      const row = model({ browserStatus }).rows[0];
      expect(row?.disabled).toBe(true);
      expect(row?.onPress).toBeUndefined();
    }
  });

  it("disables a revoked node and labels it", () => {
    const row = model({ nodes: [node({ revokedAt: 1_700_000_000 })] }).rows[0];
    expect(row?.disabled).toBe(true);
    expect(row?.onPress).toBeUndefined();
    expect(row?.detail).toContain("Revoked");
  });
});

describe("Hub node actions", () => {
  it("offers canonical renaming only to an authenticated owner with a current directory", () => {
    const renameNode = vi.fn();
    const owner = state({ nodes: [node({ effectiveRole: "owner" })] });
    const model = deriveHubNodeSectionModel({
      state: owner,
      available: true,
      e2eeStatus: "unavailable",
      actions: { ...hostedMock.controller, renameNode },
      onSignIn: vi.fn(),
    });
    model.rows[0]?.rename?.();
    expect(renameNode).toHaveBeenCalledWith(owner.nodes[0]);
    const readOnly = deriveHubNodeSectionModel({
      state: {
        ...owner,
        nodes: owner.nodes.map((node) => ({ ...node, effectiveRole: "viewer" as const })),
      },
      available: true,
      e2eeStatus: "unavailable",
      actions: { ...hostedMock.controller, renameNode },
      onSignIn: vi.fn(),
    });
    expect(readOnly.rows.every((row) => row.rename === undefined)).toBe(true);
  });

  it("selects an enabled node through the controller", () => {
    const row = model().rows[0];
    expect(row?.disabled).toBe(false);
    row?.onPress?.();
    expect(hostedMock.controller.selectNode).toHaveBeenCalledTimes(1);
    expect(hostedMock.controller.selectNode).toHaveBeenCalledWith("node-1");
  });

  it("returns to the directory from All nodes only while a node is selected", () => {
    expect(model().allNodes).toBeUndefined();
    model({ selectedNode: node() }).allNodes?.();
    expect(hostedMock.controller.returnToDirectory).toHaveBeenCalledTimes(1);
  });

  it("refreshes the directory", () => {
    model().refresh?.();
    expect(hostedMock.controller.refreshDirectory).toHaveBeenCalledTimes(1);
  });

  it("offers Retry only after a selection failed", () => {
    expect(model({ selectedNode: node() }).retry).toBeUndefined();
    model({ selectedNode: node(), transportStatus: "terminal-failure" }).retry?.();
    expect(hostedMock.controller.retrySelectedNode).toHaveBeenCalledTimes(1);
  });

  it("filters Hub rows by bounded node metadata", () => {
    const filtered = deriveHubNodeSectionModel({
      state: state({
        nodes: [node(), node({ id: "node-2", label: "Build Linux", platformOs: "linux" })],
      }),
      available: true,
      e2eeStatus: "unavailable",
      actions: hostedMock.controller,
      onSignIn: navigationMock.navigate,
      query: "build",
    });

    expect(filtered.rows.map((row) => row.label)).toEqual(["Build Linux"]);
  });
});

describe("Hub node section status text", () => {
  it("comes from the runtime derivation, never a hand-written string", () => {
    const input = {
      browserStatus: "current",
      sessionStatus: "ready",
      selectionStatus: "online",
      transportStatus: "online",
    } as const;
    const derived = deriveHostedConnectionStatusIndicator(input);
    const current = model({ ...input, selectedNode: node() });
    expect(current.statusLabel).toBe(derived.shortLabel);
    expect(current.statusText).toBe("Online");

    const stale = model({ browserStatus: "stale" });
    expect(stale.statusLabel).toBe(
      deriveHostedConnectionStatusIndicator({ ...input, browserStatus: "stale" }).shortLabel,
    );
  });

  /**
   * Settling is presentation only. Prevents the pill and the selected row from
   * being settled independently — or from disagreeing with the accessible name
   * — while a re-target walks the underlying status through its step labels.
   */
  it("presents the settled pair, including the selected row's tone, when one is supplied", () => {
    const live = {
      browserStatus: "current",
      sessionStatus: "ready",
      selectionStatus: "online",
      transportStatus: "online",
    } as const;
    const held: SettledHostedStatus = {
      statusText: "connecting",
      indicator: HOSTED_CONNECTION_STATUS_INDICATORS.connecting,
    };

    const settled = deriveHubNodeSectionModel({
      state: state({ ...live, selectedNode: node() }),
      available: true,
      e2eeStatus: "verified",
      settledStatus: held,
      actions: hostedMock.controller,
      onSignIn: navigationMock.navigate,
    });

    // The live derivation would say `Encrypted`; the settled pair is what shows.
    expect(settled.statusText).toBe("connecting");
    expect(settled.statusLabel).toBe("Connecting");
    expect(settled.rows[0]?.tone).toBe(settled.statusTone);
    expect(settled.statusTone.label).toBe("Connecting");
  });

  /**
   * Prevents the wiring from feeding the tracker a key that ignores the
   * environment, which would let a status from the previously selected node be
   * held over the next one.
   */
  it("feeds the tracker the derived pair keyed on the selected node's identity", () => {
    hostedMock.state = state({
      selectedNode: node(),
      sessionStatus: "ready",
      selectionStatus: "online",
      transportStatus: "online",
    });
    HubNodeSection();

    expect(settledMock.observed).toHaveLength(1);
    expect(settledMock.observed[0]?.statusText).toBe("Online");
    expect(settledMock.observed[0]?.selectionKey).toBe(hostedSelectionKey(node()));

    settledMock.observed.length = 0;
    hostedMock.state = state({ selectedNode: null });
    HubNodeSection();
    expect(settledMock.observed[0]?.selectionKey).toBeNull();
  });
});

describe("Hub node section when hosted mode is unavailable or signed out", () => {
  it("renders an explicit empty state with no tappable rows when unavailable", () => {
    const unavailable = model({}, { available: false });
    expect(unavailable.kind).toBe("unavailable");
    expect(unavailable.rows).toHaveLength(0);
    expect(unavailable.empty).not.toBeNull();
    // No sign-in affordance: hosted mode cannot produce a session on this build
    // or device, so a sign-in button would be the "tappable but broken" case.
    expect(unavailable.signIn).toBeUndefined();
    expect(model({ accountStatus: "unavailable" }).kind).toBe("unavailable");
  });

  it("renders a sign-in affordance and no tappable node rows when signed out", () => {
    for (const accountStatus of ["signed-out", "session-expired"] as const) {
      const signedOut = model({ accountStatus });
      expect(signedOut.kind).toBe("signed-out");
      expect(signedOut.rows).toHaveLength(0);
      expect(signedOut.empty).not.toBeNull();
      expect(signedOut.empty?.detail).toContain("Continue in your browser");
      expect(typeof signedOut.signIn).toBe("function");
      expect(signedOut.refresh).toBeUndefined();
    }
  });

  it("renders no node Pressable at all while signed out", () => {
    hostedMock.state = state({ accountStatus: "signed-out" });
    const tree = HubNodeSection();
    const tappable = pressables(tree).filter((element) => element.props.onPress !== undefined);
    // Only the EmptyState's browser-handoff capsule is tappable.
    expect(tappable).toHaveLength(1);
    (tappable[0]!.props.onPress as () => void)();
    expect(navigationMock.navigate).toHaveBeenCalledWith("Access");
    expect(hostedMock.controller.selectNode).not.toHaveBeenCalled();
    expect(acquireNodeMock).not.toHaveBeenCalled();
  });
});

describe("Hub node section view", () => {
  it.each([
    ["Refresh", "refreshDirectory"],
    ["All nodes", "returnToDirectory"],
    ["Retry", "retrySelectedNode"],
  ] as const)("preserves the controller receiver when pressing %s", (label, method) => {
    hostedMock.state = state({ selectedNode: node(), transportStatus: "terminal-failure" });
    const action = pressables(HubNodeSection()).find(
      (element) => element.props.accessibilityLabel === label,
    );
    expect(action).toBeDefined();
    (action!.props.onPress as () => void)();
    expect(hostedMock.controller[method].mock.contexts).toEqual([hostedMock.controller]);
  });

  it("renders a tappable row that acquires the node through the coordinator", () => {
    hostedMock.state = state();
    const tree = HubNodeSection();
    const row = pressables(tree).find((element) =>
      (element.props.accessibilityLabel as string)?.startsWith("Studio Mac"),
    );
    expect(row).toBeDefined();
    expect(row?.props.disabled).toBe(false);
    (row!.props.onPress as () => void)();
    expect(acquireNodeMock).toHaveBeenCalledWith("node-1");
    expect(hostedMock.controller.selectNode).not.toHaveBeenCalled();
  });

  it("renders a disabled row with no press handler when the directory is stale", () => {
    hostedMock.state = state({ directoryStatus: "stale" });
    const row = pressables(HubNodeSection()).find((element) =>
      (element.props.accessibilityLabel as string)?.startsWith("Studio Mac"),
    );
    expect(row?.props.disabled).toBe(true);
    expect(row?.props.onPress).toBeUndefined();
  });

  it("renders the disabled state and no tappable row when hosted mode is unavailable", () => {
    hostedMock.available = false;
    hostedMock.state = state();
    const tree = HubNodeSection();
    expect(pressables(tree).filter((element) => element.props.onPress !== undefined)).toEqual([]);
    expect(hostedMock.controller.selectNode).not.toHaveBeenCalled();
    expect(acquireNodeMock).not.toHaveBeenCalled();
  });
});

describe("two-plane isolation (hosted → direct)", () => {
  it("never touches the direct catalog, registry, or SecretKV while rendering or pressing", () => {
    for (const current of [
      state(),
      state({ accountStatus: "signed-out" }),
      state({ directoryStatus: "stale" }),
      state({ selectedNode: node(), transportStatus: "terminal-failure" }),
    ]) {
      hostedMock.state = current;
      const tree = HubNodeSection();
      mountEffects.forEach((effect) => effect());
      for (const element of pressables(tree)) {
        (element.props.onPress as (() => void) | undefined)?.();
      }
    }
    expect(tripwire.hits).toEqual([]);
  });

  it("never loads a direct-plane module in its own import graph", () => {
    // Vitest runs a mock factory only when something imports that module, so an
    // empty `loaded` list means no direct-plane module is reachable from this
    // section — directly or transitively. The hosted runtime binding is mocked
    // and therefore not traversed: the runtime legitimately drives the direct
    // supervisor for node turn-up/teardown (plan Task 4). What must stay clean
    // is this section's own graph.
    expect(tripwire.loaded).toEqual([]);
  });
});
