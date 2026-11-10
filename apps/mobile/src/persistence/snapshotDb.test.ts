import { describe, expect, it } from "vite-plus/test";

import {
  createSnapshotDb,
  payloadByteLength,
  payloadHash,
  type SnapshotDb,
  type SnapshotDbHandle,
} from "./snapshotDb";

import { createTestSnapshotDb } from "./snapshotDb.testSupport";

async function openNodeSqliteHandle(): Promise<SnapshotDbHandle> {
  return (await createTestSnapshotDb()).handle;
}

function rowsWrite(
  environmentId: string,
  overrides: Partial<Parameters<SnapshotDb["writeEnvironmentRows"]>[0]> = {},
): Parameters<SnapshotDb["writeEnvironmentRows"]>[0] {
  return {
    environmentId,
    schemaVersion: 4,
    updatedAt: 1,
    envelope: { payload: "{}", bytes: 2, threadCount: 0, projectCount: 0 },
    upsertThreads: [],
    deleteThreads: [],
    upsertBodies: [],
    bodySequences: [],
    deleteBodies: [],
    ...overrides,
  };
}

const row = (threadId: string, payload: string) => ({
  threadId,
  payload,
  bytes: payloadByteLength(payload),
  hash: payloadHash(payload),
});

describe("snapshotDb", () => {
  it("writes a machine's rows in one go and reads envelopes most recent first", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    await db.writeEnvironmentRows(
      rowsWrite("env-old", {
        envelope: { payload: '{"e":1}', bytes: 7, threadCount: 1, projectCount: 1 },
        upsertThreads: [row("t1", '{"t":1}')],
      }),
    );
    await db.writeEnvironmentRows(
      rowsWrite("env-new", {
        updatedAt: 5,
        envelope: { payload: '{"e":2}', bytes: 7, threadCount: 2, projectCount: 0 },
        upsertThreads: [row("t1", '{"t":1}'), row("t2", '{"t":2}')],
        upsertBodies: [{ ...row("t2", '{"messages":[]}'), sequence: 9 }],
      }),
    );

    expect(await db.loadEnvironmentEnvelopes()).toEqual([
      {
        environmentId: "env-new",
        schemaVersion: 4,
        payload: '{"e":2}',
        threadCount: 2,
        projectCount: 0,
        updatedAt: 5,
      },
      {
        environmentId: "env-old",
        schemaVersion: 4,
        payload: '{"e":1}',
        threadCount: 1,
        projectCount: 1,
        updatedAt: 1,
      },
    ]);
    expect(
      (await db.loadEnvironmentThreads("env-new")).toSorted((a, b) =>
        a.threadId.localeCompare(b.threadId),
      ),
    ).toEqual([
      { threadId: "t1", payload: '{"t":1}' },
      { threadId: "t2", payload: '{"t":2}' },
    ]);
    expect(await db.loadThreadBody("env-new", "t2")).toEqual({
      payload: '{"messages":[]}',
      sequence: 9,
    });
    expect(await db.loadThreadBody("env-new", "t1")).toBeNull();
    expect(await db.loadThreadBodySequence("env-new", "t2")).toBe(9);
    expect(await db.listThreadBodyKeys()).toEqual([{ environmentId: "env-new", threadId: "t2" }]);
  });

  it("keeps an unchanged envelope payload and updates only what a capture names", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    await db.writeEnvironmentRows(
      rowsWrite("env-1", {
        envelope: { payload: '{"e":1}', bytes: 7, threadCount: 2, projectCount: 1 },
        upsertThreads: [row("t1", '{"t":1}'), row("t2", '{"t":2}')],
        upsertBodies: [{ ...row("t1", '{"messages":[1]}'), sequence: 1 }],
      }),
    );
    await db.writeEnvironmentRows(
      rowsWrite("env-1", {
        updatedAt: 9,
        envelope: { bytes: 7, threadCount: 1, projectCount: 1 },
        upsertThreads: [row("t1", '{"t":"1b"}')],
        deleteThreads: ["t2"],
        bodySequences: [{ threadId: "t1", sequence: 4 }],
      }),
    );

    const [envelope] = await db.loadEnvironmentEnvelopes();
    expect(envelope).toMatchObject({ payload: '{"e":1}', threadCount: 1, updatedAt: 9 });
    expect(await db.loadEnvironmentThreads("env-1")).toEqual([
      { threadId: "t1", payload: '{"t":"1b"}' },
    ]);
    expect(await db.loadThreadBody("env-1", "t1")).toEqual({
      payload: '{"messages":[1]}',
      sequence: 4,
    });
    const hashes = await db.loadEnvironmentRowHashes("env-1");
    expect([...hashes.threads]).toEqual([["t1", payloadHash('{"t":"1b"}')]]);
    expect([...hashes.bodies]).toEqual([
      ["t1", { hash: payloadHash('{"messages":[1]}'), sequence: 4 }],
    ]);
  });

  it("sums a machine's rows for its size and keeps its counts beside them", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    // Multi-byte text, an astral character and a lone surrogate.
    const text = `${"naïve 日本語 🚀 \ud800 ".repeat(2_000)}end`;
    const body = JSON.stringify({ messages: [{ text }] });
    await db.writeEnvironmentRows(
      rowsWrite("env-1", {
        envelope: { payload: '{"e":1}', bytes: 7, threadCount: 1, projectCount: 3 },
        upsertThreads: [row("t1", '{"t":1}')],
        upsertBodies: [{ ...row("t1", body), sequence: null }],
      }),
    );
    const [stat] = await db.listEnvironmentCacheStats();
    expect(stat).toEqual({
      environmentId: "env-1",
      bytes: 7 + 7 + new TextEncoder().encode(body).byteLength,
      updatedAt: 1,
      threadCount: 1,
      projectCount: 3,
    });

    await db.removeThreadBodies("env-1");
    expect((await db.listEnvironmentCacheStats())[0]?.bytes).toBe(14);
  });

  it("removes a machine's rows and saved answers together, and leaves the others", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    for (const environmentId of ["env-1", "env-2"]) {
      await db.writeEnvironmentRows(
        rowsWrite(environmentId, {
          upsertThreads: [row("t1", "{}")],
          upsertBodies: [{ ...row("t1", '{"messages":[]}'), sequence: null }],
        }),
      );
      await db.saveSavedQuery({
        environmentId,
        key: "k",
        schemaVersion: 1,
        payload: "{}",
        payloadBytes: 2,
        updatedAt: 1,
      });
    }
    await db.removeEnvironment("env-1");
    expect((await db.loadEnvironmentEnvelopes()).map((env) => env.environmentId)).toEqual([
      "env-2",
    ]);
    expect(await db.loadEnvironmentThreads("env-1")).toEqual([]);
    expect(await db.loadThreadBody("env-1", "t1")).toBeNull();
    expect(await db.loadSavedQuery("env-1", "k")).toBeNull();
    expect(await db.loadThreadBody("env-2", "t1")).not.toBeNull();

    await db.removeThreadBodies();
    expect(await db.listThreadBodyKeys()).toEqual([]);
    await db.clearAll();
    expect(await db.loadEnvironmentEnvelopes()).toEqual([]);
    expect(await db.loadSavedQuery("env-2", "k")).toBeNull();
  });

  it("rolls a failed write back whole, and runs two machines' writes one after the other", async () => {
    const test = await createTestSnapshotDb();
    await test.db.writeEnvironmentRows(rowsWrite("env-1", { upsertThreads: [row("t1", "{}")] }));
    // A thread id the table cannot take (NOT NULL) fails the write after its first statement.
    await expect(
      test.db.writeEnvironmentRows(
        rowsWrite("env-1", {
          deleteThreads: ["t1"],
          upsertThreads: [{ ...row("t2", "{}"), threadId: null as never }],
        }),
      ),
    ).rejects.toThrow();
    expect(await test.db.loadEnvironmentThreads("env-1")).toEqual([
      { threadId: "t1", payload: "{}" },
    ]);

    await Promise.all([
      test.db.writeEnvironmentRows(rowsWrite("env-a", { upsertThreads: [row("t", "{}")] })),
      test.db.writeEnvironmentRows(rowsWrite("env-b", { upsertThreads: [row("t", "{}")] })),
    ]);
    expect((await test.db.loadEnvironmentEnvelopes()).length).toBe(3);
  });

  it("reads and removes single-row snapshots of older builds", async () => {
    const test = await createTestSnapshotDb();
    await test.insertLegacyRow({
      environmentId: "env-old",
      schemaVersion: 3,
      payload: '{"v":3}',
      updatedAt: 7,
    });
    expect(await test.db.loadLegacyEnvironmentSnapshots()).toEqual([
      { environmentId: "env-old", schemaVersion: 3, payload: '{"v":3}', updatedAt: 7 },
    ]);
    await test.db.removeLegacyEnvironmentSnapshot("env-old");
    expect(await test.db.loadLegacyEnvironmentSnapshots()).toEqual([]);
  });

  it("hashes payloads to a stable 53-bit number", () => {
    expect(payloadHash('{"a":1}')).toBe(payloadHash('{"a":1}'));
    expect(payloadHash('{"a":1}')).not.toBe(payloadHash('{"a":2}'));
    expect(Number.isSafeInteger(payloadHash("x".repeat(10_000)))).toBe(true);
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

    await db.removeEnvironment("env-1");
    expect(await db.loadSavedQuery("env-1", "a")).toBeNull();
    expect(await db.loadSavedQuery("env-2", "a")).not.toBeNull();

    await db.clearSavedQueries();
    expect(await db.loadSavedQuery("env-2", "a")).toBeNull();
  });
});
