import { EnvironmentId, WS_METHODS, type GitRunStackedActionInput } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import type { HostedHubApi } from "../authorization/api.ts";
import {
  configureHostedRuntime,
  type HostedRuntimeConfiguration,
} from "../authorization/runtime.ts";
import { hostedHubController, hostedHubStore } from "../authorization/state.ts";
import type { HostedHubNode, HostedRelayFailure } from "../authorization/types.ts";
import {
  bindHostedGitActionDelivery,
  GitActionRecovery,
  type GitActionRecoveryAttachment,
} from "../rpc/gitActionRecovery.ts";
import { RpcRequestRefusedError } from "../rpc/protocol.ts";
import { resetRequestLatencyStateForTests } from "../rpc/requestLatencyState.ts";
import { resetWsConnectionStateForTests } from "../rpc/wsConnectionState.ts";
import { createWsRpcClient, type WsRpcClient } from "../rpc/wsRpcClient.ts";
import { WsTransport } from "../rpc/wsTransport.ts";
import {
  FakeWebSocket,
  fakeSocketPlatform,
  type FakeRpcRequest,
} from "../../test/fakeWebSocket.ts";
import { encodeBase64Url } from "./base64url.ts";
import { HostedRelayAttemptFactory } from "./transport.ts";

/**
 * A hosted connection's Git actions over the real RPC client, protocol layer,
 * Effect socket and relay attempt factory, with the lifecycle owner deciding
 * what the session admits. Only the relay socket is faked.
 */

interface RelaySocketCallbacks {
  onTransportStatus(status: string): void;
  onFailure(failure: HostedRelayFailure): void;
}

/** A relay channel: a socket that reports to the factory the way the relay engine does. */
class FakeRelaySocket extends FakeWebSocket {
  readonly callbacks: RelaySocketCallbacks;

  constructor(url: string, callbacks: RelaySocketCallbacks) {
    super(url);
    this.callbacks = callbacks;
    callbacks.onTransportStatus("connecting");
  }

  online() {
    this.open();
    this.callbacks.onTransportStatus("online");
  }

  /** The relay engine reports a lost channel before the socket closes. */
  lose() {
    this.callbacks.onFailure({ kind: "network", retryable: true });
    this.drop();
  }
}

const sockets: FakeRelaySocket[] = [];
const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the Git action delivery tests");
    },
  },
);

function runtime(): HostedRuntimeConfiguration {
  return {
    endpoint: unusedService as EndpointService,
    httpClient: unusedService as HttpClientService,
    passkeyCeremony: unusedService as PasskeyCeremonyService,
    sessionCredentials: unusedService as SessionCredentialsService,
    nodeLifecycle: {
      activate: async () => undefined,
      suspend: async () => undefined,
      deactivate: async () => undefined,
      clearNodeScopedState: () => undefined,
      writePrimaryEnvironmentDescriptor: () => undefined,
      connectPrimaryEnvironment: () => undefined,
      disconnectPrimaryEnvironment: async () => undefined,
      setActiveEnvironmentId: () => undefined,
    },
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
      queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    },
    isForeground: () => true,
    subscribeForeground: () => () => undefined,
    hasPendingRelayRequests: () => false,
    resetRelayAttemptFactory: () => undefined,
    relayUrl: () => "wss://hub.example.test/v1/relay/client",
    createRelaySocket: (input) => {
      const socket = new FakeRelaySocket(input.url, input.callbacks as RelaySocketCallbacks);
      sockets.push(socket);
      return socket;
    },
  };
}

const hostedHubApi = {
  issueRelayTicket: async () => ({
    ticket: encodeBase64Url(new Uint8Array(32).fill(7)),
    expiresAt: Date.now() + 60_000,
    protocolMajor: 1,
    protocolMinor: 2,
  }),
  clearSessionMaterial: () => undefined,
} as unknown as HostedHubApi;

const node: HostedHubNode = {
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
const environmentId = node.environmentId;
const actionId = "6f1c0d3e-8a5b-4c2d-9e7f-1a2b3c4d5e6f";
const input: GitRunStackedActionInput = { actionId, cwd: "/repo", action: "push" };

let recovery: GitActionRecovery;
const clients: WsRpcClient[] = [];

/**
 * One hosted connection: its client claims its Git action deliveries for the
 * recovery, which follows an action again once the session is current again.
 */
function connect(): {
  readonly client: WsRpcClient;
  readonly git: GitActionRecoveryAttachment;
} {
  const factory = new HostedRelayAttemptFactory();
  const delivery = bindHostedGitActionDelivery(() =>
    hostedHubController.markEnvironmentDeliveryUnknown(environmentId),
  );
  const transport = new WsTransport(() => factory.nextUrl(), fakeSocketPlatform([]), {
    ...factory.lifecycleHandlers(undefined, delivery),
    // The replacement channel without the reconnect backoff.
    getReconnectDelayMs: () => 0,
  });
  const client = createWsRpcClient(transport);
  clients.push(client);
  const sessionCurrent = () => {
    const state = hostedHubStore.getState();
    return (
      state.transportStatus === "online" &&
      (state.sessionStatus === "ready" ||
        (state.sessionStatus === "delivery-unknown" && state.sessionRecoveredAfterUnknown))
    );
  };
  const git = recovery.attach({
    environmentId,
    git: client.git,
    readiness: {
      read: sessionCurrent,
      subscribe: (listener) => hostedHubStore.subscribe(listener),
    },
    isCurrent: () => true,
    supportsRecoverable: () => true,
    accountBound: true,
    markUncertain: delivery.markUncertain,
  });
  delivery.claim();
  return { client, git };
}

async function sent(socket: FakeWebSocket, tag: string): Promise<FakeRpcRequest> {
  return await vi.waitFor(() => {
    const request = socket.requests().find((candidate) => candidate.tag === tag);
    expect(request).toBeDefined();
    return request!;
  });
}

/** The first channel is online and its session accepted its snapshot. */
async function establish(): Promise<FakeRelaySocket> {
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.online();
  hostedHubController.markSessionReady(environmentId);
  expect(hostedHubStore.getState().sessionStatus).toBe("ready");
  return sockets[0]!;
}

/** The relay drops the channel and the factory authenticates its replacement. */
async function replaceChannel(lost: FakeRelaySocket): Promise<FakeRelaySocket> {
  lost.lose();
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  const replacement = sockets[1]!;
  replacement.online();
  return replacement;
}

beforeEach(() => {
  sockets.length = 0;
  recovery = new GitActionRecovery();
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
  configureHostedRuntime(runtime(), hostedHubApi);
  hostedHubStore.setState({
    accountStatus: "authenticated",
    selectedNode: node,
    generation: 4,
    directoryStatus: "ready",
    browserStatus: "current",
    effectiveRole: node.effectiveRole,
    transportStatus: "idle",
  });
});

afterEach(async () => {
  recovery.resetForTests();
  await Promise.allSettled(clients.map((client) => client.dispose()));
  clients.length = 0;
  hostedHubController.resetForTests();
});

describe("hosted Git action delivery over the real RPC protocol", () => {
  it("follows a recoverable action through a relay drop and can stop it on the recovered session", async () => {
    const { client, git } = connect();
    const first = await establish();
    const outcome = git
      .runStackedAction(input, { recoverable: true })
      .catch((error: unknown) => error);
    const start = await sent(first, WS_METHODS.gitRunStackedAction);
    expect(start.payload).toEqual({ ...input, recoverable: true });
    first.reply({
      _tag: "Chunk",
      requestId: start.id,
      values: [{ ...input, kind: "action_started", phases: ["push"] }],
    });

    const replacement = await replaceChannel(first);
    // Stale, not delivery unknown: the recovery answers for the action.
    expect(hostedHubStore.getState().sessionStatus).toBe("stale");
    // Until the replacement session accepts its own snapshot nothing is admitted.
    await expect(client.git.cancelStackedAction({ actionId })).rejects.toBeInstanceOf(
      RpcRequestRefusedError,
    );
    expect(replacement.requests()).toHaveLength(0);

    hostedHubController.markSessionReady(environmentId);
    expect(hostedHubStore.getState().sessionStatus).toBe("ready");
    const resume = await sent(replacement, WS_METHODS.gitResumeStackedAction);
    expect(resume.payload).toEqual(input);
    const stop = client.git.cancelStackedAction({ actionId });
    const cancel = await sent(replacement, WS_METHODS.gitCancelStackedAction);
    expect(cancel.payload).toEqual({ actionId });
    replacement.reply({
      _tag: "Exit",
      requestId: cancel.id,
      exit: { _tag: "Success", value: { cancelled: true } },
    });
    await expect(stop).resolves.toEqual({ cancelled: true });

    replacement.reply({
      _tag: "Exit",
      requestId: resume.id,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: { _tag: "GitActionStoppedError", actionId, phase: "push", reason: "requested" },
          },
        ],
      },
    });
    expect(await outcome).toMatchObject({ _tag: "GitActionStoppedError", reason: "requested" });
    expect(hostedHubStore.getState().sessionStatus).toBe("ready");
  });

  it("still holds the session for a request-owned action lost with its channel", async () => {
    const { client, git } = connect();
    const first = await establish();
    const outcome = git.runStackedAction(input).catch((error: unknown) => error);
    const start = await sent(first, WS_METHODS.gitRunStackedAction);
    expect(start.payload).toEqual(input);

    const replacement = await replaceChannel(first);
    expect(await outcome).toMatchObject({ _tag: "RpcClientError" });
    expect(hostedHubStore.getState().sessionStatus).toBe("delivery-unknown");

    // The replacement session's own snapshot admits reads; mutations wait for Continue.
    hostedHubController.markSessionReady(environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    await expect(client.git.cancelStackedAction({ actionId })).rejects.toMatchObject({
      admission: "awaiting-acknowledgement",
    });
    expect(replacement.requests()).toHaveLength(0);
  });
});
