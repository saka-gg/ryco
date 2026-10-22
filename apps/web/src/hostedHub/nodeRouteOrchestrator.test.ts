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
  setHostedNodeRouteEnvironmentResolver,
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
  // A thread link names its own environment's node, as the workspace
  // coordinator resolves it from the authorized directory in the app.
  setHostedNodeRouteEnvironmentResolver(
    (environmentId) =>
      useHostedHubStore.getState().nodes.find((entry) => entry.environmentId === environmentId)
        ?.id ?? null,
  );
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
    const path = `/node/${offline.id}/${offline.environmentId}/t_1`;
    const { win, flush } = setup(path);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();

    expect(useHostedHubStore.getState().selectedNode?.id).toBe(offline.id);
    expect(useHostedHubStore.getState().selectionStatus).toBe("offline");
    expect(useHostedHubStore.getState().sessionEstablished).toBe(false);
    expect(win.location.pathname).toBe(path);
    expect(getHostedNodeRouteNotice()).toBeNull();

    establish(offline.environmentId);
    await settle();
    flush();

    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    expect(win.location.pathname).toBe(path);
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("returns a URL-restored offline node to the directory when sync expires", async () => {
    vi.useFakeTimers();
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const { win, flush } = setup(`/node/${offline.id}/${offline.environmentId}/t_1`);

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

  it("keeps a node chosen from the directory selected on home when it fails offline", async () => {
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
    // Home names no node, and a failure there takes over nothing.
    expect(win.location.pathname).toBe("/");
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("keeps a non-timeout offline URL failure on the detailed failure surface", async () => {
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const path = `/node/${offline.id}/${offline.environmentId}/t_1`;
    const { win, flush } = setup(path);

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
    expect(win.location.pathname).toBe(path);
    expect(getHostedNodeRouteNotice()).toBeNull();
  });

  it("keeps the cursor on a pending offline restore left on Back, releasing only its demand", async () => {
    const offline = node("node_aaaaaaaaaaaaaaaaaaaaaa", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([offline]);
    const { win, history, flush } = setup("/");

    await hostedHubController.bootstrap();
    history.push(`/${offline.environmentId}/t_1`);
    flush();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    const returnToDirectory = vi.spyOn(hostedHubController, "returnToDirectory");

    win.history.back();
    await settle();
    flush();

    expect(win.location.pathname).toBe("/");
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(offline.id);
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(returnToDirectory).not.toHaveBeenCalled();
    expect(retainedPorts.releaseEnvironment).not.toHaveBeenCalled();

    // The environment's own session may still come up; the cursor shows it.
    establish(offline.environmentId);
    await settle();
    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    expect(activateHostedNode).toHaveBeenCalledOnce();
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

  it("keeps the cursor on Back from a thread with the session kept warm, and adopts it on Forward", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, history, flush } = setup("/");
    const threadPath = `/node/${target.id}/${target.environmentId}/t_1`;

    await hostedHubController.bootstrap();
    history.push(`/${target.environmentId}/t_1`);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    expect(win.location.pathname).toBe(threadPath);
    establish(target.environmentId);
    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    const generationBefore = useHostedHubStore.getState().generation;

    teardownOrder.length = 0;
    win.history.back();
    await settle();
    flush();
    // Home names no node: the cursor stays and nothing is torn down, released,
    // or cleared, not even the shown environment.
    expect(win.location.pathname).toBe("/");
    expect(teardownOrder).toEqual([]);
    expect(deactivateHostedNode).not.toHaveBeenCalled();
    expect(retainedPorts.releaseEnvironment).not.toHaveBeenCalled();
    expect(useHostedHubStore.getState()).toMatchObject({
      selectedNode: target,
      sessionEstablished: true,
      generation: generationBefore,
    });

    win.history.forward();
    await settle();
    flush();
    // The continuously live session is adopted as it is: no new connection.
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    expect(win.location.pathname).toBe(threadPath);
  });

  it("returns a URL-restored terminal authorization failure to the directory", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/node/${target.id}/${target.environmentId}/t_1`);

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

  it("clears a chosen node's terminal failure from home, keeping its explanation", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup("/");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());

    fail(target.environmentId, { kind: "incompatible", retryable: false });
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    flush();

    // The directory renders its existing bounded incompatibility alert.
    expect(useHostedHubStore.getState().selectionStatus).toBe("incompatible");
    expect(getHostedNodeRouteNotice()).toBeNull();
    expect(win.location.pathname).toBe("/");
  });

  it("keeps the bounded synchronization-timeout surface for a restored node", async () => {
    vi.useFakeTimers();
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const path = `/node/${target.id}/${target.environmentId}/t_1`;
    const { win, flush } = setup(path);

    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    flush();

    const state = useHostedHubStore.getState();
    expect(state.selectedNode?.id).toBe(target.id);
    expect(state.transportStatus).toBe("terminal-failure");
    expect(state.errorMessage).toBe(HOSTED_SESSION_SYNC_FAILURE_MESSAGE);
    // Sync timeouts keep the retryable failure surface; no directory fallback.
    expect(win.location.pathname).toBe(path);
  });

  it("clears the routed segment when a connected node loses authorization", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/node/${target.id}/${target.environmentId}/t_1`);

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

  it("keeps home un-replaced when history jumps back across a nested thread stack", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, history, flush } = setup("/");

    await hostedHubController.bootstrap();
    history.push(`/${target.environmentId}/t_1`);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    // The router pushes a nested thread view inside the node scope.
    history.push(`/${target.environmentId}/t_2?workspaceTab=diff`);
    flush();
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_2`);

    win.history.go(-2);
    await settle();
    flush();
    await settle();

    // The stale pre-pop thread pathname must not be readopted: the home entry
    // survives un-replaced, and the node is not connected again.
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(win.location.pathname).toBe("/");
    expect(win.entries()[0]).toMatchObject({ url: "/" });
  });

  it("leaves cleanly on a single Back when the thread entry was replace-created", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, history, flush } = setup("/");

    await hostedHubController.bootstrap();
    history.push("/settings");
    flush();
    // Thread navigation with replace: true (deleted-thread fallback path).
    history.replace(`/${target.environmentId}/t_1`);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    expect(win.entries()).toHaveLength(2);
    expect(win.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);

    win.history.back();
    await settle();
    flush();
    await settle();

    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(win.location.pathname).toBe("/");
    expect(win.entries()[0]).toMatchObject({ url: "/" });
  });

  it("leaves an in-flight browser resume alone when Back leaves a thread", async () => {
    const target = node();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, history, flush } = setup("/");

    await hostedHubController.bootstrap();
    history.push(`/${target.environmentId}/t_1`);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    establish(target.environmentId);

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

    // Home names no node: Back neither leaves the selection nor stands in for
    // the access check the resume is running.
    win.history.back();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
    expect(useHostedHubStore.getState().browserStatus).toBe("checking-access");
    finishRecheck(sessionResponse);
    await vi.waitFor(() =>
      expect(useHostedHubStore.getState().browserStatus).not.toBe("checking-access"),
    );
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
  });

  it("selects nothing for a node chosen before the directory is current", async () => {
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
    // The choice lands while the directory is still loading: the lifecycle
    // owner selects nothing, so nothing is demanded either.
    expect(selectHostedNodeRoute(offline.id)).toBe(true);
    flush();
    await settle();
    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(win.entries()).toHaveLength(1);

    resolveNodes([offline]);
    await bootstrap;
    expect(selectHostedNodeRoute(offline.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(offline.id);
    expect(useHostedHubStore.getState().selectionStatus).toBe("offline");
    expect(getHostedNodeRouteNotice()).toBeNull();
    expect(win.location.pathname).toBe("/");
  });

  it("keeps session, ticket, and credential material out of URLs and history entries", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, history, flush } = setup("/nodes");

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(target.id)).toBe(true);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    flush();
    history.push(`/${target.environmentId}/t_1`);
    history.push("/settings");
    flush();
    win.history.back();
    win.history.forward();
    await settle();
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
  it("keeps the cursor on home and settings with no demand, acquire, or release", async () => {
    const first = node();
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([first, second]);
    // No demand driver: what the routes alone do.
    const { win, history, flush } = setup(`/node/${first.id}/${first.environmentId}/t_1`, {
      demand: false,
    });
    await hostedHubController.bootstrap();
    flush();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(first.id);
    expect(hostedWebConnectionScopes.list()).toEqual([
      expect.objectContaining({
        environmentId: first.environmentId,
        scope: { type: "thread-detail", threadId: "t_1" },
      }),
    ]);
    const acquireEnvironment = vi.spyOn(hostedHubController, "acquireEnvironment");
    const releaseEnvironment = vi.spyOn(hostedHubController, "releaseEnvironment");
    const returnToDirectory = vi.spyOn(hostedHubController, "returnToDirectory");
    const selectNode = vi.spyOn(hostedHubController, "selectNode");

    for (const pathname of ["/", "/settings", "/tasks"]) {
      history.push(pathname);
      flush();
      await settle();
      // The address names no node, the cursor stays on the last thread's
      // node, and the page holds no demand.
      expect(win.location.pathname, pathname).toBe(pathname);
      expect(useHostedHubStore.getState().selectedNode?.id, pathname).toBe(first.id);
      expect(hostedWebConnectionScopes.list(), pathname).toEqual([]);
    }
    expect(selectNode).not.toHaveBeenCalled();

    // A thread on another node moves the cursor and holds that thread's view.
    history.push(`/${second.environmentId}/t_2`);
    flush();
    await settle();
    expect(win.location.pathname).toBe(`/node/${second.id}/${second.environmentId}/t_2`);
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(second.id);
    expect(hostedWebConnectionScopes.list()).toEqual([
      expect.objectContaining({
        environmentId: second.environmentId,
        scope: { type: "thread-detail", threadId: "t_2" },
      }),
    ]);

    // "All nodes" is a page no node owns as well.
    expect(leaveHostedNodeRouteToDirectory()).toBe(true);
    flush();
    await settle();
    expect(win.location.pathname).toBe("/nodes");
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(second.id);
    expect(hostedWebConnectionScopes.list()).toEqual([]);

    // Selecting connected nothing: the workspace coordinator does, through acquire.
    expect(acquireEnvironment).not.toHaveBeenCalled();
    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(returnToDirectory).not.toHaveBeenCalled();
    expect(retainedPorts.connectEnvironment).not.toHaveBeenCalled();
    expect(activateHostedNode).not.toHaveBeenCalled();
  });

  it("opens an older node address of a page no node owns on that page, with the cursor on its node", async () => {
    const first = node();
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([first, second]);
    const { win, flush } = setup(`/node/${second.id}/settings?section=general`, {
      demand: false,
    });

    await hostedHubController.bootstrap();
    flush();
    await settle();

    expect(useHostedHubStore.getState().selectedNode?.id).toBe(second.id);
    expect(win.entries()).toHaveLength(1);
    expect(win.location.pathname).toBe("/settings");
    expect(win.location.search).toBe("?section=general");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: null,
      malformed: false,
      logicalPathname: "/settings",
    });
    expect(getHostedNodeRouteNotice()).toBeNull();
    // No route-scoped demand: the bookmark moves the cursor and connects nothing.
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(retainedPorts.connectEnvironment).not.toHaveBeenCalled();
  });

  it("opens an older node home address on node-less home", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { win, flush } = setup(`/node/${target.id}`, { demand: false });

    await hostedHubController.bootstrap();
    flush();
    await settle();

    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
    expect(win.location.pathname).toBe("/");
    expect(hostedWebConnectionScopes.list()).toEqual([]);
  });

  it("opens home with the cursor on a node chosen from the directory, demanding it briefly", async () => {
    vi.useFakeTimers();
    const first = node();
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([first, second]);
    const { win, flush } = setup("/nodes", { demand: false });
    await hostedHubController.bootstrap();
    flush();
    await settle();

    expect(selectHostedNodeRoute(second.id)).toBe(true);
    flush();
    await settle();
    expect(win.location.pathname).toBe("/");
    expect(win.entries()).toHaveLength(2);
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(second.id);
    expect(hostedWebConnectionScopes.list()).toEqual([
      expect.objectContaining({
        environmentId: second.environmentId,
        scope: { type: "interactive" },
      }),
    ]);

    // A few seconds, as a press on a thread row holds its node; the cursor stays.
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(second.id);
  });

  it("clears the cursor on home when its node is revoked or the session ends", async () => {
    const target = node();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target]);
    const { history, flush } = setup(`/node/${target.id}/${target.environmentId}/t_1`);
    await hostedHubController.bootstrap();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    establish(target.environmentId);
    history.push("/");
    flush();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);

    listNodes.mockResolvedValue([node(target.id, { revokedAt: 5 })]);
    await hostedHubController.refreshDirectory();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
    expect(useHostedHubStore.getState().selectionStatus).toBe("revoked");

    listNodes.mockResolvedValue([target]);
    await hostedHubController.refreshDirectory();
    history.push(`/${target.environmentId}/t_1`);
    flush();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id));
    history.push("/");
    flush();
    await settle();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);

    await hostedHubController.expireSession();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode).toBeNull());
  });
});
