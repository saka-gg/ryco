import { recordWsConnectionOpened, resetWsConnectionStateForTests } from "@ryco/client-runtime/rpc";
import { nodeDirectoryEntries, selectNodeDirectoryTargets } from "@ryco/client-runtime/state/nodes";
import {
  EnvironmentId,
  type AuthSessionState,
  type ExecutionEnvironmentDescriptor,
  type LocalApi,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const session = vi.hoisted(() => ({
  fetchSessionState: vi.fn<() => Promise<Partial<AuthSessionState>>>(),
}));

vi.mock("./primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./primary")>()),
  fetchSessionState: session.fetchSessionState,
}));

import { readNodeCatalog, readNodeCatalogSnapshot, subscribeNodeCatalog } from "./nodeCatalog";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "./primary";
import { resetPrimarySessionRoleForTests } from "./nodeRole";
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
    resetPrimarySessionRoleForTests();
    session.fetchSessionState.mockReset();
    session.fetchSessionState.mockResolvedValue({ authenticated: true, role: "owner" });
  });

  afterEach(async () => {
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    resetPrimarySessionRoleForTests();
    resetWsConnectionStateForTests();
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

  it("leaves a switched-off machine out, as the sidebar does", () => {
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId: MINI,
      label: "mini.local",
      httpBaseUrl: "https://mini.example.com/",
      wsBaseUrl: "wss://mini.example.com/",
      createdAt: "2026-10-22T00:00:00.000Z",
      lastConnectedAt: null,
      disabledAt: "2026-10-23T00:00:00.000Z",
    });
    expect(readNodeCatalog().some((node) => node.environmentId === MINI)).toBe(false);
  });

  it("holds a browser's primary as owner once its own session is the owner's, and publishes to it", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNodeCatalog(listener);
    writePrimaryEnvironmentDescriptor(descriptor(PRIMARY, "Studio", { projectCopy: true }));
    recordWsConnectionOpened({ environmentId: PRIMARY, recordGlobal: false });
    // A browser's own role on the primary is asked for, never assumed.
    expect(session.fetchSessionState).toHaveBeenCalledTimes(1);

    await vi.waitFor(() =>
      expect(readNodeCatalogSnapshot().ownerEnvironmentIds.has(PRIMARY)).toBe(true),
    );
    expect(listener).toHaveBeenCalled();
    const snapshot = readNodeCatalogSnapshot();
    expect(nodeDirectoryEntries(snapshot)).toEqual([
      expect.objectContaining({
        environmentId: PRIMARY,
        label: "Studio",
        projectCopySupport: "yes",
      }),
    ]);
    const publish = vi.fn(async () => undefined);
    expect(
      selectNodeDirectoryTargets(snapshot, {
        admits: () => true,
        connectionFor: () => ({ connection: {}, publish }),
      }).map((target) => target.environmentId),
    ).toEqual([PRIMARY]);
    unsubscribe();
  });

  it("leaves a browser's client session on the primary out of the node directory", async () => {
    session.fetchSessionState.mockResolvedValue({ authenticated: true, role: "client" });
    const unsubscribe = subscribeNodeCatalog(() => undefined);
    writePrimaryEnvironmentDescriptor(descriptor(PRIMARY, "Studio", { projectCopy: true }));
    recordWsConnectionOpened({ environmentId: PRIMARY, recordGlobal: false });

    await vi.waitFor(() =>
      expect(readNodeCatalog()[0]).toMatchObject({ environmentId: PRIMARY, canMutate: false }),
    );
    const snapshot = readNodeCatalogSnapshot();
    expect(snapshot.ownerEnvironmentIds.has(PRIMARY)).toBe(false);
    expect(nodeDirectoryEntries(snapshot)).toEqual([]);
    unsubscribe();
  });

  it("asks for the primary role again once the primary's socket connects", async () => {
    // Before the page signed in, the node knew no session.
    session.fetchSessionState.mockResolvedValueOnce({ authenticated: false });
    const unsubscribe = subscribeNodeCatalog(() => undefined);
    writePrimaryEnvironmentDescriptor(descriptor(PRIMARY, "Studio", { projectCopy: true }));
    await vi.waitFor(() => expect(session.fetchSessionState).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readNodeCatalogSnapshot().ownerEnvironmentIds.has(PRIMARY)).toBe(false);

    recordWsConnectionOpened({ environmentId: PRIMARY, recordGlobal: false });
    await vi.waitFor(() =>
      expect(readNodeCatalogSnapshot().ownerEnvironmentIds.has(PRIMARY)).toBe(true),
    );
    expect(session.fetchSessionState).toHaveBeenCalledTimes(2);
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
