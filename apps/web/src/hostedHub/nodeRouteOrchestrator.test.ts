import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";
import {
  configureHostedRuntime,
  isHostedEnvironmentSessionLive,
  resetHostedEnvironmentSessionsForTests,
  type HostedRelayFailure,
} from "@ryco/client-runtime/authorization";
import * as threadStore from "../store";

import type { HostedHubNode, HostedHubSessionResponse } from "./types";
import { createFakeHistoryWindow, type FakeHistoryWindow } from "../../test/fakeHistoryWindow";

const {
  activateHostedNode,
  deactivateHostedNode,
  suspendHostedNode,
  hasHostedRelayPendingRequests,
  resetHostedRelayAttemptFactory,
} = vi.hoisted(() => ({
  activateHostedNode: vi.fn(
    async (
      _node?: HostedHubNode,
      _previousEnvironmentId?: EnvironmentId | null,
      _signal?: AbortSignal,
    ): Promise<void> => undefined,
  ),
  deactivateHostedNode: vi.fn(async (_environmentId?: EnvironmentId) => undefined),
  suspendHostedNode: vi.fn(async (_environmentId?: EnvironmentId) => undefined),
  hasHostedRelayPendingRequests: vi.fn(() => false),
  resetHostedRelayAttemptFactory: vi.fn(),
}));
vi.mock("./environment", () => ({ activateHostedNode, deactivateHostedNode, suspendHostedNode }));
vi.mock("./transport", () => ({ hasHostedRelayPendingRequests, resetHostedRelayAttemptFactory }));

import { hostedHubApi, HostedHubApiError } from "./api";
import {
  HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
  getHostedEnvironmentSessions,
  hostedHubController,
  useHostedHubStore,
} from "./state";
import {
  getRoutedHostedNode,
  installHostedNodeHistory,
  resetHostedNodeRoutesForTests,
} from "./nodeRoutes";
import {
  getHostedNodeRouteNotice,
  leaveHostedNodeRouteToDirectory,
  resetHostedNodeRouteOrchestratorForTests,
  selectHostedNodeRoute,
  startHostedNodeRouteOrchestrator,
} from "./nodeRouteOrchestrator";
import { hostedWebConnectionScopes } from "./hostedConnectionScopes";

const sessionResponse: HostedHubSessionResponse = {
  account: {
    id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Ada",
    role: "owner",
    createdAt: 1,
    disabledAt: null,
  },
  session: {
    id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
    accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    createdAt: 1,
    expiresAt: 2,
    lastSeenAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
  },
  csrfToken: "csrf-sensitive-route-canary",
};

function node(
  id = "node_aaaaaaaaaaaaaaaaaaaaaa",
  overrides: Partial<HostedHubNode> = {},
): HostedHubNode {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label: `Node ${id.slice(-1)}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
    ...overrides,
  };
}

let stopOrchestrator: (() => void) | null = null;
let stopRouteDemand: (() => void) | null = null;

/**
 * The workspace coordinator's part, reduced to what these routes need: every
 * environment a route scope demands is acquired through the lifecycle owner
 * while it has no live session, as the demand executor does with free slots.
 * Selecting a node only moves the cursor; this is what connects it.
 */
function startRouteDemand(): () => void {
  const acquireDemanded = () => {
    const state = useHostedHubStore.getState();
    const sessions = getHostedEnvironmentSessions();
    for (const entry of hostedWebConnectionScopes.list()) {
      const target = state.nodes.find(
        (candidate) => candidate.environmentId === entry.environmentId,
      );
      if (!target || isHostedEnvironmentSessionLive(sessions.read(target.environmentId))) continue;
      void hostedHubController.acquireEnvironment(target.id);
    }
  };
  retainedPorts.requestEnvironmentReconcile.mockImplementation(acquireDemanded);
  const unsubscribeScopes = hostedWebConnectionScopes.subscribe(acquireDemanded);
  const unsubscribeStore = useHostedHubStore.subscribe(acquireDemanded);
  return () => {
    unsubscribeScopes();
    unsubscribeStore();
  };
}

function setup(
  initialUrl: string,
  options: { readonly demand?: boolean } = {},
): {
  win: FakeHistoryWindow;
  history: ReturnType<typeof installHostedNodeHistory>;
  flush: () => void;
} {
  const win = createFakeHistoryWindow(initialUrl);
  const history = installHostedNodeHistory(win as unknown as Window & typeof globalThis);
  stopOrchestrator = startHostedNodeRouteOrchestrator();
  if (options.demand !== false) stopRouteDemand = startRouteDemand();
  return { win, history, flush: () => history.flush() };
}

function recordGeneration(environmentId: EnvironmentId): number {
  return getHostedEnvironmentSessions().read(environmentId)!.generation;
}

/** The environment's own relay attempt came online and accepted its shell snapshot. */
function establish(environmentId: EnvironmentId): void {
  const sessions = getHostedEnvironmentSessions();
  const generation = recordGeneration(environmentId);
  sessions.transportStatus(environmentId, generation, "online");
  sessions.markSessionReady(environmentId, generation);
}

/** The environment's own relay attempt failed. */
function fail(environmentId: EnvironmentId, failure: HostedRelayFailure): void {
  getHostedEnvironmentSessions().failure(environmentId, recordGeneration(environmentId), failure);
}

/** Let queued reconcile microtasks and history flushes settle. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 8; hop += 1) await Promise.resolve();
}

const unusedPlatformService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the route orchestrator tests");
    },
  },
);

// The hosted controller reads an injected runtime. Configure it, as hosted Web
// runs, with retained environment sessions and a node lifecycle that routes
// the package's effects to this suite's observable fakes — a node activation
// is one environment connect, clearing node-scoped state is a deactivation —
// so the route assertions keep their meaning without touching the controller
// internals. The teardown effects also record their order.
const teardownOrder: string[] = [];
const retainedPorts = {
  connectEnvironment: vi.fn((node: HostedHubNode, _generation: number) => {
    void activateHostedNode(node);
  }),
  releaseEnvironment: vi.fn(
    async (_environmentId: EnvironmentId, _generation: number) => undefined,
  ),
  suspendEnvironment: vi.fn(
    async (_environmentId: EnvironmentId, _generation: number) => undefined,
  ),
  requestEnvironmentReconcile: vi.fn(),
};

function configureRouteRuntime(): void {
  configureHostedRuntime(
    {
      endpoint: unusedPlatformService as never,
      httpClient: unusedPlatformService as never,
      passkeyCeremony: unusedPlatformService as never,
      sessionCredentials: unusedPlatformService as never,
      environmentSessions: "retained",
      nodeLifecycle: {
        activate: async () => undefined,
        suspend: async () => undefined,
        deactivate: async () => undefined,
        clearNodeScopedState: (environmentId) => {
          teardownOrder.push("clear");
          void deactivateHostedNode(environmentId);
        },
        writePrimaryEnvironmentDescriptor: (descriptor) => {
          if (descriptor === null) teardownOrder.push("descriptor:null");
        },
        connectPrimaryEnvironment: () => undefined,
        disconnectPrimaryEnvironment: async () => {
          teardownOrder.push("disconnect");
        },
        setActiveEnvironmentId: () => undefined,
        ...retainedPorts,
      },
      timers: {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
        queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
      },
      isForeground: () =>
        (globalThis.document as { visibilityState?: string } | undefined)?.visibilityState !==
        "hidden",
      subscribeForeground: (listener) => {
        const doc = globalThis.document as
          | {
              visibilityState?: string;
              addEventListener: (type: string, handler: () => void, options?: unknown) => void;
              removeEventListener: (type: string, handler: () => void) => void;
            }
          | undefined;
        const onVisibility = () => {
          if (doc?.visibilityState === "visible") listener();
        };
        doc?.addEventListener("visibilitychange", onVisibility, { once: true });
        return () => doc?.removeEventListener("visibilitychange", onVisibility);
      },
      hasPendingRelayRequests: hasHostedRelayPendingRequests,
      resetRelayAttemptFactory: () => {
        teardownOrder.push("reset");
        resetHostedRelayAttemptFactory();
      },
      relayUrl: () => "wss://hub.example.test/v1/relay/client",
      createRelaySocket: () => ({}),
    },
    hostedHubApi,
  );
}

beforeEach(() => {
  teardownOrder.length = 0;
  configureRouteRuntime();
});

afterEach(() => {
  stopRouteDemand?.();
  stopRouteDemand = null;
  stopOrchestrator?.();
  stopOrchestrator = null;
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  hostedHubController.resetForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  activateHostedNode.mockClear();
  deactivateHostedNode.mockClear();
  suspendHostedNode.mockClear();
  hasHostedRelayPendingRequests.mockClear();
  resetHostedRelayAttemptFactory.mockClear();
  for (const port of Object.values(retainedPorts)) port.mockClear();
  retainedPorts.requestEnvironmentReconcile.mockReset();
  resetHostedEnvironmentSessionsForTests();
});

describe("hosted node route restore pipeline", () => {
  it("switches routes while the previous node is synchronizing its shell", async () => {
    const first = node();
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([first, second]);
    const { history, flush } = setup(`/node/${first.id}/${first.environmentId}/t_1`);
    await hostedHubController.bootstrap();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(first.id);
    useHostedHubStore.setState({ browserStatus: "checking-access" });

    selectHostedNodeRoute(second.id);
    history.push(`/${second.environmentId}/t_2`);
    flush();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(first.id);

    // The account and directory checks finished, but A's shell has not. B
    // must use the same lifecycle owner immediately rather than waiting for A.
    useHostedHubStore.setState({ browserStatus: "synchronizing" });
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(second.id);
    expect(useHostedHubStore.getState().sessionEstablished).toBe(false);
    expect(activateHostedNode).toHaveBeenCalledTimes(2);
  });

  it("restores a routed node strictly through session, directory, and activation", async () => {
    const target = node();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockResolvedValue(sessionResponse);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(
      `/node/${target.id}/${target.environmentId}/t_1?workspaceTab=diff`,
    );

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();

    expect(restoreSession.mock.invocationCallOrder[0]!).toBeLessThan(
      listNodes.mock.invocationCallOrder[0]!,
    );
    expect(listNodes.mock.invocationCallOrder[0]!).toBeLessThan(
      activateHostedNode.mock.invocationCallOrder[0]!,
    );
    const state = useHostedHubStore.getState();
    expect(state.selectedNode?.id).toBe(target.id);
    expect(state.sessionStatus).toBe("synchronizing");
    // Mutation readiness stays gated behind the existing sync pipeline.
    expect(state.sessionEstablished).toBe(false);
    // Deep-linked thread and panel state survive the restore untouched.
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);
    expect(win.location.search).toBe("?workspaceTab=diff");
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("fails closed to the directory when the routed node is absent", async () => {
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    const { win, flush } = setup("/node/node_gone");

    await hostedHubController.bootstrap();
    flush();

    expect(activateHostedNode).not.toHaveBeenCalled();
    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(getRoutedHostedNode().nodeId).toBeNull();
    expect(win.location.pathname).toBe("/");
    expect(getHostedNodeRouteNotice()).toMatch(/not in your authorized node directory/);

    // A stale notice does not survive into the next signed-in session.
    await hostedHubController.expireSession();
    await vi.waitFor(() => expect(getHostedNodeRouteNotice()).toBeNull());
  });

  it("fails closed when the routed node grant is revoked", async () => {
    const revoked = node("node_aaaaaaaaaaaaaaaaaaaaaa", { revokedAt: 2 });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([revoked]);
    const { win, flush } = setup(`/node/${revoked.id}`);

    await hostedHubController.bootstrap();
    flush();

    expect(activateHostedNode).not.toHaveBeenCalled();
    expect(win.location.pathname).toBe("/");
    expect(getHostedNodeRouteNotice()).toMatch(/was revoked/);
  });

  it("routes an authorized offline deep link through the bounded activation lifecycle", async () => {
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const { win, flush } = setup(`/node/${offline.id}`);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();

    expect(useHostedHubStore.getState().selectedNode?.id).toBe(offline.id);
    expect(useHostedHubStore.getState().selectionStatus).toBe("offline");
    expect(useHostedHubStore.getState().sessionEstablished).toBe(false);
    expect(win.location.pathname).toBe(`/node/${offline.id}`);
    expect(getHostedNodeRouteNotice()).toBeNull();

    establish(offline.environmentId);
    await settle();
    flush();

    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    expect(win.location.pathname).toBe(`/node/${offline.id}`);
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("returns a URL-restored offline node to the directory when sync expires", async () => {
    vi.useFakeTimers();
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const { win, flush } = setup(`/node/${offline.id}`);

    await hostedHubController.bootstrap();
    await settle();
    expect(activateHostedNode).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    flush();
    await settle();

    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(win.location.pathname).toBe("/");
    expect(getHostedNodeRouteNotice()).toMatch(/is offline/);
  });

  it("keeps an interactive offline selection on its existing failure surface", async () => {
    vi.useFakeTimers();
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const { win, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(offline.id)).toBe(true);
    await settle();
    expect(activateHostedNode).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    flush();

    const state = useHostedHubStore.getState();
    expect(state.selectedNode?.id).toBe(offline.id);
    expect(state.selectionStatus).toBe("offline");
    expect(state.transportStatus).toBe("terminal-failure");
    expect(state.errorMessage).toBe(HOSTED_SESSION_SYNC_FAILURE_MESSAGE);
    expect(win.location.pathname).toBe(`/node/${offline.id}`);
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("keeps a non-timeout offline URL failure on the detailed failure surface", async () => {
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const { win, flush } = setup(`/node/${offline.id}`);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    fail(offline.environmentId, { kind: "authentication", retryable: false });
    await settle();
    flush();

    const state = useHostedHubStore.getState();
    expect(state.selectedNode?.id).toBe(offline.id);
    expect(state.selectionStatus).toBe("offline");
    expect(state.transportStatus).toBe("terminal-failure");
    expect(state.errorMessage).toMatch(/authentication attempt/);
    expect(win.location.pathname).toBe(`/node/${offline.id}`);
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("leaves a pending offline URL restore on Back, and its late readiness selects nothing", async () => {
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const { win, history, flush } = setup("/");

    await hostedHubController.bootstrap();
    history.push(`/node/${offline.id}`);
    flush();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    const generation = useHostedHubStore.getState().generation;

    win.history.back();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    await settle();
    flush();

    expect(useHostedHubStore.getState().generation).toBeGreaterThan(generation);
    expect(win.location.pathname).toBe("/");

    // The environment's own session may still come up; it is not selected.
    establish(offline.environmentId);
    await settle();
    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(useHostedHubStore.getState().sessionEstablished).toBe(false);
  });

  it("normalizes malformed node routes fail-closed before authentication", async () => {
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );
    vi.spyOn(hostedHubApi, "getBootstrapAvailability").mockResolvedValue(false);
    const { win, flush } = setup("/node/a%20b/env_a/t_1");

    await hostedHubController.bootstrap();
    flush();

    expect(useHostedHubStore.getState().accountStatus).toBe("signed-out");
    expect(win.location.pathname).toBe("/");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: null,
      malformed: false,
      logicalPathname: "/",
    });
    expect(getHostedNodeRouteNotice()).toMatch(/link is not valid/);
    expect(activateHostedNode).not.toHaveBeenCalled();
  });

  it("fails closed to the directory when the directory is stale", async () => {
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockRejectedValue(
      new HostedHubApiError("unavailable", 503),
    );
    const { win, flush } = setup("/node/node_aaaaaaaaaaaaaaaaaaaaaa");

    await hostedHubController.bootstrap();
    flush();

    expect(useHostedHubStore.getState().directoryStatus).toBe("stale");
    expect(activateHostedNode).not.toHaveBeenCalled();
    expect(win.location.pathname).toBe("/");
    expect(getHostedNodeRouteNotice()).toMatch(/not in your authorized node directory/);
  });

  it("keeps a known cached thread readable when directory refresh is temporarily unavailable", async () => {
    const target = node();
    vi.spyOn(threadStore, "selectThreadExistsByRef").mockReturnValue(true);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      nodes: [target],
      directoryStatus: "stale",
    });
    const path = `/node/${target.id}/${target.environmentId}/saved-thread`;
    const { win, flush } = setup(path);
    await settle();
    flush();
    expect(win.location.pathname).toBe(path);
    expect(activateHostedNode).not.toHaveBeenCalled();
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("redirects legacy thread URLs to the node-scoped shape in place", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/${target.environmentId}/t_1?workspaceTab=diff`);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();

    expect(win.entries()).toHaveLength(1);
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);
    expect(win.location.search).toBe("?workspaceTab=diff");
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
  });

  it("redirects unrestorable legacy URLs to the directory", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup("/env_zzzzzzzzzzzzzzzzzzzzzz/t_1");

    await hostedHubController.bootstrap();
    flush();

    expect(activateHostedNode).not.toHaveBeenCalled();
    expect(win.location.pathname).toBe("/");
    expect(getHostedNodeRouteNotice()).toMatch(/not in your authorized node directory/);
  });

  it("redirects legacy draft URLs to the directory without a notice", async () => {
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([node()]);
    const { win, flush } = setup("/draft/draft-1");

    await hostedHubController.bootstrap();
    flush();

    expect(win.location.pathname).toBe("/");
    expect(getHostedNodeRouteNotice()).toBeNull();
    expect(activateHostedNode).not.toHaveBeenCalled();
  });

  it("keeps the routed segment through session expiry and resumes after re-authentication", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );
    vi.spyOn(hostedHubApi, "getBootstrapAvailability").mockResolvedValue(false);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/node/${target.id}/${target.environmentId}/t_1`);

    await hostedHubController.bootstrap();
    flush();
    expect(useHostedHubStore.getState().accountStatus).toBe("signed-out");
    expect(activateHostedNode).not.toHaveBeenCalled();
    // The routed node survives the authentication surface in the URL only.
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);

    const signIn = vi.spyOn(hostedHubApi, "signIn").mockResolvedValue(sessionResponse);
    await hostedHubController.signIn();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();

    expect(signIn.mock.invocationCallOrder[0]!).toBeLessThan(
      listNodes.mock.invocationCallOrder.at(-1)!,
    );
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);
  });

  it("leaves the selection on Back with the session kept warm, and adopts it on Forward", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    expect(win.location.pathname).toBe(`/node/${target.id}`);
    establish(target.environmentId);
    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    const generationBefore = useHostedHubStore.getState().generation;

    teardownOrder.length = 0;
    win.history.back();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    await settle();
    // Leaving the node moves the cursor only: no relay reset, disconnect or
    // clearing of the environment's state, just the shown environment.
    expect(teardownOrder).toEqual(["descriptor:null"]);
    expect(deactivateHostedNode).not.toHaveBeenCalled();
    expect(retainedPorts.releaseEnvironment).not.toHaveBeenCalled();
    flush();
    const afterBack = useHostedHubStore.getState();
    expect(afterBack.selectedNode).toBeNull();
    expect(afterBack.selectionStatus).toBe("none");
    expect(afterBack.transportStatus).toBe("idle");
    expect(afterBack.sessionStatus).toBe("closed");
    expect(afterBack.generation).toBeGreaterThan(generationBefore);
    expect(win.location.pathname).toBe("/");

    win.history.forward();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id));
    await settle();
    flush();
    // The continuously live session is adopted as it is: no new connection.
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    expect(win.location.pathname).toBe(`/node/${target.id}`);
  });

  it("returns a URL-restored terminal authorization failure to the directory", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/node/${target.id}`);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());

    fail(target.environmentId, { kind: "incompatible", retryable: false });
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    flush();

    const state = useHostedHubStore.getState();
    expect(state.selectedNode).toBeNull();
    // The directory renders its existing bounded incompatibility alert.
    expect(state.selectionStatus).toBe("incompatible");
    expect(getHostedNodeRouteNotice()).toBeNull();
    expect(win.location.pathname).toBe("/");
  });

  it("keeps interactive terminal failures on the existing failure surface", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());

    fail(target.environmentId, { kind: "incompatible", retryable: false });
    await settle();
    flush();

    const state = useHostedHubStore.getState();
    expect(state.selectedNode?.id).toBe(target.id);
    expect(state.transportStatus).toBe("terminal-failure");
    expect(state.selectionStatus).toBe("incompatible");
    expect(win.location.pathname).toBe(`/node/${target.id}`);
  });

  it("keeps the bounded synchronization-timeout surface for a restored node", async () => {
    vi.useFakeTimers();
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/node/${target.id}`);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    flush();

    const state = useHostedHubStore.getState();
    expect(state.selectedNode?.id).toBe(target.id);
    expect(state.transportStatus).toBe("terminal-failure");
    expect(state.errorMessage).toBe(HOSTED_SESSION_SYNC_FAILURE_MESSAGE);
    // Sync timeouts keep the retryable failure surface; no directory fallback.
    expect(win.location.pathname).toBe(`/node/${target.id}`);
  });

  it("clears the routed segment when a connected node loses authorization", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/node/${target.id}`);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    establish(target.environmentId);

    listNodes.mockResolvedValue([node(target.id, { revokedAt: 5 })]);
    await hostedHubController.refreshDirectory();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    flush();

    expect(useHostedHubStore.getState().selectionStatus).toBe("revoked");
    // The existing revocation alert explains the fallback; no duplicate notice.
    expect(getHostedNodeRouteNotice()).toBeNull();
    expect(win.location.pathname).toBe("/");
  });

  it("keeps the directory entry intact when history jumps back across a nested thread stack", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, history, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    // The router pushes a nested thread view inside the node scope.
    history.push(`/${target.environmentId}/t_1?workspaceTab=diff`);
    flush();
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);

    win.history.go(-2);
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    await settle();
    flush();
    await settle();

    // The stale pre-pop thread pathname must not be readopted: the directory
    // entry survives un-replaced and the node is neither selected nor
    // connected again.
    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(win.location.pathname).toBe("/");
    expect(win.entries()[0]).toMatchObject({ url: "/" });
  });

  it("leaves cleanly on a single Back when the thread entry was replace-created", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, history, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    // Thread navigation with replace: true (deleted-thread fallback path).
    history.replace(`/${target.environmentId}/t_1`);
    flush();
    expect(win.entries()).toHaveLength(2);
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);

    win.history.back();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    await settle();
    flush();
    await settle();

    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(win.location.pathname).toBe("/");
    expect(win.entries()[0]).toMatchObject({ url: "/" });
  });

  it("recovers selection after Back interrupts an in-flight browser resume", async () => {
    const target = node();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    establish(target.environmentId);

    // A browser resume that never completes parks browserStatus in a
    // node-scoped phase.
    restoreSession.mockImplementationOnce(() => new Promise<never>(() => undefined));
    let finishRecheck: (value: typeof sessionResponse) => void = () => undefined;
    restoreSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRecheck = resolve;
        }),
    );
    void hostedHubController.resumeBrowser();
    await vi.waitFor(() =>
      expect(useHostedHubStore.getState().browserStatus).toBe("checking-access"),
    );

    win.history.back();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    // Back does not stand in for the access check the abandoned resume never
    // finished: an account-scoped one re-runs before the directory is current.
    expect(useHostedHubStore.getState().browserStatus).toBe("checking-access");
    finishRecheck(sessionResponse);
    await vi.waitFor(() => expect(useHostedHubStore.getState().browserStatus).toBe("current"));

    // The abandoned resume no longer gates a subsequent selection.
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id));
  });

  it("drops a pending interactive selection when history returns to the directory", async () => {
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    let resolveNodes: (nodes: ReadonlyArray<HostedHubNode>) => void = () => undefined;
    vi.spyOn(hostedHubApi, "listNodes").mockImplementation(
      () =>
        new Promise<ReadonlyArray<HostedHubNode>>((resolve) => {
          resolveNodes = resolve;
        }),
    );
    const { win, flush } = setup("/");

    const bootstrap = hostedHubController.bootstrap();
    await vi.waitFor(() =>
      expect(useHostedHubStore.getState().accountStatus).toBe("authenticated"),
    );
    // Interactive selection while the directory is still loading, then Back
    // before it resolves: the interactive intent must not leak into the next
    // URL-driven restore of the same node.
    expect(selectHostedNodeRoute(offline.id)).toBe(true);
    flush();
    await settle();
    win.history.back();
    await settle();

    resolveNodes([offline]);
    await bootstrap;
    win.history.forward();
    await settle();
    flush();

    // The forward re-entry is now a URL restore, not leaked interactive
    // intent, but still enters the same bounded activation lifecycle.
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(offline.id);
    expect(useHostedHubStore.getState().selectionStatus).toBe("offline");
    expect(getHostedNodeRouteNotice()).toBeNull();
    expect(win.location.pathname).toBe(`/node/${offline.id}`);
  });

  it("keeps the terminal explanation when Back leaves a failed interactive node", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    fail(target.environmentId, { kind: "incompatible", retryable: false });
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);

    win.history.back();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    flush();

    // The directory still renders the bounded incompatibility explanation.
    expect(useHostedHubStore.getState().selectionStatus).toBe("incompatible");
    expect(win.location.pathname).toBe("/");
  });

  it("keeps session, ticket, and credential material out of URLs and history entries", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    win.history.back();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    win.history.forward();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id));
    flush();

    const serializedEntries = JSON.stringify(win.entries());
    for (const sensitive of [
      sessionResponse.csrfToken,
      sessionResponse.session.id,
      sessionResponse.account.id,
    ]) {
      expect(serializedEntries).not.toContain(sensitive);
      expect(win.location.href).not.toContain(sensitive);
    }
    for (const entry of win.entries()) {
      const keys = Object.keys((entry.state ?? {}) as Record<string, unknown>);
      expect(
        keys.every((key) => key === "__TSR_index" || key === "__TSR_key" || key === "key"),
      ).toBe(true);
    }
  });
});

describe("hosted node routes move only the cursor", () => {
  it("moves only the cursor on a route swap and holds the routed environment's demand", async () => {
    const first = node();
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([first, second]);
    // No demand driver: what selecting alone does.
    const { history, flush } = setup(`/node/${first.id}`, { demand: false });
    await hostedHubController.bootstrap();
    flush();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(first.id);
    expect(hostedWebConnectionScopes.list()).toEqual([
      expect.objectContaining({
        environmentId: first.environmentId,
        scope: { type: "interactive" },
      }),
    ]);
    const returnToDirectory = vi.spyOn(hostedHubController, "returnToDirectory");

    selectHostedNodeRoute(second.id);
    flush();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(second.id);
    expect(hostedWebConnectionScopes.list()).toEqual([
      expect.objectContaining({
        environmentId: second.environmentId,
        scope: { type: "interactive" },
      }),
    ]);

    // A thread on the routed node holds that thread's view instead.
    history.push(`/${second.environmentId}/t_2`);
    flush();
    await settle();
    expect(hostedWebConnectionScopes.list()).toEqual([
      expect.objectContaining({
        environmentId: second.environmentId,
        scope: { type: "thread-detail", threadId: "t_2" },
      }),
    ]);
    // Selecting connected nothing: the workspace coordinator does, through acquire.
    expect(retainedPorts.connectEnvironment).not.toHaveBeenCalled();
    expect(activateHostedNode).not.toHaveBeenCalled();
    expect(returnToDirectory).not.toHaveBeenCalled();

    expect(leaveHostedNodeRouteToDirectory()).toBe(true);
    flush();
    await settle();
    expect(returnToDirectory).toHaveBeenCalledOnce();
    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(retainedPorts.releaseEnvironment).not.toHaveBeenCalled();
  });
});
