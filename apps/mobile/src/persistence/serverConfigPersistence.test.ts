import {
  getEnvironmentServerConfigsSnapshot,
  isEnvironmentServerConfigSaved,
  resetEnvironmentServerConfigsForTests,
  writeEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { NODE_DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/shared/keybindings";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createMemorySavedQueryStore } from "../rpc/savedQueries.testSupport";
import { hydrateSavedServerConfigs, installServerConfigSaving } from "./serverConfigPersistence";

const ENV = EnvironmentId.make("env-config");

function config(label: string): ServerConfig {
  return {
    environment: {
      environmentId: ENV,
      label,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, threadSettlement: false },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "ryco_session",
    },
    cwd: "/repo",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: NODE_DEFAULT_RESOLVED_KEYBINDINGS,
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  } as ServerConfig;
}

beforeEach(() => {
  resetEnvironmentServerConfigsForTests();
});

describe("saved server configs", () => {
  it("saves each live config and shows it at the next cold start until the node answers", async () => {
    const store = createMemorySavedQueryStore();
    const uninstall = installServerConfigSaving(store);
    writeEnvironmentServerConfig(ENV, config("Mac mini"));
    await store.flush();
    uninstall();
    expect(store.rows.size).toBe(1);

    // Cold start: nothing live yet, the saved config shows and is marked saved.
    resetEnvironmentServerConfigsForTests();
    await hydrateSavedServerConfigs(store, [ENV]);
    expect(getEnvironmentServerConfigsSnapshot().get(ENV)?.environment.label).toBe("Mac mini");
    expect(isEnvironmentServerConfigSaved(ENV)).toBe(true);

    // The saved config is not saved again; the node's own replaces it and is.
    const again = installServerConfigSaving(store);
    store.rows.clear();
    await store.flush();
    expect(store.rows.size).toBe(0);
    writeEnvironmentServerConfig(ENV, config("Mac Studio"));
    await store.flush();
    expect([...store.rows.values()][0]?.payload).toContain("Mac Studio");
    again();
  });

  it("never replaces a live config with a saved one", async () => {
    const store = createMemorySavedQueryStore();
    const uninstall = installServerConfigSaving(store);
    writeEnvironmentServerConfig(ENV, config("Old"));
    await store.flush();
    uninstall();
    resetEnvironmentServerConfigsForTests();
    writeEnvironmentServerConfig(ENV, config("Live"));
    await hydrateSavedServerConfigs(store, [ENV]);
    expect(getEnvironmentServerConfigsSnapshot().get(ENV)?.environment.label).toBe("Live");
  });
});
