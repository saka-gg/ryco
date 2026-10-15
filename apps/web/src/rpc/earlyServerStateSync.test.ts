import { createEnvironmentConnection } from "@ryco/client-runtime/connection";
import type { KnownEnvironment } from "@ryco/client-runtime/knownEnvironment";
import {
  emitWelcome,
  resetServerStateForTests,
  startServerStateSync,
  type WsRpcClient,
} from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  ThreadId,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerLifecycleWelcomePayload,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EARLY_SERVER_STATE_SYNC_HOLD_MS,
  releaseEarlyPrimaryServerStateSync,
  startEarlyPrimaryServerStateSync,
} from "./earlyServerStateSync";

const lifecycleListeners = new Set<(event: ServerLifecycleStreamEvent) => void>();
const configListeners = new Set<(event: ServerConfigStreamEvent) => void>();

const server = {
  subscribeLifecycle: vi.fn((listener: (event: ServerLifecycleStreamEvent) => void) => {
    lifecycleListeners.add(listener);
    return () => lifecycleListeners.delete(listener);
  }),
  subscribeConfig: vi.fn((listener: (event: ServerConfigStreamEvent) => void) => {
    configListeners.add(listener);
    return () => configListeners.delete(listener);
  }),
};

/** The primary connection as the web shell builds it: no config handler of its own. */
function createPrimaryConnection() {
  return createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local",
    } as unknown as KnownEnvironment,
    client: {
      server,
      orchestration: { subscribeShell: () => () => undefined },
      terminal: { onEvent: () => () => undefined },
      dispose: async () => undefined,
      reconnect: async () => undefined,
    } as unknown as WsRpcClient,
    pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
    resetShellProjection: () => undefined,
    applyShellEvent: () => undefined,
    syncShellSnapshot: () => undefined,
    applyTerminalEvent: () => undefined,
  });
}

let connection = createPrimaryConnection();

function welcome(threadId: string): ServerLifecycleWelcomePayload {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    },
    cwd: "/tmp/workspace",
    projectName: "ryco",
    bootstrapThreadId: ThreadId.make(threadId),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lifecycleListeners.clear();
  configListeners.clear();
  resetServerStateForTests();
  connection = createPrimaryConnection();
});

afterEach(() => {
  releaseEarlyPrimaryServerStateSync();
  vi.useRealTimers();
  resetServerStateForTests();
});

describe("startEarlyPrimaryServerStateSync", () => {
  it("opens the welcome and config streams once and hands them to the shell's hold", () => {
    startEarlyPrimaryServerStateSync(connection);
    expect(server.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(server.subscribeConfig).toHaveBeenCalledOnce();

    // The shell's ServerStateBootstrap: same connection, no second stream.
    const stopShell = startServerStateSync(connection);
    releaseEarlyPrimaryServerStateSync();
    expect(server.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(server.subscribeConfig).toHaveBeenCalledOnce();
    expect(lifecycleListeners.size).toBe(1);
    expect(configListeners.size).toBe(1);

    stopShell();
    expect(lifecycleListeners.size).toBe(0);
    expect(configListeners.size).toBe(0);
  });

  it("runs the first-welcome warm-up once", () => {
    const warm = vi.fn();
    startEarlyPrimaryServerStateSync(connection, { onFirstWelcome: warm });

    emitWelcome(welcome("thread-1"));
    emitWelcome(welcome("thread-2"));

    expect(warm).toHaveBeenCalledOnce();
    expect(warm.mock.calls[0]?.[0].bootstrapThreadId).toBe("thread-1");
  });

  it("closes its streams when the shell never takes them over", () => {
    vi.useFakeTimers();
    startEarlyPrimaryServerStateSync(connection);

    vi.advanceTimersByTime(EARLY_SERVER_STATE_SYNC_HOLD_MS - 1);
    expect(lifecycleListeners.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(lifecycleListeners.size).toBe(0);
    expect(configListeners.size).toBe(0);
  });

  it("opens the config stream only once the provider catalogs have attached", async () => {
    let attachCatalogs!: () => void;
    const catalogsAttached = new Promise<void>((resolve) => {
      attachCatalogs = resolve;
    });
    startEarlyPrimaryServerStateSync(connection, { after: catalogsAttached });
    await Promise.resolve();
    expect(server.subscribeConfig).not.toHaveBeenCalled();
    expect(server.subscribeLifecycle).not.toHaveBeenCalled();

    attachCatalogs();
    await catalogsAttached;
    await Promise.resolve();
    expect(server.subscribeConfig).toHaveBeenCalledOnce();
    expect(server.subscribeLifecycle).toHaveBeenCalledOnce();
  });

  it("opens the streams when the catalog attach rejects", async () => {
    const failed = Promise.reject(new Error("indexeddb unavailable"));
    startEarlyPrimaryServerStateSync(connection, { after: failed });
    await failed.catch(() => undefined);
    await Promise.resolve();
    expect(server.subscribeConfig).toHaveBeenCalledOnce();
  });

  it("opens nothing when the shell takes over before the catalogs attach", async () => {
    let attachCatalogs!: () => void;
    const catalogsAttached = new Promise<void>((resolve) => {
      attachCatalogs = resolve;
    });
    const warm = vi.fn();
    startEarlyPrimaryServerStateSync(connection, { after: catalogsAttached, onFirstWelcome: warm });

    const stopShell = startServerStateSync(connection);
    releaseEarlyPrimaryServerStateSync();
    attachCatalogs();
    await catalogsAttached;
    await Promise.resolve();
    emitWelcome(welcome("thread-1"));

    expect(server.subscribeConfig).toHaveBeenCalledOnce();
    expect(warm).not.toHaveBeenCalled();
    stopShell();
    expect(configListeners.size).toBe(0);
  });
});
