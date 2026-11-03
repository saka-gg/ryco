import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubApi, HostedHubNode } from "@ryco/client-runtime/authorization";

interface CapturedTransport {
  readonly options: {
    readonly authorizeRequest?: (request: {
      readonly tag: string;
      readonly stream: boolean;
    }) => string;
    readonly onRequestStart?: (request: {
      readonly id: string;
      readonly tag: string;
      readonly stream: boolean;
    }) => void;
  };
}

interface GitCall {
  readonly input: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface CapturedClient {
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly git: {
    readonly runStackedAction: ReturnType<typeof vi.fn>;
    readonly resumeStackedAction: ReturnType<typeof vi.fn>;
  };
  readonly gitStarts: GitCall[];
  readonly gitResumes: GitCall[];
  emitShellSnapshot(snapshot: OrchestrationShellSnapshot): void;
  emitConfigCapabilities(capabilities: object): void;
}

const { capturedTransports, capturedClients, createWsRpcClient } = vi.hoisted(() => ({
  capturedTransports: [] as CapturedTransport[],
  capturedClients: [] as CapturedClient[],
  createWsRpcClient: vi.fn(),
}));

function MockWsTransport(
  _resolveUrl: () => Promise<string>,
  options: CapturedTransport["options"],
) {
  capturedTransports.push({ options });
}

vi.mock("../../rpc/wsTransport", () => ({
  DeviceWsTransport: MockWsTransport,
  HostedWsTransport: MockWsTransport,
  WsTransport: MockWsTransport,
}));

vi.mock("../../rpc/wsRpcClient", () => ({ createWsRpcClient }));

const node: HostedHubNode = {
  id: "node_aaaaaaaaaaaaaaaaaaaaaa",
  environmentId: EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa"),
  label: "Node A",
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
const dispatchCommand = { tag: ORCHESTRATION_WS_METHODS.dispatchCommand, stream: false } as const;

function shellSnapshot(sequence: number): OrchestrationShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [],
    threads: [],
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function makeClient(): CapturedClient & Record<string, unknown> {
  let shellListener:
    | ((item: { kind: "snapshot"; snapshot: OrchestrationShellSnapshot }) => void)
    | null = null;
  let configListener: ((event: unknown) => void) | null = null;
  const gitStarts: GitCall[] = [];
  const gitResumes: GitCall[] = [];
  const record = (calls: GitCall[]) => (input: unknown) =>
    new Promise((resolve, reject) => {
      calls.push({ input, resolve, reject });
    });
  return {
    reconnect: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    isHeartbeatFresh: vi.fn(() => false),
    server: {
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeConfig: vi.fn((listener: typeof configListener) => {
        configListener = listener;
        return () => {
          configListener = null;
        };
      }),
    },
    git: {
      runStackedAction: vi.fn(record(gitStarts)),
      resumeStackedAction: vi.fn(record(gitResumes)),
    },
    gitStarts,
    gitResumes,
    emitConfigCapabilities(capabilities) {
      configListener?.({
        version: 1,
        type: "snapshot",
        config: {
          environment: { environmentId, label: node.label, capabilities },
          providers: [],
          issues: [],
          keybindings: [],
          settings: {},
        },
      });
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => ({ sequence: 0 })),
      subscribeShell: vi.fn((listener: typeof shellListener) => {
        shellListener = listener;
        return () => {
          shellListener = null;
        };
      }),
    },
    terminal: { onEvent: vi.fn(() => () => undefined) },
    emitShellSnapshot(snapshot) {
      shellListener?.({ kind: "snapshot", snapshot });
    },
  };
}

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the hosted connection tests");
    },
  },
);

/**
 * The real service, connection and session registry in retained mode; only the
 * socket and the RPC client are fakes. Each test starts from fresh modules.
 */
async function setup() {
  const service = await import("./service");
  const connections = await import("./hostedEnvironmentConnection");
  const authorization = await import("@ryco/client-runtime/authorization");
  authorization.configureHostedRuntime(
    {
      endpoint: unusedService as never,
      httpClient: unusedService as never,
      passkeyCeremony: unusedService as never,
      sessionCredentials: unusedService as never,
      environmentSessions: "retained",
      nodeLifecycle: {
        activate: async () => undefined,
        suspend: async () => undefined,
        deactivate: async () => undefined,
        clearNodeScopedState: () => undefined,
        writePrimaryEnvironmentDescriptor: () => undefined,
        connectPrimaryEnvironment: () => undefined,
        disconnectPrimaryEnvironment: async () => undefined,
        setActiveEnvironmentId: () => undefined,
        connectEnvironment: service.connectHostedEnvironment,
        releaseEnvironment: service.removeHostedEnvironment,
        suspendEnvironment: service.suspendHostedEnvironment,
        requestEnvironmentReconcile: () => undefined,
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
      createRelaySocket: () => {
        throw new Error("no relay socket is opened by the hosted connection tests");
      },
    },
    {
      credentialMode: "cookie",
      clearSessionMaterial: vi.fn(),
    } as unknown as HostedHubApi,
  );
  authorization.hostedHubStore.setState({
    accountStatus: "authenticated",
    account: {
      id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
      displayName: "Ada",
      role: "owner",
      createdAt: 1,
      disabledAt: null,
    },
    directoryStatus: "ready",
    browserStatus: "current",
    nodes: [node],
  });
  const sessions = authorization.getHostedEnvironmentSessions();
  const generation = sessions.ensureRecord(node).generation;
  sessions.markConnectRequested(environmentId, generation);
  return { service, connections, sessions, generation };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  vi.stubGlobal("window", {
    location: { href: "https://hub.example.test/", origin: "https://hub.example.test" },
  });
  capturedTransports.length = 0;
  capturedClients.length = 0;
  createWsRpcClient.mockReset();
  createWsRpcClient.mockImplementation(() => {
    const client = makeClient();
    capturedClients.push(client);
    return client;
  });
});

afterEach(async () => {
  const { resetEnvironmentServiceForTests } = await import("./service");
  const { resetHostedEnvironmentSessionsForTests } =
    await import("@ryco/client-runtime/authorization");
  await resetEnvironmentServiceForTests();
  resetHostedEnvironmentSessionsForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hosted environment connections", () => {
  it("fences every handler by the record generation it was created for", async () => {
    const { connections, sessions, generation } = await setup();
    const fence = connections.hostedRecordFence(sessions, environmentId, generation);
    sessions.transportStatus(environmentId, generation, "online");

    expect(fence.accepts()).toBe(true);
    fence.markReplaying(environmentId);
    expect(sessions.read(environmentId)?.sessionStatus).toBe("replaying");
    expect(fence.isQueryRefreshReady(environmentId)).toBe(false);
    fence.markReady(environmentId);
    expect(sessions.read(environmentId)).toMatchObject({
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    expect(fence.isQueryRefreshReady(environmentId)).toBe(true);

    // A renewed record belongs to a fresh connection: nothing the old one
    // delivers counts any more.
    const renewed = sessions.renew(environmentId)!.generation;
    sessions.transportStatus(environmentId, renewed, "online");
    expect(fence.accepts()).toBe(false);
    fence.markReplaying(environmentId);
    fence.markReady(environmentId);
    fence.reportShellError(environmentId);
    expect(sessions.read(environmentId)).toMatchObject({
      generation: renewed,
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      syncFailed: false,
    });
    expect(fence.isQueryRefreshReady(environmentId)).toBe(false);
  });

  it("admits requests from its own record and drops a replaced generation's snapshot", async () => {
    const { service, sessions, generation } = await setup();
    await service.connectHostedEnvironment(node, generation);
    expect(capturedTransports).toHaveLength(1);
    expect(capturedTransports[0]!.options.authorizeRequest?.(dispatchCommand)).toBe(
      "awaiting-session",
    );

    sessions.transportStatus(environmentId, generation, "online");
    capturedClients[0]!.emitShellSnapshot(shellSnapshot(1));
    expect(sessions.read(environmentId)?.sessionEstablished).toBe(true);
    expect(capturedTransports[0]!.options.authorizeRequest?.(dispatchCommand)).toBe("allowed");

    const renewed = sessions.renew(environmentId)!.generation;
    capturedClients[0]!.emitShellSnapshot(shellSnapshot(2));
    expect(sessions.read(environmentId)).toMatchObject({
      generation: renewed,
      sessionEstablished: false,
    });
    expect(capturedTransports[0]!.options.authorizeRequest?.(dispatchCommand)).toBe("forbidden");
  });

  it("connects once per generation and replaces only an older connection", async () => {
    const { service, connections, sessions, generation } = await setup();
    await service.connectHostedEnvironment(node, generation);
    await service.connectHostedEnvironment(node, generation);
    expect(capturedTransports).toHaveLength(1);
    const first = service.readEnvironmentConnection(environmentId)!;
    expect(connections.hostedEnvironmentConnectionGeneration(first)).toBe(generation);

    const renewed = sessions.renew(environmentId)!.generation;
    // A generation the record has moved past connects nothing.
    await service.connectHostedEnvironment(node, generation);
    expect(capturedTransports).toHaveLength(1);
    expect(service.readEnvironmentConnection(environmentId)).toBe(first);

    await service.connectHostedEnvironment(node, renewed);
    expect(capturedClients[0]!.dispose).toHaveBeenCalledOnce();
    expect(capturedTransports).toHaveLength(2);
    const second = service.readEnvironmentConnection(environmentId)!;
    expect(connections.hostedEnvironmentConnectionGeneration(second)).toBe(renewed);
    expect(service.listEnvironmentConnections()).toEqual([second]);
  });

  it("leaves a newer connection alone when an older generation is released or suspended", async () => {
    const { service, sessions, generation } = await setup();
    const renewed = sessions.renew(environmentId)!.generation;
    sessions.markConnectRequested(environmentId, renewed);
    await service.connectHostedEnvironment(node, renewed);
    const current = service.readEnvironmentConnection(environmentId);
    expect(current).not.toBeNull();

    await service.removeHostedEnvironment(environmentId, generation);
    await service.suspendHostedEnvironment(environmentId, generation);
    expect(service.readEnvironmentConnection(environmentId)).toBe(current);
    expect(capturedClients[0]!.dispose).not.toHaveBeenCalled();

    await service.suspendHostedEnvironment(environmentId, renewed);
    expect(service.readEnvironmentConnection(environmentId)).toBeNull();
    expect(capturedClients[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("follows a dropped Git action only on the next generation, once its session is adoptable", async () => {
    const { service, sessions, generation } = await setup();
    const { recordWsConnectionAttempt, recordWsConnectionOpened } =
      await import("@ryco/client-runtime/rpc");
    const openSocket = () => {
      recordWsConnectionAttempt("wss://hub.example.test/v1/relay/client", {
        environmentId,
        recordGlobal: false,
      });
      recordWsConnectionOpened({ environmentId, recordGlobal: false });
    };
    const flush = async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    };
    const input = {
      actionId: "6f1c0d3e-8a5b-4c2d-9e7f-1a2b3c4d5e6f",
      cwd: "/repo",
      action: "push" as const,
    };

    await service.connectHostedEnvironment(node, generation);
    sessions.transportStatus(environmentId, generation, "online");
    openSocket();
    capturedClients[0]!.emitConfigCapabilities({ recoverableGitActions: true });
    capturedClients[0]!.emitShellSnapshot(shellSnapshot(1));
    const run = service
      .readEnvironmentConnection(environmentId)!
      .client.git.runStackedAction(input, { recoverable: true });
    expect(capturedClients[0]!.gitStarts[0]!.input).toEqual({ ...input, recoverable: true });

    // The relay drops: the old generation's connection is suspended and replaced.
    sessions.connectionClosed(environmentId, generation);
    capturedClients[0]!.gitStarts[0]!.reject(
      Object.assign(new Error("SocketReadError"), { _tag: "RpcClientError" }),
    );
    await flush();
    sessions.suspendAll();
    await service.suspendHostedEnvironment(environmentId, generation);
    const next = sessions.read(environmentId)!.generation;
    sessions.markConnectRequested(environmentId, next);
    await service.connectHostedEnvironment(node, next);
    sessions.transportStatus(environmentId, next, "online");
    openSocket();
    capturedClients[1]!.emitConfigCapabilities({ recoverableGitActions: true });
    await flush();
    expect(capturedClients[1]!.git.resumeStackedAction).not.toHaveBeenCalled();

    // The new generation accepts its own snapshot: now it may follow the action.
    capturedClients[1]!.emitShellSnapshot(shellSnapshot(2));
    await flush();
    expect(capturedClients[1]!.git.resumeStackedAction).toHaveBeenCalledOnce();
    expect(capturedClients[1]!.gitResumes[0]!.input).toEqual(input);
    capturedClients[1]!.gitResumes[0]!.resolve({ action: "push" });
    await expect(run).resolves.toEqual({ action: "push" });
    expect(capturedClients[0]!.git.resumeStackedAction).not.toHaveBeenCalled();
    expect(capturedClients[0]!.git.runStackedAction).toHaveBeenCalledOnce();
    expect(capturedClients[1]!.git.runStackedAction).not.toHaveBeenCalled();
  });

  it("does not follow a dropped Git action on a snapshot the lifecycle owner did not accept", async () => {
    const { service, sessions, generation } = await setup();
    const { recordWsConnectionAttempt, recordWsConnectionOpened } =
      await import("@ryco/client-runtime/rpc");
    recordWsConnectionAttempt("wss://hub.example.test/v1/relay/client", {
      environmentId,
      recordGlobal: false,
    });
    recordWsConnectionOpened({ environmentId, recordGlobal: false });
    const flush = async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    };
    const input = {
      actionId: "0b7e6f52-3c1d-4a9e-8f20-6d5c4b3a2918",
      cwd: "/repo",
      action: "commit" as const,
    };

    await service.connectHostedEnvironment(node, generation);
    sessions.transportStatus(environmentId, generation, "online");
    const client = capturedClients[0]!;
    client.emitConfigCapabilities({ recoverableGitActions: true });
    client.emitShellSnapshot(shellSnapshot(1));
    const run = service
      .readEnvironmentConnection(environmentId)!
      .client.git.runStackedAction(input, { recoverable: true });

    sessions.connectionClosed(environmentId, generation);
    client.gitStarts[0]!.reject(
      Object.assign(new Error("SocketReadError"), { _tag: "RpcClientError" }),
    );
    await flush();
    // A snapshot inside the relay gap came from the lost channel: the record ignores it.
    client.emitShellSnapshot(shellSnapshot(2));
    await flush();
    expect(client.git.resumeStackedAction).not.toHaveBeenCalled();

    sessions.transportStatus(environmentId, generation, "online");
    sessions.connectionRecovered(environmentId, generation);
    client.emitShellSnapshot(shellSnapshot(3));
    await flush();
    expect(client.git.resumeStackedAction).toHaveBeenCalledOnce();
    client.gitResumes[0]!.resolve({ action: "commit" });
    await expect(run).resolves.toEqual({ action: "commit" });
  });

  it("leaves its Git actions' delivery to the recovery, which holds the session only for a lost request-owned one", async () => {
    const { service, sessions, generation } = await setup();
    const { recordWsConnectionAttempt, recordWsConnectionOpened } =
      await import("@ryco/client-runtime/rpc");
    const { hostedHubController } = await import("@ryco/client-runtime/authorization");
    recordWsConnectionAttempt("wss://hub.example.test/v1/relay/client", {
      environmentId,
      recordGlobal: false,
    });
    recordWsConnectionOpened({ environmentId, recordGlobal: false });
    const flush = async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    };
    const input = {
      actionId: "2f4e6a8c-0b1d-4e3f-9a5c-7e9b1d3f5a7c",
      cwd: "/repo",
      action: "push" as const,
    };
    const started = (id: string) =>
      capturedTransports[0]!.options.onRequestStart?.({
        id,
        tag: WS_METHODS.gitRunStackedAction,
        stream: true,
      });

    await service.connectHostedEnvironment(node, generation);
    sessions.transportStatus(environmentId, generation, "online");
    const client = capturedClients[0]!;
    client.emitConfigCapabilities({ recoverableGitActions: true });
    client.emitShellSnapshot(shellSnapshot(1));
    const connection = service.readEnvironmentConnection(environmentId)!;

    // A request-owned action lost with its channel: nothing follows it again.
    const owned = connection.client.git.runStackedAction(input).catch((error: unknown) => error);
    started("owned");
    client.gitStarts[0]!.reject(
      Object.assign(new Error("SocketReadError"), { _tag: "RpcClientError" }),
    );
    await owned;
    expect(sessions.read(environmentId)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    hostedHubController.acknowledgeDeliveryUnknown(environmentId);
    expect(sessions.read(environmentId)?.sessionStatus).toBe("ready");

    // A recoverable one still open when the connection is suspended is followed again instead.
    void connection.client.git
      .runStackedAction(input, { recoverable: true })
      .catch(() => undefined);
    started("recoverable");
    await flush();
    sessions.suspendAll();
    expect(sessions.read(environmentId)?.sessionStatus).not.toBe("delivery-unknown");
  });

  it("never builds a hosted connection on the generic primary path", async () => {
    const { service, generation } = await setup();
    const { writePrimaryEnvironmentDescriptor } = await import("../primary");
    writePrimaryEnvironmentDescriptor({
      environmentId,
      label: node.label,
      platform: { os: node.platformOs, arch: node.platformArch },
      serverVersion: node.clientVersion,
      capabilities: {
        repositoryIdentity: false,
        threadSettlement: false,
      },
    });
    expect(() => service.getPrimaryEnvironmentConnection()).toThrow(
      "No hosted connection is registered for the active environment.",
    );
    expect(service.connectPrimaryEnvironment()).toBeNull();
    expect(capturedTransports).toHaveLength(0);

    await service.connectHostedEnvironment(node, generation);
    expect(service.getPrimaryEnvironmentConnection()).toBe(
      service.readEnvironmentConnection(environmentId),
    );
    expect(capturedTransports).toHaveLength(1);
  });
});
