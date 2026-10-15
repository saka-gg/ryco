import { createEnvironmentConnection } from "@ryco/client-runtime/connection";
import type { KnownEnvironment } from "@ryco/client-runtime/knownEnvironment";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  type WsRpcClient,
} from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  ProjectId,
  type EffectiveProjectPreferences,
  type EnvironmentApi,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  connection: null as unknown,
  cachedConfig: null as unknown,
}));

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: () => harness.connection,
}));
vi.mock("./useChatsAvailability", () => ({
  readEnvironmentServerConfig: () => harness.cachedConfig,
}));

import { readNewDraftDefaults, resetNewDraftDefaultsCacheForTests } from "./newDraftDefaults";
import { readNodeConfig, resolveNodeConfigSource } from "./nodeConfigSource";

const ENVIRONMENT_ID = EnvironmentId.make("environment-hosted");
const PROJECT_ID = ProjectId.make("project-1");
const EFFECTIVE = { marker: "effective" } as unknown as EffectiveProjectPreferences;

function config(label: string): ServerConfig {
  return {
    environment: {
      environmentId: ENVIRONMENT_ID,
      label,
      capabilities: { projectPreferences: true },
    },
    providers: [],
    issues: [],
    keybindings: [],
    settings: { label },
  } as unknown as ServerConfig;
}

function openSocketAttempt() {
  recordWsConnectionAttempt("wss://hub.test/relay", {
    environmentId: ENVIRONMENT_ID,
    recordGlobal: false,
  });
  recordWsConnectionOpened({ environmentId: ENVIRONMENT_ID, recordGlobal: false });
}

/** A hosted primary connection of `generation`, with its config stream observed. */
function hostedConnection(generation: { current: number }) {
  let emit: (event: ServerConfigStreamEvent) => void = () => undefined;
  const subscribeConfig = vi.fn((listener: (event: ServerConfigStreamEvent) => void) => {
    emit = listener;
    return () => undefined;
  });
  const connection = createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: {
      environmentId: ENVIRONMENT_ID,
      label: "Hosted node",
    } as unknown as KnownEnvironment,
    client: {
      server: { subscribeLifecycle: () => () => undefined, subscribeConfig },
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
    lifecycleGeneration: { generation: generation.current, readCurrent: () => generation.current },
  });
  // The shell's server-state sync observes it.
  connection.config.subscribe(() => undefined);
  return {
    connection,
    emitSnapshot: (next: ServerConfig) =>
      emit({ version: 1, type: "snapshot", config: next } as ServerConfigStreamEvent),
  };
}

function nodeApi(freshConfig: ServerConfig) {
  const getConfig = vi.fn(async () => freshConfig);
  const getProjectPreferences = vi.fn(async () => EFFECTIVE);
  return {
    api: { server: { getConfig, getProjectPreferences } } as unknown as EnvironmentApi,
    getConfig,
    getProjectPreferences,
  };
}

function readHostedDraftDefaults(api: EnvironmentApi) {
  return readNewDraftDefaults({
    api,
    environmentId: ENVIRONMENT_ID,
    ...resolveNodeConfigSource(ENVIRONMENT_ID, { currentOnly: true }),
    projectId: PROJECT_ID,
  });
}

beforeEach(() => {
  resetWsConnectionStateForTests();
  openSocketAttempt();
  harness.connection = null;
  harness.cachedConfig = config("previous node (cached)");
});

afterEach(() => {
  resetWsConnectionStateForTests();
  resetNewDraftDefaultsCacheForTests();
});

describe("resolveNodeConfigSource", () => {
  it("keeps the cached config for direct targets", () => {
    expect(resolveNodeConfigSource(ENVIRONMENT_ID, { currentOnly: false })).toEqual({
      cachedConfig: harness.cachedConfig,
      requireFreshConfig: false,
    });
  });

  it("uses a hosted connection's current live config and never the cache", async () => {
    const generation = { current: 7 };
    const hosted = hostedConnection(generation);
    harness.connection = hosted.connection;
    hosted.emitSnapshot(config("current node"));
    const target = nodeApi(config("fresh"));

    const defaults = await readHostedDraftDefaults(target.api);

    expect(target.getConfig).not.toHaveBeenCalled();
    expect(defaults.config.environment.label).toBe("current node");
    expect(defaults.effective).toBe(EFFECTIVE);
  });

  it("reads the config fresh while the hosted connection has no snapshot yet", async () => {
    const hosted = hostedConnection({ current: 7 });
    harness.connection = hosted.connection;
    const target = nodeApi(config("fresh"));

    const defaults = await readHostedDraftDefaults(target.api);

    expect(target.getConfig).toHaveBeenCalledOnce();
    expect(defaults.config.environment.label).toBe("fresh");
  });

  it("reads the config fresh without a connection", async () => {
    const target = nodeApi(config("fresh"));
    await readHostedDraftDefaults(target.api);
    expect(target.getConfig).toHaveBeenCalledOnce();
  });

  it("reads the config fresh once the hosted generation moved on", async () => {
    const generation = { current: 7 };
    const hosted = hostedConnection(generation);
    harness.connection = hosted.connection;
    hosted.emitSnapshot(config("old generation"));
    // A node switch, sign-out or deactivation; the old connection is still registered.
    generation.current = 8;
    const target = nodeApi(config("fresh"));

    const defaults = await readHostedDraftDefaults(target.api);

    expect(target.getConfig).toHaveBeenCalledOnce();
    expect(defaults.config.environment.label).toBe("fresh");
  });

  it("reads the config fresh after a relay reconnect until the new attempt's snapshot", async () => {
    const hosted = hostedConnection({ current: 7 });
    harness.connection = hosted.connection;
    hosted.emitSnapshot(config("lost channel"));
    openSocketAttempt();
    const target = nodeApi(config("fresh"));

    await readHostedDraftDefaults(target.api);
    expect(target.getConfig).toHaveBeenCalledOnce();

    hosted.emitSnapshot(config("replacement channel"));
    const again = await readHostedDraftDefaults(target.api);
    expect(target.getConfig).toHaveBeenCalledOnce();
    expect(again.config.environment.label).toBe("replacement channel");
  });

  it("lets a hosted draft open with the remembered answer once its live config is current", async () => {
    const hosted = hostedConnection({ current: 7 });
    harness.connection = hosted.connection;
    hosted.emitSnapshot(config("current node"));
    const target = nodeApi(config("fresh"));
    await readHostedDraftDefaults(target.api);

    let answer!: (value: EffectiveProjectPreferences) => void;
    target.getProjectPreferences.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const repeat = await readHostedDraftDefaults(target.api);

    // Opened at once with the last answer; the node is asked in the background.
    expect(repeat.effective).toBe(EFFECTIVE);
    expect(repeat.fresh).toBeDefined();
    expect(target.getConfig).not.toHaveBeenCalled();
    answer(EFFECTIVE);
    await expect(repeat.fresh).resolves.toBe(EFFECTIVE);
  });
});

describe("readNodeConfig", () => {
  it("returns the current config without a read and reads only when required", async () => {
    const target = nodeApi(config("fresh"));
    const live = config("live");
    await expect(
      readNodeConfig({ cachedConfig: live, requireFreshConfig: false }, target.api),
    ).resolves.toBe(live);
    expect(target.getConfig).not.toHaveBeenCalled();

    await expect(
      readNodeConfig({ cachedConfig: live, requireFreshConfig: true }, target.api),
    ).resolves.toMatchObject({ environment: { label: "fresh" } });
    await expect(
      readNodeConfig({ cachedConfig: null, requireFreshConfig: false }, target.api),
    ).resolves.toMatchObject({ environment: { label: "fresh" } });
    expect(target.getConfig).toHaveBeenCalledTimes(2);
  });
});
