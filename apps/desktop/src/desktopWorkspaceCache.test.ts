import * as FS from "node:fs";
import * as FSPromises from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { EnvironmentId, ProjectId } from "@ryco/contracts";
import {
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  isWorkspaceMetadataSnapshot,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCacheRecord,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopWorkspaceMetadataCache as createUntrackedCache,
  type DesktopWorkspaceMetadataCache,
} from "./desktopWorkspaceCache.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

vi.mock("@ryco/client-runtime/state/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/state/workspace")>();
  return {
    ...actual,
    isWorkspaceMetadataSnapshot: vi.fn(actual.isWorkspaceMetadataSnapshot),
    workspaceMetadataPayloadBytes: vi.fn(actual.workspaceMetadataPayloadBytes),
  };
});

const temporaryDirectories: string[] = [];
const openCaches: DesktopWorkspaceMetadataCache[] = [];

/** Every cache is disposed after its test so no deferred write outlives its directory. */
function createDesktopWorkspaceMetadataCache(filePath: string): DesktopWorkspaceMetadataCache {
  const cache = createUntrackedCache(filePath);
  openCaches.push(cache);
  return cache;
}

function temporaryFile(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-desktop-workspace-cache-"));
  temporaryDirectories.push(directory);
  return Path.join(directory, "desktop-workspace-client", "metadata-v1.json");
}

function record(environment: string, capturedAt = 1): WorkspaceMetadataCacheRecord {
  const environmentId = EnvironmentId.make(environment);
  const snapshot = {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt,
    projects: [
      {
        environmentId,
        id: ProjectId.make("shared"),
        name: environment,
        cwd: `/${environment}`,
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [],
    threads: [],
  };
  return {
    namespace: { hubOrigin: "https://hub.example", accountId: "account-a", environmentId },
    snapshot,
    payloadBytes: workspaceMetadataPayloadBytes(snapshot),
    updatedAt: capturedAt,
  };
}

const writeFile = vi.mocked(FSPromises.writeFile);
const validate = vi.mocked(isWorkspaceMetadataSnapshot);
const measure = vi.mocked(workspaceMetadataPayloadBytes);

beforeEach(() => {
  writeFile.mockClear();
  validate.mockClear();
  measure.mockClear();
});

afterEach(async () => {
  await Promise.all(openCaches.splice(0).map((cache) => cache.dispose().catch(() => undefined)));
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop workspace metadata cache", () => {
  it("serializes reads with pending writes and persists purges across restarts", async () => {
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    const item = record("local");
    const writing = cache.replace(item);
    const reading = cache.load(item.namespace);
    const purging = cache.purgeEnvironment(item.namespace);
    const after = cache.load(item.namespace);
    await writing;
    expect(await reading).toEqual(item);
    await purging;
    expect(await after).toBeNull();
    expect(await createDesktopWorkspaceMetadataCache(file).load(item.namespace)).toBeNull();
  });

  it("keeps colliding resource ids in exact environment namespaces", async () => {
    const cache = createDesktopWorkspaceMetadataCache(temporaryFile());
    await cache.replace(record("local", 10));
    await cache.replace(record("remote", 20));

    expect(
      await cache.list({ hubOrigin: "https://hub.example/", accountId: "account-a" }),
    ).toHaveLength(2);
    expect(
      (
        await cache.load({
          hubOrigin: "https://hub.example",
          accountId: "account-a",
          environmentId: EnvironmentId.make("local"),
        })
      )?.snapshot.projects[0]?.cwd,
    ).toBe("/local");
  });

  it("rejects non-metadata payloads and purges only the requested account", async () => {
    const filePath = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(filePath);
    await cache.replace(record("local"));
    const remote = record("remote");
    for (const invalid of [
      { ...remote, snapshot: { ...remote.snapshot, environmentId: EnvironmentId.make("local") } },
      { ...remote, payloadBytes: -1 },
      { ...remote, payloadBytes: 1.5 },
      { ...remote, updatedAt: -1 },
      { ...remote, namespace: { ...remote.namespace, accountId: "" } },
      { ...remote, snapshot: null },
    ]) {
      await expect(cache.replace(invalid as WorkspaceMetadataCacheRecord)).rejects.toThrow(
        "Invalid Desktop workspace metadata record",
      );
    }

    await cache.flush();
    const serialized = FS.readFileSync(filePath, "utf8");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("message");
    await cache.purgeAccount({ hubOrigin: "https://hub.example", accountId: "account-a" });
    expect(await cache.list({ hubOrigin: "https://hub.example", accountId: "account-a" })).toEqual(
      [],
    );
  });

  it("uses a client-only path separate from backend state", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-desktop-workspace-root-"));
    temporaryDirectories.push(root);
    const clientPath = Path.join(root, "desktop-workspace-client", "metadata-v1.json");
    const backendPath = Path.join(root, "settings.json");
    FS.writeFileSync(backendPath, '{"node":"owned"}\n');
    const cache = createDesktopWorkspaceMetadataCache(clientPath);
    await cache.replace(record("local"));
    await cache.flush();

    expect(FS.readFileSync(backendPath, "utf8")).toBe('{"node":"owned"}\n');
    expect(FS.existsSync(clientPath)).toBe(true);
  });
});

describe("Desktop workspace metadata cache writes", () => {
  const fileRecords = (file: string): WorkspaceMetadataCacheRecord[] =>
    (JSON.parse(FS.readFileSync(file, "utf8")) as { records: WorkspaceMetadataCacheRecord[] })
      .records;

  function fakeClock() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  }

  it("serves a change from memory at once and writes it after a quiet period", async () => {
    fakeClock();
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    const item = record("local");
    await cache.replace(item);

    expect(await cache.load(item.namespace)).toEqual(item);
    vi.advanceTimersByTime(1_999);
    await cache.load(item.namespace);
    expect(FS.existsSync(file)).toBe(false);

    vi.advanceTimersByTime(1);
    await cache.flush();
    expect(fileRecords(file)).toEqual([item]);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("writes a burst of changes once, after the burst", async () => {
    fakeClock();
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    for (const capturedAt of [1, 2, 3, 4, 5]) {
      await cache.replace(record("local", capturedAt));
      vi.advanceTimersByTime(1_500);
    }
    await cache.replace(record("remote", 6));
    expect(writeFile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    await cache.flush();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(
      fileRecords(file).map((entry) => [entry.namespace.environmentId, entry.updatedAt]),
    ).toEqual([
      ["local", 5],
      ["remote", 6],
    ]);
  });

  it("never defers a change beyond the maximum wait", async () => {
    fakeClock();
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    // A change every 1.5 s keeps resetting the quiet period.
    for (let capturedAt = 1; capturedAt <= 6; capturedAt += 1) {
      await cache.replace(record("local", capturedAt));
      vi.advanceTimersByTime(1_500);
    }
    expect(writeFile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    await cache.flush();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(fileRecords(file).map((entry) => entry.updatedAt)).toEqual([6]);

    // The next change starts a new wait.
    await cache.replace(record("local", 7));
    vi.advanceTimersByTime(1_999);
    await cache.load(record("local").namespace);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("writes at once on purge, including changes still waiting", async () => {
    fakeClock();
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    await cache.replace(record("local"));
    await cache.replace(record("remote"));
    expect(FS.existsSync(file)).toBe(false);

    await cache.purgeEnvironment(record("local").namespace);
    expect(fileRecords(file).map((entry) => entry.namespace.environmentId)).toEqual(["remote"]);

    await cache.replace(record("local"));
    await cache.purgeAccount({ hubOrigin: "https://hub.example", accountId: "account-a" });
    expect(fileRecords(file)).toEqual([]);
    expect(writeFile).toHaveBeenCalledTimes(2);

    // Nothing is left waiting.
    vi.advanceTimersByTime(20_000);
    await cache.flush();
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it("validates and measures what it reads from disk, but not what replace is handed", async () => {
    const file = temporaryFile();
    const good = record("local");
    const wrongSize = { ...record("remote"), payloadBytes: 1 };
    const broken = record("broken");
    // A thread of a project the snapshot does not have.
    const orphanThread = {
      environmentId: broken.namespace.environmentId,
      id: "thread-1",
      projectId: "missing",
    };
    const brokenSnapshot = {
      ...broken,
      snapshot: { ...broken.snapshot, threads: [orphanThread] },
    };
    const extra = record("extra");
    FS.mkdirSync(Path.dirname(file), { recursive: true });
    FS.writeFileSync(
      file,
      JSON.stringify({ version: 1, records: [good, wrongSize, brokenSnapshot] }),
    );
    validate.mockClear();
    measure.mockClear();

    const cache = createDesktopWorkspaceMetadataCache(file);
    const listed = await cache.list({ hubOrigin: "https://hub.example", accountId: "account-a" });
    expect(listed.map((entry) => entry.namespace.environmentId)).toEqual(["local"]);
    expect(validate).toHaveBeenCalledTimes(3);
    // The record whose snapshot is invalid is never measured.
    expect(measure).toHaveBeenCalledTimes(2);

    validate.mockClear();
    measure.mockClear();
    await cache.replace(extra);
    expect(validate).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(await cache.load(extra.namespace)).toBe(extra);
  });

  it("writes a purge that removes nothing when the file still holds discarded records", async () => {
    const file = temporaryFile();
    const fileEnvironments = () => fileRecords(file).map((entry) => entry.namespace.environmentId);
    FS.mkdirSync(Path.dirname(file), { recursive: true });
    FS.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        records: [record("local"), { ...record("remote"), payloadBytes: 1 }],
      }),
    );
    const cache = createDesktopWorkspaceMetadataCache(file);
    await cache.list({ hubOrigin: "https://hub.example", accountId: "account-a" });
    expect(fileEnvironments()).toEqual(["local", "remote"]);

    await cache.purgeAccount({ hubOrigin: "https://hub.example", accountId: "account-b" });
    expect(fileEnvironments()).toEqual(["local"]);
    expect(writeFile).toHaveBeenCalledTimes(1);

    // The file now matches the document, so the next such purge writes nothing.
    await cache.purgeEnvironment(record("elsewhere").namespace);
    expect(writeFile).toHaveBeenCalledTimes(1);

    // The same holds for a file that cannot be read as a cache at all.
    const unreadable = temporaryFile();
    FS.mkdirSync(Path.dirname(unreadable), { recursive: true });
    FS.writeFileSync(unreadable, "not a cache");
    const second = createDesktopWorkspaceMetadataCache(unreadable);
    await second.purgeEnvironment(record("local").namespace);
    expect(fileRecords(unreadable)).toEqual([]);
  });

  it("does not rewrite the file for a purge that removes nothing", async () => {
    fakeClock();
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    await cache.replace(record("local"));
    await cache.flush();
    writeFile.mockClear();

    await cache.purgeEnvironment(record("remote").namespace);
    await cache.purgeAccount({ hubOrigin: "https://hub.example", accountId: "account-b" });
    expect(writeFile).not.toHaveBeenCalled();
    expect(fileRecords(file)).toHaveLength(1);
  });

  it("flushes on dispose and writes every later change at once", async () => {
    fakeClock();
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    await cache.replace(record("local", 1));
    expect(FS.existsSync(file)).toBe(false);

    await cache.dispose();
    expect(fileRecords(file).map((entry) => entry.updatedAt)).toEqual([1]);

    await cache.replace(record("local", 2));
    expect(fileRecords(file).map((entry) => entry.updatedAt)).toEqual([2]);
  });

  it("persists what is waiting when the process exits", async () => {
    fakeClock();
    const file = temporaryFile();
    const hooksBefore = new Set(process.listeners("exit"));
    const cache = createDesktopWorkspaceMetadataCache(file);
    await cache.replace(record("local", 3));
    const hooks = process.listeners("exit").filter((listener) => !hooksBefore.has(listener));
    expect(hooks).toHaveLength(1);
    expect(FS.existsSync(file)).toBe(false);

    hooks[0]!(0);
    expect(fileRecords(file).map((entry) => entry.updatedAt)).toEqual([3]);

    // Once written, nothing is waiting and the hook is gone.
    await cache.flush();
    expect(process.listeners("exit").filter((listener) => !hooksBefore.has(listener))).toEqual([]);
  });

  it("keeps a change whose write failed and writes it on the next attempt", async () => {
    fakeClock();
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    await cache.replace(record("local", 1));
    writeFile.mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(cache.flush()).rejects.toThrow("disk unavailable");
    expect(await cache.load(record("local").namespace)).toMatchObject({ updatedAt: 1 });
    expect(FS.existsSync(file)).toBe(false);

    await cache.flush();
    expect(fileRecords(file).map((entry) => entry.updatedAt)).toEqual([1]);
  });
});
