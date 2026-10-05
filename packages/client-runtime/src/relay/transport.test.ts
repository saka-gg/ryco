import {
  AGENT_CONTROL_WS_METHODS,
  DEVICE_WS_METHODS,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@ryco/contracts";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import { HostedHubApi, HostedHubApiError } from "../authorization/api";
import {
  configureHostedRuntime,
  type HostedNodeLifecycle,
  type HostedRuntimeConfiguration,
} from "../authorization/runtime";
import { hostedHubController, hostedHubStore } from "../authorization/state";
import type { HostedHubNode, HostedRelayFailure } from "../authorization/types";
import { RpcRequestRefusedError } from "../rpc/protocol";
import type { WsRpcClient } from "../rpc/wsRpcClient";
import { encodeBase64Url } from "./base64url";
import {
  bindHostedDispatchReplay,
  getHostedDispatchReplay,
  hostedDispatchLineage,
  HostedDispatchUnconfirmedError,
} from "./dispatchReplay";
import {
  admitHostedRequestForState,
  HostedRelayAttemptFactory,
  HostedRelayPreparationError,
  ticketFailure,
  type HostedRelayAttemptBinding,
} from "./transport";

const RELAY_URL = "wss://hub.example.test/v1/relay/client";

/** Callbacks the attempt factory hands to `createRelaySocket`. */
interface RelaySocketCallbacks {
  onTransportStatus(status: string): void;
  onSessionStatus(status: string): void;
  onRole(role: string | null): void;
  onFailure(failure: HostedRelayFailure): void;
}

/**
 * Fake relay socket. The real socket (the package relay engine) publishes
 * "connecting" as soon as it is constructed and surfaces a lost connection via
 * `onFailure`; the fake reproduces exactly those two callback edges so the
 * attempt factory's state wiring can be exercised without a browser WebSocket.
 */
class MockRelaySocket {
  constructor(readonly callbacks: RelaySocketCallbacks) {
    callbacks.onTransportStatus("connecting");
  }
  fail(): void {
    this.callbacks.onFailure({ kind: "network", retryable: true });
  }
}

const sockets: MockRelaySocket[] = [];

/** What a relay drop surfaces for an in-flight request. */
const relayDrop = () =>
  new RpcClientError({ reason: new Socket.SocketReadError({ cause: new Event("error") }) });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rawClient(): WsRpcClient {
  return {
    dispose: async () => undefined,
    orchestration: { dispatchCommand: async () => ({ sequence: 1 }) },
  } as unknown as WsRpcClient;
}

/** A configurable Hub API instance the factory reads via the runtime. */
const hostedHubApi = {
  issueRelayTicket: vi.fn(),
  clearSessionMaterial: vi.fn(),
} as unknown as HostedHubApi;

const nodeLifecycle: HostedNodeLifecycle = {
  activate: vi.fn(async () => undefined),
  suspend: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  clearNodeScopedState: vi.fn(),
  writePrimaryEnvironmentDescriptor: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(async () => undefined),
  setActiveEnvironmentId: vi.fn(),
};

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the relay attempt factory tests");
    },
  },
);

function fakeRuntime(): HostedRuntimeConfiguration {
  return {
    endpoint: unusedService as EndpointService,
    httpClient: unusedService as HttpClientService,
    passkeyCeremony: unusedService as PasskeyCeremonyService,
    sessionCredentials: unusedService as SessionCredentialsService,
    nodeLifecycle,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
      queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    },
    isForeground: () => true,
    subscribeForeground: () => () => undefined,
    hasPendingRelayRequests: () => false,
    resetRelayAttemptFactory: vi.fn(),
    relayUrl: () => RELAY_URL,
    createRelaySocket: (input) => {
      const socket = new MockRelaySocket(input.callbacks as RelaySocketCallbacks);
      sockets.push(socket);
      return socket;
    },
  };
}

const selectedNode: HostedHubNode = {
  id: "node_aaaaaaaaaaaaaaaaaaaaaa",
  environmentId: EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa"),
  label: "Node",
  platformOs: "linux",
  platformArch: "x64",
  clientVersion: "0.9.0",
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
  grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "operator" },
  effectiveRole: "operator",
  presence: { online: true, lastHeartbeatAt: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  sockets.length = 0;
  configureHostedRuntime(fakeRuntime(), hostedHubApi);
  hostedHubStore.setState({
    accountStatus: "authenticated",
    selectedNode,
    generation: 4,
    directoryStatus: "ready",
    effectiveRole: selectedNode.effectiveRole,
    transportStatus: "idle",
  });
});

afterEach(() => {
  hostedHubController.resetForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HostedRelayAttemptFactory", () => {
  it("exposes authoritative admission changes and releases their listener", () => {
    const factory = new HostedRelayAttemptFactory();
    const changed = vi.fn();
    const unsubscribe = factory.lifecycleHandlers().subscribeAdmissionChanges!(changed);
    hostedHubStore.setState({ sessionStatus: "ready" });
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    hostedHubStore.setState({ sessionStatus: "stale" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("publishes a bounded native grant failure before reconnect policy runs", async () => {
    const failure = vi.fn();
    const binding: HostedRelayAttemptBinding = {
      nodeId: () => selectedNode.id,
      generation: () => 4,
      isAuthenticated: () => true,
      isCurrent: () => true,
      issueRelayAttempt: async () => {
        throw new HostedRelayPreparationError({
          kind: "protocol",
          retryable: false,
          closeReason: "channel_rejected",
        });
      },
      authorizeRequest: () => "forbidden",
      shouldReconnect: () => false,
      transportStatus: () => undefined,
      sessionStatus: () => undefined,
      role: () => undefined,
      failure,
      markDeliveryUnknown: () => undefined,
      connectionClosed: () => undefined,
    };

    await expect(new HostedRelayAttemptFactory(binding).nextUrl()).rejects.toThrow(
      "Hosted relay preparation failed.",
    );
    expect(failure).toHaveBeenCalledWith(4, {
      kind: "protocol",
      retryable: false,
      closeReason: "channel_rejected",
    });
  });

  it("holds native grant context for one socket and disposes abandoned attempts", async () => {
    let current = true;
    let sequence = 0;
    const disposed: unknown[] = [];
    const created: unknown[] = [];
    const binding: HostedRelayAttemptBinding = {
      nodeId: () => selectedNode.id,
      generation: () => 4,
      isAuthenticated: () => true,
      isCurrent: () => current,
      prepareSocketContext: async () => ({ publicMaterial: ++sequence }),
      issueRelayAttempt: async ({ preparedSocketContext }) => ({
        ticket: encodeBase64Url(new Uint8Array(32).fill(sequence)),
        expiresAt: Date.now() + 60_000,
        preparedSocketContext: {
          preparedSocketContext,
          transientGrant: `grant-canary-${sequence}`,
        },
      }),
      disposeSocketContext: (context) => disposed.push(context),
      relayUrl: () => RELAY_URL,
      createRelaySocket: (input) => {
        created.push(input.preparedSocketContext);
        return new MockRelaySocket(input.callbacks as RelaySocketCallbacks);
      },
      authorizeRequest: () => "allowed",
      shouldReconnect: () => true,
      transportStatus: () => undefined,
      sessionStatus: () => undefined,
      role: () => undefined,
      failure: () => undefined,
      markDeliveryUnknown: () => undefined,
      connectionClosed: () => undefined,
    };
    const factory = new HostedRelayAttemptFactory(binding);

    await factory.nextUrl();
    await factory.nextUrl();
    expect(disposed).toEqual([
      {
        preparedSocketContext: { publicMaterial: 1 },
        transientGrant: "grant-canary-1",
      },
    ]);
    factory.createSocket(RELAY_URL);
    expect(created).toEqual([
      {
        preparedSocketContext: { publicMaterial: 2 },
        transientGrant: "grant-canary-2",
      },
    ]);
    expect(disposed).toHaveLength(1);

    current = false;
    await expect(factory.nextUrl()).rejects.toThrow("Hosted node selection changed.");
    expect(disposed).toHaveLength(2);
    expect(disposed[1]).toEqual({ publicMaterial: 3 });
  });

  it.each([
    ["node_offline", "offline", true],
    ["server_draining", "draining", true],
    ["rate_limited", "rate-limited", true],
    ["unsupported_version", "incompatible", false],
    ["forbidden", "authorization-removed", false],
    ["revoked", "revoked", false],
  ] as const)("classifies ticket HTTP failure %s", (code, kind, retryable) => {
    expect(ticketFailure(new HostedHubApiError(code, 400, 1_500))).toMatchObject({
      kind,
      retryable,
      ...(retryable ? { retryAfterMs: 1_500 } : {}),
    });
  });

  it("treats an unclassified ticket transport failure as retryable network loss", () => {
    expect(ticketFailure(new HostedHubApiError("unavailable", 0))).toEqual({
      kind: "network",
      retryable: true,
    });
  });

  it("authorizes only bootstrap subscriptions while the hosted session opens", () => {
    const lifecycle = new HostedRelayAttemptFactory().lifecycleHandlers();

    expect(
      lifecycle.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.subscribeShell,
        stream: true,
      }),
    ).toBe("allowed");
    expect(
      lifecycle.authorizeRequest?.({
        tag: WS_METHODS.subscribeTerminalEvents,
        stream: true,
      }),
    ).toBe("allowed");
    expect(
      lifecycle.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).not.toBe("allowed");
    expect(
      lifecycle.authorizeRequest?.({
        tag: WS_METHODS.gitRunStackedAction,
        stream: true,
      }),
    ).not.toBe("allowed");

    hostedHubStore.setState({ directoryStatus: "stale" });
    expect(
      lifecycle.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.subscribeShell,
        stream: true,
      }),
    ).not.toBe("allowed");
  });

  it("tells a request that waits for the session from one that is refused for good", () => {
    const proposals = { tag: AGENT_CONTROL_WS_METHODS.subscribeProposals, stream: true } as const;
    const ready = {
      effectiveRole: "owner",
      directoryStatus: "ready",
      transportStatus: "online",
      browserStatus: "current",
      sessionStatus: "ready",
      sessionRecoveredAfterUnknown: false,
    } as const;
    expect(admitHostedRequestForState(ready, proposals)).toBe("allowed");

    // A rebuilt client whose replacement session is still synchronizing: the
    // Agent Control queue must wait, not end.
    for (const recovering of [
      { ...ready, sessionStatus: "synchronizing" },
      { ...ready, sessionStatus: "stale", transportStatus: "reconnecting" },
      { ...ready, sessionStatus: "delivery-unknown" },
      { ...ready, browserStatus: "synchronizing" },
      { ...ready, directoryStatus: "loading", effectiveRole: null },
    ] as const) {
      expect(admitHostedRequestForState(recovering, proposals)).toBe("awaiting-session");
    }

    // A known role below the method's tier, a method no hosted role may call,
    // or a terminally failed transport.
    expect(
      admitHostedRequestForState(
        { ...ready, effectiveRole: "viewer" },
        { tag: WS_METHODS.terminalWrite, stream: false },
      ),
    ).toBe("forbidden");
    expect(
      admitHostedRequestForState(ready, { tag: WS_METHODS.subscribeAuthAccess, stream: true }),
    ).toBe("forbidden");
    expect(
      admitHostedRequestForState(
        { ...ready, transportStatus: "terminal-failure", sessionStatus: "stale" },
        proposals,
      ),
    ).toBe("forbidden");
  });

  it("retains only session-sync authority across a retryable socket close", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(5)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    const subscribeShell = {
      tag: ORCHESTRATION_WS_METHODS.subscribeShell,
      stream: true,
    } as const;
    const dispatch = {
      tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
      stream: false,
    } as const;
    factory.createSocket(await factory.nextUrl());
    hostedHubStore.setState({
      transportStatus: "online",
      sessionStatus: "ready",
      browserStatus: "current",
    });

    lifecycle.onClose?.({ code: 4000, reason: "network" }, { intentional: false });

    expect(hostedHubStore.getState()).toMatchObject({
      effectiveRole: "operator",
      transportStatus: "reconnecting",
      sessionStatus: "stale",
    });
    expect(lifecycle.authorizeRequest?.(subscribeShell)).toBe("allowed");
    expect(lifecycle.authorizeRequest?.(dispatch)).not.toBe("allowed");
  });

  it("re-enters the selected-node lifecycle only after the relay channel recovers", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(10)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const retrySelectedNode = vi
      .spyOn(hostedHubController, "retrySelectedNode")
      .mockResolvedValue(undefined);
    hostedHubStore.setState({
      nodes: [selectedNode],
      browserStatus: "current",
      sessionStatus: "ready",
      transportStatus: "online",
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    factory.createSocket(await factory.nextUrl());

    lifecycle.onClose?.({ code: 4000, reason: "network" }, { intentional: false });
    expect(retrySelectedNode).not.toHaveBeenCalled();

    factory.createSocket(await factory.nextUrl());
    sockets.at(-1)?.callbacks.onTransportStatus("online");
    await vi.waitFor(() => expect(retrySelectedNode).toHaveBeenCalledOnce());
  });

  it("does not rebuild the rpc client for the initial relay connection", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(11)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const retrySelectedNode = vi
      .spyOn(hostedHubController, "retrySelectedNode")
      .mockResolvedValue(undefined);
    const factory = new HostedRelayAttemptFactory();

    factory.createSocket(await factory.nextUrl());
    sockets.at(-1)?.callbacks.onTransportStatus("online");

    expect(retrySelectedNode).not.toHaveBeenCalled();
  });

  it("denies RPCs at the transport boundary until browser recovery is complete", () => {
    const lifecycle = new HostedRelayAttemptFactory().lifecycleHandlers();
    const dispatch = {
      tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
      stream: false,
    } as const;
    const subscribeShell = {
      tag: ORCHESTRATION_WS_METHODS.subscribeShell,
      stream: true,
    } as const;
    hostedHubStore.setState({
      transportStatus: "online",
      sessionStatus: "ready",
      browserStatus: "current",
    });

    expect(lifecycle.authorizeRequest?.(dispatch)).toBe("allowed");
    hostedHubController.suspendBrowser("hidden");
    expect(hostedHubStore.getState()).toMatchObject({
      directoryStatus: "ready",
      effectiveRole: "operator",
      browserStatus: "suspended",
      sessionStatus: "stale",
    });
    expect(lifecycle.authorizeRequest?.(dispatch)).not.toBe("allowed");
    expect(lifecycle.authorizeRequest?.(subscribeShell)).not.toBe("allowed");

    hostedHubStore.setState({
      browserStatus: "synchronizing",
      sessionStatus: "stale",
    });
    expect(lifecycle.authorizeRequest?.(dispatch)).not.toBe("allowed");
    expect(lifecycle.authorizeRequest?.(subscribeShell)).toBe("allowed");

    hostedHubStore.setState({ browserStatus: "current", sessionStatus: "ready" });
    expect(lifecycle.authorizeRequest?.(dispatch)).toBe("allowed");
  });

  it("requests and consumes one memory-only ticket per connection attempt", async () => {
    const ticket = encodeBase64Url(new Uint8Array(32).fill(9));
    const issue = vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket,
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const firstUrl = await factory.nextUrl();
    expect(firstUrl).toBe(RELAY_URL);
    factory.createSocket(firstUrl);
    expect(() => factory.createSocket(firstUrl)).toThrow("fresh relay ticket");

    const secondUrl = await factory.nextUrl();
    factory.createSocket(secondUrl);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain(ticket);
  });

  it("retries transient ticket preflight with fresh attempt material", async () => {
    const ticket = encodeBase64Url(new Uint8Array(32).fill(7));
    const issue = vi
      .spyOn(hostedHubApi, "issueRelayTicket")
      .mockRejectedValueOnce(new HostedHubApiError("server_draining", 503, 0))
      .mockResolvedValue({
        ticket,
        expiresAt: Date.now() + 60_000,
        protocolMajor: 1,
        protocolMinor: 2,
      });
    const factory = new HostedRelayAttemptFactory();

    await expect(factory.nextUrl()).rejects.toBeInstanceOf(HostedHubApiError);
    expect(hostedHubStore.getState().transportStatus).toBe("reconnecting");

    const url = await factory.nextUrl();
    factory.createSocket(url);

    expect(issue).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    expect(hostedHubStore.getState().transportStatus).toBe("connecting");
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain(ticket);
  });

  it("stops automatic relay reconnects while the browser is suspended", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(8)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    await factory.nextUrl();

    expect(lifecycle.shouldReconnect?.()).toBe(true);
    hostedHubController.suspendBrowser("hidden");
    expect(lifecycle.shouldReconnect?.()).toBe(false);

    hostedHubStore.setState({ browserStatus: "checking-access" });
    expect(lifecycle.shouldReconnect?.()).toBe(false);
    hostedHubStore.setState({ browserStatus: "synchronizing" });
    expect(lifecycle.shouldReconnect?.()).toBe(false);

    await factory.nextUrl();
    expect(lifecycle.shouldReconnect?.()).toBe(true);
  });

  it("stops terminal ticket preflight without opening a socket", async () => {
    const issue = vi
      .spyOn(hostedHubApi, "issueRelayTicket")
      .mockRejectedValue(new HostedHubApiError("forbidden", 403));
    const factory = new HostedRelayAttemptFactory();

    await expect(factory.nextUrl()).rejects.toBeInstanceOf(HostedHubApiError);

    expect(issue).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState().transportStatus).toBe("terminal-failure");
    expect(sockets).toHaveLength(0);
  });

  it("rejects expired tickets before opening a relay socket", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(2)),
      expiresAt: Date.now() - 1,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const url = await factory.nextUrl();
    expect(() => factory.createSocket(url)).toThrow("fresh relay ticket");
    expect(sockets).toHaveLength(0);
  });

  it("marks an unacknowledged mutation delivery unknown without replaying it", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(3)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    const url = await factory.nextUrl();
    factory.createSocket(url);
    lifecycle.onRequestStart?.({
      id: "mutation-1",
      tag: WS_METHODS.terminalWrite,
      stream: false,
    });
    expect(factory.hasPendingRequests()).toBe(true);
    lifecycle.onRequestStart?.({ id: "read-1", tag: WS_METHODS.projectsList, stream: false });
    lifecycle.onRequestExit?.({ id: "read-1", tag: WS_METHODS.projectsList, stream: false });
    sockets[0]!.fail();
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "reconnecting",
      sessionStatus: "delivery-unknown",
    });
    expect(factory.hasPendingRequests()).toBe(false);
  });

  it("never makes delivery uncertain for an in-flight read", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(12)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    hostedHubStore.setState({ sessionStatus: "ready" });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    factory.createSocket(await factory.nextUrl());

    // Operator-tier unary reads, which never answered before the drop.
    lifecycle.onRequestStart?.({ id: "file-1", tag: WS_METHODS.projectsReadFile, stream: false });
    lifecycle.onRequestStart?.({
      id: "diff-1",
      tag: WS_METHODS.vcsReadLocalChanges,
      stream: false,
    });
    lifecycle.onRequestStart?.({
      id: "window-1",
      tag: ORCHESTRATION_WS_METHODS.getThreadWindow,
      stream: false,
    });
    // Long-lived read streams that only end with the channel.
    lifecycle.onRequestStart?.({
      id: "proposals-1",
      tag: AGENT_CONTROL_WS_METHODS.subscribeProposals,
      stream: true,
    });
    lifecycle.onRequestStart?.({
      id: "device-1",
      tag: DEVICE_WS_METHODS.subscribeEvents,
      stream: true,
    });
    lifecycle.onRequestChunk?.({
      id: "proposals-1",
      tag: AGENT_CONTROL_WS_METHODS.subscribeProposals,
      chunkCount: 1,
    });
    expect(factory.hasPendingRequests()).toBe(false);

    sockets[0]!.fail();
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "reconnecting",
      sessionStatus: "stale",
    });
  });

  it("tracks a receipted command until its client has claimed it for replay", () => {
    const dispatch = {
      id: "dispatch-1",
      tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
      stream: false,
    } as const;
    const unclaimed = new HostedRelayAttemptFactory();
    unclaimed.lifecycleHandlers().onRequestStart?.(dispatch);
    expect(unclaimed.hasPendingRequests()).toBe(true);

    // A binding that could not attach (no authenticated account) claims nothing.
    const detached = bindHostedDispatchReplay({
      environmentId: selectedNode.environmentId,
      lineage: null,
      markUncertain: () => undefined,
    });
    const unattached = new HostedRelayAttemptFactory();
    detached.wrap(rawClient());
    unattached.lifecycleHandlers(detached).onRequestStart?.(dispatch);
    expect(unattached.hasPendingRequests()).toBe(true);

    const binding = bindHostedDispatchReplay({
      environmentId: selectedNode.environmentId,
      lineage: "account-1",
      markUncertain: () => undefined,
    });
    const claimed = new HostedRelayAttemptFactory();
    const lifecycle = claimed.lifecycleHandlers(binding);
    binding.wrap(rawClient());
    lifecycle.onRequestStart?.(dispatch);
    expect(claimed.hasPendingRequests()).toBe(false);
    // A mutation without a receipt stays tracked regardless.
    lifecycle.onRequestStart?.({ id: "write-1", tag: WS_METHODS.terminalWrite, stream: false });
    expect(claimed.hasPendingRequests()).toBe(true);
  });

  it("tells the owner of a connection's commands when that connection closes unexpectedly", () => {
    const owner = { ownsReceiptedRequests: () => true, connectionLost: vi.fn() };
    const lifecycle = new HostedRelayAttemptFactory().lifecycleHandlers(owner);

    // Its own disposal is reported by the client it wraps instead.
    lifecycle.onClose?.({ code: 1000, reason: "" }, { intentional: true });
    expect(owner.connectionLost).not.toHaveBeenCalled();
    lifecycle.onClose?.({ code: 1006, reason: "network" }, { intentional: false });
    expect(owner.connectionLost).toHaveBeenCalledOnce();
  });

  it("replays a held orchestration command only once the hosted session can accept it", async () => {
    hostedHubStore.setState({
      account: { id: "account-1", displayName: "A", role: "owner", createdAt: 1, disabledAt: null },
      browserStatus: "current",
      transportStatus: "online",
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });
    const lineage = hostedDispatchLineage(hostedHubStore.getState())!;
    const markUncertain = vi.fn();
    const { dispatch } = getHostedDispatchReplay().attach({
      environmentId: selectedNode.environmentId,
      lineage,
      dispatch: () => Promise.reject(relayDrop()),
      markUncertain,
    });
    const replacement = vi.fn(async () => ({ sequence: 5 }));
    const command = {
      type: "thread.meta.update",
      commandId: "cmd-held",
      threadId: "thread-held",
      title: "Renamed",
    } as unknown as Parameters<typeof dispatch>[0];
    const result = dispatch(command);
    await flush();
    getHostedDispatchReplay().attach({
      environmentId: selectedNode.environmentId,
      lineage,
      dispatch: replacement,
      markUncertain,
    });

    // Snapshot accepted, but another action's delivery is still unconfirmed:
    // mutations — the replay included — wait for the acknowledgement.
    hostedHubController.markSessionReady(selectedNode.environmentId);
    await flush();
    expect(replacement).not.toHaveBeenCalled();

    hostedHubController.acknowledgeDeliveryUnknown();
    await expect(result).resolves.toEqual({ sequence: 5 });
    expect(replacement).toHaveBeenCalledWith(command);
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("fails a held orchestration command closed when the hosted node is left", async () => {
    hostedHubStore.setState({
      account: { id: "account-1", displayName: "A", role: "owner", createdAt: 1, disabledAt: null },
    });
    const lineage = hostedDispatchLineage(hostedHubStore.getState())!;
    const markUncertain = vi.fn();
    const held = getHostedDispatchReplay().attach({
      environmentId: selectedNode.environmentId,
      lineage,
      dispatch: () => Promise.reject(relayDrop()),
      markUncertain,
    });
    const heldResult = held.dispatch({} as Parameters<typeof held.dispatch>[0]);
    await flush();
    // A slow bootstrap turn start still in flight when the user leaves.
    let cutOff!: (error: unknown) => void;
    const inFlight = getHostedDispatchReplay().attach({
      environmentId: selectedNode.environmentId,
      lineage,
      dispatch: () => new Promise((_, reject) => (cutOff = reject)),
      markUncertain,
    });
    const inFlightOutcome = inFlight
      .dispatch({} as Parameters<typeof inFlight.dispatch>[0])
      .catch((error: unknown) => error);
    // Leaving disposes the node's client, which interrupts what it has in flight.
    vi.mocked(nodeLifecycle.disconnectPrimaryEnvironment).mockImplementationOnce(async () => {
      inFlight.detach();
      cutOff(new Error("All fibers interrupted without error"));
    });

    await hostedHubController.returnToDirectory();
    await expect(heldResult).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);

    // Selecting the node again within the horizon replays nothing into it.
    const returned = vi.fn(async () => ({ sequence: 1 }));
    getHostedDispatchReplay().attach({
      environmentId: selectedNode.environmentId,
      lineage,
      dispatch: returned,
      markUncertain,
    });
    getHostedDispatchReplay().markReady(selectedNode.environmentId);
    await flush();
    expect(returned).not.toHaveBeenCalled();
    expect(await inFlightOutcome).toBeInstanceOf(HostedDispatchUnconfirmedError);
    // Nothing is left to hold: the node is no longer selected.
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("holds a current session for acknowledgement when a replay cannot confirm its command", () => {
    hostedHubStore.setState({ sessionStatus: "ready", sessionRecoveredAfterUnknown: false });
    hostedHubController.markEnvironmentDeliveryUnknown(EnvironmentId.make("env_other"));
    expect(hostedHubStore.getState().sessionStatus).toBe("ready");

    hostedHubController.markEnvironmentDeliveryUnknown(selectedNode.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });

    // A session still recovering waits for its snapshot before it can be acknowledged.
    hostedHubStore.setState({
      sessionStatus: "synchronizing",
      sessionRecoveredAfterUnknown: false,
    });
    hostedHubController.markEnvironmentDeliveryUnknown(selectedNode.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });
    hostedHubController.markSessionReady(selectedNode.environmentId);
    expect(hostedHubStore.getState().sessionRecoveredAfterUnknown).toBe(true);
  });

  it("admits reads but not mutations once a session recovers with delivery unknown", () => {
    const lifecycle = new HostedRelayAttemptFactory().lifecycleHandlers();
    const readFile = { tag: WS_METHODS.projectsReadFile, stream: false } as const;
    const proposals = { tag: AGENT_CONTROL_WS_METHODS.subscribeProposals, stream: true } as const;
    const terminalWrite = { tag: WS_METHODS.terminalWrite, stream: false } as const;
    const dispatch = { tag: ORCHESTRATION_WS_METHODS.dispatchCommand, stream: false } as const;
    hostedHubStore.setState({
      effectiveRole: "owner",
      transportStatus: "online",
      browserStatus: "current",
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });

    // Before the replacement session accepts a snapshot nothing new is admitted.
    expect(lifecycle.authorizeRequest?.(readFile)).not.toBe("allowed");
    expect(lifecycle.authorizeRequest?.(proposals)).not.toBe("allowed");

    hostedHubStore.setState({ sessionRecoveredAfterUnknown: true });
    expect(lifecycle.authorizeRequest?.(readFile)).toBe("allowed");
    expect(lifecycle.authorizeRequest?.(proposals)).toBe("allowed");
    // Not "synchronizing": only the user's Continue on the inline notice helps.
    expect(lifecycle.authorizeRequest?.(terminalWrite)).toBe("awaiting-acknowledgement");
    expect(lifecycle.authorizeRequest?.(dispatch)).toBe("awaiting-acknowledgement");
    expect(new RpcRequestRefusedError("awaiting-acknowledgement").message).toMatch(/Continue/);

    hostedHubController.acknowledgeDeliveryUnknown();
    expect(hostedHubStore.getState().sessionStatus).toBe("ready");
    expect(lifecycle.authorizeRequest?.(terminalWrite)).toBe("allowed");
  });

  it("preserves streaming mutation uncertainty through progress until final exit", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(4)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    factory.createSocket(await factory.nextUrl());

    lifecycle.onRequestStart?.({
      id: "subscription-1",
      tag: ORCHESTRATION_WS_METHODS.subscribeShell,
      stream: true,
    });
    expect(factory.hasPendingRequests()).toBe(false);

    lifecycle.onRequestStart?.({
      id: "stacked-action-1",
      tag: WS_METHODS.gitRunStackedAction,
      stream: true,
    });
    lifecycle.onRequestChunk?.({
      id: "stacked-action-1",
      tag: WS_METHODS.gitRunStackedAction,
      chunkCount: 1,
    });
    expect(factory.hasPendingRequests()).toBe(true);

    sockets[0]!.fail();
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "reconnecting",
      sessionStatus: "delivery-unknown",
    });
    expect(factory.hasPendingRequests()).toBe(false);
  });

  it("clears streaming mutation uncertainty after final exit", () => {
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();

    lifecycle.onRequestStart?.({
      id: "stacked-action-1",
      tag: WS_METHODS.gitRunStackedAction,
      stream: true,
    });
    expect(factory.hasPendingRequests()).toBe(true);

    lifecycle.onRequestExit?.({
      id: "stacked-action-1",
      tag: WS_METHODS.gitRunStackedAction,
      stream: true,
    });
    expect(factory.hasPendingRequests()).toBe(false);
  });

  it("keeps generic retry delays state-neutral", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(6)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    factory.createSocket(await factory.nextUrl());
    hostedHubStore.setState({ transportStatus: "online" });
    const transportStatus = vi.spyOn(hostedHubController, "transportStatus");

    expect(lifecycle.getReconnectDelayMs?.(0)).toBeGreaterThan(0);
    expect(hostedHubStore.getState().transportStatus).toBe("online");
    expect(transportStatus).not.toHaveBeenCalled();

    factory.reset();
    lifecycle.getReconnectDelayMs?.(1);
    expect(transportStatus).not.toHaveBeenCalled();
  });

  it("transitions on an actual close and ignores delayed close callbacks after reset", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(6)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    factory.createSocket(await factory.nextUrl());
    hostedHubStore.setState({ transportStatus: "online" });

    lifecycle.onClose?.({ code: 1006, reason: "network" }, { intentional: false });
    expect(hostedHubStore.getState().transportStatus).toBe("reconnecting");

    factory.reset();
    hostedHubStore.setState({ transportStatus: "online" });
    lifecycle.onClose?.({ code: 1006, reason: "network" }, { intentional: false });
    expect(hostedHubStore.getState().transportStatus).toBe("online");
  });

  it("ignores callbacks from a superseded socket attempt in the same selection generation", async () => {
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: encodeBase64Url(new Uint8Array(32).fill(6)),
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const factory = new HostedRelayAttemptFactory();
    const lifecycle = factory.lifecycleHandlers();
    const first = factory.createSocket(await factory.nextUrl()) as MockRelaySocket;
    const second = factory.createSocket(await factory.nextUrl()) as MockRelaySocket;

    second.callbacks.onRole("operator");
    second.callbacks.onSessionStatus("ready");
    second.callbacks.onTransportStatus("online");
    expect(lifecycle.isSocketCurrent?.(first as unknown as WebSocket)).toBe(false);
    expect(lifecycle.isSocketCurrent?.(second as unknown as WebSocket)).toBe(true);

    first.callbacks.onRole(null);
    first.callbacks.onSessionStatus("stale");
    first.callbacks.onTransportStatus("reconnecting");
    first.fail();

    expect(hostedHubStore.getState()).toMatchObject({
      effectiveRole: "operator",
      sessionStatus: "ready",
      transportStatus: "online",
    });
  });
});
