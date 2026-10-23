import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentConnection } from "../connection/connection.ts";
import type { KnownEnvironment } from "../knownEnvironment.ts";
import {
  clearEnvironmentServerConfigs,
  forgetEnvironmentServerConfig,
  forgetEnvironmentsServerState,
  getEnvironmentServerConfigsSnapshot,
  getReportedThreadCapabilitiesSnapshot,
  getShellSettlementRulesSnapshot,
  isEnvironmentServerConfigShown,
  patchEnvironmentServerSettings,
  readEnvironmentServerConfig,
  recordEnvironmentShellSettlementPolicy,
  resetEnvironmentServerConfigsForTests,
  resolveEnvironmentThreadCapabilities,
  startActiveEnvironmentServerConfigProjection,
  subscribeEnvironmentServerConfigs,
  subscribeReportedThreadCapabilities,
  writeEnvironmentServerConfig,
} from "./environmentServerConfigs.ts";
import {
  applyProvidersUpdated,
  applySettingsUpdated,
  getServerConfig,
  getServerConfigUpdatedNotification,
  onProvidersUpdated,
  onServerConfigUpdated,
  onWelcome,
  emitWelcome,
  resetServerStateForTests,
  setServerConfigSnapshot,
} from "./serverState.ts";
import type { WsRpcClient } from "./wsRpcClient.ts";

const NODE_A = EnvironmentId.make("node-a");
const NODE_B = EnvironmentId.make("node-b");

function provider(instanceId: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function config(environmentId: EnvironmentId, providers: ReadonlyArray<string>): ServerConfig {
  return {
    environment: { environmentId, label: environmentId, capabilities: {} },
    issues: [],
    providers: providers.map(provider),
    settings: DEFAULT_SERVER_SETTINGS,
  } as unknown as ServerConfig;
}

function shownProviderIds(): ReadonlyArray<string> {
  return (getServerConfig()?.providers ?? []).map((entry) => entry.instanceId);
}

/** A hand-driven active-environment source, as the shell supplies one. */
function activeSource(initial: EnvironmentId | null) {
  let active = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      readActive: () => active,
      subscribeActive: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setActive(next: EnvironmentId | null) {
      active = next;
      for (const listener of Array.from(listeners)) listener();
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
});

afterEach(() => {
  resetServerStateForTests();
  resetEnvironmentServerConfigsForTests();
});

describe("environment server config store", () => {
  it("keeps each environment isolated and applies settings snapshots optimistically", () => {
    const first = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, first);
    expect(readEnvironmentServerConfig(NODE_A)).toBe(first);
    expect(readEnvironmentServerConfig(NODE_B)).toBeNull();

    patchEnvironmentServerSettings(NODE_A, { responseStreamingMode: "token" });
    expect(readEnvironmentServerConfig(NODE_A)?.settings.responseStreamingMode).toBe("token");
    // A patch for an environment without a config has nothing to apply to.
    patchEnvironmentServerSettings(NODE_B, { responseStreamingMode: "token" });
    expect(readEnvironmentServerConfig(NODE_B)).toBeNull();
  });

  it("forgets one environment and leaves the others", () => {
    const configA = config(NODE_A, ["codex"]);
    const configB = config(NODE_B, ["claude"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    writeEnvironmentServerConfig(NODE_B, configB);

    forgetEnvironmentServerConfig(NODE_A);

    expect(readEnvironmentServerConfig(NODE_A)).toBeNull();
    expect(readEnvironmentServerConfig(NODE_B)).toBe(configB);
  });

  it("tells whether the global config holds an environment's config", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    writeEnvironmentServerConfig(NODE_B, config(NODE_B, ["claude"]));
    expect(isEnvironmentServerConfigShown(NODE_A)).toBe(false);

    startActiveEnvironmentServerConfigProjection({
      readActive: () => NODE_A,
      subscribeActive: () => () => undefined,
    })();
    expect(isEnvironmentServerConfigShown(NODE_A)).toBe(true);
    expect(isEnvironmentServerConfigShown(NODE_B)).toBe(false);

    // A local overlay of the shown config still belongs to its environment.
    setServerConfigSnapshot({ ...configA, issues: [] });
    expect(isEnvironmentServerConfigShown(NODE_A)).toBe(true);
  });

  it("clears every environment", () => {
    writeEnvironmentServerConfig(NODE_A, config(NODE_A, ["codex"]));
    writeEnvironmentServerConfig(NODE_B, config(NODE_B, ["claude"]));

    clearEnvironmentServerConfigs();

    expect(getEnvironmentServerConfigsSnapshot().size).toBe(0);
  });

  it("notifies only when the stored entries change", () => {
    const listener = vi.fn();
    const stop = subscribeEnvironmentServerConfigs(listener);
    const configA = config(NODE_A, ["codex"]);

    writeEnvironmentServerConfig(NODE_A, configA);
    writeEnvironmentServerConfig(NODE_A, configA);
    expect(listener).toHaveBeenCalledOnce();

    forgetEnvironmentServerConfig(NODE_B);
    clearEnvironmentServerConfigs();
    clearEnvironmentServerConfigs();
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
    writeEnvironmentServerConfig(NODE_A, configA);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("environment thread capabilities", () => {
  function withCapabilities(
    environmentId: EnvironmentId,
    capabilities: { readonly threadSettlement: boolean; readonly threadSnooze?: boolean },
    providers: ReadonlyArray<string> = ["codex"],
  ): ServerConfig {
    const base = config(environmentId, providers);
    return {
      ...base,
      environment: { ...base.environment, capabilities: { ...capabilities } },
    } as ServerConfig;
  }

  it("takes the node's live config over every other source", () => {
    writeEnvironmentServerConfig(
      NODE_A,
      withCapabilities(NODE_A, { threadSettlement: true, threadSnooze: true }),
    );
    expect(
      resolveEnvironmentThreadCapabilities(NODE_A, {
        descriptor: { threadSettlement: false },
        directory: { threadSettlement: false, threadSnooze: false },
      }),
    ).toEqual({ threadSettlement: true, threadSnooze: true });
  });

  it("keeps a node's last answer after its config is forgotten", () => {
    writeEnvironmentServerConfig(NODE_A, withCapabilities(NODE_A, { threadSettlement: true }));
    forgetEnvironmentServerConfig(NODE_A);

    expect(readEnvironmentServerConfig(NODE_A)).toBeNull();
    expect(resolveEnvironmentThreadCapabilities(NODE_A)).toEqual({
      threadSettlement: true,
      threadSnooze: false,
    });
  });

  it("falls back to a node's descriptor, then to the flags a directory states", () => {
    expect(
      resolveEnvironmentThreadCapabilities(NODE_B, {
        descriptor: { threadSettlement: true },
        directory: { threadSettlement: false },
      }),
    ).toEqual({ threadSettlement: true, threadSnooze: false });
    expect(
      resolveEnvironmentThreadCapabilities(NODE_B, { directory: { threadSettlement: false } }),
    ).toEqual({ threadSettlement: false, threadSnooze: "unknown" });
    expect(
      resolveEnvironmentThreadCapabilities(NODE_B, {
        directory: { threadSettlement: true, threadSnooze: true },
      }),
    ).toEqual({ threadSettlement: true, threadSnooze: true });
  });

  it("is unknown for a node nothing has stated anything about", () => {
    const unknown = { threadSettlement: "unknown", threadSnooze: "unknown" };
    expect(resolveEnvironmentThreadCapabilities(NODE_B)).toEqual(unknown);
    expect(resolveEnvironmentThreadCapabilities(NODE_B, { directory: {} })).toEqual(unknown);
    expect(resolveEnvironmentThreadCapabilities(NODE_B, { descriptor: null })).toEqual(unknown);
  });

  it("forgets every answer with the account", () => {
    writeEnvironmentServerConfig(NODE_A, withCapabilities(NODE_A, { threadSettlement: true }));
    forgetEnvironmentServerConfig(NODE_A);
    const listener = vi.fn();
    subscribeReportedThreadCapabilities(listener);

    clearEnvironmentServerConfigs();

    expect(listener).toHaveBeenCalledOnce();
    expect(getReportedThreadCapabilitiesSnapshot().size).toBe(0);
    expect(resolveEnvironmentThreadCapabilities(NODE_A).threadSettlement).toBe("unknown");
  });

  it("changes its snapshot only when a node's answer changes", () => {
    const listener = vi.fn();
    subscribeReportedThreadCapabilities(listener);
    writeEnvironmentServerConfig(NODE_A, withCapabilities(NODE_A, { threadSettlement: true }));
    const snapshot = getReportedThreadCapabilitiesSnapshot();
    const resolved = resolveEnvironmentThreadCapabilities(NODE_A);
    expect(listener).toHaveBeenCalledOnce();

    // Provider and settings pushes carry the same capabilities.
    writeEnvironmentServerConfig(
      NODE_A,
      withCapabilities(NODE_A, { threadSettlement: true }, ["codex", "claude"]),
      "providerStatusesDelta",
    );
    patchEnvironmentServerSettings(NODE_A, { responseStreamingMode: "token" });
    forgetEnvironmentServerConfig(NODE_A);
    expect(getReportedThreadCapabilitiesSnapshot()).toBe(snapshot);
    expect(resolveEnvironmentThreadCapabilities(NODE_A)).toBe(resolved);
    expect(listener).toHaveBeenCalledOnce();

    writeEnvironmentServerConfig(
      NODE_A,
      withCapabilities(NODE_A, { threadSettlement: true, threadSnooze: true }),
    );
    expect(getReportedThreadCapabilitiesSnapshot()).not.toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("environment auto-settle rule", () => {
  function ruleConfig(
    environmentId: EnvironmentId,
    input: {
      readonly nodeAutoSettlement?: boolean;
      readonly threadAutoSettleAfterDays?: 1 | 3 | 7 | 14 | 30 | 90 | null;
    },
  ): ServerConfig {
    const base = config(environmentId, ["codex"]);
    return {
      ...base,
      environment: {
        ...base.environment,
        capabilities: {
          threadSettlement: true,
          ...(input.nodeAutoSettlement === undefined
            ? {}
            : { nodeAutoSettlement: input.nodeAutoSettlement }),
        },
      },
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        ...(input.threadAutoSettleAfterDays === undefined
          ? {}
          : { threadAutoSettleAfterDays: input.threadAutoSettleAfterDays }),
      },
    } as ServerConfig;
  }

  it("takes each node's own rule, the shared default until it sets one", () => {
    writeEnvironmentServerConfig(
      NODE_A,
      ruleConfig(NODE_A, { nodeAutoSettlement: true, threadAutoSettleAfterDays: 30 }),
    );
    writeEnvironmentServerConfig(NODE_B, ruleConfig(NODE_B, { nodeAutoSettlement: true }));
    expect(resolveEnvironmentThreadCapabilities(NODE_A).autoSettleAfterDays).toBe(30);
    expect(resolveEnvironmentThreadCapabilities(NODE_B).autoSettleAfterDays).toBe(7);

    writeEnvironmentServerConfig(
      NODE_B,
      ruleConfig(NODE_B, { nodeAutoSettlement: true, threadAutoSettleAfterDays: null }),
      "settingsUpdated",
    );
    expect(resolveEnvironmentThreadCapabilities(NODE_B).autoSettleAfterDays).toBeNull();
  });

  it("states no rule for a node that leaves it to clients", () => {
    writeEnvironmentServerConfig(NODE_A, ruleConfig(NODE_A, { threadAutoSettleAfterDays: 30 }));
    expect(resolveEnvironmentThreadCapabilities(NODE_A).autoSettleAfterDays).toBeUndefined();
    expect(resolveEnvironmentThreadCapabilities(NODE_B).autoSettleAfterDays).toBeUndefined();
  });

  it("follows a settings push and keeps the last rule after the config is forgotten", () => {
    const listener = vi.fn();
    subscribeReportedThreadCapabilities(listener);
    writeEnvironmentServerConfig(NODE_A, ruleConfig(NODE_A, { nodeAutoSettlement: true }));
    const snapshot = getReportedThreadCapabilitiesSnapshot();
    patchEnvironmentServerSettings(NODE_A, { responseStreamingMode: "token" });
    expect(getReportedThreadCapabilitiesSnapshot()).toBe(snapshot);

    patchEnvironmentServerSettings(NODE_A, { threadAutoSettleAfterDays: 3 });
    expect(getReportedThreadCapabilitiesSnapshot()).not.toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(2);

    forgetEnvironmentServerConfig(NODE_A);
    expect(resolveEnvironmentThreadCapabilities(NODE_A).autoSettleAfterDays).toBe(3);
  });

  it("uses a snapshot's rule only while no live config states one", () => {
    recordEnvironmentShellSettlementPolicy(NODE_A, { autoSettleAfterDays: 14 });
    expect(resolveEnvironmentThreadCapabilities(NODE_A)).toEqual({
      threadSettlement: "unknown",
      threadSnooze: "unknown",
      autoSettleAfterDays: 14,
    });

    // The live config supersedes the snapshot, and a later snapshot does not override it.
    writeEnvironmentServerConfig(
      NODE_A,
      ruleConfig(NODE_A, { nodeAutoSettlement: true, threadAutoSettleAfterDays: 30 }),
    );
    expect(getShellSettlementRulesSnapshot().has(NODE_A)).toBe(false);
    recordEnvironmentShellSettlementPolicy(NODE_A, { autoSettleAfterDays: 1 });
    expect(resolveEnvironmentThreadCapabilities(NODE_A).autoSettleAfterDays).toBe(30);

    // Released: a newer snapshot (another device changed the rule) beats the last known one.
    forgetEnvironmentServerConfig(NODE_A);
    recordEnvironmentShellSettlementPolicy(NODE_A, { autoSettleAfterDays: null });
    expect(resolveEnvironmentThreadCapabilities(NODE_A).autoSettleAfterDays).toBeNull();
    // A snapshot from an older node states nothing.
    recordEnvironmentShellSettlementPolicy(NODE_A, undefined);
    expect(resolveEnvironmentThreadCapabilities(NODE_A).autoSettleAfterDays).toBeNull();
  });

  it("forgets only the listed environments when an account's nodes go", () => {
    writeEnvironmentServerConfig(NODE_A, ruleConfig(NODE_A, { nodeAutoSettlement: true }));
    writeEnvironmentServerConfig(NODE_B, ruleConfig(NODE_B, { nodeAutoSettlement: true }));
    const NODE_C = EnvironmentId.make("node-c");
    recordEnvironmentShellSettlementPolicy(NODE_C, { autoSettleAfterDays: 14 });
    const listener = vi.fn();
    subscribeReportedThreadCapabilities(listener);

    forgetEnvironmentsServerState([NODE_A, NODE_C]);

    expect(listener).toHaveBeenCalledOnce();
    expect(readEnvironmentServerConfig(NODE_A)).toBeNull();
    expect(resolveEnvironmentThreadCapabilities(NODE_A).threadSettlement).toBe("unknown");
    expect(resolveEnvironmentThreadCapabilities(NODE_C).autoSettleAfterDays).toBeUndefined();
    expect(readEnvironmentServerConfig(NODE_B)).not.toBeNull();
    expect(resolveEnvironmentThreadCapabilities(NODE_B).autoSettleAfterDays).toBe(7);

    forgetEnvironmentsServerState([NODE_A]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("forgets snapshot rules with the account", () => {
    recordEnvironmentShellSettlementPolicy(NODE_B, { autoSettleAfterDays: 14 });
    const listener = vi.fn();
    subscribeReportedThreadCapabilities(listener);
    clearEnvironmentServerConfigs();
    expect(listener).toHaveBeenCalledOnce();
    expect(getShellSettlementRulesSnapshot().size).toBe(0);
    expect(resolveEnvironmentThreadCapabilities(NODE_B).autoSettleAfterDays).toBeUndefined();
  });
});

describe("startActiveEnvironmentServerConfigProjection", () => {
  it("publishes the active environment's config and follows its updates", () => {
    const first = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, first);
    const { source } = activeSource(NODE_A);

    const stop = startActiveEnvironmentServerConfigProjection(source);
    expect(getServerConfig()).toBe(first);

    const second = config(NODE_A, ["codex", "claude"]);
    writeEnvironmentServerConfig(NODE_A, second);
    expect(getServerConfig()).toBe(second);
    stop();
  });

  it("shows only the active environment's providers while others write theirs", () => {
    const configA = config(NODE_A, ["codex"]);
    const configB = config(NODE_B, ["claude", "opencode"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const driver = activeSource(NODE_A);
    const stop = startActiveEnvironmentServerConfigProjection(driver.source);
    const updates = vi.fn();
    const stopUpdates = onServerConfigUpdated(updates);
    updates.mockClear();

    // A connection that is not the active one writes its config: nothing is
    // published, announced or replaced.
    writeEnvironmentServerConfig(NODE_B, configB);
    expect(getServerConfig()).toBe(configA);
    expect(updates).not.toHaveBeenCalled();

    // Switching publishes the other entry straight from memory, once.
    driver.setActive(NODE_B);
    expect(getServerConfig()).toBe(configB);
    expect(getServerConfig()?.providers.map((entry) => entry.instanceId)).toEqual([
      "claude",
      "opencode",
    ]);
    expect(updates).toHaveBeenCalledOnce();

    driver.setActive(NODE_A);
    expect(getServerConfig()).toBe(configA);
    expect(updates).toHaveBeenCalledTimes(2);
    stopUpdates();
    stop();
  });

  it("publishes an unchanged config object once", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const driver = activeSource(NODE_A);
    const stop = startActiveEnvironmentServerConfigProjection(driver.source);
    const updates = vi.fn();
    const providers = vi.fn();
    const stopUpdates = onServerConfigUpdated(updates);
    const stopProviders = onProvidersUpdated(providers);
    updates.mockClear();
    providers.mockClear();

    // Writes of the same object, and active-environment notifications that
    // change nothing, announce nothing.
    writeEnvironmentServerConfig(NODE_A, configA);
    driver.setActive(NODE_A);
    expect(updates).not.toHaveBeenCalled();
    expect(providers).not.toHaveBeenCalled();
    expect(getServerConfigUpdatedNotification()?.id).toBe(1);

    writeEnvironmentServerConfig(NODE_A, config(NODE_A, ["codex", "claude"]));
    expect(updates).toHaveBeenCalledOnce();
    expect(providers).toHaveBeenCalledOnce();
    stopProviders();
    stopUpdates();
    stop();
  });

  it("does not announce an entry a restarted projection finds already shown", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const driver = activeSource(NODE_A);
    startActiveEnvironmentServerConfigProjection(driver.source)();
    const updates = vi.fn();
    const stopUpdates = onServerConfigUpdated(updates);
    updates.mockClear();

    const stop = startActiveEnvironmentServerConfigProjection(driver.source);

    expect(getServerConfig()).toBe(configA);
    expect(updates).not.toHaveBeenCalled();
    stopUpdates();
    stop();
  });

  it("resets the config atoms, not welcome, when the active entry is forgotten", () => {
    const configA = config(NODE_A, ["codex"]);
    const configB = config(NODE_B, ["claude"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    writeEnvironmentServerConfig(NODE_B, configB);
    const driver = activeSource(NODE_A);
    const stop = startActiveEnvironmentServerConfigProjection(driver.source);
    const welcome = {
      environment: configA.environment,
      cwd: "/workspace",
      projectName: "ryco",
    } as Parameters<typeof emitWelcome>[0];
    emitWelcome(welcome);

    // Forgetting an environment that is not shown changes nothing.
    forgetEnvironmentServerConfig(NODE_B);
    expect(getServerConfig()).toBe(configA);

    forgetEnvironmentServerConfig(NODE_A);
    expect(getServerConfig()).toBeNull();
    expect(getServerConfigUpdatedNotification()).toBeNull();
    const welcomeListener = vi.fn();
    const stopWelcome = onWelcome(welcomeListener);
    expect(welcomeListener).toHaveBeenCalledWith(welcome);

    // The environment's next snapshot shows again.
    const next = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, next);
    expect(getServerConfig()).toBe(next);
    stopWelcome();
    stop();
  });

  it("shows no config for an active environment that has none yet, and none without one", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const driver = activeSource(NODE_A);
    const stop = startActiveEnvironmentServerConfigProjection(driver.source);
    expect(getServerConfig()).toBe(configA);

    driver.setActive(NODE_B);
    expect(getServerConfig()).toBeNull();
    const snapshot = config(NODE_B, ["claude"]);
    writeEnvironmentServerConfig(NODE_B, snapshot);
    expect(getServerConfig()).toBe(snapshot);

    driver.setActive(null);
    expect(getServerConfig()).toBeNull();
    stop();
  });

  it("announces an update as the event that produced it, and a switch as a snapshot", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const driver = activeSource(NODE_A);
    const stop = startActiveEnvironmentServerConfigProjection(driver.source);
    const sources: Array<string> = [];
    const providers = vi.fn();
    const stopUpdates = onServerConfigUpdated((_payload, source) => sources.push(source));
    const stopProviders = onProvidersUpdated(providers);
    sources.length = 0;
    providers.mockClear();

    writeEnvironmentServerConfig(NODE_A, config(NODE_A, ["codex"]), "settingsUpdated");
    writeEnvironmentServerConfig(NODE_A, config(NODE_A, ["codex"]), "keybindingsUpdated");
    expect(sources).toEqual(["settingsUpdated", "keybindingsUpdated"]);
    expect(providers).not.toHaveBeenCalled();

    // A provider delta reports as a provider status change and names providers.
    writeEnvironmentServerConfig(
      NODE_A,
      config(NODE_A, ["codex", "claude"]),
      "providerStatusesDelta",
    );
    expect(sources.at(-1)).toBe("providerStatuses");
    expect(providers).toHaveBeenCalledOnce();

    // Everything about the other environment is new to the UI, whatever its
    // last update was.
    providers.mockClear();
    writeEnvironmentServerConfig(NODE_B, config(NODE_B, ["gemini"]), "settingsUpdated");
    driver.setActive(NODE_B);
    expect(sources.at(-1)).toBe("snapshot");
    expect(providers).toHaveBeenCalledOnce();

    patchEnvironmentServerSettings(NODE_B, { responseStreamingMode: "token" });
    expect(sources.at(-1)).toBe("settingsUpdated");
    stopProviders();
    stopUpdates();
    stop();
  });

  it("keeps a local settings write through provider updates until the node's settings arrive", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const stop = startActiveEnvironmentServerConfigProjection(activeSource(NODE_A).source);
    const optimistic = { ...DEFAULT_SERVER_SETTINGS, responseStreamingMode: "token" as const };
    applySettingsUpdated(optimistic);
    expect(getServerConfig()?.settings).toBe(optimistic);

    // The node reports a provider change before it confirms the settings write.
    const withClaude = {
      ...configA,
      providers: [provider("codex"), provider("claude")],
    };
    writeEnvironmentServerConfig(NODE_A, withClaude, "providerStatusesDelta");
    expect(getServerConfig()?.settings).toBe(optimistic);
    expect(shownProviderIds()).toEqual(["codex", "claude"]);

    writeEnvironmentServerConfig(NODE_A, { ...withClaude, issues: [] }, "keybindingsUpdated");
    expect(getServerConfig()?.settings).toBe(optimistic);

    // The node's settings event replaces the write and keeps the providers.
    const confirmed = { ...DEFAULT_SERVER_SETTINGS, responseStreamingMode: "turn" as const };
    writeEnvironmentServerConfig(NODE_A, { ...withClaude, settings: confirmed }, "settingsUpdated");
    expect(getServerConfig()?.settings).toBe(confirmed);
    expect(shownProviderIds()).toEqual(["codex", "claude"]);
    stop();
  });

  it("keeps a local provider write through settings updates until the node's providers arrive", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const stop = startActiveEnvironmentServerConfigProjection(activeSource(NODE_A).source);
    const refreshed = [provider("codex"), provider("gemini")];
    applyProvidersUpdated({ providers: refreshed });
    expect(getServerConfig()?.providers).toBe(refreshed);

    const settings = { ...DEFAULT_SERVER_SETTINGS, responseStreamingMode: "token" as const };
    writeEnvironmentServerConfig(NODE_A, { ...configA, settings }, "settingsUpdated");
    expect(getServerConfig()?.settings).toBe(settings);
    expect(getServerConfig()?.providers).toBe(refreshed);

    const reported = { ...configA, settings, providers: [provider("claude")] };
    writeEnvironmentServerConfig(NODE_A, reported, "providerStatusesDelta");
    expect(getServerConfig()).toBe(reported);
    stop();
  });

  it("lets a snapshot or a switch of environment replace local writes", () => {
    const configA = config(NODE_A, ["codex"]);
    const configB = config(NODE_B, ["claude"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    writeEnvironmentServerConfig(NODE_B, configB);
    const driver = activeSource(NODE_A);
    const stop = startActiveEnvironmentServerConfigProjection(driver.source);
    applySettingsUpdated({ ...DEFAULT_SERVER_SETTINGS, responseStreamingMode: "token" });

    const snapshot = config(NODE_A, ["codex", "opencode"]);
    writeEnvironmentServerConfig(NODE_A, snapshot);
    expect(getServerConfig()).toBe(snapshot);

    applySettingsUpdated({ ...DEFAULT_SERVER_SETTINGS, responseStreamingMode: "token" });
    driver.setActive(NODE_B);
    expect(getServerConfig()).toBe(configB);
    driver.setActive(NODE_A);
    expect(getServerConfig()).toBe(snapshot);
    stop();
  });

  it("stops following once disposed", () => {
    const configA = config(NODE_A, ["codex"]);
    writeEnvironmentServerConfig(NODE_A, configA);
    const driver = activeSource(NODE_A);
    const stop = startActiveEnvironmentServerConfigProjection(driver.source);

    stop();

    expect(driver.listenerCount()).toBe(0);
    writeEnvironmentServerConfig(NODE_A, config(NODE_A, ["claude"]));
    driver.setActive(NODE_B);
    expect(getServerConfig()).toBe(configA);
  });
});

describe("a connection writing its config before any projection runs", () => {
  function connectWithConfigHandler(generation: { current: number }) {
    const streams: Array<(event: ServerConfigStreamEvent) => void> = [];
    const subscribeConfig = vi.fn((listener: (event: ServerConfigStreamEvent) => void) => {
      streams.push(listener);
      return () => undefined;
    });
    const client = {
      server: { subscribeLifecycle: () => () => undefined, subscribeConfig },
      orchestration: { subscribeShell: () => () => undefined },
      terminal: { onEvent: () => () => undefined },
      dispose: async () => undefined,
      reconnect: async () => undefined,
    } as unknown as WsRpcClient;
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: { environmentId: NODE_A, label: "Node A" } as unknown as KnownEnvironment,
      client,
      lifecycleGeneration: { generation: 1, readCurrent: () => generation.current },
      onConfigUpdated: (next, type) => writeEnvironmentServerConfig(NODE_A, next, type),
      pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
      resetShellProjection: () => undefined,
      applyShellEvent: () => undefined,
      syncShellSnapshot: () => undefined,
      applyTerminalEvent: () => undefined,
    });
    return { subscribeConfig, emit: (event: ServerConfigStreamEvent) => streams[0]?.(event) };
  }

  it("fills the store from the connection's config stream, ahead of the shell", () => {
    const generation = { current: 1 };
    const node = connectWithConfigHandler(generation);

    // The stream opens with the connection: no shell or projection exists yet.
    expect(node.subscribeConfig).toHaveBeenCalledOnce();
    const snapshot = config(NODE_A, ["codex"]);
    node.emit({ version: 1, type: "snapshot", config: snapshot } as ServerConfigStreamEvent);
    const stored = readEnvironmentServerConfig(NODE_A);
    expect(stored).toEqual(snapshot);
    expect(getServerConfig()).toBeNull();

    // The shell's projection, once it mounts, shows the entry from memory.
    const stop = startActiveEnvironmentServerConfigProjection({
      readActive: () => NODE_A,
      subscribeActive: () => () => undefined,
    });
    expect(getServerConfig()).toBe(stored);

    node.emit({
      version: 1,
      type: "settingsUpdated",
      payload: { settings: { ...DEFAULT_SERVER_SETTINGS, responseStreamingMode: "token" } },
    } as ServerConfigStreamEvent);
    expect(getServerConfig()?.settings.responseStreamingMode).toBe("token");
    expect(getServerConfigUpdatedNotification()?.source).toBe("settingsUpdated");
    stop();
  });

  it("writes nothing once its hosted generation has moved on", () => {
    const generation = { current: 1 };
    const node = connectWithConfigHandler(generation);
    node.emit({
      version: 1,
      type: "snapshot",
      config: config(NODE_A, ["codex"]),
    } as ServerConfigStreamEvent);
    const stored = readEnvironmentServerConfig(NODE_A);
    expect(stored).not.toBeNull();

    generation.current = 2;
    node.emit({
      version: 1,
      type: "snapshot",
      config: config(NODE_A, ["claude"]),
    } as ServerConfigStreamEvent);

    expect(readEnvironmentServerConfig(NODE_A)).toBe(stored);
  });
});
