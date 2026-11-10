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

/** A machine's saved copy before the per-thread layout: one row with everything. */
export interface StoredLegacyEnvironmentSnapshotRow extends StoredSnapshotRow {
  readonly environmentId: string;
  readonly updatedAt: number;
}

/** One machine's envelope row: its projects and worktrees, with counts kept beside them. */
export interface StoredEnvironmentEnvelopeRow extends StoredSnapshotRow {
  readonly environmentId: string;
  readonly updatedAt: number;
  readonly threadCount: number;
  readonly projectCount: number;
}

/** One thread's list row (its shell and summary). */
export interface StoredEnvironmentThreadRow {
  readonly threadId: string;
  readonly payload: string;
}

/** One thread's saved body (recent text and open prompts); read when the thread opens. */
export interface StoredThreadBodyRow {
  readonly payload: string;
  readonly sequence: number | null;
}

/** What each stored row of a machine was written from, so a capture writes only what changed. */
export interface StoredEnvironmentRowHashes {
  readonly threads: ReadonlyMap<string, number>;
  readonly bodies: ReadonlyMap<string, { readonly hash: number; readonly sequence: number | null }>;
}

/** A machine's stored size (envelope, thread rows and bodies together), age and counts. */
export interface EnvironmentCacheStat {
  readonly environmentId: string;
  readonly bytes: number;
  readonly updatedAt: number;
  readonly threadCount: number;
  readonly projectCount: number;
}

export interface StoredRowWrite {
  readonly threadId: string;
  readonly payload: string;
  readonly bytes: number;
  readonly hash: number;
}

export interface StoredBodyWrite extends StoredRowWrite {
  readonly sequence: number | null;
}

/**
 * One capture of a machine, written in one transaction: the envelope (its
 * payload only when it changed), the thread rows and bodies that changed, and
 * the removal of rows that left the bounds.
 */
export interface EnvironmentRowsWrite {
  readonly environmentId: string;
  readonly schemaVersion: number;
  readonly updatedAt: number;
  readonly envelope: {
    /** Omitted when the stored envelope payload is still current. */
    readonly payload?: string;
    readonly bytes: number;
    readonly threadCount: number;
    readonly projectCount: number;
  };
  readonly upsertThreads: ReadonlyArray<StoredRowWrite>;
  readonly deleteThreads: ReadonlyArray<string>;
  readonly upsertBodies: ReadonlyArray<StoredBodyWrite>;
  /** Bodies whose text is unchanged and whose sequence moved. */
  readonly bodySequences: ReadonlyArray<{
    readonly threadId: string;
    readonly sequence: number | null;
  }>;
  readonly deleteBodies: ReadonlyArray<string>;
}

export interface SnapshotDb {
  /** Machines' envelopes, most recently written first (the launch read). */
  readonly loadEnvironmentEnvelopes: () => Promise<ReadonlyArray<StoredEnvironmentEnvelopeRow>>;
  /** One machine's thread rows (the launch read). */
  readonly loadEnvironmentThreads: (
    environmentId: string,
  ) => Promise<ReadonlyArray<StoredEnvironmentThreadRow>>;
  readonly loadThreadBody: (
    environmentId: string,
    threadId: string,
  ) => Promise<StoredThreadBodyRow | null>;
  readonly loadThreadBodySequence: (
    environmentId: string,
    threadId: string,
  ) => Promise<number | null>;
  /** Every thread that has a saved body, without the bodies. */
  readonly listThreadBodyKeys: () => Promise<
    ReadonlyArray<{ readonly environmentId: string; readonly threadId: string }>
  >;
  readonly loadEnvironmentRowHashes: (environmentId: string) => Promise<StoredEnvironmentRowHashes>;
  readonly writeEnvironmentRows: (input: EnvironmentRowsWrite) => Promise<void>;
  /** A machine's envelope, thread rows, bodies and saved screen answers. */
  readonly removeEnvironment: (environmentId: string) => Promise<void>;
  /** Every machine's size, age and counts, without reading any payload. */
  readonly listEnvironmentCacheStats: () => Promise<ReadonlyArray<EnvironmentCacheStat>>;
  /** Saved bodies of one machine, or of all of them. */
  readonly removeThreadBodies: (environmentId?: string) => Promise<void>;
  /** Rows of the single-row layout (schema v1 to v3), for the one-time move. */
  readonly loadLegacyEnvironmentSnapshots: () => Promise<
    ReadonlyArray<StoredLegacyEnvironmentSnapshotRow>
  >;
  readonly removeLegacyEnvironmentSnapshot: (environmentId: string) => Promise<void>;
  readonly loadHubNodeRoster: () => Promise<StoredSnapshotRow | null>;
  readonly saveHubNodeRoster: (input: {
    readonly schemaVersion: number;
    readonly payload: string;
    readonly updatedAt: number;
  }) => Promise<void>;
  readonly clearAll: () => Promise<void>;
  /**
   * Node reads kept so a screen can show its last answer at once (the saved
   * query cache, persistence/savedQueryStore.ts), one row per read under the
   * same rules as the environment's snapshot: removing the environment's
   * snapshot removes them too.
   */
  readonly loadSavedQuery: (
    environmentId: string,
    key: string,
  ) => Promise<StoredSavedQueryRow | null>;
  readonly saveSavedQuery: (input: {
    readonly environmentId: string;
    readonly key: string;
    readonly schemaVersion: number;
    readonly payload: string;
    readonly payloadBytes: number;
    readonly updatedAt: number;
  }) => Promise<void>;
  /** Size and age of every saved read (no payloads), for the eviction budget. */
  readonly listSavedQueryStats: () => Promise<ReadonlyArray<SavedQueryStat>>;
  readonly removeSavedQueries: (
    entries: ReadonlyArray<{ readonly environmentId: string; readonly key: string }>,
  ) => Promise<void>;
  readonly savedQueryBytes: (environmentId: string) => Promise<number>;
  /** Rows of an older store format (`schema_version` below `minimum`). */
  readonly removeSavedQueriesBelowVersion: (minimum: number) => Promise<void>;
  /** Every environment's saved reads (the device setting was turned off). */
  readonly clearSavedQueries: () => Promise<void>;
}

export interface StoredSavedQueryRow extends StoredSnapshotRow {
  readonly updatedAt: number;
}

export interface SavedQueryStat {
  readonly environmentId: string;
  readonly key: string;
  readonly payloadBytes: number;
  readonly updatedAt: number;
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

/**
 * A 53-bit hash of a stored payload (cyrb53), kept beside the row so a later
 * capture can tell an unchanged row from a changed one without reading it. A
 * collision only leaves a display-only row stale until that thread changes
 * again.
 */
export function payloadHash(payload: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < payload.length; index += 1) {
    const unit = payload.charCodeAt(index);
    h1 = Math.imul(h1 ^ unit, 2654435761);
    h2 = Math.imul(h2 ^ unit, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * `environment_snapshots` is the single-row layout (one row per machine with
 * every thread and its text), read once to move its rows into the per-thread
 * tables. A machine is now an envelope row, one row per thread (read at
 * launch) and one body row per thread with saved text (read when the thread
 * opens).
 */
const DDL = `
CREATE TABLE IF NOT EXISTS environment_snapshots (
  environment_id TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS environment_envelopes (
  environment_id TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  thread_count INTEGER NOT NULL,
  project_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS environment_threads (
  environment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  payload_hash INTEGER NOT NULL,
  PRIMARY KEY (environment_id, thread_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS environment_thread_bodies (
  environment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  payload_hash INTEGER NOT NULL,
  sequence INTEGER,
  PRIMARY KEY (environment_id, thread_id)
) WITHOUT ROWID;
DROP TABLE IF EXISTS pull_request_reads;
CREATE TABLE IF NOT EXISTS saved_queries (
  environment_id TEXT NOT NULL,
  query_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, query_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hub_node_roster (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const ENVIRONMENT_TABLES = [
  "environment_snapshots",
  "environment_envelopes",
  "environment_threads",
  "environment_thread_bodies",
  "saved_queries",
] as const;

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
  // The connection is shared and its calls are asynchronous: transactions run
  // one at a time, so two machines' writes never nest a BEGIN in another.
  let transactions: Promise<unknown> = Promise.resolve();
  const transaction = (work: (handle: SnapshotDbHandle) => Promise<void>): Promise<void> => {
    const run = transactions.then(async () => {
      const handle = await acquire();
      await handle.execAsync("BEGIN");
      try {
        await work(handle);
        await handle.execAsync("COMMIT");
      } catch (error) {
        await handle.execAsync("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    transactions = run.catch(() => undefined);
    return run;
  };

  return {
    loadEnvironmentEnvelopes: async () => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{
        environment_id: string;
        schema_version: number;
        payload: string;
        thread_count: number;
        project_count: number;
        updated_at: number;
      }>(
        `SELECT environment_id, schema_version, payload, thread_count, project_count, updated_at
           FROM environment_envelopes
          ORDER BY updated_at DESC`,
        [],
      );
      return rows.map((row) => ({
        environmentId: row.environment_id,
        schemaVersion: row.schema_version,
        payload: row.payload,
        threadCount: row.thread_count,
        projectCount: row.project_count,
        updatedAt: row.updated_at,
      }));
    },
    loadEnvironmentThreads: async (environmentId) => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{ thread_id: string; payload: string }>(
        "SELECT thread_id, payload FROM environment_threads WHERE environment_id = ?",
        [environmentId],
      );
      return rows.map((row) => ({ threadId: row.thread_id, payload: row.payload }));
    },
    loadThreadBody: async (environmentId, threadId) => {
      const handle = await acquire();
      const row = await handle.getFirstAsync<{ payload: string; sequence: number | null }>(
        `SELECT payload, sequence FROM environment_thread_bodies
          WHERE environment_id = ? AND thread_id = ?`,
        [environmentId, threadId],
      );
      return row ? { payload: row.payload, sequence: row.sequence ?? null } : null;
    },
    loadThreadBodySequence: async (environmentId, threadId) => {
      const handle = await acquire();
      const row = await handle.getFirstAsync<{ sequence: number | null }>(
        `SELECT sequence FROM environment_thread_bodies
          WHERE environment_id = ? AND thread_id = ?`,
        [environmentId, threadId],
      );
      return row?.sequence ?? null;
    },
    listThreadBodyKeys: async () => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{ environment_id: string; thread_id: string }>(
        "SELECT environment_id, thread_id FROM environment_thread_bodies",
        [],
      );
      return rows.map((row) => ({ environmentId: row.environment_id, threadId: row.thread_id }));
    },
    loadEnvironmentRowHashes: async (environmentId) => {
      const handle = await acquire();
      const [threads, bodies] = await Promise.all([
        handle.getAllAsync<{ thread_id: string; payload_hash: number }>(
          "SELECT thread_id, payload_hash FROM environment_threads WHERE environment_id = ?",
          [environmentId],
        ),
        handle.getAllAsync<{ thread_id: string; payload_hash: number; sequence: number | null }>(
          `SELECT thread_id, payload_hash, sequence FROM environment_thread_bodies
            WHERE environment_id = ?`,
          [environmentId],
        ),
      ]);
      return {
        threads: new Map(threads.map((row) => [row.thread_id, Number(row.payload_hash)])),
        bodies: new Map(
          bodies.map((row) => [
            row.thread_id,
            { hash: Number(row.payload_hash), sequence: row.sequence ?? null },
          ]),
        ),
      };
    },
    writeEnvironmentRows: (input) =>
      transaction(async (handle) => {
        const { environmentId, envelope } = input;
        if (envelope.payload !== undefined) {
          await handle.runAsync(
            `INSERT INTO environment_envelopes
               (environment_id, schema_version, payload, payload_bytes, thread_count, project_count, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (environment_id) DO UPDATE SET
               schema_version = excluded.schema_version,
               payload = excluded.payload,
               payload_bytes = excluded.payload_bytes,
               thread_count = excluded.thread_count,
               project_count = excluded.project_count,
               updated_at = excluded.updated_at`,
            [
              environmentId,
              input.schemaVersion,
              envelope.payload,
              envelope.bytes,
              envelope.threadCount,
              envelope.projectCount,
              input.updatedAt,
            ],
          );
        } else {
          await handle.runAsync(
            `UPDATE environment_envelopes
                SET thread_count = ?, project_count = ?, updated_at = ?
              WHERE environment_id = ?`,
            [envelope.threadCount, envelope.projectCount, input.updatedAt, environmentId],
          );
        }
        for (const threadId of input.deleteThreads) {
          await handle.runAsync(
            "DELETE FROM environment_threads WHERE environment_id = ? AND thread_id = ?",
            [environmentId, threadId],
          );
        }
        for (const row of input.upsertThreads) {
          await handle.runAsync(
            `INSERT INTO environment_threads
               (environment_id, thread_id, payload, payload_bytes, payload_hash)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (environment_id, thread_id) DO UPDATE SET
               payload = excluded.payload,
               payload_bytes = excluded.payload_bytes,
               payload_hash = excluded.payload_hash`,
            [environmentId, row.threadId, row.payload, row.bytes, row.hash],
          );
        }
        for (const threadId of input.deleteBodies) {
          await handle.runAsync(
            "DELETE FROM environment_thread_bodies WHERE environment_id = ? AND thread_id = ?",
            [environmentId, threadId],
          );
        }
        for (const row of input.upsertBodies) {
          await handle.runAsync(
            `INSERT INTO environment_thread_bodies
               (environment_id, thread_id, payload, payload_bytes, payload_hash, sequence)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (environment_id, thread_id) DO UPDATE SET
               payload = excluded.payload,
               payload_bytes = excluded.payload_bytes,
               payload_hash = excluded.payload_hash,
               sequence = excluded.sequence`,
            [environmentId, row.threadId, row.payload, row.bytes, row.hash, row.sequence],
          );
        }
        for (const row of input.bodySequences) {
          await handle.runAsync(
            `UPDATE environment_thread_bodies SET sequence = ?
              WHERE environment_id = ? AND thread_id = ?`,
            [row.sequence, environmentId, row.threadId],
          );
        }
      }),
    removeEnvironment: (environmentId) =>
      transaction(async (handle) => {
        for (const table of ENVIRONMENT_TABLES) {
          await handle.runAsync(`DELETE FROM ${table} WHERE environment_id = ?`, [environmentId]);
        }
      }),
    listEnvironmentCacheStats: async () => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{
        environment_id: string;
        updated_at: number;
        thread_count: number;
        project_count: number;
        bytes: number;
      }>(
        `SELECT e.environment_id, e.updated_at, e.thread_count, e.project_count,
                e.payload_bytes
                + COALESCE((SELECT SUM(t.payload_bytes) FROM environment_threads t
                             WHERE t.environment_id = e.environment_id), 0)
                + COALESCE((SELECT SUM(b.payload_bytes) FROM environment_thread_bodies b
                             WHERE b.environment_id = e.environment_id), 0) AS bytes
           FROM environment_envelopes e`,
        [],
      );
      return rows.map((row) => ({
        environmentId: row.environment_id,
        bytes: Number(row.bytes),
        updatedAt: row.updated_at,
        threadCount: row.thread_count,
        projectCount: row.project_count,
      }));
    },
    removeThreadBodies: async (environmentId) => {
      const handle = await acquire();
      if (environmentId === undefined) {
        await handle.runAsync("DELETE FROM environment_thread_bodies", []);
        return;
      }
      await handle.runAsync("DELETE FROM environment_thread_bodies WHERE environment_id = ?", [
        environmentId,
      ]);
    },
    loadLegacyEnvironmentSnapshots: async () => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{
        environment_id: string;
        schema_version: number;
        payload: string;
        updated_at: number;
      }>(
        "SELECT environment_id, schema_version, payload, updated_at FROM environment_snapshots",
        [],
      );
      return rows.map((row) => ({
        environmentId: row.environment_id,
        schemaVersion: row.schema_version,
        payload: row.payload,
        updatedAt: row.updated_at,
      }));
    },
    removeLegacyEnvironmentSnapshot: async (environmentId) => {
      const handle = await acquire();
      await handle.runAsync("DELETE FROM environment_snapshots WHERE environment_id = ?", [
        environmentId,
      ]);
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
    clearAll: () =>
      transaction(async (handle) => {
        for (const table of ENVIRONMENT_TABLES) await handle.runAsync(`DELETE FROM ${table}`, []);
        await handle.runAsync("DELETE FROM hub_node_roster", []);
      }),
    loadSavedQuery: async (environmentId, key) => {
      const handle = await acquire();
      const row = await handle.getFirstAsync<{
        schema_version: number;
        payload: string;
        updated_at: number;
      }>(
        `SELECT schema_version, payload, updated_at
           FROM saved_queries
          WHERE environment_id = ? AND query_key = ?`,
        [environmentId, key],
      );
      return row
        ? { schemaVersion: row.schema_version, payload: row.payload, updatedAt: row.updated_at }
        : null;
    },
    saveSavedQuery: async (input) => {
      const handle = await acquire();
      await handle.runAsync(
        `INSERT INTO saved_queries
           (environment_id, query_key, schema_version, payload, payload_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment_id, query_key) DO UPDATE SET
           schema_version = excluded.schema_version,
           payload = excluded.payload,
           payload_bytes = excluded.payload_bytes,
           updated_at = excluded.updated_at`,
        [
          input.environmentId,
          input.key,
          input.schemaVersion,
          input.payload,
          input.payloadBytes,
          input.updatedAt,
        ],
      );
    },
    listSavedQueryStats: async () => {
      const handle = await acquire();
      const rows = await handle.getAllAsync<{
        environment_id: string;
        query_key: string;
        payload_bytes: number;
        updated_at: number;
      }>("SELECT environment_id, query_key, payload_bytes, updated_at FROM saved_queries", []);
      return rows.map((row) => ({
        environmentId: row.environment_id,
        key: row.query_key,
        payloadBytes: row.payload_bytes,
        updatedAt: row.updated_at,
      }));
    },
    removeSavedQueries: async (entries) => {
      if (entries.length === 0) return;
      const handle = await acquire();
      for (const entry of entries) {
        await handle.runAsync(
          "DELETE FROM saved_queries WHERE environment_id = ? AND query_key = ?",
          [entry.environmentId, entry.key],
        );
      }
    },
    savedQueryBytes: async (environmentId) => {
      const handle = await acquire();
      const row = await handle.getFirstAsync<{ bytes: number | null }>(
        "SELECT SUM(payload_bytes) AS bytes FROM saved_queries WHERE environment_id = ?",
        [environmentId],
      );
      return row?.bytes ?? 0;
    },
    removeSavedQueriesBelowVersion: async (minimum) => {
      const handle = await acquire();
      await handle.runAsync("DELETE FROM saved_queries WHERE schema_version < ?", [minimum]);
    },
    clearSavedQueries: async () => {
      const handle = await acquire();
      await handle.runAsync("DELETE FROM saved_queries", []);
    },
  };
}
