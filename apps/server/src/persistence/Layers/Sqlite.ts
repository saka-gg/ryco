import { Effect, Layer, FileSystem, Logger, Path } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  BACKUP_FINALIZE_DELAY,
  databaseBackupsDirectory,
  needsPremigrationBackup,
  readPremigrationBackupMode,
} from "../databaseBackupPolicy.ts";
import { asDatabaseOwner } from "../databaseOwnerLock.ts";
import { databaseRestoreJournalPath } from "../databaseRestoreJournal.ts";
import { inspectMigrationLedger, runMigrations } from "../Migrations.ts";
import type { SqliteCheckpointWorkerOptions } from "../SqliteCheckpointWorker.ts";
import { migrateUnderOwnershipPolicy } from "../migrationOwnershipPolicy.ts";
import * as SqliteReadClientLayer from "../SqliteReadClient.ts";
import { BLOCKING_BUSY_TIMEOUT_MS, MAIN_CONNECTION_BUSY_TIMEOUT_MS } from "../sqliteBusy.ts";
import { ServerConfig } from "../../config.ts";
import { trackStartupPhase } from "../../startupStallMonitor.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
  /** Node only (NodeSqliteClient); Bun's client ignores it. */
  readonly walCheckpointWorker?: boolean | SqliteCheckpointWorkerOptions;
  /**
   * Bun's client switches to WAL when it opens the file unless this is set; `setup` then cannot
   * choose `auto_vacuum` first. Node's client sets no pragmas at open and ignores it.
   */
  readonly disableWAL?: boolean;
  /** Bun's client creates a missing file unless this is false; Node's client ignores it. */
  readonly create?: boolean;
  /**
   * How long a statement waits for another connection's lock before it fails with SQLITE_BUSY:
   * Bun's blocking busy timeout, Node's asynchronous retry budget. 0 fails at once. Defaults to
   * each client's own (5 s).
   */
  readonly busyTimeoutMs?: number;
};

type Loader = {
  layer: (
    config: Omit<RuntimeSqliteLayerConfig, "busyTimeoutMs"> & {
      readonly busyTimeout?: number;
      readonly busyRetryBudgetMs?: number;
    },
  ) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

/** A SQLite client of the running runtime (`bun:sqlite` on Bun, `node:sqlite` on Node), no setup. */
export const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  const { busyTimeoutMs, ...rest } = config;
  return clientModule.layer(
    busyTimeoutMs === undefined
      ? rest
      : runtime === "bun"
        ? { ...rest, busyTimeout: busyTimeoutMs }
        : { ...rest, busyRetryBudgetMs: busyTimeoutMs },
  );
}, Layer.unwrap);

/**
 * Which database `setup` prepares. A file database may be shared with other processes, so it
 * migrates under the ownership policy and is backed up before it changes; a private one (in
 * memory, or a copy no other process knows of) is migrated directly.
 */
type SetupTarget =
  | { readonly kind: "file"; readonly dbPath: string }
  | { readonly kind: "private" };

/**
 * The backup code (~30 KB) stays out of the boot path: startup loads it only when a backup is
 * due, otherwise the background pass loads it 30 s later. Failing to load it skips the backup
 * and never fails the upgrade.
 */
const loadDatabaseBackups = Effect.tryPromise(() => import("../databaseBackups.ts"));
const loadFailureText = ({ cause }: { readonly cause?: unknown }) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Brings a file database's schema up to date, after a restorable backup when it is about to
 * change (databaseBackups.ts); the backup never blocks or fails the upgrade. Runs only in the
 * process the ownership policy lets migrate; `finalize` is true in the database's long-lived
 * owner, which may start the backup's background pass.
 */
const backUpAndMigrate = (dbPath: string, options: { readonly finalize: boolean }) =>
  Effect.gen(function* () {
    const mode = yield* readPremigrationBackupMode;
    if (mode !== "off") {
      const ledger = yield* inspectMigrationLedger();
      if (needsPremigrationBackup(ledger)) {
        const sql = yield* SqlClient.SqlClient;
        yield* trackStartupPhase(
          "persistence.migrations.backup",
          loadDatabaseBackups.pipe(
            Effect.flatMap(({ snapshotBeforeMigration }) =>
              snapshotBeforeMigration({
                sql,
                dbPath,
                ledger,
                mode,
                openSqlite: makeRuntimeSqliteLayer,
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning(
                `Upgrading the database without a backup: could not load the backup code: ${loadFailureText(error)}. See docs/database-backups.md to back it up yourself.`,
              ),
            ),
          ),
        );
      }
    }
    const executed = yield* runMigrations({ backupsDir: databaseBackupsDirectory(dbPath) });
    if (mode !== "off" && options.finalize) {
      // Verify, compress and prune out of boot and hydration. Only the database's long-lived owner
      // gets here; a CLI that migrated (finalize false) leaves its raw backup to the next server.
      yield* Effect.forkScoped(
        Effect.delay(
          loadDatabaseBackups.pipe(
            Effect.flatMap(({ finalizeDatabaseBackups }) =>
              finalizeDatabaseBackups({ dbPath, openSqlite: makeRuntimeSqliteLayer }),
            ),
            Effect.catch((error) =>
              Effect.logWarning(`Database backup maintenance failed: ${loadFailureText(error)}`),
            ),
          ),
          BACKUP_FINALIZE_DELAY,
        ),
      );
    }
    return executed;
  });

/**
 * Brings the schema up to date. A file database is migrated, and backed up first, only by the
 * process allowed to (migrationOwnershipPolicy.ts): a CLI refused by a live server, or waiting
 * for one to finish its own upgrade, never takes a backup.
 */
const upgradeSchema = (target: SetupTarget) =>
  target.kind === "private"
    ? runMigrations()
    : migrateUnderOwnershipPolicy(target.dbPath, (options) =>
        backUpAndMigrate(target.dbPath, options),
      );

const runSetup = (target: SetupTarget) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    // node:sqlite waits on the main thread, so the Node client waits briefly per attempt and
    // retries asynchronously for the full budget (sqliteBusy.ts); Bun keeps the blocking wait.
    const busyTimeoutMs =
      process.versions.bun !== undefined
        ? BLOCKING_BUSY_TIMEOUT_MS
        : MAIN_CONNECTION_BUSY_TIMEOUT_MS;
    yield* sql.unsafe(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    // A new database returns its free pages to the file system (DatabaseMaintenance reclaims
    // them a little at a time). SQLite only takes this before the first table exists, and only
    // before WAL: switching to WAL writes the header and pins NONE (probed on SQLite 3.54).
    // Existing databases keep their mode; changing it needs a VACUUM. `sqlite_master`, not the
    // `sqlite_schema` alias: that needs SQLite 3.33, newer than some system builds Bun loads.
    const [schema] = yield* sql<{ readonly tables: number }>`
      SELECT count(*) AS tables FROM sqlite_master
    `;
    if (Number(schema?.tables ?? 0) === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // Read-path tuning, adopted from a repeated A/B on a synthetic 5k-thread / 400k-activity
    // database (fresh-clone cold reads and warm re-reads, 5 runs per variant, twice):
    // - mmap: cold boot hydration reads fell ~50-60% (threads 191 -> 100 ms, anchors 506 ->
    //   187 ms, latest turns 160 -> 62 ms) and warm ones 10-25%.
    // - 32 MiB page cache (default 2 MiB): warm re-reads, the steady state of repeated shell
    //   snapshots, fell 20-35% (latest turns 10 -> 6.6 ms, tool-use stats 37 -> 26 ms).
    // Not adopted: temp_store=MEMORY (no measurable gain) and PRAGMA optimize/ANALYZE (no gain
    // on these plans, seconds of boot-time ANALYZE on large databases, and plan changes).
    // `synchronous` stays at its default on purpose (docs/streaming-sqlite.md).
    yield* sql`PRAGMA mmap_size = 268435456;`;
    yield* sql`PRAGMA cache_size = -32768;`;
    // Checkpoints run on a worker thread where supported and faster (SqliteCheckpointWorker.ts;
    // not in the macOS desktop app); the writer keeps SQLite's autocheckpoint as a 10,000-frame
    // backstop. Long read transactions on the read worker can delay checkpoints, and writes
    // without a pause keep the WAL from restarting, so it may grow well past its steady size
    // (about 41 MB at the backstop). Cap what stays on disk once it is reset (64 MiB).
    yield* sql`PRAGMA journal_size_limit = 67108864;`;
    // Named for the startup stall monitor: a slow ledger pass or one-time repair (9.5 s and
    // 27.4 s stalls were observed before the listener bound) is otherwise unattributed.
    // A file database is migrated only by its owner (migrationOwnershipPolicy.ts).
    yield* trackStartupPhase("persistence.migrations", upgradeSchema(target));
    yield* Effect.logDebug("startup sqlite setup complete", {
      durationMs: Date.now() - startedAt,
    });
  });

const makeSetup = (target: SetupTarget) => Layer.effectDiscard(runSetup(target));
const privateSetup = makeSetup({ kind: "private" });

export interface SqlitePersistenceOptions {
  /**
   * Run WAL checkpoints on a worker thread where it measured faster
   * (SqliteCheckpointWorker.ts: not in the macOS desktop app). Defaults to true;
   * an object sets test and measurement hooks. Short-lived processes turn it off:
   * they serve no event loop, and a connection that needs `wal_checkpoint(TRUNCATE)`
   * to succeed must not race the worker for the checkpoint lock.
   */
  readonly checkpointWorker?: boolean | SqliteCheckpointWorkerOptions;
}

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
  options?: SqlitePersistenceOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  // An in-place restore (`ryco db restore --replace`) that was interrupted is finished before
  // anything opens the database; startup fails with its journal's path when it cannot be
  // (`database-restore-interrupted`, startupFailure.ts).
  if (
    yield* fs.exists(databaseRestoreJournalPath(dbPath)).pipe(Effect.orElseSucceed(() => false))
  ) {
    const { finishInterruptedDatabaseRestore } = yield* Effect.promise(
      () => import("../databaseRestoreSwap.ts"),
    );
    yield* asDatabaseOwner(
      dbPath,
      "finish an interrupted database restore",
      finishInterruptedDatabaseRestore(dbPath),
    );
  }
  // Only a database without content needs `setup` to choose auto_vacuum before WAL. Every other
  // file keeps the Bun client's own WAL switch, which retries SQLITE_BUSY (setup's does not).
  const empty = yield* fs.stat(dbPath).pipe(
    Effect.map((info) => Number(info.size) === 0),
    Effect.orElseSucceed(() => true),
  );

  return SqliteReadClientLayer.layer(dbPath).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        makeSetup({ kind: "file", dbPath }),
        makeRuntimeSqliteLayer({
          filename: dbPath,
          disableWAL: empty,
          spanAttributes: {
            "db.name": path.basename(dbPath),
            "service.name": "ryco-server",
          },
          walCheckpointWorker: options?.checkpointWorker ?? true,
        }),
      ),
    ),
  );
}, Layer.unwrap);

/**
 * A private copy of a database, set up and migrated as the server does its own, without the
 * ownership policy or a pre-upgrade backup: no other process knows the file. The node update
 * preflight (nodeUpdate/preflight.ts) migrates one to show a release can upgrade this node's
 * database. The file must exist: Node's client would create an empty one.
 */
export const makePrivateSqliteCopyLive = (dbPath: string) =>
  Layer.provideMerge(privateSetup, makeRuntimeSqliteLayer({ filename: dbPath, create: false }));

const memoryPersistence = (sqlite: Layer.Layer<SqlClient.SqlClient, SqlError>) =>
  SqliteReadClientLayer.layerMain.pipe(
    Layer.provideMerge(Layer.provideMerge(privateSetup, sqlite)),
  );

/** A new in-memory database that runs every migration itself. */
export const SqlitePersistenceMemoryFresh = memoryPersistence(
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

// Tests build in-memory databases by the hundred, and migrating each one costs
// ~60-180 ms. Under Node, the first build of a process migrates one database and
// keeps its image; each later build opens a private copy of it (well under a
// millisecond) and still runs `setup`, whose ledger pass then has nothing to do.
// `undefined` (Bun, or a `node:sqlite` without images) keeps the fresh path.
let migratedMemoryImagePromise: Promise<Uint8Array | undefined> | undefined;
const buildMigratedMemoryImage = Effect.gen(function* () {
  if (process.versions.bun !== undefined) return undefined;
  const NodeSqliteClient = yield* Effect.promise(defaultSqliteClientLoaders.node);
  if (!NodeSqliteClient.supportsDatabaseImages) return undefined;
  return yield* Effect.gen(function* () {
    const client = yield* NodeSqliteClient.SqliteClient;
    return yield* client.export;
  }).pipe(
    Effect.provide(
      Layer.provideMerge(privateSetup, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );
}).pipe(
  // Built once for every caller, apart from their runtimes: the migration logs
  // would only be noise there. A failure still fails each build that needs it.
  Effect.provide(Logger.layer([])),
);
const migratedMemoryImage = Effect.promise(
  () => (migratedMemoryImagePromise ??= Effect.runPromise(buildMigratedMemoryImage)),
);

/**
 * A new in-memory database with every migration applied, private to the layer
 * that builds it.
 */
export const SqlitePersistenceMemory = Layer.unwrap(
  Effect.gen(function* () {
    const image = yield* migratedMemoryImage;
    if (image === undefined) return SqlitePersistenceMemoryFresh;
    const NodeSqliteClient = yield* Effect.promise(defaultSqliteClientLoaders.node);
    return memoryPersistence(NodeSqliteClient.layer({ filename: ":memory:", image }));
  }),
);

/** The server's persistence: the database at `ServerConfig.dbPath`. */
export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);

/**
 * Persistence for short-lived CLI commands (`ryco project`, `ryco auth`): no
 * checkpoint worker. Such a process serves no clients, so moving its checkpoints
 * off-thread gains nothing, and the trigger would be the running server's WAL
 * backlog rather than its own writes.
 */
export const layerConfigCli = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) =>
    makeSqlitePersistenceLive(dbPath, { checkpointWorker: false }),
  ),
);
