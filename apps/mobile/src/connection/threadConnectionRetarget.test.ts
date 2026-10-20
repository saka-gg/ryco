import {
  createHostedEnvironmentSessions,
  type HostedHubNode,
  type HostedHubState,
} from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));
vi.mock("@ryco/mobile-device-key", () => ({
  default: {
    ensureKey: async () => ({ publicKey: "", backing: "unavailable" }),
    sign: async () => "",
    hasKey: async () => false,
    deleteKey: async () => {},
  },
}));

import type { CachedHubNodeRecord } from "../hostedHub/nodeRoster";
import {
  createThreadConnectionRetargetEngine,
  deriveThreadConnectionRetarget,
  isWarmHostedEnvironmentSession,
  resetMobileThreadConnectionRetargetEngineForTests,
  THREAD_CONNECTION_RETARGET_DEBOUNCE_MS,
  type ThreadConnectionRetargetEngine,
  type ThreadConnectionRetargetEngineDeps,
} from "./threadConnectionRetarget";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;
const ENV_DIRECT = "env-direct" as EnvironmentId;
const DEBOUNCE_MS = 50;

function node(
  nodeId: string,
  environmentId: EnvironmentId,
  overrides: { revokedAt?: number | null; online?: boolean } = {},
): HostedHubNode {
  return {
    id: nodeId,
    environmentId,
    label: nodeId,
    effectiveRole: "operator",
    revokedAt: overrides.revokedAt ?? null,
    lastAuthenticatedAt: null,
    presence: { online: overrides.online ?? true, lastHeartbeatAt: null },
  } as unknown as HostedHubNode;
}

function hubState(overrides: Partial<HostedHubState> = {}): HostedHubState {
  return {
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
    selectedNode: null,
    selectionStatus: "none",
    nodes: [],
    ...overrides,
  } as HostedHubState;
}

function rosterRecord(nodeId: string, environmentId: EnvironmentId): CachedHubNodeRecord {
  return {
    nodeId,
    environmentId,
    label: nodeId,
    effectiveRole: "operator",
    revokedAt: null,
    presenceOnline: true,
    lastHeartbeatAt: null,
    lastAuthenticatedAt: null,
    observedAt: 1,
  };
}

function createFakeStore(initial: HostedHubState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch: (next: Partial<HostedHubState>) => {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

/**
 * A `selectNode` fake that resolves only when the test says so, and that
 * records how many dispatches were live at once. Every assertion about
 * concurrency in this file reads `maxConcurrent`.
 */
function createDeferredSelectNode() {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const selectNode = vi.fn(async (nodeId: string) => {
    calls.push(nodeId);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise<void>((resolve) => pending.push(resolve));
    concurrent -= 1;
  });
  return {
    selectNode,
    calls,
    resolveNext: () => pending.shift()?.(),
    get maxConcurrent() {
      return maxConcurrent;
    },
  };
}

let engines: ThreadConnectionRetargetEngine[] = [];

function createEngine(
  overrides: Partial<ThreadConnectionRetargetEngineDeps> & {
    readonly store: ThreadConnectionRetargetEngineDeps["store"];
  },
): ThreadConnectionRetargetEngine {
  const engine = createThreadConnectionRetargetEngine({
    selectNode: async () => undefined,
    hasDirectEnvironment: () => false,
    hostedAvailable: () => true,
    getRosterEntry: () => null,
    debounceMs: DEBOUNCE_MS,
    ...overrides,
  });
  engines.push(engine);
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const engine of engines) engine.dispose();
  engines = [];
  resetMobileThreadConnectionRetargetEngineForTests();
  vi.useRealTimers();
});

describe("thread connection retarget decision", () => {
  /**
   * Prevents the dual-plane leak: a hosted connection built for an environment
   * the direct plane already owns is rejected by `supervisor.register` after
   * its socket is live, orphaning it.
   */
  it("leaves a direct-plane environment alone even when the hosted store says it is selectable", () => {
    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: true,
        hostedAvailable: true,
        state: hubState({ nodes: [node("node-a", ENV_A)] }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      }),
    ).toEqual({ kind: "none" });
  });

  /**
   * Prevents a re-dispatch loop: without this the engine would keep asking for
   * a selection it already has, and `selectNode` would silently no-op forever.
   */
  it("reports nothing to do once the environment is already the hosted selection", () => {
    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable: true,
        state: hubState({
          nodes: [node("node-a", ENV_A)],
          selectedNode: node("node-a", ENV_A),
        }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      }),
    ).toEqual({ kind: "none" });
  });

  it("reacquires a selected environment whose bounded connection was released", () => {
    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hasHostedConnection: false,
        hostedAvailable: true,
        state: hubState({
          nodes: [node("node-a", ENV_A)],
          selectedNode: node("node-a", ENV_A),
        }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      }),
    ).toEqual({ kind: "retarget", nodeId: "node-a" });
  });

  /**
   * Prevents this feature from touching non-hosted rows: opening a thread on a
   * plain direct or unknown environment must not publish a degraded reason.
   */
  it("ignores environments neither the roster nor the directory knows", () => {
    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_DIRECT,
        hasDirectEnvironment: false,
        hostedAvailable: false,
        state: hubState({ accountStatus: "signed-out", nodes: [node("node-a", ENV_A)] }),
        rosterEntry: null,
      }),
    ).toEqual({ kind: "none" });
  });

  /**
   * Prevents a permanent spinner on a build with no hosted config or no usable
   * hardware key: the roster can still name the node, but nothing can connect.
   */
  it("degrades to hosted-unavailable when the build cannot open hosted sessions", () => {
    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable: false,
        state: hubState({ nodes: [node("node-a", ENV_A)] }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      }),
    ).toEqual({ kind: "degraded", reason: "hosted-unavailable" });
  });

  /**
   * Prevents both failure modes of the account axis: a signed-out user waiting
   * on a spinner that will never resolve, and a mid-sign-in user being told to
   * sign in again half a second before the session lands.
   */
  it("degrades to signed-out for terminal account states and waits out the transients", () => {
    const forAccount = (accountStatus: HostedHubState["accountStatus"]) =>
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable: true,
        state: hubState({ accountStatus, nodes: [node("node-a", ENV_A)] }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      });

    expect(forAccount("signed-out")).toEqual({ kind: "degraded", reason: "signed-out" });
    expect(forAccount("session-expired")).toEqual({ kind: "degraded", reason: "signed-out" });
    expect(forAccount("unavailable")).toEqual({ kind: "degraded", reason: "signed-out" });
    expect(forAccount("authenticating")).toEqual({ kind: "wait" });
    expect(forAccount("signing-out")).toEqual({ kind: "wait" });
  });

  /**
   * Prevents deciding "node missing" from a directory whose last refresh
   * failed — a stale list would report every node as gone and purge nothing
   * back when it recovers.
   */
  it("fails closed on a stale directory and waits while it is still loading", () => {
    const forDirectory = (directoryStatus: HostedHubState["directoryStatus"]) =>
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable: true,
        state: hubState({ directoryStatus, nodes: [] }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      });

    expect(forDirectory("stale")).toEqual({ kind: "degraded", reason: "directory-unavailable" });
    expect(forDirectory("idle")).toEqual({ kind: "wait" });
    expect(forDirectory("loading")).toEqual({ kind: "wait" });
  });

  /**
   * Prevents every app background from being reported as a failure:
   * `browserStatus` leaves "current" on suspend and returns on resume, so a
   * thread opened from a notification must wait rather than degrade.
   */
  it("waits while the browser is away from current instead of failing closed", () => {
    for (const browserStatus of [
      "suspended",
      "offline",
      "checking-access",
      "synchronizing",
      "stale",
    ] as const) {
      expect(
        deriveThreadConnectionRetarget({
          environmentId: ENV_A,
          hasDirectEnvironment: false,
          hostedAvailable: true,
          state: hubState({ browserStatus, nodes: [node("node-a", ENV_A)] }),
          rosterEntry: rosterRecord("node-a", ENV_A),
        }),
      ).toEqual({ kind: "wait" });
    }
  });

  /**
   * Prevents a revoked or de-authorized node's thread from hanging: once the
   * directory is authoritative these are facts, and the screen owes the user a
   * stated reason on top of the cached content.
   */
  it("degrades when a ready directory has lost the node or reports it revoked", () => {
    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable: true,
        state: hubState({ nodes: [node("node-b", ENV_B)] }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      }),
    ).toEqual({ kind: "degraded", reason: "node-missing" });

    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable: true,
        state: hubState({ nodes: [node("node-a", ENV_A, { revokedAt: 42 })] }),
        rosterEntry: rosterRecord("node-a", ENV_A),
      }),
    ).toEqual({ kind: "degraded", reason: "revoked" });
  });

  /**
   * Prevents a presence fail-fast from blocking the tap. Presence is a
   * heartbeat observation, not permission; the wake-up attempt is exactly what
   * the user asked for by opening the thread.
   */
  it("retargets a presence-offline node because a thread tap is interactive intent", () => {
    expect(
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable: true,
        state: hubState({ nodes: [node("node-a", ENV_A, { online: false })] }),
        rosterEntry: null,
      }),
    ).toEqual({ kind: "retarget", nodeId: "node-a" });
  });

  /**
   * The guard-mirror property. `hostedHubController.selectNode` returns
   * silently — indistinguishably from success — whenever the directory is not
   * ready, the browser is not current, the node is missing or revoked, or the
   * node is already selected. If this model could ever ask for a retarget under
   * one of those conditions, the engine would dispatch, observe nothing, and
   * leave the thread waiting forever. Every retarget the model can produce must
   * therefore satisfy that guard set.
   */
  it("only asks for a retarget under inputs that satisfy selectNode's own guard set", () => {
    const accountStatuses = [
      "signed-out",
      "authenticating",
      "authenticated",
      "signing-out",
      "session-expired",
      "unavailable",
    ] as const;
    const directoryStatuses = ["idle", "loading", "ready", "stale"] as const;
    const browserStatuses = [
      "current",
      "suspended",
      "offline",
      "checking-access",
      "synchronizing",
      "stale",
    ] as const;
    const nodeShapes = ["present", "absent", "revoked"] as const;
    const selections = ["none", "same-environment", "other-node"] as const;
    const selectionStatuses = [
      "none",
      "online",
      "offline",
      "revoked",
      "authorization-removed",
      "incompatible",
    ] as const;

    let retargets = 0;
    let cases = 0;

    for (const accountStatus of accountStatuses) {
      for (const directoryStatus of directoryStatuses) {
        for (const browserStatus of browserStatuses) {
          for (const nodeShape of nodeShapes) {
            for (const selection of selections) {
              for (const selectionStatus of selectionStatuses) {
                for (const hasDirectEnvironment of [false, true]) {
                  for (const hostedAvailable of [false, true]) {
                    for (const withRoster of [false, true]) {
                      cases += 1;
                      const nodes =
                        nodeShape === "absent"
                          ? []
                          : [
                              node("node-a", ENV_A, {
                                revokedAt: nodeShape === "revoked" ? 42 : null,
                              }),
                            ];
                      const selectedNode =
                        selection === "none"
                          ? null
                          : selection === "same-environment"
                            ? node("node-a", ENV_A)
                            : node("node-b", ENV_B);
                      const state = hubState({
                        accountStatus,
                        directoryStatus,
                        browserStatus,
                        nodes,
                        selectedNode,
                        selectionStatus,
                      });
                      const decision = deriveThreadConnectionRetarget({
                        environmentId: ENV_A,
                        hasDirectEnvironment,
                        hostedAvailable,
                        state,
                        rosterEntry: withRoster ? rosterRecord("node-a", ENV_A) : null,
                      });
                      if (decision.kind !== "retarget") continue;
                      retargets += 1;

                      // selectNode's guard set, restated verbatim.
                      expect(state.directoryStatus).toBe("ready");
                      expect(state.browserStatus).toBe("current");
                      const target = state.nodes.find(
                        (candidate) => candidate.id === decision.nodeId,
                      );
                      expect(target).toBeDefined();
                      expect(target?.revokedAt).toBeNull();
                      expect(
                        state.selectedNode?.id === target?.id &&
                          state.selectedNode?.environmentId === target?.environmentId,
                      ).toBe(false);
                      // Plus this model's own preconditions.
                      expect(state.accountStatus).toBe("authenticated");
                      expect(hasDirectEnvironment).toBe(false);
                      expect(hostedAvailable).toBe(true);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(cases).toBe(62_208);
    expect(retargets).toBeGreaterThan(0);
  });

  /**
   * Prevents a revoked-but-still-selected node from reading as satisfied. The
   * relay reports revocation by patching `selectionStatus` while
   * `selectedNode` stays set until the 20s directory poll tears it down; a
   * thread opened inside that window owes the user the revoked reason, not a
   * silent consume of the one-shot intent.
   */
  it("falls through a terminally failed selection instead of declaring satisfaction", () => {
    const base = {
      environmentId: ENV_A,
      hasDirectEnvironment: false,
      hostedAvailable: true,
      rosterEntry: rosterRecord("node-a", ENV_A),
    };

    // Directory already agrees the node is revoked: state the reason.
    expect(
      deriveThreadConnectionRetarget({
        ...base,
        state: hubState({
          selectedNode: node("node-a", ENV_A),
          selectionStatus: "revoked",
          nodes: [node("node-a", ENV_A, { revokedAt: 42 })],
        }),
      }),
    ).toEqual({ kind: "degraded", reason: "revoked" });

    // Directory lists a re-enrolled replacement under a new node id sharing
    // the environment: retarget it — selectNode's already-selected guard
    // compares (id, environmentId) and will not no-op on the new id.
    expect(
      deriveThreadConnectionRetarget({
        ...base,
        state: hubState({
          selectedNode: node("node-a", ENV_A),
          selectionStatus: "authorization-removed",
          nodes: [node("node-a-replacement", ENV_A)],
        }),
      }),
    ).toEqual({ kind: "retarget", nodeId: "node-a-replacement" });

    // Directory still lists the very node that is terminally selected as live:
    // a contradiction the next poll resolves, and dispatching it would silently
    // no-op on selectNode's already-selected guard. Wait, do not dispatch.
    expect(
      deriveThreadConnectionRetarget({
        ...base,
        state: hubState({
          selectedNode: node("node-a", ENV_A),
          selectionStatus: "revoked",
          nodes: [node("node-a", ENV_A)],
        }),
      }),
    ).toEqual({ kind: "wait" });

    // A healthy same-environment selection is still satisfaction.
    expect(
      deriveThreadConnectionRetarget({
        ...base,
        state: hubState({
          selectedNode: node("node-a", ENV_A),
          selectionStatus: "online",
          nodes: [node("node-a", ENV_A)],
        }),
      }),
    ).toEqual({ kind: "none" });
  });

  /**
   * Prevents the cold-start race: at launch the roster hydrates from SQLite
   * behind fire-and-forget imports and the directory starts empty, so "neither
   * knows this environment" is not yet evidence of anything. Deciding "none"
   * there would consume the one-shot intent and strand a deep-linked thread
   * with no reason and no retarget.
   */
  it("waits out an unhydrated roster and empty directory instead of deciding not-our-plane", () => {
    const unknown = (overrides: Partial<HostedHubState>, hostedAvailable = true) =>
      deriveThreadConnectionRetarget({
        environmentId: ENV_A,
        hasDirectEnvironment: false,
        hostedAvailable,
        state: hubState({ nodes: [], ...overrides }),
        rosterEntry: null,
      });

    // Cold start: directory has not answered yet.
    expect(unknown({ directoryStatus: "idle" })).toEqual({ kind: "wait" });
    expect(unknown({ directoryStatus: "loading" })).toEqual({ kind: "wait" });
    // A ready directory that does not know the environment is authoritative.
    expect(unknown({ directoryStatus: "ready" })).toEqual({ kind: "none" });
    // Sign-in still in flight may yet produce a directory.
    expect(unknown({ accountStatus: "authenticating" })).toEqual({ kind: "wait" });
    // Terminal account states cannot prove hub-ness for an unknown environment.
    expect(unknown({ accountStatus: "signed-out" })).toEqual({ kind: "none" });
    // A build that can never open hosted sessions has nothing to wait for.
    expect(unknown({ directoryStatus: "idle" }, false)).toEqual({ kind: "none" });
  });

  /**
   * Prevents a list-order dependency: a directory can list a revoked record
   * alongside its re-enrolled replacement sharing one environment id, and the
   * decision must find the live one wherever it sits.
   */
  it("prefers a live directory record over a revoked one sharing the environment id", () => {
    for (const nodes of [
      [node("node-old", ENV_A, { revokedAt: 42 }), node("node-new", ENV_A)],
      [node("node-new", ENV_A), node("node-old", ENV_A, { revokedAt: 42 })],
    ]) {
      expect(
        deriveThreadConnectionRetarget({
          environmentId: ENV_A,
          hasDirectEnvironment: false,
          hostedAvailable: true,
          state: hubState({ nodes }),
          rosterEntry: null,
        }),
      ).toEqual({ kind: "retarget", nodeId: "node-new" });
    }
  });
});

describe("thread connection retarget engine", () => {
  /**
   * The wave 3a acceptance case: tapping thread A and immediately thread B must
   * cost one relay ticket, not two. Every dispatched `selectNode` buys a real
   * teardown and turn-up even though the transition queue serializes them, so a
   * superseded target has to be dropped before dispatch.
   */
  it("dispatches only the newest target when two threads are opened inside the debounce window", async () => {
    const store = createFakeStore(
      hubState({ nodes: [node("node-a", ENV_A), node("node-b", ENV_B)] }),
    );
    const selectNode = vi.fn(async () => undefined);
    const engine = createEngine({ store, selectNode });

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 20);
    engine.open(ENV_B);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-b");
  });

  /**
   * The post-debounce half of the same race. Once A is dispatched it cannot be
   * recalled, so B must queue behind it — and the two must never be in flight
   * together, because a second dispatch would race the transition queue's
   * teardown ordering for the connection A is still tearing up.
   */
  it("never runs two selectNode dispatches at once and follows a dispatched target with the newer one", async () => {
    const store = createFakeStore(
      hubState({ nodes: [node("node-a", ENV_A), node("node-b", ENV_B)] }),
    );
    const deferred = createDeferredSelectNode();
    const engine = createEngine({ store, selectNode: deferred.selectNode });

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(deferred.calls).toEqual(["node-a"]);

    engine.open(ENV_B);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // A is still in flight: B waits rather than dispatching alongside it.
    expect(deferred.calls).toEqual(["node-a"]);

    deferred.resolveNext();
    await vi.advanceTimersByTimeAsync(0);

    expect(deferred.calls).toEqual(["node-a", "node-b"]);
    expect(deferred.maxConcurrent).toBe(1);
  });

  /**
   * Prevents a connection being opened for a thread the user has already
   * navigated away from — a back-swipe inside the debounce window must cost
   * nothing at all.
   */
  it("starts a single cross-node open within the default window", async () => {
    // The window is pure latency on every cross-node thread open, so it stays
    // just long enough to collapse a double tap.
    expect(THREAD_CONNECTION_RETARGET_DEBOUNCE_MS).toBeLessThanOrEqual(100);
    const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
    const selectNode = vi.fn(async () => undefined);
    const engine = createEngine({ store, selectNode, debounceMs: undefined });

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(THREAD_CONNECTION_RETARGET_DEBOUNCE_MS - 1);
    expect(selectNode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");
  });

  it("cancels an intent released before the debounce fires", async () => {
    const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
    const selectNode = vi.fn(async () => undefined);
    const engine = createEngine({ store, selectNode });

    const release = engine.open(ENV_A);
    release();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

    expect(selectNode).not.toHaveBeenCalled();
  });

  /**
   * Prevents the cold-start hole: a thread opened from a notification before
   * the directory has loaded would otherwise be decided against an empty node
   * list and abandoned.
   */
  it("holds a pending intent until the directory becomes authoritative, then dispatches once", async () => {
    const store = createFakeStore(hubState({ directoryStatus: "loading", nodes: [] }));
    const selectNode = vi.fn(async () => undefined);
    const engine = createEngine({
      store,
      selectNode,
      getRosterEntry: () => rosterRecord("node-a", ENV_A),
    });

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(selectNode).not.toHaveBeenCalled();

    store.patch({ directoryStatus: "ready", nodes: [node("node-a", ENV_A)] });
    await vi.advanceTimersByTimeAsync(0);

    expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");
  });

  /**
   * Prevents the other cold-start hole: the roster hydrates from SQLite
   * *outside* the hosted store, so an intent evaluated before hydration sees
   * neither roster nor directory. The decision waits — and hydration itself
   * must re-evaluate, because no store notification accompanies it.
   */
  it("re-evaluates a pending intent when the roster hydrates, without a store change", async () => {
    const store = createFakeStore(hubState({ directoryStatus: "idle", nodes: [] }));
    const selectNode = vi.fn(async () => undefined);
    let rosterListener: () => void = () => undefined;
    let hydrated = false;
    const engine = createEngine({
      store,
      selectNode,
      getRosterEntry: () => (hydrated ? rosterRecord("node-a", ENV_A) : null),
      subscribeRoster: (listener) => {
        rosterListener = listener;
        return () => {
          rosterListener = () => undefined;
        };
      },
    });

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    // Unknown environment + unanswered directory: parked, not abandoned.
    expect(selectNode).not.toHaveBeenCalled();
    expect(engine.readDegradedReason(ENV_A)).toBeNull();

    // Hydration proves hub-ness with no store notification of its own; the
    // roster subscription is what keeps the intent alive through it.
    hydrated = true;
    rosterListener();
    await vi.advanceTimersByTimeAsync(0);
    store.patch({ directoryStatus: "ready", nodes: [node("node-a", ENV_A)] });
    await vi.advanceTimersByTimeAsync(0);

    expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");
  });

  /**
   * Prevents a terminal-looking screen from being terminal: a revoked node
   * states its reason and never dispatches, while a stale directory states a
   * different one and still recovers into a real connection when the next
   * refresh succeeds.
   */
  it("publishes a degraded reason, notifies subscribers, and recovers when the directory does", async () => {
    const revokedStore = createFakeStore(
      hubState({ nodes: [node("node-a", ENV_A, { revokedAt: 42 })] }),
    );
    const revokedSelect = vi.fn(async () => undefined);
    const revokedEngine = createEngine({ store: revokedStore, selectNode: revokedSelect });
    revokedEngine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(revokedEngine.readDegradedReason(ENV_A)).toBe("revoked");
    expect(revokedSelect).not.toHaveBeenCalled();

    const store = createFakeStore(hubState({ directoryStatus: "stale", nodes: [] }));
    const selectNode = vi.fn(async () => undefined);
    const engine = createEngine({
      store,
      selectNode,
      getRosterEntry: () => rosterRecord("node-a", ENV_A),
    });
    const notifications = vi.fn();
    engine.subscribe(notifications);

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(engine.readDegradedReason(ENV_A)).toBe("directory-unavailable");
    expect(notifications).toHaveBeenCalledOnce();
    expect(selectNode).not.toHaveBeenCalled();

    store.patch({ directoryStatus: "ready", nodes: [node("node-a", ENV_A)] });
    await vi.advanceTimersByTimeAsync(0);

    expect(engine.readDegradedReason(ENV_A)).toBeNull();
    expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  /**
   * Keeps the manual selection affordance working, which wave 3a must not
   * break: the intent is one-shot, so once it has landed the engine must not
   * drag the user back when they pick another node from the Hub section.
   */
  it("stops reconciling once the selection lands and never fights a later manual selection", async () => {
    const store = createFakeStore(
      hubState({ nodes: [node("node-a", ENV_A), node("node-b", ENV_B)] }),
    );
    const selectNode = vi.fn(async () => undefined);
    const engine = createEngine({ store, selectNode });

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");

    store.patch({ selectedNode: node("node-a", ENV_A) });
    await vi.advanceTimersByTimeAsync(0);

    // The user picks a different node by hand.
    store.patch({ selectedNode: node("node-b", ENV_B) });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

    expect(selectNode).toHaveBeenCalledOnce();
  });

  /**
   * Prevents the iPad double-mount from cancelling itself: ThreadFilesRoute
   * Screen mounts ThreadDetailScreen alongside its own copy, so one unmount
   * must not retract an intent the other still holds.
   */
  it("keeps the intent while any opener is still holding it and cancels only on the last release", async () => {
    const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
    const survivingSelect = vi.fn(async () => undefined);
    const surviving = createEngine({ store, selectNode: survivingSelect });
    surviving.open(ENV_A);
    const releaseSecond = surviving.open(ENV_A);
    releaseSecond();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(survivingSelect).toHaveBeenCalledExactlyOnceWith("node-a");

    const cancelledSelect = vi.fn(async () => undefined);
    const cancelled = createEngine({ store, selectNode: cancelledSelect });
    const releaseA = cancelled.open(ENV_A);
    const releaseB = cancelled.open(ENV_A);
    releaseA();
    releaseB();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
    expect(cancelledSelect).not.toHaveBeenCalled();
  });

  /**
   * The dual-plane guard again, at the engine level: a node paired directly and
   * also enrolled in the Hub shares one environment id, and dispatching here
   * would build a hosted connection that `supervisor.register` then rejects,
   * leaving a live socket with no owner.
   */
  it("never dispatches for an environment the direct plane already owns", async () => {
    const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
    const selectNode = vi.fn(async () => undefined);
    const engine = createEngine({
      store,
      selectNode,
      hasDirectEnvironment: () => true,
      getRosterEntry: () => rosterRecord("node-a", ENV_A),
    });

    engine.open(ENV_A);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

    expect(selectNode).not.toHaveBeenCalled();
    expect(engine.readDegradedReason(ENV_A)).toBeNull();
  });

  describe("with a warm session", () => {
    const warmOnly = (...warm: ReadonlyArray<EnvironmentId>) => ({
      hasWarmSession: (environmentId: EnvironmentId) => warm.includes(environmentId),
    });

    /**
     * Selecting a session that can be adopted or joined buys no relay ticket,
     * so the window that collapses an A→B tap-through only adds latency.
     */
    it("dispatches an open at once instead of waiting out the debounce", async () => {
      const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
      const selectNode = vi.fn(async () => undefined);
      const engine = createEngine({ store, selectNode, ...warmOnly(ENV_A) });

      engine.open(ENV_A);
      await vi.advanceTimersByTimeAsync(0);

      expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
      expect(selectNode).toHaveBeenCalledOnce();
    });

    it("dispatches at once under the default window too", async () => {
      const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
      const selectNode = vi.fn(async () => undefined);
      const engine = createEngine({
        store,
        selectNode,
        debounceMs: undefined,
        ...warmOnly(ENV_A),
      });

      engine.open(ENV_A);
      await vi.advanceTimersByTimeAsync(0);

      expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");
    });

    it("keeps the trailing debounce for a target without a warm session", async () => {
      const store = createFakeStore(
        hubState({ nodes: [node("node-a", ENV_A), node("node-b", ENV_B)] }),
      );
      const selectNode = vi.fn(async () => undefined);
      const engine = createEngine({ store, selectNode, ...warmOnly(ENV_A) });

      engine.open(ENV_B);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
      expect(selectNode).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-b");
    });

    it("lets a warm open supersede a pending debounced one without dispatching the older target", async () => {
      const store = createFakeStore(
        hubState({ nodes: [node("node-a", ENV_A), node("node-b", ENV_B)] }),
      );
      const selectNode = vi.fn(async () => undefined);
      const engine = createEngine({ store, selectNode, ...warmOnly(ENV_A) });

      engine.open(ENV_B);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 20);
      engine.open(ENV_A);
      await vi.advanceTimersByTimeAsync(0);
      expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
      expect(selectNode).toHaveBeenCalledOnce();
    });

    it("lets a debounced open supersede a warm one that has not dispatched yet", async () => {
      const store = createFakeStore(
        hubState({ nodes: [node("node-a", ENV_A), node("node-b", ENV_B)] }),
      );
      const selectNode = vi.fn(async () => undefined);
      const engine = createEngine({ store, selectNode, ...warmOnly(ENV_A) });

      engine.open(ENV_A);
      engine.open(ENV_B);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
      expect(selectNode).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-b");
    });

    it("drops a warm open released before it dispatched", async () => {
      const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
      const selectNode = vi.fn(async () => undefined);
      const engine = createEngine({ store, selectNode, ...warmOnly(ENV_A) });

      engine.open(ENV_A)();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

      expect(selectNode).not.toHaveBeenCalled();
    });

    it("still waits for an authoritative directory before dispatching a warm open", async () => {
      const store = createFakeStore(hubState({ directoryStatus: "loading", nodes: [] }));
      const selectNode = vi.fn(async () => undefined);
      const engine = createEngine({
        store,
        selectNode,
        getRosterEntry: () => rosterRecord("node-a", ENV_A),
        ...warmOnly(ENV_A),
      });

      engine.open(ENV_A);
      await vi.advanceTimersByTimeAsync(0);
      expect(selectNode).not.toHaveBeenCalled();

      store.patch({ directoryStatus: "ready", nodes: [node("node-a", ENV_A)] });
      await vi.advanceTimersByTimeAsync(0);

      expect(selectNode).toHaveBeenCalledExactlyOnceWith("node-a");
    });

    it("never runs two selectNode dispatches at once across warm opens", async () => {
      const store = createFakeStore(
        hubState({ nodes: [node("node-a", ENV_A), node("node-b", ENV_B)] }),
      );
      const deferred = createDeferredSelectNode();
      const engine = createEngine({
        store,
        selectNode: deferred.selectNode,
        ...warmOnly(ENV_A, ENV_B),
      });

      engine.open(ENV_A);
      await vi.advanceTimersByTimeAsync(0);
      engine.open(ENV_B);
      await vi.advanceTimersByTimeAsync(0);
      expect(deferred.calls).toEqual(["node-a"]);

      deferred.resolveNext();
      await vi.advanceTimersByTimeAsync(0);

      expect(deferred.calls).toEqual(["node-a", "node-b"]);
      expect(deferred.maxConcurrent).toBe(1);
    });

    it("does not dispatch again for a target that was already dispatched", async () => {
      const store = createFakeStore(hubState({ nodes: [node("node-a", ENV_A)] }));
      const deferred = createDeferredSelectNode();
      const engine = createEngine({
        store,
        selectNode: deferred.selectNode,
        ...warmOnly(ENV_A),
      });

      engine.open(ENV_A);
      await vi.advanceTimersByTimeAsync(0);
      // The same environment mounted a second time (a replace, or iPad's
      // second thread surface) re-decides at once but finds it dispatched.
      engine.open(ENV_A);
      await vi.advanceTimersByTimeAsync(0);
      deferred.resolveNext();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

      expect(deferred.calls).toEqual(["node-a"]);
    });
  });
});

describe("warm hosted environment session", () => {
  const sessionPorts = {
    now: () => Date.now(),
    setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer: unknown) =>
      globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  };

  it("has no warm session without a record", () => {
    expect(isWarmHostedEnvironmentSession(undefined)).toBe(false);
  });

  it("is warm while its connection is on its way, adoptable once established, cold otherwise", () => {
    const sessions = createHostedEnvironmentSessions(sessionPorts);
    try {
      const { generation } = sessions.ensureRecord(node("node-a", ENV_A));
      const warm = () => isWarmHostedEnvironmentSession(sessions.read(ENV_A));

      // A record nobody asked to connect is not on its way anywhere.
      expect(warm()).toBe(false);

      sessions.markConnectRequested(ENV_A, generation);
      expect(warm()).toBe(true);

      sessions.transportStatus(ENV_A, generation, "online");
      sessions.sessionStatus(ENV_A, generation, "synchronizing");
      expect(warm()).toBe(true);

      sessions.markSessionReady(ENV_A, generation);
      expect(warm()).toBe(true);

      sessions.suspendAll();
      expect(warm()).toBe(false);
    } finally {
      sessions.clear();
    }
  });

  it("is cold after a terminal failure", () => {
    const sessions = createHostedEnvironmentSessions(sessionPorts);
    try {
      const { generation } = sessions.ensureRecord(node("node-a", ENV_A));
      sessions.markConnectRequested(ENV_A, generation);
      sessions.transportStatus(ENV_A, generation, "terminal-failure");

      expect(isWarmHostedEnvironmentSession(sessions.read(ENV_A))).toBe(false);
    } finally {
      sessions.clear();
    }
  });
});
