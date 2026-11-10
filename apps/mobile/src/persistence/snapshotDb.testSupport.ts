import {
  createSnapshotDb,
  payloadByteLength,
  type SnapshotDb,
  type SnapshotDbHandle,
} from "./snapshotDb";

/**
 * Real SQL against node:sqlite, adapted to the expo-sqlite method names the
 * store uses. This exercises the actual DDL, upserts and transactions; the
 * expo-sqlite native module itself cannot load in the node runner.
 */
export interface TestSnapshotDb {
  readonly db: SnapshotDb;
  readonly handle: SnapshotDbHandle;
  /** UTF-8 bytes of every text value bound to a write, and of every text value read. */
  readonly counters: { written: number; read: number };
  /** Rows of one table, for assertions. */
  readonly rows: <T = Record<string, unknown>>(table: string) => Promise<T[]>;
  /** A machine saved in the single-row layout (v1 to v3), as an older build wrote it. */
  readonly insertLegacyRow: (input: {
    readonly environmentId: string;
    readonly schemaVersion: number;
    readonly payload: string;
    readonly updatedAt: number;
  }) => Promise<void>;
}

function textBytes(value: unknown): number {
  if (typeof value === "string") return payloadByteLength(value);
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textBytes(item), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>((sum, item) => sum + textBytes(item), 0);
  }
  return 0;
}

export async function createTestSnapshotDb(): Promise<TestSnapshotDb> {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  const counters = { written: 0, read: 0 };
  const handle: SnapshotDbHandle = {
    execAsync: async (source) => {
      sqlite.exec(source);
    },
    runAsync: async (source, params) => {
      counters.written += textBytes(params);
      return sqlite.prepare(source).run(...params);
    },
    getAllAsync: async (source, params) => {
      const rows = sqlite.prepare(source).all(...params);
      counters.read += textBytes(rows);
      return rows as never;
    },
    getFirstAsync: async (source, params) => {
      const row = sqlite.prepare(source).get(...params) ?? null;
      counters.read += textBytes(row);
      return row as never;
    },
  };
  const db = createSnapshotDb(async () => handle);
  return {
    db,
    handle,
    counters,
    rows: async (table) => {
      // Opens the database (and runs its DDL) first.
      await db.listEnvironmentCacheStats();
      return sqlite.prepare(`SELECT * FROM ${table}`).all() as never;
    },
    insertLegacyRow: async (input) => {
      await db.listEnvironmentCacheStats();
      sqlite
        .prepare(
          `INSERT INTO environment_snapshots
             (environment_id, schema_version, payload, payload_bytes, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.environmentId,
          input.schemaVersion,
          input.payload,
          payloadByteLength(input.payload),
          input.updatedAt,
        );
    },
  };
}
