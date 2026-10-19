import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";
import type { EnvironmentConnectionInput } from "@ryco/client-runtime/connection";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  type WsRpcClient,
} from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const enrollment = vi.hoisted(() => ({
  applyRevocation: vi.fn(() => true),
  invalidate: vi.fn(async () => undefined),
}));
vi.mock("./e2eeEnrollment", () => ({
  getMobileNativeE2eeEnrollmentCoordinator: () => enrollment,
}));

const e2ee = vi.hoisted(() => ({
  prepare: vi.fn(async (_target: unknown): Promise<unknown> => ({ kind: "account" })),
  issue: vi.fn(async (_input: unknown) => ({
    ticket: "ticket",
    expiresAt: Number.MAX_SAFE_INTEGER,
    preparedSocketContext: { kind: "account" },
  })),
  dispose: vi.fn((_context: unknown) => undefined),
}));
vi.mock("./accountE2eeAttempt", () => ({
  prepareMobileRelaySocketContext: e2ee.prepare,
  issueMobileRelayAttempt: e2ee.issue,
  disposeMobileRelaySocketContext: e2ee.dispose,
  providerForMobileRelaySocketContext: () => () => undefined,
}));
vi.mock("./relaySocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./relaySocket")>()),
  openMobileEarlyRelaySocket: () => undefined,
}));

const relay = vi.hoisted(() => ({
  created: null as import("@ryco/client-runtime/relay").HostedEnvironmentAttemptFactory | null,
}));
vi.mock("@ryco/client-runtime/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/relay")>();
  return {
    ...actual,
    createHostedEnvironmentAttemptFactory: (
      options: Parameters<typeof actual.createHostedEnvironmentAttemptFactory>[0],
    ) => {
      relay.created = actual.createHostedEnvironmentAttemptFactory(options);
      return relay.created;
    },
  };
});

const demand = vi.hoisted(() => ({ value: true }));
vi.mock("../connection/hostedConnectionCoordinator", () => ({
  readMobileHostedConnectionCoordinator: () => ({ isDemanded: () => demand.value }),
}));

const connectionFactory = vi.hoisted(() => ({
  input: null as Record<string, unknown> | null,
}));
vi.mock("@ryco/client-runtime/connection", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createEnvironmentConnection: (input: Record<string, unknown>) => {
    connectionFactory.input = input;
    return {
      kind: input.kind,
      environmentId: (input.knownEnvironment as { environmentId: string }).environmentId,
      knownEnvironment: input.knownEnvironment,
      client: input.client,
      ensureBootstrapped: async () => undefined,
      reconnect: async () => undefined,
      dispose: async () => undefined,
    };
  },
}));
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
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        appVariant: "production",
        hosted: {
          hubBaseUrl: "https://hub.example.test",
          appUrl: "https://app.ryco.space",
          relyingParty: "app.ryco.space",
        },
      },
    },
  },
}));

import {
  configureHostedRuntime,
  getHostedEnvironmentSessions,
  hostedHubStore,
  resetHostedEnvironmentSessionsForTests,
  type HostedHubApi,
  type HostedHubNode,
  type HostedNodeLifecycle,
} from "@ryco/client-runtime/authorization";

import { createHostedEnvironmentConnection } from "./primaryConnection";
import { resetMobileHostedRuntimeConfigForTests } from "./runtimeConfig";
import {
  readEnvironmentServerConfig,
  resetEnvironmentServerConfigsForTests,
} from "../state/environmentServerConfigs";

function hubNode(suffix: string, label: string): HostedHubNode {
  return {
    id: `node-${suffix}`,
    environmentId: EnvironmentId.make(`env-${suffix}`),
    label,
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1",
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: null,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant-${suffix}`, role: "owner" },
    effectiveRole: "owner",
    presence: { online: true, lastHeartbeatAt: null },
  };
}

const studio = hubNode("hosted-1", "Studio");
const laptop = hubNode("hosted-2", "Laptop");
const dispatchCommand = { tag: ORCHESTRATION_WS_METHODS.dispatchCommand, stream: false } as const;

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the relay connection tests");
    },
  },
);

const lifecycle: HostedNodeLifecycle = {
  activate: async () => undefined,
  suspend: async () => undefined,
  deactivate: async () => undefined,
  clearNodeScopedState: () => undefined,
  writePrimaryEnvironmentDescriptor: () => undefined,
  connectPrimaryEnvironment: () => undefined,
  disconnectPrimaryEnvironment: async () => undefined,
  setActiveEnvironmentId: () => undefined,
  connectEnvironment: () => undefined,
  releaseEnvironment: async () => undefined,
  suspendEnvironment: async () => undefined,
  requestEnvironmentReconcile: () => undefined,
};

function deps() {
  return {
    pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
    resetShellProjection: vi.fn(),
    applyShellEvent: vi.fn(),
    applyThreadPriorities: vi.fn(),
    syncShellSnapshot: vi.fn(),
  };
}

/** A connection was requested for the node's environment, as the controller leaves it. */
function requestConnection(node: HostedHubNode): number {
  const sessions = getHostedEnvironmentSessions();
  const { generation } = sessions.ensureRecord(node);
  sessions.markConnectRequested(node.environmentId, generation);
  return generation;
}

function connect(node: HostedHubNode, input = deps()) {
  const generation = requestConnection(node);
  const connection = createHostedEnvironmentConnection({ ...input, node, generation });
  return { connection, generation, binding: relay.created!.binding, input };
}

beforeEach(() => {
  resetHostedEnvironmentSessionsForTests();
  configureHostedRuntime(
    {
      endpoint: unusedService as EndpointService,
      httpClient: unusedService as HttpClientService,
      passkeyCeremony: unusedService as PasskeyCeremonyService,
      sessionCredentials: unusedService as SessionCredentialsService,
      nodeLifecycle: lifecycle,
      environmentSessions: "retained",
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
      createRelaySocket: () => {
        throw new Error("no relay socket is opened by the relay connection tests");
      },
    },
    { credentialMode: "bearer", clearSessionMaterial: () => undefined } as unknown as HostedHubApi,
  );
  // Another node is selected: every connection here is a warm, non-selected one.
  hostedHubStore.setState({
    accountStatus: "authenticated",
    account: { id: "acct-1" } as never,
    directoryStatus: "ready",
    browserStatus: "current",
    nodes: [studio, laptop],
    selectedNode: laptop,
  });
  demand.value = true;
  enrollment.applyRevocation.mockClear();
  enrollment.invalidate.mockClear();
  e2ee.prepare.mockClear();
  e2ee.issue.mockClear();
  e2ee.dispose.mockClear();
  connectionFactory.input = null;
  relay.created = null;
  resetWsConnectionStateForTests();
  resetEnvironmentServerConfigsForTests();
  resetMobileHostedRuntimeConfigForTests();
});

afterEach(() => {
  resetHostedEnvironmentSessionsForTests();
});

describe("hosted environment connection", () => {
  it("builds a primary-kind hub-hosted connection that targets the relay, never a node address", async () => {
    const { connection } = connect(studio);

    // The supervisor keeps hosted node connections as primary ones.
    expect(connection.kind).toBe("primary");
    expect(connection.knownEnvironment).toMatchObject({
      environmentId: studio.environmentId,
      label: "Studio",
      source: "hub-hosted",
      target: {
        wsBaseUrl: "wss://hub.example.test/v1/relay/client",
        httpBaseUrl: "https://hub.example.test",
      },
    });
    await connection.dispose();
  });

  it("admits requests from its own record while another node is selected", () => {
    const { binding, generation } = connect(studio);
    const sessions = getHostedEnvironmentSessions();

    expect(binding.authorizeRequest(dispatchCommand)).toBe("awaiting-session");
    sessions.transportStatus(studio.environmentId, generation, "online");
    sessions.markSessionReady(studio.environmentId, generation);
    expect(binding.authorizeRequest(dispatchCommand)).toBe("allowed");

    // A replaced generation never admits anything again.
    sessions.renew(studio.environmentId);
    expect(binding.authorizeRequest(dispatchCommand)).toBe("forbidden");
  });

  it("reconnects a dropped warm connection without being selected while it is demanded", () => {
    const { binding, generation } = connect(studio);

    expect(hostedHubStore.getState().selectedNode).toBe(laptop);
    expect(binding.shouldReconnect(generation)).toBe(true);

    // Nothing holds it: it stops instead, and the coordinator releases it.
    demand.value = false;
    expect(binding.shouldReconnect(generation)).toBe(false);
  });

  it("prepares its E2EE attempt for its own node and record generation", async () => {
    const { binding, generation } = connect(studio);

    await binding.prepareSocketContext!();

    const [target] = e2ee.prepare.mock.calls[0] as [
      {
        nodeId: string;
        nodeLabel: string;
        environmentId: string;
        generation: number;
        isCurrent: () => boolean;
      },
    ];
    expect(target).toMatchObject({
      nodeId: studio.id,
      nodeLabel: "Studio",
      environmentId: studio.environmentId,
      generation,
    });
    expect(target.isCurrent()).toBe(true);
    getHostedEnvironmentSessions().renew(studio.environmentId);
    expect(target.isCurrent()).toBe(false);
  });

  it("refuses an attempt whose record was replaced during E2EE preparation", async () => {
    connect(studio);
    const prepared = { kind: "account" };
    e2ee.prepare.mockImplementationOnce(async () => {
      getHostedEnvironmentSessions().renew(studio.environmentId);
      return prepared;
    });

    await expect(relay.created!.factory.nextUrl()).rejects.toThrow(
      "Hosted node selection changed.",
    );

    expect(e2ee.issue).not.toHaveBeenCalled();
    expect(e2ee.dispose).toHaveBeenCalledWith(prepared);
  });

  it.each(["revoked", "node_revoked", "grant_revoked"] as const)(
    "keeps the device enrollment when a %s close ends one node's channel",
    (closeReason) => {
      const { binding, generation } = connect(studio);
      const failure = { kind: "revoked", retryable: false, closeReason } as const;

      binding.failure(generation, failure);

      expect(enrollment.applyRevocation).not.toHaveBeenCalled();
      expect(enrollment.invalidate).not.toHaveBeenCalled();
      // The node's own record still reports the revocation.
      expect(getHostedEnvironmentSessions().read(studio.environmentId)).toMatchObject({
        failure,
        transportStatus: "terminal-failure",
      });
    },
  );

  it("hands only the Hub's enrollment frame to the enrollment coordinator", () => {
    const { binding, generation } = connect(studio);
    const enrollmentRevoked = { enrollmentId: `enr_${"e".repeat(22)}`, enrollmentRevision: 2 };

    binding.failure(generation, {
      kind: "revoked",
      retryable: false,
      closeReason: "revoked",
      enrollmentRevoked,
    });

    expect(enrollment.applyRevocation).toHaveBeenCalledExactlyOnceWith(enrollmentRevoked);
    expect(enrollment.invalidate).not.toHaveBeenCalled();
  });

  it("marks its own record ready when the supervisor accepts the first snapshot", () => {
    const input = deps();
    input.syncShellSnapshot.mockImplementation((_snapshot, _environmentId, callbacks) => {
      callbacks?.onReady();
    });
    connect(studio, input);
    const syncShellSnapshot = connectionFactory.input?.syncShellSnapshot as (
      snapshot: unknown,
      environmentId: string,
    ) => void;

    syncShellSnapshot({ snapshotSequence: 1 }, studio.environmentId);

    expect(input.syncShellSnapshot).toHaveBeenCalledTimes(1);
    expect(getHostedEnvironmentSessions().read(studio.environmentId)).toMatchObject({
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    // The selected node's session is untouched.
    expect(getHostedEnvironmentSessions().read(laptop.environmentId)).toBeUndefined();
  });

  it("reports replay and snapshot failure for its own record generation", () => {
    connect(studio);
    const connectionInput = connectionFactory.input as {
      onResubscribe: (environmentId: string) => void;
      onShellError: (environmentId: string) => void;
    };

    connectionInput.onResubscribe(studio.environmentId);
    expect(getHostedEnvironmentSessions().read(studio.environmentId)?.sessionStatus).toBe(
      "replaying",
    );
    connectionInput.onShellError(studio.environmentId);
    expect(getHostedEnvironmentSessions().read(studio.environmentId)).toMatchObject({
      transportStatus: "terminal-failure",
      syncFailed: true,
    });
  });

  it("keeps shell data across selection changes and drops it once the record is replaced", () => {
    const { input } = connect(studio);
    const connectionInput = connectionFactory.input as {
      applyShellEvent: (event: unknown, environmentId: string) => void;
      syncShellSnapshot: (snapshot: unknown, environmentId: string) => void;
    };

    hostedHubStore.setState({ selectedNode: studio, generation: 8 });
    connectionInput.applyShellEvent({ sequence: 1 }, studio.environmentId);
    hostedHubStore.setState({ selectedNode: null, generation: 9 });
    connectionInput.applyShellEvent({ sequence: 2 }, studio.environmentId);
    expect(input.applyShellEvent).toHaveBeenCalledTimes(2);

    getHostedEnvironmentSessions().renew(studio.environmentId);
    connectionInput.applyShellEvent({ sequence: 3 }, studio.environmentId);
    connectionInput.syncShellSnapshot({ snapshotSequence: 1 }, studio.environmentId);

    expect(input.applyShellEvent).toHaveBeenCalledTimes(2);
    expect(input.syncShellSnapshot).not.toHaveBeenCalled();
  });

  it("asks for thread-priority deltas and drops them from a replaced generation", () => {
    const { input } = connect(studio);
    // The shared connection requests `threadPriorities: "delta"` exactly when
    // this handler is supplied; without it every ranking batch is a full
    // shell snapshot over the relay.
    const connectionInput = connectionFactory.input as {
      applyThreadPriorities?: (item: unknown, environmentId: string) => void;
    };
    expect(connectionInput.applyThreadPriorities).toBeTypeOf("function");
    const item = { kind: "thread-priorities", priorities: [] };
    connectionInput.applyThreadPriorities!(item, studio.environmentId);
    expect(input.applyThreadPriorities).toHaveBeenCalledExactlyOnceWith(item, studio.environmentId);

    getHostedEnvironmentSessions().release(studio.environmentId);
    connectionInput.applyThreadPriorities!(item, studio.environmentId);
    expect(input.applyThreadPriorities).toHaveBeenCalledOnce();
  });

  it("never reads or publishes config from a replaced generation", async () => {
    connect(studio);
    // The real connection over the input the hosted connection built.
    const { createEnvironmentConnection: createRealConnection } = await vi.importActual<
      typeof import("@ryco/client-runtime/connection")
    >("@ryco/client-runtime/connection");
    let emit: (event: ServerConfigStreamEvent) => void = () => undefined;
    const connection = createRealConnection({
      ...(connectionFactory.input as unknown as EnvironmentConnectionInput),
      client: {
        server: {
          subscribeLifecycle: () => () => undefined,
          subscribeConfig: (listener: (event: ServerConfigStreamEvent) => void) => {
            emit = listener;
            return () => undefined;
          },
        },
        orchestration: { subscribeShell: () => () => undefined },
        terminal: { onEvent: () => () => undefined },
        dispose: async () => undefined,
        reconnect: async () => undefined,
      } as unknown as WsRpcClient,
    });
    const environmentId = studio.environmentId;
    recordWsConnectionAttempt("wss://hub.example.test/v1/relay/client", {
      environmentId,
      recordGlobal: false,
    });
    recordWsConnectionOpened({ environmentId, recordGlobal: false });
    const observed = vi.fn();
    connection.config.subscribe(observed);
    const config = (label: string) =>
      ({
        environment: { environmentId, label },
        providers: [],
        issues: [],
        keybindings: [],
        settings: { label },
      }) as unknown as ServerConfig;

    emit({ version: 1, type: "snapshot", config: config("current") } as ServerConfigStreamEvent);
    expect(connection.config.read()).not.toBeNull();
    expect(readEnvironmentServerConfig(environmentId)?.settings).toEqual({ label: "current" });
    expect(observed).toHaveBeenCalledOnce();

    // The environment's session started over: a new record generation.
    getHostedEnvironmentSessions().renew(environmentId);
    expect(connection.config.read()).toBeNull();
    emit({ version: 1, type: "snapshot", config: config("stale") } as ServerConfigStreamEvent);
    emit({
      version: 1,
      type: "settingsUpdated",
      payload: { settings: { label: "stale delta" } },
    } as unknown as ServerConfigStreamEvent);

    expect(connection.config.read()).toBeNull();
    expect(observed).toHaveBeenCalledOnce();
    expect(readEnvironmentServerConfig(environmentId)?.settings).toEqual({ label: "current" });
    await connection.dispose();
  });
});

describe("primary environment descriptor store", () => {
  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const {
      resetPrimaryEnvironmentForTests,
      subscribePrimaryEnvironmentDescriptor,
      readPrimaryEnvironmentDescriptor,
      writePrimaryEnvironmentDescriptor,
    } = await import("./primaryEnvironment");
    resetPrimaryEnvironmentForTests();
    const descriptor = { environmentId: studio.environmentId, label: "Studio" } as never;
    const listener = vi.fn();
    const unsubscribe = subscribePrimaryEnvironmentDescriptor(listener);

    writePrimaryEnvironmentDescriptor(descriptor);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readPrimaryEnvironmentDescriptor()).toBe(descriptor);

    unsubscribe();
    writePrimaryEnvironmentDescriptor(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the descriptor is unchanged", async () => {
    const {
      resetPrimaryEnvironmentForTests,
      subscribePrimaryEnvironmentDescriptor,
      writePrimaryEnvironmentDescriptor,
    } = await import("./primaryEnvironment");
    resetPrimaryEnvironmentForTests();
    const descriptor = { environmentId: studio.environmentId, label: "Studio" } as never;
    const listener = vi.fn();
    subscribePrimaryEnvironmentDescriptor(listener);

    writePrimaryEnvironmentDescriptor(descriptor);
    writePrimaryEnvironmentDescriptor(descriptor);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
