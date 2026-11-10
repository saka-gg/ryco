import type { ChangeRequest, EnvironmentId } from "@ryco/contracts";
import { ChangeRequest as ChangeRequestSchema } from "@ryco/contracts/source-control";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { schemaSavedQueryCodec } from "../rpc/savedQueryCodec";
import {
  purgeEnvironmentDeviceData,
  resetEnvironmentDevicePurgesForTests,
} from "./environmentDevicePurge";
import {
  createSavedQueryStore,
  planSavedQueryEvictions,
  SAVED_QUERY_MAX_BYTES,
  storedSavedQueryKey,
  storedSavedQueryVersion,
} from "./savedQueryStore";
import { createSnapshotDb, type SnapshotDbHandle } from "./snapshotDb";

const ENV = "env-1" as EnvironmentId;
const OTHER = "env-2" as EnvironmentId;

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

const row: ChangeRequest = {
  provider: "github",
  number: 7,
  title: "Fix login",
  url: "https://github.com/acme/app/pull/7",
  baseRefName: "main",
  headRefName: "fix/login",
  state: "open",
  updatedAt: Option.some(DateTime.makeUnsafe(Date.UTC(2026, 10, 8, 12))),
  labels: [{ name: "bug", color: "d73a4a" }],
  additions: 3,
  deletions: 1,
};

afterEach(() => {
  resetEnvironmentDevicePurgesForTests();
});

describe("schemaSavedQueryCodec", () => {
  it("round-trips contract data with dates and options, and misses on another shape", () => {
    const codec = schemaSavedQueryCodec(Schema.Array(ChangeRequestSchema), 1);
    expect(codec.decode(codec.encode([row]))).toEqual([row]);
    expect(codec.decode("not json")).toBeNull();
    expect(codec.decode('{"number":"seven"}')).toBeNull();
  });
});

describe("createSavedQueryStore", () => {
  it("writes an answer after the quiet period and reads it back with its time", async () => {
    let now = 10;
    const db = createSnapshotDb(openNodeSqliteHandle);
    const store = createSavedQueryStore({ db, isEnabled: () => true, now: () => now });
    store.save(ENV, "a", 1, () => '{"v":1}');
    store.save(ENV, "a", 1, () => '{"v":2}');
    expect(await store.load(ENV, "a", 1)).toBeNull();
    await store.flush();
    now = 20;
    expect(await store.load(ENV, "a", 1)).toEqual({ payload: '{"v":2}', savedAt: 10 });
    store.dispose();
  });

  it("drops rows of an older row format when it starts", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    await db.saveSavedQuery({
      environmentId: ENV,
      key: "old",
      schemaVersion: 10_001,
      payload: "{}",
      payloadBytes: 2,
      updatedAt: 1,
    });
    const store = createSavedQueryStore({ db, isEnabled: () => true, now: () => 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await db.loadSavedQuery(ENV, "old")).toBeNull();
    store.dispose();
  });

  it("treats a row of another version as a miss and removes it", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    const store = createSavedQueryStore({ db, isEnabled: () => true, now: () => 1 });
    store.save(ENV, "a", 1, () => "{}");
    await store.flush();
    expect(await store.load(ENV, "a", 2)).toBeNull();
    await Promise.resolve();
    expect(await db.loadSavedQuery(ENV, "a")).toBeNull();
    expect(storedSavedQueryVersion(1)).not.toBe(1);
    store.dispose();
  });

  it("keeps and shows nothing while the device setting is off", async () => {
    let enabled = false;
    const db = createSnapshotDb(openNodeSqliteHandle);
    const store = createSavedQueryStore({ db, isEnabled: () => enabled, now: () => 1 });
    store.save(ENV, "a", 1, () => "{}");
    await store.flush();
    expect(await db.loadSavedQuery(ENV, "a")).toBeNull();
    enabled = true;
    store.save(ENV, "a", 1, () => "{}");
    await store.flush();
    enabled = false;
    expect(await store.load(ENV, "a", 1)).toBeNull();
    store.dispose();
  });

  it("does not keep an oversized answer, and drops the older copy it replaces", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    const store = createSavedQueryStore({ db, isEnabled: () => true, now: () => 1 });
    store.save(ENV, "a", 1, () => "{}");
    await store.flush();
    store.save(ENV, "a", 1, () => "x".repeat(SAVED_QUERY_MAX_BYTES + 1));
    await store.flush();
    expect(await db.loadSavedQuery(ENV, "a")).toBeNull();
    store.dispose();
  });

  it("drops an environment's waiting and written answers when it is purged", async () => {
    const db = createSnapshotDb(openNodeSqliteHandle);
    const store = createSavedQueryStore({ db, isEnabled: () => true, now: () => 1 });
    store.save(ENV, "a", 1, () => "{}");
    store.save(OTHER, "a", 1, () => "{}");
    await store.flush();
    store.save(ENV, "b", 1, () => "{}");
    await purgeEnvironmentDeviceData(ENV);
    await store.flush();
    expect(await db.listSavedQueryStats()).toEqual([
      expect.objectContaining({ environmentId: OTHER, key: "a" }),
    ]);
    store.dispose();
  });

  it("keeps each environment and the whole store within their budgets", async () => {
    let now = 0;
    const db = createSnapshotDb(openNodeSqliteHandle);
    const store = createSavedQueryStore({
      db,
      isEnabled: () => true,
      now: () => (now += 1),
      caps: {
        perEnvironment: { maxEntries: 2, maxBytes: 1_000 },
        overall: { maxEntries: 3, maxBytes: 1_000 },
      },
    });
    for (const key of ["a", "b", "c"]) {
      store.save(ENV, key, 1, () => "{}");
      await store.flush();
    }
    for (const key of ["a", "b"]) {
      store.save(OTHER, key, 1, () => "{}");
      await store.flush();
    }
    const left = (await db.listSavedQueryStats())
      .map((stat) => `${stat.environmentId}/${stat.key}`)
      .toSorted();
    expect(left).toEqual(["env-1/c", "env-2/a", "env-2/b"]);
    store.dispose();
  });
});

describe("storedSavedQueryKey", () => {
  it("never stores a NUL, and keeps distinct keys distinct", () => {
    const a = storedSavedQueryKey("pull-requests\u0000list\u0000env\u0000/a/b\u0000open");
    const b = storedSavedQueryKey("pull-requests\u0000list\u0000env\u0000/a/b\u0000closed");
    const c = storedSavedQueryKey("pull-requests\u0000list\u0000env\u0000/a%2Fb\u0000open");
    expect(a).not.toContain("\u0000");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("planSavedQueryEvictions", () => {
  it("never evicts a pinned answer and evicts least recently written first", () => {
    const stats = [
      { environmentId: "e", key: "old", payloadBytes: 600, updatedAt: 1 },
      { environmentId: "e", key: "new", payloadBytes: 600, updatedAt: 2 },
    ];
    const caps = {
      perEnvironment: { maxEntries: 10, maxBytes: 1_000 },
      overall: { maxEntries: 10, maxBytes: 10_000 },
    };
    expect(planSavedQueryEvictions(stats, new Set(), caps).map((stat) => stat.key)).toEqual([
      "old",
    ]);
    expect(planSavedQueryEvictions(stats, new Set(["e\u0000old"]), caps).map((s) => s.key)).toEqual(
      ["new"],
    );
  });
});
