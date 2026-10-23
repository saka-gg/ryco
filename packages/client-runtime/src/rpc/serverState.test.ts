import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
} from "@ryco/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/shared/keybindings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentConnection } from "../connection/connection.ts";
import type { KnownEnvironment } from "../knownEnvironment.ts";
import type { WsRpcClient } from "./wsRpcClient.ts";
import {
  readEnvironmentServerConfig,
  resetEnvironmentServerConfigsForTests,
  writeEnvironmentServerConfig,
} from "./environmentServerConfigs.ts";
import {
  applyServerConfigEvent,
  clearWelcomeState,
  getServerConfig,
  getLegacyServerKeybindings,
  onProvidersUpdated,
  onServerConfigUpdated,
  onWelcome,
  resetServerStateForTests,
  setServerConfigSnapshot,
  startServerStateSync,
} from "./serverState.ts";

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const lifecycleListeners = new Set<(event: ServerLifecycleStreamEvent) => void>();
const configListeners = new Set<(event: ServerConfigStreamEvent) => void>();

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

const baseEnvironment = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    threadSettlement: false,
    threadPriorityRanking: false,
  },
};

const baseServerConfig: ServerConfig = {
  environment: baseEnvironment,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: "ryco_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const serverApi = {
  getConfig: vi.fn<() => Promise<ServerConfig>>(),
  subscribeConfig: vi.fn((listener: (event: ServerConfigStreamEvent) => void) =>
    registerListener(configListeners, listener),
  ),
  subscribeLifecycle: vi.fn((listener: (event: ServerLifecycleStreamEvent) => void) =>
    registerListener(lifecycleListeners, listener),
  ),
};

/** A primary connection over `serverApi`, as the web shell builds it: config goes to the per-environment store. */
function createPrimaryConnection() {
  return createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: {
      environmentId: baseEnvironment.environmentId,
      label: "Local environment",
    } as unknown as KnownEnvironment,
    client: {
      server: serverApi,
      orchestration: { subscribeShell: () => () => undefined },
      terminal: { onEvent: () => () => undefined },
      dispose: async () => undefined,
      reconnect: async () => undefined,
    } as unknown as WsRpcClient,
    onConfigUpdated: (config) =>
      writeEnvironmentServerConfig(baseEnvironment.environmentId, config),
    pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
    resetShellProjection: () => undefined,
    applyShellEvent: () => undefined,
    syncShellSnapshot: () => undefined,
    applyTerminalEvent: () => undefined,
  });
}

let connection = createPrimaryConnection();

function emitLifecycleEvent(event: ServerLifecycleStreamEvent) {
  for (const listener of lifecycleListeners) {
    listener(event);
  }
}

function emitServerConfigEvent(event: ServerConfigStreamEvent) {
  for (const listener of configListeners) {
    listener(event);
  }
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
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
});

describe("serverState", () => {
  it("uses default keybindings before a server config snapshot is available", () => {
    expect(getServerConfig()).toBeNull();
    expect(getLegacyServerKeybindings()).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
  });

  it("keeps the welcome stream only and writes no config of its own", () => {
    const stop = startServerStateSync(connection);

    expect(serverApi.subscribeLifecycle).toHaveBeenCalledOnce();
    // The connection's own config stream carries the config (one stream, one
    // writer: the per-environment store); the sync adds no stream or write.
    expect(serverApi.subscribeConfig).toHaveBeenCalledOnce();
    expect(serverApi.getConfig).not.toHaveBeenCalled();

    emitServerConfigEvent({ version: 1, type: "snapshot", config: baseServerConfig });
    expect(readEnvironmentServerConfig(baseEnvironment.environmentId)).toEqual(baseServerConfig);
    expect(getServerConfig()).toBeNull();

    stop();
  });

  it("takes a config snapshot and replays it to late subscribers", () => {
    const configListener = vi.fn();
    const unsubscribe = onServerConfigUpdated(configListener);

    setServerConfigSnapshot(baseServerConfig);
    expect(getServerConfig()).toEqual(baseServerConfig);
    expect(configListener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "snapshot",
    );

    const lateListener = vi.fn();
    const unsubscribeLate = onServerConfigUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "snapshot",
    );

    unsubscribeLate();
    unsubscribe();
  });

  it("shares one lifecycle subscription between holders of the same connection", () => {
    const stopEarly = startServerStateSync(connection);
    const stopShell = startServerStateSync(connection);

    expect(serverApi.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(lifecycleListeners.size).toBe(1);

    // The first holder letting go (twice, even) leaves the other's stream open.
    stopEarly();
    stopEarly();
    expect(lifecycleListeners.size).toBe(1);

    stopShell();
    expect(lifecycleListeners.size).toBe(0);
    // The connection's config stream is not the sync's to close.
    expect(configListeners.size).toBe(1);

    // A later holder opens a fresh stream.
    const stopAgain = startServerStateSync(connection);
    expect(serverApi.subscribeLifecycle).toHaveBeenCalledTimes(2);
    stopAgain();
  });

  it("replays welcome events to late subscribers", async () => {
    const stop = startServerStateSync(connection);

    const listener = vi.fn();
    const unsubscribe = onWelcome(listener);

    emitLifecycleEvent({
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: baseEnvironment,
        cwd: "/tmp/workspace",
        projectName: "ryco",
        bootstrapProjectId: ProjectId.make("project-1"),
        bootstrapThreadId: ThreadId.make("thread-1"),
      },
    });

    expect(listener).toHaveBeenCalledWith({
      environment: baseEnvironment,
      cwd: "/tmp/workspace",
      projectName: "ryco",
      bootstrapProjectId: ProjectId.make("project-1"),
      bootstrapThreadId: ThreadId.make("thread-1"),
    });

    const lateListener = vi.fn();
    const unsubscribeLate = onWelcome(lateListener);
    expect(lateListener).toHaveBeenCalledWith({
      environment: baseEnvironment,
      cwd: "/tmp/workspace",
      projectName: "ryco",
      bootstrapProjectId: ProjectId.make("project-1"),
      bootstrapThreadId: ThreadId.make("thread-1"),
    });

    unsubscribeLate();
    unsubscribe();
    stop();
  });

  it("resets the welcome alone, leaving the shown config as it is", () => {
    const stop = startServerStateSync(connection);
    setServerConfigSnapshot(baseServerConfig);
    emitLifecycleEvent({
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: { environment: baseEnvironment, cwd: "/workspace", projectName: "ryco" },
    });

    clearWelcomeState();

    const welcomeListener = vi.fn();
    const unsubscribe = onWelcome(welcomeListener);
    expect(welcomeListener).not.toHaveBeenCalled();
    expect(getServerConfig()).toBe(baseServerConfig);
    unsubscribe();
    stop();
  });

  it("merges provider, settings, and keybinding updates into the cached config", () => {
    const configListener = vi.fn();
    const providersListener = vi.fn();
    const unsubscribeConfig = onServerConfigUpdated(configListener);
    const unsubscribeProviders = onProvidersUpdated(providersListener);

    applyServerConfigEvent({ version: 1, type: "snapshot", config: baseServerConfig });
    expect(getServerConfig()).toEqual(baseServerConfig);

    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        status: "warning",
        checkedAt: "2026-01-02T00:00:00.000Z",
        message: "rate limited",
      },
    ];

    const nextKeybindings = [
      {
        command: "commandPalette.toggle",
        shortcut: {
          key: "p",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ] as const;

    applyServerConfigEvent({
      version: 1,
      type: "keybindingsUpdated",
      payload: {
        keybindings: nextKeybindings,
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      },
    });
    applyServerConfigEvent({
      version: 1,
      type: "providerStatuses",
      payload: {
        providers: nextProviders,
      },
    });
    applyServerConfigEvent({
      version: 1,
      type: "settingsUpdated",
      payload: {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          responseStreamingMode: "token",
        },
      },
    });

    expect(getServerConfig()).toEqual({
      ...baseServerConfig,
      keybindings: nextKeybindings,
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: nextProviders,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        responseStreamingMode: "token",
      },
    });

    expect(providersListener).toHaveBeenLastCalledWith({ providers: nextProviders });
    expect(configListener).toHaveBeenNthCalledWith(
      2,
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "keybindingsUpdated",
    );
    expect(configListener).toHaveBeenNthCalledWith(
      3,
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: nextProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "providerStatuses",
    );
    expect(configListener).toHaveBeenLastCalledWith(
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: nextProviders,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          responseStreamingMode: "token",
        },
      },
      "settingsUpdated",
    );

    unsubscribeProviders();
    unsubscribeConfig();
  });
  it("applies a provider delta onto the list the stream sent and reports it as a provider update", () => {
    const configListener = vi.fn();
    const providersListener = vi.fn();
    const unsubscribeConfig = onServerConfigUpdated(configListener);
    const unsubscribeProviders = onProvidersUpdated(providersListener);
    const model = { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null };
    const codex = { ...defaultProviders[0]!, models: [model] };
    const work: ServerProvider = {
      ...codex,
      instanceId: ProviderInstanceId.make("codex-work"),
    };

    applyServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: { ...baseServerConfig, providers: [codex, work] },
    });
    expect(getServerConfig()?.providers).toHaveLength(2);

    const { models: _models, skills: _skills, slashCommands: _slashCommands, ...status } = work;
    applyServerConfigEvent({
      version: 1,
      type: "providerStatusesDelta",
      payload: {
        instanceIds: [work.instanceId, codex.instanceId],
        providers: [{ ...status, status: "error" }],
      },
    });

    const providers = getServerConfig()?.providers ?? [];
    expect(providers.map((provider) => provider.instanceId)).toEqual(["codex-work", "codex"]);
    // The untouched instance keeps its object; the changed one keeps its catalogs.
    expect(providers[1]).toBe(getServerConfig()?.providers[1]);
    expect(providers[0]).toEqual({ ...work, status: "error" });
    expect(providersListener).toHaveBeenLastCalledWith({
      providers: getServerConfig()?.providers,
    });
    expect(configListener).toHaveBeenLastCalledWith(expect.anything(), "providerStatuses");

    unsubscribeProviders();
    unsubscribeConfig();
  });
});
