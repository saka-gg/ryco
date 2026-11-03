import { EnvironmentId, type LocalApi } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { acquireNode } from "./acquireNode";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./runtime";

const MINI = EnvironmentId.make("env-mini");

describe("acquireNode", () => {
  beforeEach(async () => {
    vi.stubGlobal("window", {
      nativeApi: {
        persistence: {
          getClientSettings: async () => null,
          setClientSettings: async () => undefined,
          getSavedEnvironmentRegistry: async () => [],
          setSavedEnvironmentRegistry: async () => undefined,
          getSavedEnvironmentSecret: async () => null,
          setSavedEnvironmentSecret: async () => true,
          removeSavedEnvironmentSecret: async () => undefined,
        },
      } satisfies Pick<LocalApi, "persistence">,
    });
    const { __resetLocalApiForTests } = await import("../localApi");
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    const { __resetLocalApiForTests } = await import("../localApi");
    await __resetLocalApiForTests();
    vi.unstubAllGlobals();
  });

  it("refuses a node this client does not know", async () => {
    await expect(acquireNode(EnvironmentId.make("env-unknown"))).rejects.toThrow(
      "This device is not one Ryco knows here.",
    );
  });

  it("refuses a reachable node that would refuse the copy, with the catalog's reason", async () => {
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId: MINI,
      label: "Mac mini",
      httpBaseUrl: "https://mini.example.com/",
      wsBaseUrl: "wss://mini.example.com/",
      createdAt: "2026-10-22T00:00:00.000Z",
      lastConnectedAt: null,
    });
    useSavedEnvironmentRuntimeStore.getState().patch(MINI, {
      connectionState: "connected",
      role: "client",
    });
    await expect(acquireNode(MINI)).rejects.toThrow(
      "Mac mini was paired with limited access; pair it again as its owner to add projects",
    );
  });

  it("refuses a switched-off machine by name, which the catalog leaves out", async () => {
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId: MINI,
      label: "Mac mini",
      httpBaseUrl: "https://mini.example.com/",
      wsBaseUrl: "wss://mini.example.com/",
      createdAt: "2026-10-22T00:00:00.000Z",
      lastConnectedAt: null,
      disabledAt: "2026-10-23T00:00:00.000Z",
    });
    await expect(acquireNode(MINI)).rejects.toThrow("Mac mini is switched off");
  });
});
