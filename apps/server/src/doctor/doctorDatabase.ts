/**
 * doctorDatabase - the SQLite side of `ryco doctor`: its own connections and the checks it runs.
 *
 * The doctor never builds the persistence layer: that would migrate, start a read worker (or,
 * with `sqlite-checkpoint-worker`, a checkpoint worker: a second connection on the file defeats
 * the exclusive lock below) and set pragmas that write. It opens plain connections of the running
 * runtime (`bun:sqlite` or `node:sqlite`) that fail at once on a busy database instead of
 * retrying, and closes them exactly when the swap needs them closed.
 *
 * @module doctorDatabase
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { ORCHESTRATION_PROJECTOR_NAMES } from "../orchestration/Layers/ProjectionPipeline.ts";
import {
  autoVacuumModeOf,
  type AutoVacuumMode,
} from "../persistence/Layers/DatabaseMaintenance.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import { wholeNonNegative } from "../persistence/databaseStorageReport.ts";
import { inspectMigrationLedger, isUpgradePending } from "../persistence/Migrations.ts";

export interface DoctorConnection {
  readonly sql: SqlClient.SqlClient;
  /** Closes the connection now; idempotent. It is also closed with the enclosing scope. */
  readonly close: Effect.Effect<void>;
}

/**
 * A connection without setup: no migrations, no WAL switch, no busy retries (`busyTimeoutMs: 0`),
 * so a lock held by another process fails the statement at once.
 */
export const openDoctorConnection = (
  filename: string,
  options: { readonly readonly: boolean },
): Effect.Effect<DoctorConnection, SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const close = Scope.close(scope, Exit.void);
    const context = yield* Layer.buildWithScope(
      makeRuntimeSqliteLayer({
        filename,
        readonly: options.readonly,
        disableWAL: true,
        busyTimeoutMs: 0,
      }),
      scope,
    ).pipe(Effect.onError(() => close));
    return { sql: Context.get(context, SqlClient.SqlClient), close };
  });

/**
 * A connection that only reads `filename`. Read-only first; when SQLite cannot read a WAL
 * database that way (Bun's system SQLite cannot create a missing `-shm` read-only:
 * SQLITE_CANTOPEN on the first statement), a read-write connection with `query_only` set, which
 * rejects every write, the way any Ryco process opens the file.
 */
export const openDoctorReadConnection = (
  filename: string,
): Effect.Effect<DoctorConnection, SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const readOnly = yield* openDoctorConnection(filename, { readonly: true });
    const probe = yield* readOnly.sql`SELECT count(*) AS tables FROM sqlite_master`.pipe(
      Effect.result,
    );
    if (probe._tag === "Success") return readOnly;
    yield* readOnly.close;
    const connection = yield* openDoctorConnection(filename, { readonly: false });
    yield* connection.sql.unsafe("PRAGMA query_only = ON");
    yield* connection.sql`SELECT count(*) AS tables FROM sqlite_master`;
    return connection;
  });

export interface DatabasePages {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freePages: number;
  readonly autoVacuum: AutoVacuumMode;
}

export const readDatabasePages: Effect.Effect<DatabasePages, SqlError, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly pageSize: number;
      readonly pageCount: number;
      readonly freePages: number;
      readonly autoVacuum: number;
    }>`
      SELECT
        page_size AS "pageSize",
        page_count AS "pageCount",
        freelist_count AS "freePages",
        auto_vacuum AS "autoVacuum"
      FROM pragma_page_size(), pragma_page_count(), pragma_freelist_count(), pragma_auto_vacuum()
    `;
    return {
      pageSize: wholeNonNegative(row?.pageSize),
      pageCount: wholeNonNegative(row?.pageCount),
      freePages: wholeNonNegative(row?.freePages),
      autoVacuum: autoVacuumModeOf(row?.autoVacuum),
    };
  });

/** Bytes of pages that hold data (what a compacted copy would at most need). */
export const usedBytes = (pages: DatabasePages): number =>
  Math.max(0, pages.pageCount - pages.freePages) * pages.pageSize;

export interface SchemaCompatibility {
  /** Latest migration applied to the database. */
  readonly applied: number;
  /** Latest migration this binary knows. */
  readonly supported: number;
  readonly pendingMigrations: ReadonlyArray<number>;
  /**
   * Keys of the compatibility repairs this binary runs that the database has never recorded
   * (`repairsPending`): the next server start would run them.
   */
  readonly repairs: ReadonlyArray<string>;
}

/** Every migration applied, none newer, and no upgrade left to do (`isUpgradePending`). */
export const isSchemaCurrent = (schema: SchemaCompatibility): boolean =>
  schema.applied === schema.supported &&
  !isUpgradePending({ pending: schema.pendingMigrations, repairsPending: schema.repairs });

/**
 * The database's schema against this binary's, from the migration ledger and the
 * `ryco_compatibility_repairs` records (`inspectMigrationLedger`). Nothing runs, so it also works
 * on a read-only connection.
 */
export const readSchemaCompatibility: Effect.Effect<
  SchemaCompatibility,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const ledger = yield* inspectMigrationLedger();
  return {
    applied: ledger.latestApplied,
    supported: ledger.supported,
    pendingMigrations: ledger.pending,
    repairs: ledger.repairsPending,
  };
});

export interface ProjectionCursors {
  readonly headSequence: number;
  /** Projectors whose cursor is behind the log's head (or missing while the log has events). */
  readonly lagging: ReadonlyArray<{ readonly projector: string; readonly sequence: number }>;
}

/**
 * Every projector's cursor advances with every committed event, so on a database a server
 * closed cleanly all of them equal the head.
 */
export const readProjectionCursors: Effect.Effect<
  ProjectionCursors,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [head] = yield* sql<{
    readonly head: number | null;
  }>`SELECT MAX(sequence) AS head FROM orchestration_events`;
  const headSequence = wholeNonNegative(head?.head);
  const rows = yield* sql<{ readonly projector: string; readonly sequence: number }>`
    SELECT projector, last_applied_sequence AS "sequence" FROM projection_state
  `;
  const cursors = new Map(rows.map((row) => [row.projector, wholeNonNegative(row.sequence)]));
  const lagging =
    headSequence === 0
      ? []
      : Object.values(ORCHESTRATION_PROJECTOR_NAMES)
          .map((projector) => ({ projector, sequence: cursors.get(projector) ?? 0 }))
          .filter((cursor) => cursor.sequence < headSequence);
  return { headSequence, lagging };
});

/** `PRAGMA quick_check` or `integrity_check`: the problems it reports, none when "ok". */
export const checkIntegrity = (
  kind: "quick_check" | "integrity_check",
): Effect.Effect<ReadonlyArray<string>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, unknown>>(`PRAGMA ${kind}`);
    const messages = rows.map((row) => String(Object.values(row)[0] ?? ""));
    return messages.length === 1 && messages[0] === "ok" ? [] : messages;
  });

/**
 * Takes SQLite's exclusive lock and keeps it until the connection closes
 * (`locking_mode = EXCLUSIVE`): fails while any other connection has the database open and has
 * read it, even an idle one in WAL mode. With `locking_mode` set before the first read, SQLite
 * keeps the WAL index in this process's memory and never maps `-shm`.
 */
export const takeExclusiveLock: Effect.Effect<void, SqlError, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA locking_mode = EXCLUSIVE");
    yield* sql.unsafe("BEGIN EXCLUSIVE");
    yield* sql.unsafe("COMMIT");
  },
);

/**
 * Offline settings for the doctor's own connection, which nothing else shares: a 64 MiB page
 * cache instead of SQLite's 2 MiB default (compaction walks every index of the log);
 * `synchronous = NORMAL`, which in WAL mode keeps the database consistent on a crash or power loss
 * and only gives up the durability of the last transactions (deletions a rerun repeats); and a
 * checkpoint every 10,000 WAL pages (40 MiB) instead of 1,000, since each checkpoint copies pages
 * back and syncs the file (the delete phase is bound by those writes).
 */
export const tuneForMaintenance: Effect.Effect<void, SqlError, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA cache_size = -65536");
    yield* sql.unsafe("PRAGMA synchronous = NORMAL");
    yield* sql.unsafe("PRAGMA wal_autocheckpoint = 10000");
  },
);

/** Row counts of every ordinary table (virtual tables are counted through their shadow tables). */
export const countTableRows: Effect.Effect<
  ReadonlyMap<string, number>,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string; readonly sql: string | null }>`
    SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  const counts = new Map<string, number>();
  for (const table of tables) {
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(table.sql ?? "")) continue;
    const [row] = yield* sql.unsafe<{ readonly rows: number }>(
      `SELECT count(*) AS "rows" FROM "${table.name.replaceAll('"', '""')}"`,
    );
    counts.set(table.name, wholeNonNegative(row?.rows));
  }
  return counts;
});

/** AUTOINCREMENT high-water marks, which a copy must keep (sequences are never reused). */
export const readAutoincrementSequences: Effect.Effect<
  ReadonlyArray<string>,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [exists] = yield* sql<{ readonly found: number }>`
    SELECT count(*) AS found FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'
  `;
  if (wholeNonNegative(exists?.found) === 0) return [];
  const rows = yield* sql<{ readonly name: string; readonly seq: number }>`
    SELECT name, seq FROM sqlite_sequence ORDER BY name
  `;
  return rows.map((row) => `${row.name}=${row.seq}`);
});

/** Size of the WAL in frames after a `wal_checkpoint(TRUNCATE)`; `busy` when it could not run. */
export const checkpointTruncate: Effect.Effect<
  { readonly busy: boolean; readonly logFrames: number },
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly busy: number;
    readonly log: number;
  }>`PRAGMA wal_checkpoint(TRUNCATE)`;
  return { busy: Number(row?.busy ?? 0) !== 0, logFrames: Math.max(0, Number(row?.log ?? 0)) };
});
