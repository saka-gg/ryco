import { describe, expect, it } from "vite-plus/test";

import { createSnapshotDb, payloadByteLength, type SnapshotDbHandle } from "./snapshotDb";

// Real SQL against node:sqlite, adapted to the expo-sqlite method names the
// store uses. This exercises the actual DDL and upsert paths; the expo-sqlite
// native module itself cannot load in the node runner.
async function openNodeSqliteHandle(): Promise<SnapshotDbHandle> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  return {
    execAsync: async (source) => {
      db.exec(source);
    },
    runAsync: async (source, params) => db.prepare(source).run(...params),
    getAllAsync: async (source, params) => db.prepare(source).all(...params) as never,
    getFirstAsync: async (source, params) => (db.prepare(source).get(...params) ?? null) as never,
  };
}

describe("snapshotDb", () => {
  it("round-trips an environment snapshot and upserts in place", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    await db.saveEnvironmentSnapshot({
      environmentId: "env-1",
      schemaVersion: 1,
      payload: '{"v":1}',
      updatedAt: 100,
    });
    await db.saveEnvironmentSnapshot({
      environmentId: "env-1",
      schemaVersion: 1,
      payload: '{"v":2}',
      updatedAt: 200,
    });

    expect(await db.loadEnvironmentSnapshot("env-1")).toEqual({
      schemaVersion: 1,
      payload: '{"v":2}',
      updatedAt: 200,
    });
    expect(await db.listEnvironmentSnapshotStats()).toEqual([
      { environmentId: "env-1", payloadBytes: payloadByteLength('{"v":2}'), updatedAt: 200 },
    ]);
  });

  it("removes a snapshot and reports a miss as null", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    await db.saveEnvironmentSnapshot({
      environmentId: "env-1",
      schemaVersion: 1,
      payload: "{}",
      updatedAt: 1,
    });
    await db.removeEnvironmentSnapshot("env-1");
    expect(await db.loadEnvironmentSnapshot("env-1")).toBeNull();
    expect(await db.loadEnvironmentSnapshot("never-written")).toBeNull();
  });

  it("stores the roster as a singleton row", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    expect(await db.loadHubNodeRoster()).toBeNull();
    await db.saveHubNodeRoster({ schemaVersion: 1, payload: '{"nodes":[]}', updatedAt: 1 });
    await db.saveHubNodeRoster({ schemaVersion: 1, payload: '{"nodes":[1]}', updatedAt: 2 });
    expect(await db.loadHubNodeRoster()).toEqual({ schemaVersion: 1, payload: '{"nodes":[1]}' });
  });

  it("measures payload bytes as UTF-8 length", () => {
    expect(payloadByteLength("abc")).toBe(3);
    expect(payloadByteLength("ü")).toBe(2);
  });

  it("counts exactly what TextEncoder would encode, without encoding", () => {
    const samples = [
      "",
      "plain ascii",
      "ü€",
      "emoji 🚀 pair",
      "lone \ud800 high",
      "lone \udc00 low",
      "trailing high \ud83d",
      JSON.stringify({ title: "Ünïcödé 🧪", body: "x".repeat(300) }),
    ];
    for (const sample of samples) {
      expect(payloadByteLength(sample), JSON.stringify(sample)).toBe(
        new TextEncoder().encode(sample).byteLength,
      );
    }
  });

  it("reads every snapshot in one query, most recently written first", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    await db.saveEnvironmentSnapshot({
      environmentId: "env-old",
      schemaVersion: 1,
      payload: "{}",
      updatedAt: 1,
    });
    await db.saveEnvironmentSnapshot({
      environmentId: "env-new",
      schemaVersion: 2,
      payload: '{"n":1}',
      payloadBytes: 7,
      updatedAt: 5,
    });
    expect(await db.loadEnvironmentSnapshots()).toEqual([
      { environmentId: "env-new", schemaVersion: 2, payload: '{"n":1}', updatedAt: 5 },
      { environmentId: "env-old", schemaVersion: 1, payload: "{}", updatedAt: 1 },
    ]);
    expect(
      (await db.listEnvironmentSnapshotStats()).find((stat) => stat.environmentId === "env-new")
        ?.payloadBytes,
    ).toBe(7);
  });

  it("accounts for stored conversation text in the payload bytes", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    const record = (text: string) =>
      JSON.stringify({
        threads: [],
        content: { "thread-1": { messages: [{ id: "m1", role: "user", text }] } },
      });
    // Multi-byte text, an astral character and a lone surrogate, about 2 MB.
    const text = `${"naïve 日本語 🚀 \ud800 ".repeat(70_000)}end`;
    const payload = record(text);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(1_800_000);

    await db.saveEnvironmentSnapshot({
      environmentId: "env-content",
      schemaVersion: 3,
      payload,
      updatedAt: 1,
    });
    expect(await db.loadEnvironmentSnapshot("env-content")).toEqual({
      schemaVersion: 3,
      payload,
      updatedAt: 1,
    });
    const [stat] = await db.listEnvironmentSnapshotStats();
    expect(stat?.payloadBytes).toBe(new TextEncoder().encode(payload).byteLength);

    // Rewritten without the text, the row is accounted for at its new size.
    const shellOnly = JSON.stringify({ threads: [] });
    await db.saveEnvironmentSnapshot({
      environmentId: "env-content",
      schemaVersion: 3,
      payload: shellOnly,
      payloadBytes: payloadByteLength(shellOnly),
      updatedAt: 1,
    });
    expect((await db.listEnvironmentSnapshotStats())[0]?.payloadBytes).toBe(shellOnly.length);
  });

  it("stores saved answers per environment and removes them with its snapshot", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    const save = (environmentId: string, key: string, updatedAt: number) =>
      db.saveSavedQuery({
        environmentId,
        key,
        schemaVersion: 1,
        payload: `{"k":"${key}"}`,
        payloadBytes: payloadByteLength(`{"k":"${key}"}`),
        updatedAt,
      });
    await save("env-1", "a", 1);
    await save("env-1", "a", 5);
    await save("env-1", "b", 2);
    await save("env-2", "a", 1);
    expect(await db.loadSavedQuery("env-1", "a")).toEqual({
      schemaVersion: 1,
      payload: '{"k":"a"}',
      updatedAt: 5,
    });
    expect(await db.savedQueryBytes("env-1")).toBe(2 * payloadByteLength('{"k":"a"}'));
    expect((await db.listSavedQueryStats()).length).toBe(3);

    await db.removeSavedQueries([{ environmentId: "env-1", key: "b" }]);
    expect(await db.loadSavedQuery("env-1", "b")).toBeNull();

    await db.removeEnvironmentSnapshot("env-1");
    expect(await db.loadSavedQuery("env-1", "a")).toBeNull();
    expect(await db.loadSavedQuery("env-2", "a")).not.toBeNull();

    await db.clearSavedQueries();
    expect(await db.loadSavedQuery("env-2", "a")).toBeNull();
  });
});
