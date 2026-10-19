import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
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
  };
}

interface CapturedClient {
  readonly dispose: ReturnType<typeof vi.fn>;
  emitShellSnapshot(snapshot: OrchestrationShellSnapshot): void;
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
  return {
    reconnect: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    isHeartbeatFresh: vi.fn(() => false),
    server: {
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeConfig: vi.fn(() => () => undefined),
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
        threadPriorityRanking: false,
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
