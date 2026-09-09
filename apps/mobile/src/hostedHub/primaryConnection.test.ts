import type { ExecutionEnvironmentDescriptor } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hostedLifecycle = vi.hoisted(() => ({
  generation: 7,
  markReady: vi.fn(),
  markReplaying: vi.fn(),
  reportFailure: vi.fn(),
}));
const connectionFactory = vi.hoisted(() => ({
  input: null as Record<string, unknown> | null,
}));
const relay = vi.hoisted(() => ({
  binding: null as import("@ryco/client-runtime/relay").HostedRelayAttemptBinding | null,
  recover: vi.fn(),
}));
vi.mock("@ryco/client-runtime/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/relay")>();
  return {
    ...actual,
    recoverHostedRelayConnection: relay.recover,
    HostedRelayAttemptFactory: class extends actual.HostedRelayAttemptFactory {
      constructor(binding: import("@ryco/client-runtime/relay").HostedRelayAttemptBinding) {
        super(binding);
        relay.binding = binding;
      }
    },
  };
});

const coordinator = vi.hoisted(() => ({
  current: true,
  generation: 3,
  markReady: vi.fn(),
  markReplaying: vi.fn(),
  reportFailure: vi.fn(),
}));

vi.mock("@ryco/client-runtime/authorization", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hostedHubStore: {
    getState: () => ({
      generation: hostedLifecycle.generation,
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      selectedNode: {
        id: "node-hosted-1",
        environmentId: "env-hosted-1",
        label: "Studio",
        effectiveRole: "owner",
      },
    }),
  },
  hostedHubController: {},
  markHostedSessionReady: hostedLifecycle.markReady,
  markHostedSessionReplaying: hostedLifecycle.markReplaying,
  reportHostedShellSnapshotFailure: hostedLifecycle.reportFailure,
}));
vi.mock("../connection/hostedConnectionCoordinator", () => ({
  getMobileHostedConnectionCoordinator: () => ({
    ensureRecord: () => ({
      generation: coordinator.generation,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      effectiveRole: "owner",
    }),
    shouldActivate: () => true,
    isCurrentGeneration: () => coordinator.current,
    registerPendingRequestReader: vi.fn(),
    read: () => ({
      generation: coordinator.generation,
      transportStatus: "online",
      sessionStatus: "ready",
      effectiveRole: "owner",
    }),
    markAttemptPrepared: vi.fn(),
    transportStatus: vi.fn(),
    sessionStatus: vi.fn(),
    role: vi.fn(),
    failure: vi.fn(),
    markDeliveryUnknown: vi.fn(),
    acknowledgeDeliveryUnknown: vi.fn(),
    connectionClosed: vi.fn(),
    markSessionReady: coordinator.markReady,
    markSessionReplaying: coordinator.markReplaying,
    reportShellSnapshotFailure: coordinator.reportFailure,
  }),
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

import { createHostedPrimaryConnection } from "./primaryConnection";
import {
  resetPrimaryEnvironmentForTests,
  writePrimaryEnvironmentDescriptor,
} from "./primaryEnvironment";
import { resetMobileHostedRuntimeConfigForTests } from "./runtimeConfig";

const descriptor = {
  environmentId: "env-hosted-1",
  label: "Studio",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.0.0",
  capabilities: { repositoryIdentity: false },
} as unknown as ExecutionEnvironmentDescriptor;

const deps = () => ({
  pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
  resetShellProjection: vi.fn(),
  applyShellEvent: vi.fn(),
  syncShellSnapshot: vi.fn(),
});

beforeEach(() => {
  hostedLifecycle.generation = 7;
  hostedLifecycle.markReady.mockReset();
  hostedLifecycle.markReplaying.mockReset();
  hostedLifecycle.reportFailure.mockReset();
  coordinator.current = true;
  coordinator.markReady.mockReset();
  coordinator.markReplaying.mockReset();
  coordinator.reportFailure.mockReset();
  connectionFactory.input = null;
  relay.binding = null;
  relay.recover.mockClear();
  resetPrimaryEnvironmentForTests();
  resetMobileHostedRuntimeConfigForTests();
});

describe("hosted primary connection", () => {
  it("returns recovered channels to the shared lifecycle only for the active record", () => {
    writePrimaryEnvironmentDescriptor(descriptor);
    createHostedPrimaryConnection(deps());
    relay.binding?.connectionRecovered?.(coordinator.generation);
    expect(relay.recover).toHaveBeenCalledExactlyOnceWith(hostedLifecycle.generation);

    coordinator.current = false;
    relay.binding?.connectionRecovered?.(coordinator.generation);
    expect(relay.recover).toHaveBeenCalledTimes(1);
  });

  it("returns null when no hosted node is selected", () => {
    // The normal state, including at supervisor start() on a direct-only build.
    expect(createHostedPrimaryConnection(deps())).toBeNull();
  });

  it("returns null again after the descriptor is cleared", () => {
    writePrimaryEnvironmentDescriptor(descriptor);
    writePrimaryEnvironmentDescriptor(null);
    expect(createHostedPrimaryConnection(deps())).toBeNull();
  });

  it("builds a primary-kind connection once a node is selected", async () => {
    writePrimaryEnvironmentDescriptor(descriptor);

    const connection = createHostedPrimaryConnection(deps());

    expect(connection).not.toBeNull();
    // `disconnectPrimary` finds the connection by `entry.kind === "primary"`.
    expect(connection?.kind).toBe("primary");
    expect(connection?.knownEnvironment.environmentId).toBe("env-hosted-1");
    expect(connection?.knownEnvironment.source).toBe("hub-hosted");
    await connection?.dispose().catch(() => undefined);
  });

  it("points the connection target at the relay, never at a node address", async () => {
    writePrimaryEnvironmentDescriptor(descriptor);

    const connection = createHostedPrimaryConnection(deps());

    // The hosted plane never learns a node-owned address; the only reachable
    // endpoint is the Hub's relay.
    expect(connection?.knownEnvironment.target.wsBaseUrl).toBe(
      "wss://hub.example.test/v1/relay/client",
    );
    expect(connection?.knownEnvironment.target.httpBaseUrl).toBe("https://hub.example.test");
    await connection?.dispose().catch(() => undefined);
  });

  it("marks the hosted session ready when the supervisor accepts the first snapshot", () => {
    writePrimaryEnvironmentDescriptor(descriptor);
    const input = deps();
    input.syncShellSnapshot.mockImplementation((_snapshot, _environmentId, callbacks) => {
      callbacks?.onReady();
    });

    createHostedPrimaryConnection(input);
    const syncShellSnapshot = connectionFactory.input?.syncShellSnapshot as (
      snapshot: unknown,
      environmentId: string,
    ) => void;
    syncShellSnapshot({ snapshotSequence: 1 }, "env-hosted-1");

    expect(input.syncShellSnapshot).toHaveBeenCalledTimes(1);
    expect(hostedLifecycle.markReady).toHaveBeenCalledWith("env-hosted-1", 7);
  });

  it("marks current snapshots ready and reports replay or snapshot failure", () => {
    writePrimaryEnvironmentDescriptor(descriptor);
    const input = deps();
    input.syncShellSnapshot.mockImplementation((_snapshot, _environmentId, callbacks) => {
      callbacks?.onCurrent();
    });

    createHostedPrimaryConnection(input);
    const connectionInput = connectionFactory.input as {
      syncShellSnapshot: (snapshot: unknown, environmentId: string) => void;
      onResubscribe: (environmentId: string) => void;
      onShellError: (environmentId: string) => void;
    };
    connectionInput.syncShellSnapshot({ snapshotSequence: 1 }, "env-hosted-1");
    connectionInput.onResubscribe("env-hosted-1");
    connectionInput.onShellError("env-hosted-1");

    expect(hostedLifecycle.markReady).toHaveBeenCalledWith("env-hosted-1", 7);
    expect(hostedLifecycle.markReplaying).toHaveBeenCalledWith("env-hosted-1", 7);
    expect(hostedLifecycle.reportFailure).toHaveBeenCalledWith("env-hosted-1", 7);
  });

  it("keeps retained shell data across selection generations and drops it after eviction", () => {
    writePrimaryEnvironmentDescriptor(descriptor);
    const input = deps();

    createHostedPrimaryConnection(input);
    hostedLifecycle.generation = 8;
    const connectionInput = connectionFactory.input as {
      applyShellEvent: (event: unknown, environmentId: string) => void;
      syncShellSnapshot: (snapshot: unknown, environmentId: string) => void;
    };
    connectionInput.applyShellEvent({ sequence: 1 }, "env-hosted-1");
    expect(input.applyShellEvent).toHaveBeenCalledOnce();

    coordinator.current = false;
    connectionInput.applyShellEvent({ sequence: 2 }, "env-hosted-1");
    connectionInput.syncShellSnapshot({ snapshotSequence: 1 }, "env-hosted-1");

    expect(input.applyShellEvent).toHaveBeenCalledOnce();
    expect(input.syncShellSnapshot).not.toHaveBeenCalled();
    expect(hostedLifecycle.markReady).not.toHaveBeenCalled();
  });
});

describe("primary environment descriptor store", () => {
  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const { subscribePrimaryEnvironmentDescriptor, readPrimaryEnvironmentDescriptor } =
      await import("./primaryEnvironment");
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
    const { subscribePrimaryEnvironmentDescriptor } = await import("./primaryEnvironment");
    const listener = vi.fn();
    subscribePrimaryEnvironmentDescriptor(listener);

    writePrimaryEnvironmentDescriptor(descriptor);
    writePrimaryEnvironmentDescriptor(descriptor);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
