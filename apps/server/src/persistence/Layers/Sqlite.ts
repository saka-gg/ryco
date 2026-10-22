import { Effect, Layer, FileSystem, Logger, Path } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import * as SqliteReadClientLayer from "../SqliteReadClient.ts";
import { BLOCKING_BUSY_TIMEOUT_MS, MAIN_CONNECTION_BUSY_TIMEOUT_MS } from "../sqliteBusy.ts";
import { ServerConfig } from "../../config.ts";
import { trackStartupPhase } from "../../startupStallMonitor.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

const setup = Layer.effectDiscard(
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
    // Long read transactions on the read worker can delay checkpoints, so the WAL may grow
    // well past its steady size. Cap what stays on disk once it is reset (64 MiB).
    yield* sql`PRAGMA journal_size_limit = 67108864;`;
    // Named for the startup stall monitor: a slow ledger pass or one-time repair (9.5 s and
    // 27.4 s stalls were observed before the listener bound) is otherwise unattributed.
    yield* trackStartupPhase("persistence.migrations", runMigrations());
    yield* Effect.logDebug("startup sqlite setup complete", {
      durationMs: Date.now() - startedAt,
    });
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return SqliteReadClientLayer.layer(dbPath).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        setup,
        makeRuntimeSqliteLayer({
          filename: dbPath,
          spanAttributes: {
            "db.name": path.basename(dbPath),
            "service.name": "ryco-server",
          },
        }),
      ),
    ),
  );
}, Layer.unwrap);

const memoryPersistence = (sqlite: Layer.Layer<SqlClient.SqlClient, SqlError>) =>
  SqliteReadClientLayer.layerMain.pipe(Layer.provideMerge(Layer.provideMerge(setup, sqlite)));

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
    Effect.provide(Layer.provideMerge(setup, NodeSqliteClient.layer({ filename: ":memory:" }))),
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

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
