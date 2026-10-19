import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCacheRecord,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createInMemoryWorkspaceMetadataCache,
  getBrowserWorkspaceMetadataCache,
  HOSTED_WORKSPACE_METADATA_CACHE_KEY,
} from "./workspaceMetadataCache";

const HUB_ORIGIN = "https://hub.example.test";

function snapshotOf(
  environment: string,
  capturedAt = 1,
  title = "Thread",
): WorkspaceMetadataSnapshot {
  const environmentId = EnvironmentId.make(environment);
  return {
    schemaVersion: 1 as const,
    environmentId,
    capturedAt,
    projects: [
      {
        environmentId,
        id: ProjectId.make("project"),
        name: "Project",
        cwd: "/project",
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [],
    threads: [
      {
        environmentId,
        id: ThreadId.make("thread"),
        projectId: ProjectId.make("project"),
        worktreeId: null,
        title,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: null,
        archivedAt: null,
        modelSelection: null,
        providerDriver: null,
        branch: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        deliveryUnknown: false,
      },
    ],
  };
}

function recordOf(
  snapshot: WorkspaceMetadataSnapshot,
  origin = HUB_ORIGIN,
  accountId = "account-a",
  updatedAt = snapshot.capturedAt,
): WorkspaceMetadataCacheRecord {
  return {
    namespace: { hubOrigin: origin, accountId, environmentId: snapshot.environmentId },
    snapshot,
    payloadBytes: workspaceMetadataPayloadBytes(snapshot),
    updatedAt,
  };
}

function record(origin: string, accountId: string, environment: string, capturedAt = 1) {
  return recordOf(snapshotOf(environment, capturedAt), origin, accountId);
}

describe("hosted browser workspace metadata cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("namespaces colliding environments by normalized Hub origin and account", async () => {
    const cache = createInMemoryWorkspaceMetadataCache();
    await cache.replace(record("HTTPS://HUB.EXAMPLE.TEST/", "account-a", "same", 1));
    await cache.replace(record("https://hub.example.test", "account-b", "same", 2));

    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toHaveLength(1);
    expect(await cache.list({ hubOrigin: `${HUB_ORIGIN}/`, accountId: "account-b" })).toHaveLength(
      1,
    );
    await expect(
      cache.load({
        hubOrigin: "https://HUB.example.test/",
        accountId: "account-a",
        environmentId: EnvironmentId.make("same"),
      }),
    ).resolves.toMatchObject({
      namespace: { hubOrigin: HUB_ORIGIN, accountId: "account-a" },
      updatedAt: 1,
    });
    await expect(
      cache.load({
        hubOrigin: HUB_ORIGIN,
        accountId: "account-c",
        environmentId: EnvironmentId.make("same"),
      }),
    ).resolves.toBeNull();
  });

  it("purges only the requested environment or account namespace", async () => {
    const cache = createInMemoryWorkspaceMetadataCache();
    const first = record(HUB_ORIGIN, "account-a", "one", 1);
    const second = record(HUB_ORIGIN, "account-a", "two", 2);
    const other = record(HUB_ORIGIN, "account-b", "one", 3);
    await cache.replace(first);
    await cache.replace(second);
    await cache.replace(other);

    await cache.purgeEnvironment({ ...first.namespace, hubOrigin: "HTTPS://Hub.Example.Test/" });
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toEqual([second]);
    await cache.purgeAccount({ hubOrigin: "https://hub.example.test/", accountId: "account-a" });
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toEqual([]);
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-b" })).toEqual([other]);
  });

  it("rejects malformed records without storing or evicting anything", async () => {
    const cache = createInMemoryWorkspaceMetadataCache();
    const stored = record(HUB_ORIGIN, "account-a", "one", 1);
    await cache.replace(stored);

    const valid = record(HUB_ORIGIN, "account-a", "two", 2);
    const orphanThread = {
      ...valid.snapshot,
      threads: [{ ...valid.snapshot.threads[0]!, projectId: ProjectId.make("missing") }],
    };
    const malformed: ReadonlyArray<unknown> = [
      null,
      "record",
      { namespace: { accountId: "a" }, secret: "no" },
      { ...valid, namespace: { ...valid.namespace, accountId: "" } },
      { ...valid, snapshot: { ...valid.snapshot, environmentId: EnvironmentId.make("other") } },
      {
        ...valid,
        snapshot: orphanThread,
        payloadBytes: workspaceMetadataPayloadBytes(orphanThread),
      },
      { ...valid, payloadBytes: valid.payloadBytes + 1 },
      { ...valid, payloadBytes: 1.5 },
      { ...valid, updatedAt: -1 },
    ];
    for (const value of malformed) {
      await expect(cache.replace(value as WorkspaceMetadataCacheRecord)).rejects.toThrow(TypeError);
    }
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toEqual([stored]);
  });

  it("evicts the least recently updated environments beyond the entry limit", async () => {
    const cache = createInMemoryWorkspaceMetadataCache();
    for (let index = 0; index <= MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS; index += 1) {
      await cache.replace(record(HUB_ORIGIN, "account-a", `environment-${index}`, index + 1));
    }
    const listed = await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" });
    expect(listed).toHaveLength(MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS);
    expect(listed.map((entry) => entry.namespace.environmentId)).not.toContain("environment-0");
    expect(listed.at(-1)?.namespace.environmentId).toBe(
      `environment-${MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS}`,
    );
  });

  it("evicts older environments for bytes, and refuses a record over the byte limit", async () => {
    const cache = createInMemoryWorkspaceMetadataCache();
    const large = (environment: string, updatedAt: number) =>
      recordOf(
        snapshotOf(environment, updatedAt, "x".repeat(MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES / 2 + 1)),
        HUB_ORIGIN,
        "account-a",
        updatedAt,
      );
    const first = large("first", 1);
    const second = large("second", 2);
    await cache.replace(first);
    await cache.replace(second);
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toEqual([second]);

    const oversized = recordOf(
      snapshotOf("oversized", 3, "x".repeat(MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES)),
      HUB_ORIGIN,
      "account-a",
      3,
    );
    await cache.replace(oversized);
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toEqual([second]);
  });

  it("keeps a refreshed record's arrays and only checks the fixed fields", async () => {
    // Counts each validation walk over an array's rows.
    const walks = { count: 0 };
    const counted = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> => {
      const array = [...items];
      Object.defineProperty(array, Symbol.iterator, {
        value: () => {
          walks.count += 1;
          return Array.prototype.values.call(array);
        },
      });
      return array;
    };
    const base = snapshotOf("one", 1);
    const first = recordOf({
      ...base,
      projects: counted(base.projects),
      worktrees: counted(base.worktrees),
      threads: counted(base.threads),
    });
    const other = record(HUB_ORIGIN, "account-a", "two", 2);
    const cache = createInMemoryWorkspaceMetadataCache();
    await cache.replace(first);
    await cache.replace(other);
    expect(walks.count).toBeGreaterThan(0);

    walks.count = 0;
    const refreshedSnapshot = { ...first.snapshot, capturedAt: 5 };
    const refreshed = recordOf(refreshedSnapshot, HUB_ORIGIN, "account-a", 5);
    await cache.replace(refreshed);
    expect(walks.count).toBe(0);
    const listed = await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" });
    expect(listed.map((entry) => entry.updatedAt)).toEqual([2, 5]);
    expect(listed[1]?.snapshot.capturedAt).toBe(5);
    expect(listed[1]?.snapshot.threads).toBe(first.snapshot.threads);

    // Sharing the arrays does not excuse a wrong environment or a bad envelope.
    await expect(
      cache.replace({
        ...refreshed,
        snapshot: { ...refreshedSnapshot, environmentId: EnvironmentId.make("two") },
      }),
    ).rejects.toThrow(TypeError);
    await expect(cache.replace({ ...refreshed, updatedAt: -1 })).rejects.toThrow(TypeError);
    await expect(
      cache.replace({ ...refreshed, snapshot: { ...refreshedSnapshot, capturedAt: Number.NaN } }),
    ).rejects.toThrow(TypeError);
    expect(walks.count).toBe(0);

    // A new array is validated in full again.
    const changed = { ...refreshedSnapshot, threads: counted(refreshedSnapshot.threads) };
    await cache.replace(recordOf(changed, HUB_ORIGIN, "account-a", 6));
    expect(walks.count).toBeGreaterThan(0);
    const invalid = {
      ...refreshedSnapshot,
      threads: [{ ...refreshedSnapshot.threads[0]!, projectId: ProjectId.make("missing") }],
    };
    await expect(cache.replace(recordOf(invalid, HUB_ORIGIN, "account-a", 7))).rejects.toThrow(
      TypeError,
    );
    expect((await cache.load(refreshed.namespace))?.updatedAt).toBe(6);
  });

  it("serializes writes in call order and survives a rejected write", async () => {
    const cache = createInMemoryWorkspaceMetadataCache();
    const writes = [
      cache.replace(record(HUB_ORIGIN, "account-a", "one", 1)),
      cache.replace({ not: "a record" } as unknown as WorkspaceMetadataCacheRecord),
      cache.replace(record(HUB_ORIGIN, "account-a", "one", 2)),
      cache.purgeEnvironment({
        hubOrigin: HUB_ORIGIN,
        accountId: "account-a",
        environmentId: EnvironmentId.make("one"),
      }),
      cache.replace(record(HUB_ORIGIN, "account-a", "one", 3)),
    ];
    const settled = await Promise.allSettled(writes);
    expect(settled.map((entry) => entry.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toMatchObject([
      { updatedAt: 3 },
    ]);
  });

  it("starts empty and clears the legacy persisted key once", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { removeItem } });
    const cache = getBrowserWorkspaceMetadataCache();
    expect(getBrowserWorkspaceMetadataCache()).toBe(cache);
    expect(removeItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledWith(HOSTED_WORKSPACE_METADATA_CACHE_KEY);
    expect(await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).toEqual([]);
  });
});
