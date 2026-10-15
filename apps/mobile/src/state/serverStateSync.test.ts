import { createEnvironmentConnection } from "@ryco/client-runtime/connection";
import type { KnownEnvironment } from "@ryco/client-runtime/knownEnvironment";
import { EnvironmentId, type ServerConfig, type ServerConfigStreamEvent } from "@ryco/contracts";
import {
  getServerConfig,
  resetServerStateForTests,
  type WsRpcClient,
} from "@ryco/client-runtime/rpc";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The hook runs under a minimal hook runtime (no React renderer exists in this
// suite): effects run at once and return their cleanup to the test.
const hoisted = vi.hoisted(() => ({
  activeEnvironmentId: null as string | null,
  connection: null as unknown,
  cleanups: [] as Array<() => void>,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  useEffect: (effect: () => (() => void) | void) => {
    const cleanup = effect();
    if (cleanup) hoisted.cleanups.push(cleanup);
  },
}));
vi.mock("../providers/ConnectionRegistryProvider", () => ({
  useConnectionRegistry: () => ({
    driver: {
      supervisor: {
        subscribe: () => () => undefined,
        read: (environmentId: string) =>
          environmentId === hoisted.activeEnvironmentId ? hoisted.connection : null,
      },
    },
  }),
}));
vi.mock("./threadsRuntime", () => ({
  useStore: (selector: (state: { activeEnvironmentId: string | null }) => unknown) =>
    selector({ activeEnvironmentId: hoisted.activeEnvironmentId }),
}));

import {
  resetEnvironmentServerConfigsForTests,
  writeEnvironmentServerConfig,
} from "./environmentServerConfigs";
import { startActiveEnvironmentServerStateSync, useServerStateSync } from "./serverStateSync";

const NODE_A = EnvironmentId.make("node-a");
const NODE_B = EnvironmentId.make("node-b");

function config(label: string): ServerConfig {
  return {
    environment: { environmentId: NODE_A, label, capabilities: {} },
    providers: [],
    issues: [],
    settings: {},
  } as unknown as ServerConfig;
}

beforeEach(() => {
  resetEnvironmentServerConfigsForTests();
  resetServerStateForTests();
  hoisted.activeEnvironmentId = null;
  hoisted.connection = null;
  hoisted.cleanups = [];
});

describe("startActiveEnvironmentServerStateSync", () => {
  it("publishes the active environment's config from its connection's own stream", () => {
    const first = config("first");
    writeEnvironmentServerConfig(NODE_A, first);

    const stop = startActiveEnvironmentServerStateSync(NODE_A);
    expect(getServerConfig()).toBe(first);

    // Later updates of the same connection stream follow; other environments
    // never reach the global atom.
    const second = config("second");
    writeEnvironmentServerConfig(NODE_A, second);
    expect(getServerConfig()).toBe(second);
    writeEnvironmentServerConfig(NODE_B, config("other node"));
    expect(getServerConfig()).toBe(second);

    stop();
    expect(getServerConfig()).toBeNull();
    writeEnvironmentServerConfig(NODE_A, config("after stop"));
    expect(getServerConfig()).toBeNull();
  });

  it("stays a loading state until the connection's first snapshot arrives", () => {
    const stop = startActiveEnvironmentServerStateSync(NODE_A);
    expect(getServerConfig()).toBeNull();
    const first = config("first");
    writeEnvironmentServerConfig(NODE_A, first);
    expect(getServerConfig()).toBe(first);
    stop();
  });
});

describe("useServerStateSync", () => {
  it("opens no config or lifecycle stream of its own on the active connection", () => {
    const server = { subscribeConfig: vi.fn(), subscribeLifecycle: vi.fn() };
    hoisted.activeEnvironmentId = NODE_A;
    hoisted.connection = { environmentId: NODE_A, client: { server } };
    // The connection's own config stream already stored the node's last config.
    const stored = config("stored");
    writeEnvironmentServerConfig(NODE_A, stored);

    useServerStateSync();

    expect(server.subscribeConfig).not.toHaveBeenCalled();
    expect(server.subscribeLifecycle).not.toHaveBeenCalled();
    // A reconnect starts from the environment's last stored config, not null.
    expect(getServerConfig()).toBe(stored);

    for (const cleanup of hoisted.cleanups.splice(0)) cleanup();
    expect(getServerConfig()).toBeNull();
  });

  it("leaves exactly one config stream on a real connection", () => {
    const listeners: Array<(event: ServerConfigStreamEvent) => void> = [];
    const server = {
      subscribeConfig: vi.fn((listener: (event: ServerConfigStreamEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
      subscribeLifecycle: vi.fn(() => () => undefined),
    };
    // As the environment driver builds a direct connection: its own config
    // stream feeds the per-environment store.
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: { environmentId: NODE_A, label: "Node A" } as unknown as KnownEnvironment,
      client: {
        server,
        orchestration: { subscribeShell: () => () => undefined },
        terminal: { onEvent: () => () => undefined },
        dispose: async () => undefined,
        reconnect: async () => undefined,
      } as unknown as WsRpcClient,
      onConfigUpdated: (next) => writeEnvironmentServerConfig(NODE_A, next),
      pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
      resetShellProjection: () => undefined,
      applyShellEvent: () => undefined,
      syncShellSnapshot: () => undefined,
      applyTerminalEvent: () => undefined,
    });
    hoisted.activeEnvironmentId = NODE_A;
    hoisted.connection = connection;

    useServerStateSync();
    const snapshot = config("from the one stream");
    for (const listener of listeners) {
      listener({ version: 1, type: "snapshot", config: snapshot } as ServerConfigStreamEvent);
    }

    expect(server.subscribeConfig).toHaveBeenCalledOnce();
    expect(getServerConfig()?.environment.label).toBe("from the one stream");
    for (const cleanup of hoisted.cleanups.splice(0)) cleanup();
    void connection.dispose();
  });

  it("publishes nothing without an active connection", () => {
    hoisted.activeEnvironmentId = NODE_A;
    writeEnvironmentServerConfig(NODE_A, config("stored"));
    useServerStateSync();
    expect(hoisted.cleanups).toEqual([]);
    expect(getServerConfig()).toBeNull();
  });
});
