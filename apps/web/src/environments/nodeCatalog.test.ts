import { EnvironmentId, type ExecutionEnvironmentDescriptor, type LocalApi } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readNodeCatalog, readNodeCatalogSnapshot, subscribeNodeCatalog } from "./nodeCatalog";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "./primary";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./runtime";

const PRIMARY = EnvironmentId.make("env-primary");
const MINI = EnvironmentId.make("env-mini");

function descriptor(
  environmentId: EnvironmentId,
  label: string,
  capabilities: Partial<ExecutionEnvironmentDescriptor["capabilities"]> = {},
): ExecutionEnvironmentDescriptor {
  return {
    environmentId,
    label,
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "1.0.0",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: true,
      threadPriorityRanking: true,
      ...capabilities,
    },
  };
}

describe("node catalog store", () => {
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
    resetPrimaryEnvironmentDescriptorForTests();
  });

  afterEach(async () => {
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    const { __resetLocalApiForTests } = await import("../localApi");
    await __resetLocalApiForTests();
    vi.unstubAllGlobals();
  });

  it("lists the primary and saved environments and follows their stores", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNodeCatalog(listener);
    writePrimaryEnvironmentDescriptor(descriptor(PRIMARY, "Studio"));
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId: MINI,
      label: "mini.local",
      httpBaseUrl: "https://mini.example.com/",
      wsBaseUrl: "wss://mini.example.com/",
      createdAt: "2026-10-22T00:00:00.000Z",
      lastConnectedAt: null,
    });
    expect(listener).toHaveBeenCalled();

    expect(readNodeCatalog()).toEqual([
      expect.objectContaining({ environmentId: PRIMARY, label: "Studio", isPrimary: true }),
      expect.objectContaining({
        environmentId: MINI,
        label: "mini.local",
        presence: "offline",
        canMutate: false,
        mutateBlockedReason: "mini.local is offline",
        projectCopySupport: "unknown",
      }),
    ]);

    useSavedEnvironmentRuntimeStore.getState().patch(MINI, {
      connectionState: "connected",
      role: "owner",
      descriptor: descriptor(MINI, "Mac mini", { projectCopy: true }),
      connectedAt: "2026-10-22T08:00:00.000Z",
    });
    expect(readNodeCatalog().find((node) => node.environmentId === MINI)).toMatchObject({
      label: "Mac mini",
      presence: "online",
      canMutate: true,
      transport: "direct",
      projectCopySupport: "yes",
      platformOs: "darwin",
    });
    expect(readNodeCatalogSnapshot().ownerEnvironmentIds.has(MINI)).toBe(true);
    unsubscribe();
  });

  it("keeps its identity while what it shows is the same", () => {
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId: MINI,
      label: "Mac mini",
      httpBaseUrl: "https://mini.example.com/",
      wsBaseUrl: "wss://mini.example.com/",
      createdAt: "2026-10-22T00:00:00.000Z",
      lastConnectedAt: null,
    });
    const first = readNodeCatalog();
    expect(readNodeCatalog()).toBe(first);
    // A runtime change the catalog does not show leaves it as it was.
    useSavedEnvironmentRuntimeStore.getState().patch(MINI, { lastError: "socket closed" });
    expect(readNodeCatalog()).toBe(first);
    useSavedEnvironmentRuntimeStore.getState().patch(MINI, { connectionState: "connecting" });
    expect(readNodeCatalog()).not.toBe(first);
  });
});
