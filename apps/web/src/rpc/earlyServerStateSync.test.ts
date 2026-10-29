import { createEnvironmentConnection } from "@ryco/client-runtime/connection";
import type { KnownEnvironment } from "@ryco/client-runtime/knownEnvironment";
import {
  emitWelcome,
  getServerConfig,
  getServerConfigUpdatedNotification,
  resetEnvironmentServerConfigsForTests,
  resetServerStateForTests,
  startServerStateSync,
  writeEnvironmentServerConfig,
  type WsRpcClient,
} from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerLifecycleWelcomePayload,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { retainActiveServerConfigProjection } from "./activeServerConfig";
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

/**
 * The primary connection as the web shell builds it: its config handler keeps
 * the connection's one config stream open from the start.
 */
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
    onConfigUpdated: () => undefined,
    pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
    resetShellProjection: () => undefined,
    applyShellEvent: () => undefined,
    syncShellSnapshot: () => undefined,
    applyTerminalEvent: () => undefined,
  });
}

let connection = createPrimaryConnection();

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function configWithProviders(...instanceIds: ReadonlyArray<string>): ServerConfig {
  return {
    environment: { environmentId: PRIMARY_ENVIRONMENT_ID, label: "Local", capabilities: {} },
    issues: [],
    providers: instanceIds.map((instanceId) => ({ instanceId })),
    settings: {},
  } as unknown as ServerConfig;
}

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
  resetEnvironmentServerConfigsForTests();
  connection = createPrimaryConnection();
});

afterEach(() => {
  releaseEarlyPrimaryServerStateSync();
  vi.useRealTimers();
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
  resetPrimaryEnvironmentDescriptorForTests();
});

describe("startEarlyPrimaryServerStateSync", () => {
  it("opens the welcome stream once and hands it to the shell's hold", () => {
    startEarlyPrimaryServerStateSync(connection);
    expect(server.subscribeLifecycle).toHaveBeenCalledOnce();

    // The shell's ServerStateBootstrap: same connection, no second stream.
    const stopShell = startServerStateSync(connection);
    releaseEarlyPrimaryServerStateSync();
    expect(server.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(lifecycleListeners.size).toBe(1);

    stopShell();
    expect(lifecycleListeners.size).toBe(0);
    // The config stream belongs to the connection, not to the sync holds.
    expect(server.subscribeConfig).toHaveBeenCalledOnce();
    expect(configListeners.size).toBe(1);
  });

  it("runs the first-welcome warm-up once", () => {
    const warm = vi.fn();
    startEarlyPrimaryServerStateSync(connection, { onFirstWelcome: warm });

    emitWelcome(welcome("thread-1"));
    emitWelcome(welcome("thread-2"));

    expect(warm).toHaveBeenCalledOnce();
    expect(warm.mock.calls[0]?.[0].bootstrapThreadId).toBe("thread-1");
  });

  it("closes its stream when the shell never takes it over", () => {
    vi.useFakeTimers();
    startEarlyPrimaryServerStateSync(connection);

    vi.advanceTimersByTime(EARLY_SERVER_STATE_SYNC_HOLD_MS - 1);
    expect(lifecycleListeners.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(lifecycleListeners.size).toBe(0);
  });

  it("drops the first-welcome warm-up once the shell has taken the sync over", () => {
    const warm = vi.fn();
    startEarlyPrimaryServerStateSync(connection, { onFirstWelcome: warm });

    const stopShell = startServerStateSync(connection);
    releaseEarlyPrimaryServerStateSync();
    emitWelcome(welcome("thread-1"));

    expect(server.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(warm).not.toHaveBeenCalled();
    stopShell();
    expect(lifecycleListeners.size).toBe(0);
  });

  it("shows the primary's config as it arrives and hands the projection to the shell", () => {
    writePrimaryEnvironmentDescriptor({
      environmentId: PRIMARY_ENVIRONMENT_ID,
    } as unknown as ExecutionEnvironmentDescriptor);
    startEarlyPrimaryServerStateSync(connection);

    // The connection's config arrives while the shell is still loading.
    const first = configWithProviders("codex");
    writeEnvironmentServerConfig(PRIMARY_ENVIRONMENT_ID, first);
    expect(getServerConfig()).toBe(first);
    const announced = getServerConfigUpdatedNotification()?.id;

    // The shell takes its own hold before the boot path lets go: nothing is
    // shown or announced again, and the projection keeps following.
    const stopShell = retainActiveServerConfigProjection();
    releaseEarlyPrimaryServerStateSync();
    expect(getServerConfig()).toBe(first);
    expect(getServerConfigUpdatedNotification()?.id).toBe(announced);
    const second = configWithProviders("codex", "claude");
    writeEnvironmentServerConfig(PRIMARY_ENVIRONMENT_ID, second);
    expect(getServerConfig()).toBe(second);

    stopShell();
    writeEnvironmentServerConfig(PRIMARY_ENVIRONMENT_ID, configWithProviders("gemini"));
    expect(getServerConfig()).toBe(second);
  });

  it("stops showing config once the boot path's hold ends with no shell", () => {
    writePrimaryEnvironmentDescriptor({
      environmentId: PRIMARY_ENVIRONMENT_ID,
    } as unknown as ExecutionEnvironmentDescriptor);
    startEarlyPrimaryServerStateSync(connection);
    const first = configWithProviders("codex");
    writeEnvironmentServerConfig(PRIMARY_ENVIRONMENT_ID, first);

    releaseEarlyPrimaryServerStateSync();
    writeEnvironmentServerConfig(PRIMARY_ENVIRONMENT_ID, configWithProviders("claude"));

    expect(getServerConfig()).toBe(first);
  });
});
