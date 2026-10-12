import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { selectEnvironmentShellLive } from "@ryco/client-runtime/state/threads";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  capturePrimaryShellSnapshot,
  createIndexedDbPrimaryShellCacheStorage,
  hydratePrimaryShellFromCache,
  readPrimaryShellCache,
} from "../persistence/primaryShellCache";
import { createIndexedDbProviderCatalogStore } from "../persistence/providerCatalogStore";
import { selectEnvironmentState, useStore } from "../store";

const environmentId = EnvironmentId.make("environment-browser-primary");
const date = "2026-10-12T00:00:00.000Z";
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: date,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/repo/a",
      defaultModelSelection: null,
      scripts: [],
      createdAt: date,
      updatedAt: date,
    },
  ],
  worktrees: [],
  threads: [
    {
      id: ThreadId.make("thread-a"),
      projectId: ProjectId.make("project-a"),
      title: "Cached thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      goal: null,
      createdAt: date,
      updatedAt: date,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
};

const databases: string[] = [];
afterEach(async () => {
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  for (const name of databases.splice(0)) {
    await new Promise<void>((resolve) => {
      const operation = indexedDB.deleteDatabase(name);
      for (const event of ["success", "error", "blocked"]) {
        operation.addEventListener(event, () => resolve(), { once: true });
      }
    });
  }
});

describe("primary shell cache in IndexedDB", () => {
  it("round-trips the live shell and paints it as last-known state on the next boot", async () => {
    const name = `ryco-primary-shell-test-${crypto.randomUUID()}`;
    databases.push(name);
    const storage = createIndexedDbPrimaryShellCacheStorage(indexedDB, name);
    const origin = window.location.origin;

    useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
    const captured = capturePrimaryShellSnapshot(environmentId, useStore.getState(), 42)!;
    await storage.write({ origin, environmentId, savedAt: 42, snapshot: captured });

    // A new page: nothing in memory, the cache read races the connection.
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    const value = await readPrimaryShellCache(storage, origin);
    expect(hydratePrimaryShellFromCache({ value, environmentId, origin, storage })).toBe(true);

    const state = useStore.getState();
    expect(selectEnvironmentState(state, environmentId).threadIds).toEqual(["thread-a"]);
    expect(selectEnvironmentState(state, environmentId).hydratedFromCacheAt).toBe(42);
    expect(selectEnvironmentShellLive(state, environmentId)).toBe(false);

    await storage.remove(origin);
    expect(await readPrimaryShellCache(storage, origin)).toBeUndefined();
  });

  it("reads nothing, rather than failing the boot, when storage is unusable", async () => {
    const broken = {
      read: () => Promise.reject(new Error("blocked")),
      write: () => Promise.reject(new Error("blocked")),
      remove: () => Promise.reject(new Error("blocked")),
    };
    expect(await readPrimaryShellCache(broken, window.location.origin)).toBeNull();
  });

  it("persists provider catalogs per origin", async () => {
    const name = `ryco-provider-catalogs-test-${crypto.randomUUID()}`;
    databases.push(name);
    const catalog = {
      models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
      skills: [],
      slashCommands: [],
    };
    const store = createIndexedDbProviderCatalogStore({
      factory: indexedDB,
      origin: window.location.origin,
      databaseName: name,
    });
    await store.save([["digest-a", catalog]]);
    expect(await store.load()).toEqual([["digest-a", catalog]]);
    const otherOrigin = createIndexedDbProviderCatalogStore({
      factory: indexedDB,
      origin: "http://localhost:1",
      databaseName: name,
    });
    expect(await otherOrigin.load()).toEqual([]);
    await store.clear();
    expect(await store.load()).toEqual([]);
  });
});
