import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
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
    yield* sql`PRAGMA busy_timeout = 5000;`;
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

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "ryco-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
