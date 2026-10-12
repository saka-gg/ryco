import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ServerConfig,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readNewDraftDefaults,
  readRememberedProjectPreferences,
  resetNewDraftDefaultsCacheForTests,
} from "./newDraftDefaults";

const ENVIRONMENT_ID = "environment-1" as EnvironmentId;

afterEach(() => {
  resetNewDraftDefaultsCacheForTests();
});

function config(projectPreferences: boolean, label = "node"): ServerConfig {
  return {
    environment: { label, capabilities: { projectPreferences } },
  } as unknown as ServerConfig;
}

const EFFECTIVE = { marker: "effective" } as unknown as EffectiveProjectPreferences;
const PROJECT_ID = "project-1" as ProjectId;

function api(input: {
  readonly getConfig?: () => Promise<ServerConfig>;
  readonly getProjectPreferences?: () => Promise<EffectiveProjectPreferences>;
}) {
  const getConfig = vi.fn(input.getConfig ?? (() => Promise.resolve(config(true, "fresh"))));
  const getProjectPreferences = vi.fn(
    input.getProjectPreferences ?? (() => Promise.resolve(EFFECTIVE)),
  );
  return {
    api: { server: { getConfig, getProjectPreferences } } as unknown as EnvironmentApi,
    getConfig,
    getProjectPreferences,
  };
}

describe("readNewDraftDefaults", () => {
  it("uses the cached config and reads only the preferences when no fresh read is required", async () => {
    const cached = config(true, "cached");
    const target = api({});

    const defaults = await readNewDraftDefaults({
      api: target.api,
      environmentId: ENVIRONMENT_ID,
      cachedConfig: cached,
      requireFreshConfig: false,
      projectId: PROJECT_ID,
    });

    expect(defaults).toEqual({ config: cached, effective: EFFECTIVE });
    expect(target.getConfig).not.toHaveBeenCalled();
    expect(target.getProjectPreferences).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });

  it("skips every RPC when the cached node has no preferences capability", async () => {
    const cached = config(false, "cached");
    const target = api({});

    await expect(
      readNewDraftDefaults({
        api: target.api,
        environmentId: ENVIRONMENT_ID,
        cachedConfig: cached,
        requireFreshConfig: false,
      }),
    ).resolves.toEqual({ config: cached, effective: null });
    expect(target.getConfig).not.toHaveBeenCalled();
    expect(target.getProjectPreferences).not.toHaveBeenCalled();
  });

  it("falls back to a fresh read when nothing is cached", async () => {
    const target = api({});

    const defaults = await readNewDraftDefaults({
      api: target.api,
      environmentId: ENVIRONMENT_ID,
      cachedConfig: null,
      requireFreshConfig: false,
    });

    expect(defaults.config.environment.label).toBe("fresh");
    expect(defaults.effective).toBe(EFFECTIVE);
    expect(target.getConfig).toHaveBeenCalledOnce();
    expect(target.getProjectPreferences).toHaveBeenCalledOnce();
  });

  it("reads the config and the preferences in parallel for hosted targets the cache shows capable", async () => {
    let resolveConfig: (value: ServerConfig) => void = () => undefined;
    const target = api({
      getConfig: () =>
        new Promise<ServerConfig>((resolve) => {
          resolveConfig = resolve;
        }),
    });

    const pending = readNewDraftDefaults({
      api: target.api,
      environmentId: ENVIRONMENT_ID,
      cachedConfig: config(true, "previous node"),
      requireFreshConfig: true,
    });
    // Both requests are in flight before the config returns.
    await Promise.resolve();
    expect(target.getConfig).toHaveBeenCalledOnce();
    expect(target.getProjectPreferences).toHaveBeenCalledOnce();

    resolveConfig(config(true, "fresh"));
    const defaults = await pending;
    expect(defaults.config.environment.label).toBe("fresh");
    expect(defaults.effective).toBe(EFFECTIVE);
  });

  it("lets only the fresh config decide whether preferences apply", async () => {
    const target = api({
      getConfig: () => Promise.resolve(config(false, "fresh")),
      getProjectPreferences: () => Promise.reject(new Error("unsupported")),
    });

    await expect(
      readNewDraftDefaults({
        api: target.api,
        environmentId: ENVIRONMENT_ID,
        cachedConfig: config(true, "previous node"),
        requireFreshConfig: true,
      }),
    ).resolves.toEqual({ config: config(false, "fresh"), effective: null });
  });

  it("surfaces a preferences failure on a node the fresh config confirms capable", async () => {
    const failure = new Error("preferences failed");
    const target = api({ getProjectPreferences: () => Promise.reject(failure) });

    await expect(
      readNewDraftDefaults({
        api: target.api,
        environmentId: ENVIRONMENT_ID,
        cachedConfig: config(true),
        requireFreshConfig: true,
      }),
    ).rejects.toBe(failure);
  });

  it("keeps hosted reads sequential when the cache does not show the capability", async () => {
    const order: string[] = [];
    const target = api({
      getConfig: async () => {
        order.push("config");
        return config(true, "fresh");
      },
      getProjectPreferences: async () => {
        order.push("preferences");
        return EFFECTIVE;
      },
    });

    await readNewDraftDefaults({
      api: target.api,
      environmentId: ENVIRONMENT_ID,
      cachedConfig: null,
      requireFreshConfig: true,
    });

    expect(order).toEqual(["config", "preferences"]);
  });

  it("opens with the remembered preferences and reads the current ones in the background", async () => {
    const cached = config(true, "cached");
    const first = api({});
    await readNewDraftDefaults({
      api: first.api,
      environmentId: ENVIRONMENT_ID,
      cachedConfig: cached,
      requireFreshConfig: false,
      projectId: PROJECT_ID,
    });
    expect(readRememberedProjectPreferences(ENVIRONMENT_ID, PROJECT_ID)).toBe(EFFECTIVE);

    const NEWER = { marker: "newer" } as unknown as EffectiveProjectPreferences;
    let answer!: (value: EffectiveProjectPreferences) => void;
    const second = api({
      getProjectPreferences: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    // Resolves without waiting for the node.
    const defaults = await readNewDraftDefaults({
      api: second.api,
      environmentId: ENVIRONMENT_ID,
      cachedConfig: cached,
      requireFreshConfig: false,
      projectId: PROJECT_ID,
    });
    expect(defaults.effective).toBe(EFFECTIVE);
    answer(NEWER);
    await expect(defaults.fresh).resolves.toBe(NEWER);
    expect(readRememberedProjectPreferences(ENVIRONMENT_ID, PROJECT_ID)).toBe(NEWER);
  });

  it("never lets a remembered answer decide support", async () => {
    const target = api({});
    await readNewDraftDefaults({
      api: target.api,
      environmentId: ENVIRONMENT_ID,
      cachedConfig: config(true),
      requireFreshConfig: false,
      projectId: PROJECT_ID,
    });
    await expect(
      readNewDraftDefaults({
        api: target.api,
        environmentId: ENVIRONMENT_ID,
        cachedConfig: config(false),
        requireFreshConfig: false,
        projectId: PROJECT_ID,
      }),
    ).resolves.toEqual({ config: config(false), effective: null });
  });
});
