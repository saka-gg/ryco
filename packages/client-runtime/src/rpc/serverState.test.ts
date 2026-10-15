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

import {
  getServerConfig,
  getLegacyServerKeybindings,
  onProvidersUpdated,
  onServerConfigUpdated,
  onWelcome,
  resetServerStateForTests,
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

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  lifecycleListeners.clear();
  configListeners.clear();
  resetServerStateForTests();
});

afterEach(() => {
  resetServerStateForTests();
});

describe("serverState", () => {
  it("uses default keybindings before a server config snapshot is available", () => {
    expect(getServerConfig()).toBeNull();
    expect(getLegacyServerKeybindings()).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
  });

  it("takes the config snapshot from the subscription alone and replays it to late subscribers", async () => {
    const configListener = vi.fn();
    const stop = startServerStateSync(serverApi);
    const unsubscribe = onServerConfigUpdated(configListener);

    emitServerConfigEvent({ version: 1, type: "snapshot", config: baseServerConfig });
    await waitFor(() => {
      expect(getServerConfig()).toEqual(baseServerConfig);
    });

    expect(serverApi.subscribeConfig).toHaveBeenCalledOnce();
    expect(serverApi.subscribeLifecycle).toHaveBeenCalledOnce();
    // The subscription's first item is the snapshot; a parallel read would
    // fetch the same config twice on every connect.
    expect(serverApi.getConfig).not.toHaveBeenCalled();
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
    stop();
  });

  it("shares one lifecycle and config subscription between holders of the same client", () => {
    const stopEarly = startServerStateSync(serverApi);
    const stopShell = startServerStateSync(serverApi);

    expect(serverApi.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(serverApi.subscribeConfig).toHaveBeenCalledOnce();
    expect(lifecycleListeners.size).toBe(1);
    expect(configListeners.size).toBe(1);

    // The first holder letting go (twice, even) leaves the other's streams open.
    stopEarly();
    stopEarly();
    expect(lifecycleListeners.size).toBe(1);
    expect(configListeners.size).toBe(1);

    stopShell();
    expect(lifecycleListeners.size).toBe(0);
    expect(configListeners.size).toBe(0);

    // A later holder opens fresh streams.
    const stopAgain = startServerStateSync(serverApi);
    expect(serverApi.subscribeConfig).toHaveBeenCalledTimes(2);
    stopAgain();
  });

  it("replays welcome events to late subscribers", async () => {
    const stop = startServerStateSync(serverApi);

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

  it("merges provider, settings, and keybinding updates into the cached config", async () => {
    const configListener = vi.fn();
    const providersListener = vi.fn();
    const stop = startServerStateSync(serverApi);
    const unsubscribeConfig = onServerConfigUpdated(configListener);
    const unsubscribeProviders = onProvidersUpdated(providersListener);

    emitServerConfigEvent({ version: 1, type: "snapshot", config: baseServerConfig });
    await waitFor(() => {
      expect(getServerConfig()).toEqual(baseServerConfig);
    });

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

    emitServerConfigEvent({
      version: 1,
      type: "keybindingsUpdated",
      payload: {
        keybindings: nextKeybindings,
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      },
    });
    emitServerConfigEvent({
      version: 1,
      type: "providerStatuses",
      payload: {
        providers: nextProviders,
      },
    });
    emitServerConfigEvent({
      version: 1,
      type: "settingsUpdated",
      payload: {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          enableLegacyTokenStreaming: true,
        },
      },
    });

    await waitFor(() => {
      expect(getServerConfig()).toEqual({
        ...baseServerConfig,
        keybindings: nextKeybindings,
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: nextProviders,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          enableLegacyTokenStreaming: true,
        },
      });
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
          enableLegacyTokenStreaming: true,
        },
      },
      "settingsUpdated",
    );

    unsubscribeProviders();
    unsubscribeConfig();
    stop();
  });
  it("applies a provider delta onto the list the stream sent and reports it as a provider update", async () => {
    const configListener = vi.fn();
    const providersListener = vi.fn();
    const stop = startServerStateSync(serverApi);
    const unsubscribeConfig = onServerConfigUpdated(configListener);
    const unsubscribeProviders = onProvidersUpdated(providersListener);
    const model = { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null };
    const codex = { ...defaultProviders[0]!, models: [model] };
    const work: ServerProvider = {
      ...codex,
      instanceId: ProviderInstanceId.make("codex-work"),
    };

    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: { ...baseServerConfig, providers: [codex, work] },
    });
    await waitFor(() => expect(getServerConfig()?.providers).toHaveLength(2));

    const { models: _models, skills: _skills, slashCommands: _slashCommands, ...status } = work;
    emitServerConfigEvent({
      version: 1,
      type: "providerStatusesDelta",
      payload: {
        instanceIds: [work.instanceId, codex.instanceId],
        providers: [{ ...status, status: "error" }],
      },
    });

    await waitFor(() => {
      const providers = getServerConfig()?.providers ?? [];
      expect(providers.map((provider) => provider.instanceId)).toEqual(["codex-work", "codex"]);
      // The untouched instance keeps its object; the changed one keeps its catalogs.
      expect(providers[1]).toBe(getServerConfig()?.providers[1]);
      expect(providers[0]).toEqual({ ...work, status: "error" });
    });
    expect(providersListener).toHaveBeenLastCalledWith({
      providers: getServerConfig()?.providers,
    });
    expect(configListener).toHaveBeenLastCalledWith(expect.anything(), "providerStatuses");

    unsubscribeProviders();
    unsubscribeConfig();
    stop();
  });
});
