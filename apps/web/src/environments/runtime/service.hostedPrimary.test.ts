import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubNode } from "@ryco/client-runtime/authorization";

const { createWsRpcClient, transportCount } = vi.hoisted(() => ({
  createWsRpcClient: vi.fn(),
  transportCount: { value: 0 },
}));

function MockWsTransport() {
  transportCount.value += 1;
}

vi.mock("../../rpc/wsTransport", () => ({
  DeviceWsTransport: MockWsTransport,
  HostedWsTransport: MockWsTransport,
  WsTransport: MockWsTransport,
}));

vi.mock("../../rpc/wsRpcClient", () => ({ createWsRpcClient }));

function hubNode(suffix: string): HostedHubNode {
  return {
    id: `node_${suffix.repeat(22)}`,
    environmentId: EnvironmentId.make(`env_${suffix.repeat(22)}`),
    label: `Node ${suffix}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix.repeat(22)}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

function descriptor(environmentId: EnvironmentId, label: string): ExecutionEnvironmentDescriptor {
  return {
    environmentId,
    label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.9.0",
    capabilities: {
      repositoryIdentity: false,
      threadSettlement: false,
      threadPriorityRanking: false,
    },
  };
}

function makeClient(): Record<string, unknown> {
  return {
    reconnect: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    isHeartbeatFresh: vi.fn(() => false),
    server: {
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeConfig: vi.fn(() => () => undefined),
    },
    orchestration: {
      subscribeShell: vi.fn(
        (_listener: (item: OrchestrationShellSnapshot) => void) => () => undefined,
      ),
    },
    terminal: { onEvent: vi.fn(() => () => undefined) },
  };
}

beforeEach(() => {
  vi.resetModules();
  transportCount.value = 0;
  createWsRpcClient.mockReset();
  createWsRpcClient.mockImplementation(() => makeClient());
});

afterEach(async () => {
  const { resetEnvironmentServiceForTests } = await import("./service");
  const { resetPrimaryEnvironmentDescriptorForTests } = await import("../primary");
  await resetEnvironmentServiceForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the primary environment connection on hosted Web", () => {
  /** The hosted runtime as production configures it, signed in with `nodes` in the directory. */
  async function signedIn(
    nodes: ReadonlyArray<HostedHubNode>,
    windowExtras: Record<string, unknown> = {},
  ) {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
    vi.stubGlobal("window", {
      location: { href: "https://hub.example.test/", origin: "https://hub.example.test" },
      ...windowExtras,
    });
    const { hostedHubApi } = await import("../../hostedHub/api");
    const { configureWebHostedRuntime } = await import("../../hostedHub/runtime");
    configureWebHostedRuntime(hostedHubApi);
    const state = await import("../../hostedHub/state");
    state.hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      nodes,
    });
    const service = await import("./service");
    const { writePrimaryEnvironmentDescriptor } = await import("../primary");
    return {
      service,
      sessions: state.getHostedEnvironmentSessions(),
      writePrimaryEnvironmentDescriptor,
    };
  }

  it("never builds a connection, through any primary entry point", async () => {
    const node = hubNode("a");
    const { service, writePrimaryEnvironmentDescriptor } = await signedIn([node]);
    // The active environment, as selecting the node shows it.
    writePrimaryEnvironmentDescriptor(descriptor(node.environmentId, node.label));

    const stop = service.startEnvironmentConnectionService();
    expect(() => service.getPrimaryEnvironmentConnection()).toThrow(
      "No hosted connection is registered for the active environment.",
    );
    expect(service.connectPrimaryEnvironment()).toBeNull();

    expect(createWsRpcClient).not.toHaveBeenCalled();
    expect(transportCount.value).toBe(0);
    expect(service.listEnvironmentConnections()).toHaveLength(0);
    stop();
  });

  it("returns the hosted connection registered for the active environment, and no other", async () => {
    const [a, b] = [hubNode("a"), hubNode("b")];
    const { service, sessions, writePrimaryEnvironmentDescriptor } = await signedIn([a, b]);
    // Only the lifecycle owner's connect port creates a hosted connection.
    await service.connectHostedEnvironment(a, sessions.ensureRecord(a).generation);
    expect(createWsRpcClient).toHaveBeenCalledOnce();
    const registered = service.readEnvironmentConnection(a.environmentId);
    expect(registered).not.toBeNull();

    writePrimaryEnvironmentDescriptor(descriptor(a.environmentId, a.label));
    expect(service.getPrimaryEnvironmentConnection()).toBe(registered);
    expect(service.connectPrimaryEnvironment()).toBe(registered);

    // Another active environment without a connection of its own gets none.
    writePrimaryEnvironmentDescriptor(descriptor(b.environmentId, b.label));
    expect(() => service.getPrimaryEnvironmentConnection()).toThrow(
      "No hosted connection is registered for the active environment.",
    );
    expect(service.connectPrimaryEnvironment()).toBeNull();

    expect(createWsRpcClient).toHaveBeenCalledOnce();
    expect(service.listEnvironmentConnections()).toEqual([registered]);
  });

  it("leaves a hosted connection's browser resume to the hosted lifecycle owner", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    const node = hubNode("a");
    const { service, sessions } = await signedIn([node], {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    const stop = service.startEnvironmentConnectionService();
    await service.connectHostedEnvironment(node, sessions.ensureRecord(node).generation);
    const client = createWsRpcClient.mock.results[0]?.value as {
      readonly reconnect: ReturnType<typeof vi.fn>;
    };

    // Everything the generic supervisor would read as a resume.
    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("online"));

    expect(client.reconnect).not.toHaveBeenCalled();
    expect(createWsRpcClient).toHaveBeenCalledOnce();
    stop();
  });
});

describe("the primary environment connection in standard mode", () => {
  it("builds the primary connection once and returns it on every later call", async () => {
    vi.stubGlobal("window", {
      location: { href: "http://localhost:3773/", origin: "http://localhost:3773" },
      desktopBridge: undefined,
    });
    const service = await import("./service");
    const { writePrimaryEnvironmentDescriptor } = await import("../primary");
    writePrimaryEnvironmentDescriptor(
      descriptor(EnvironmentId.make("environment-local"), "Local environment"),
    );

    const first = service.getPrimaryEnvironmentConnection();
    const second = service.getPrimaryEnvironmentConnection();

    expect(second).toBe(first);
    expect(service.connectPrimaryEnvironment()).toBe(first);
    expect(first.kind).toBe("primary");
    expect(createWsRpcClient).toHaveBeenCalledOnce();
  });
});
