import {
  emitWelcome,
  resetServerStateForTests,
  startServerStateSync,
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

const client = {
  subscribeLifecycle: vi.fn((listener: (event: ServerLifecycleStreamEvent) => void) => {
    lifecycleListeners.add(listener);
    return () => lifecycleListeners.delete(listener);
  }),
  subscribeConfig: vi.fn((listener: (event: ServerConfigStreamEvent) => void) => {
    configListeners.add(listener);
    return () => configListeners.delete(listener);
  }),
};

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
});

afterEach(() => {
  releaseEarlyPrimaryServerStateSync();
  vi.useRealTimers();
  resetServerStateForTests();
});

describe("startEarlyPrimaryServerStateSync", () => {
  it("opens the welcome and config streams once and hands them to the shell's hold", () => {
    startEarlyPrimaryServerStateSync(client);
    expect(client.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(client.subscribeConfig).toHaveBeenCalledOnce();

    // The shell's ServerStateBootstrap: same client, no second stream.
    const stopShell = startServerStateSync(client);
    releaseEarlyPrimaryServerStateSync();
    expect(client.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(client.subscribeConfig).toHaveBeenCalledOnce();
    expect(lifecycleListeners.size).toBe(1);
    expect(configListeners.size).toBe(1);

    stopShell();
    expect(lifecycleListeners.size).toBe(0);
    expect(configListeners.size).toBe(0);
  });

  it("runs the first-welcome warm-up once", () => {
    const warm = vi.fn();
    startEarlyPrimaryServerStateSync(client, { onFirstWelcome: warm });

    emitWelcome(welcome("thread-1"));
    emitWelcome(welcome("thread-2"));

    expect(warm).toHaveBeenCalledOnce();
    expect(warm.mock.calls[0]?.[0].bootstrapThreadId).toBe("thread-1");
  });

  it("closes its streams when the shell never takes them over", () => {
    vi.useFakeTimers();
    startEarlyPrimaryServerStateSync(client);

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
    startEarlyPrimaryServerStateSync(client, { after: catalogsAttached });
    await Promise.resolve();
    expect(client.subscribeConfig).not.toHaveBeenCalled();
    expect(client.subscribeLifecycle).not.toHaveBeenCalled();

    attachCatalogs();
    await catalogsAttached;
    await Promise.resolve();
    expect(client.subscribeConfig).toHaveBeenCalledOnce();
    expect(client.subscribeLifecycle).toHaveBeenCalledOnce();
  });

  it("opens the streams when the catalog attach rejects", async () => {
    const failed = Promise.reject(new Error("indexeddb unavailable"));
    startEarlyPrimaryServerStateSync(client, { after: failed });
    await failed.catch(() => undefined);
    await Promise.resolve();
    expect(client.subscribeConfig).toHaveBeenCalledOnce();
  });

  it("opens nothing when the shell takes over before the catalogs attach", async () => {
    let attachCatalogs!: () => void;
    const catalogsAttached = new Promise<void>((resolve) => {
      attachCatalogs = resolve;
    });
    const warm = vi.fn();
    startEarlyPrimaryServerStateSync(client, { after: catalogsAttached, onFirstWelcome: warm });

    const stopShell = startServerStateSync(client);
    releaseEarlyPrimaryServerStateSync();
    attachCatalogs();
    await catalogsAttached;
    await Promise.resolve();
    emitWelcome(welcome("thread-1"));

    expect(client.subscribeConfig).toHaveBeenCalledOnce();
    expect(warm).not.toHaveBeenCalled();
    stopShell();
    expect(configListeners.size).toBe(0);
  });
});
