/**
 * The untyped byte store under the per-environment snapshot cache: opens the
 * client-cache SQLite database and moves opaque TEXT payloads. It knows nothing
 * about record shapes or schema versions beyond storing the version column —
 * decoding and discard-on-mismatch live in environmentSnapshotCodec.ts,
 * mirroring the upstream split (t3code mobile-database.ts vs
 * environment-cache-store.ts).
 *
 * `expo-sqlite` is imported lazily inside the opener — it reaches react-native
 * at module scope, which the node test runner cannot parse. Tests inject a
 * handle backed by `node:sqlite` instead.
 */

const DATABASE_NAME = "ryco-client-cache.db";

/**
 * The slice of expo-sqlite's `SQLiteDatabase` this store uses. Tests satisfy it
 * with a `node:sqlite` adapter.
 */
export interface SnapshotDbHandle {
  readonly execAsync: (source: string) => Promise<void>;
  // Mutable arrays on purpose: expo-sqlite's SQLiteBindParams is mutable, so a
  // readonly parameter type would reject the real SQLiteDatabase.
  readonly runAsync: (source: string, params: Array<string | number | null>) => Promise<unknown>;
  readonly getAllAsync: <T>(source: string, params: Array<string | number | null>) => Promise<T[]>;
  readonly getFirstAsync: <T>(
    source: string,
    params: Array<string | number | null>,
  ) => Promise<T | null>;
}

export interface StoredSnapshotRow {
  readonly schemaVersion: number;
  readonly payload: string;
}

export interface EnvironmentSnapshotStat {
  readonly environmentId: string;
  readonly payloadBytes: number;
  readonly updatedAt: number;
}

export interface StoredEnvironmentSnapshotRow extends StoredSnapshotRow {
  readonly environmentId: string;
  readonly updatedAt: number;
}

export interface SnapshotDb {
  readonly loadEnvironmentSnapshot: (environmentId: string) => Promise<StoredSnapshotRow | null>;
  /** Every stored environment snapshot in one read, most recently written first. */
  readonly loadEnvironmentSnapshots: () => Promise<ReadonlyArray<StoredEnvironmentSnapshotRow>>;
  readonly saveEnvironmentSnapshot: (input: {
    readonly environmentId: string;
    readonly schemaVersion: number;
    readonly payload: string;
    /** UTF-8 length of `payload` when the caller already measured it. */
    readonly payloadBytes?: number;
    readonly updatedAt: number;
  }) => Promise<void>;
  readonly removeEnvironmentSnapshot: (environmentId: string) => Promise<void>;
  readonly listEnvironmentSnapshotStats: () => Promise<ReadonlyArray<EnvironmentSnapshotStat>>;
  readonly loadHubNodeRoster: () => Promise<StoredSnapshotRow | null>;
  readonly saveHubNodeRoster: (input: {
    readonly schemaVersion: number;
    readonly payload: string;
    readonly updatedAt: number;
  }) => Promise<void>;
  readonly clearAll: () => Promise<void>;
}

async function openExpoSqliteHandle(): Promise<SnapshotDbHandle> {
  const SQLite = await import("expo-sqlite");
  return SQLite.openDatabaseAsync(DATABASE_NAME);
}

/**
 * Same measure the supervision byte budget uses: UTF-8 length of the payload.
 *
 * Counted from UTF-16 code units without encoding: Hermes has no native
 * `TextEncoder`, and the polyfill allocates and walks a multi-megabyte buffer
 * just to read its length. Lone surrogates count as U+FFFD (3 bytes), exactly
 * as `TextEncoder` would encode them.
 */
export function payloadByteLength(payload: string): number {
  let bytes = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const unit = payload.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < payload.length) {
      const next = payload.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const DDL = `
CREATE TABLE IF NOT EXISTS environment_snapshots (
  environment_id TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hub_node_roster (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function createSnapshotDb(
  open: () => Promise<SnapshotDbHandle> = openExpoSqliteHandle,
): SnapshotDb {
  // Single-flight open + one-time DDL; a failed open clears the slot so a
  // later call can retry instead of caching the rejection forever.
  let handlePromise: Promise<SnapshotDbHandle> | null = null;
  const acquire = (): Promise<SnapshotDbHandle> => {
    handlePromise ??= (async () => {
      const handle = await open();
      await handle.execAsync("PRAGMA journal_mode = WAL;");
      await handle.execAsync(DDL);
      return handle;
    })().catch((error: unknown) => {
      handlePromise = null;
      throw error;
    });
    return handlePromise;
  };

  return {
    loadEnvironmentSnapshot: async (environmentId) => {
      const handle = await acquire();
      const row = await handle.getFirstAsync<{ schema_version: number; payload: string }>(
        "SELECT schema_version, payload FROM environment_snapshots WHERE environment_id = ?",
        [environmentId],
      );
      return row ? { schemaVersion: row.schema_version, payload: row.payload } : null;
    },
    loadEnvironmentSnapshots: async () => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{
        environment_id: string;
        schema_version: number;
        payload: string;
        updated_at: number;
      }>(
        `SELECT environment_id, schema_version, payload, updated_at
           FROM environment_snapshots
          ORDER BY updated_at DESC`,
        [],
      );
      return rows.map((row) => ({
        environmentId: row.environment_id,
        schemaVersion: row.schema_version,
        payload: row.payload,
        updatedAt: row.updated_at,
      }));
    },
    saveEnvironmentSnapshot: async (input) => {
      const handle = await acquire();
      await handle.runAsync(
        `INSERT INTO environment_snapshots
           (environment_id, schema_version, payload, payload_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (environment_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           payload = excluded.payload,
           payload_bytes = excluded.payload_bytes,
           updated_at = excluded.updated_at`,
        [
          input.environmentId,
          input.schemaVersion,
          input.payload,
          input.payloadBytes ?? payloadByteLength(input.payload),
          input.updatedAt,
        ],
      );
    },
    removeEnvironmentSnapshot: async (environmentId) => {
      const handle = await acquire();
      await handle.runAsync("DELETE FROM environment_snapshots WHERE environment_id = ?", [
        environmentId,
      ]);
    },
    listEnvironmentSnapshotStats: async () => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{
        environment_id: string;
        payload_bytes: number;
        updated_at: number;
      }>("SELECT environment_id, payload_bytes, updated_at FROM environment_snapshots", []);
      return rows.map((row) => ({
        environmentId: row.environment_id,
        payloadBytes: row.payload_bytes,
        updatedAt: row.updated_at,
      }));
    },
    loadHubNodeRoster: async () => {
      const handle = await acquire();
      const row = await handle.getFirstAsync<{ schema_version: number; payload: string }>(
        "SELECT schema_version, payload FROM hub_node_roster WHERE singleton = 1",
        [],
      );
      return row ? { schemaVersion: row.schema_version, payload: row.payload } : null;
    },
    saveHubNodeRoster: async (input) => {
      const handle = await acquire();
      await handle.runAsync(
        `INSERT INTO hub_node_roster (singleton, schema_version, payload, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET
           schema_version = excluded.schema_version,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        [input.schemaVersion, input.payload, input.updatedAt],
      );
    },
    clearAll: async () => {
      const handle = await acquire();
      await handle.runAsync("DELETE FROM environment_snapshots", []);
      await handle.runAsync("DELETE FROM hub_node_roster", []);
    },
  };
}
