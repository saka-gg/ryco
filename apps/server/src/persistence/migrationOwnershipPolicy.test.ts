// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Fiber, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  defaultBootId,
  defaultBootTime,
  defaultProcessProbe,
  defaultProcessStartTime,
} from "../processLock/processIdentity.ts";
import { isAcceptingConnections } from "../serverRuntimeState.ts";
import { databaseBackupsDirectory } from "./databaseBackupPolicy.ts";
import {
  acquireDatabaseServer,
  DatabaseOwnerLease,
  DatabaseOwnerLockEnvironment,
  databaseOwnerLockPath,
  type DatabaseUpgradeBlockedError,
} from "./databaseOwnerLock.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import {
  compatibilityRepairMarker,
  migrationSchemaDigest,
  runMigrations,
  SUPPORTED_MIGRATION_ID,
} from "./Migrations.ts";
import { migrateUnderOwnershipPolicy } from "./migrationOwnershipPolicy.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const makeDbPath = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-migration-owner-"));
  return NodePath.join(directory, "userdata", "state.sqlite");
};

const removeHome = (dbPath: string) =>
  Effect.sync(() => {
    const lockPath = databaseOwnerLockPath(dbPath);
    if (NodeFS.existsSync(lockPath)) NodeFS.chmodSync(lockPath, 0o600);
    NodeFS.rmSync(NodePath.dirname(NodePath.dirname(dbPath)), { recursive: true, force: true });
  });

/** A database file migrated through `toMigrationInclusive`, then closed. */
const createDatabase = (dbPath: string, toMigrationInclusive?: number) =>
  Effect.gen(function* () {
    NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
    yield* runMigrations({ toMigrationInclusive }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    );
  });

const inspectFile = (dbPath: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      ledger: (
        db.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get() as {
          id: number;
        }
      ).id,
      schema: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
      repairs: db
        .prepare("SELECT repair_key FROM ryco_compatibility_repairs ORDER BY repair_key")
        .all(),
    };
  } finally {
    db.close();
  }
};

/** The pre-upgrade backups of `dbPath` (databaseBackups.ts), oldest name first. */
const backupFiles = (dbPath: string) => {
  const directory = databaseBackupsDirectory(dbPath);
  return NodeFS.existsSync(directory) ? NodeFS.readdirSync(directory).toSorted() : [];
};

/** Run `statements` on the database file, as another process would. */
const execFile = (dbPath: string, ...statements: ReadonlyArray<string>) => {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
};

const deleteRecord = (key: string) =>
  `DELETE FROM ryco_compatibility_repairs WHERE repair_key = '${compatibilityRepairMarker(key)}'`;

/**
 * A database this binary migrated, then changed back as a binary without the repair `key` left
 * it: the repair's column is gone and its record too.
 */
const forgetRepair = (dbPath: string, key: string, sql: string) =>
  execFile(dbPath, sql, deleteRecord(key));

/** As a release from before repair records left a database: every repair ran, none is recorded. */
const forgetRepairRecords = (dbPath: string) =>
  execFile(
    dbPath,
    "DELETE FROM ryco_compatibility_repairs WHERE repair_key LIKE 'schema-repair:%'",
  );

/** A real live process that stands in for a running server (or another CLI). */
const spawnIdleProcess = Effect.acquireRelease(
  Effect.sync(() =>
    NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
      stdio: "ignore",
    }),
  ),
  (child) => Effect.sync(() => child.kill("SIGKILL")),
);

/** Write the lock that a live owner `pid` would write, with its real boot and start time. */
const writeLiveOwnerFile = async (
  dbPath: string,
  pid: number,
  overrides: Record<string, unknown> = {},
) => {
  const lockPath = databaseOwnerLockPath(dbPath);
  NodeFS.writeFileSync(lockPath, "", { mode: 0o600 });
  const ino = NodeFS.lstatSync(lockPath).ino;
  const record = {
    version: 1,
    token: "live-owner",
    pid,
    kind: "server",
    purpose: "serve",
    launcher: "desktop",
    appVersion: "0.1.0",
    startedAt: new Date().toISOString(),
    bootTime: defaultBootTime(),
    bootId: (await defaultBootId()) ?? null,
    startTime: (await defaultProcessStartTime(pid)) ?? null,
    ino,
    schemaSupported: SUPPORTED_MIGRATION_ID - 1,
    schemaDigest: "0000000000000000",
    ...overrides,
  };
  NodeFS.writeFileSync(lockPath, `${JSON.stringify(record)}\n`);
  return NodeFS.readFileSync(lockPath, "utf8");
};

const writeLiveOwner = (dbPath: string, pid: number, overrides: Record<string, unknown> = {}) =>
  Effect.promise(() => writeLiveOwnerFile(dbPath, pid, overrides));

/**
 * A running server from before the owner lock: no lock file, but a live pid in
 * `server-runtime.json` and something listening on its port. Gone when the scope closes.
 */
const startLegacyServer = (dbPath: string) =>
  Effect.gen(function* () {
    const server = yield* spawnIdleProcess;
    const listening = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const socket = NodeNet.createServer();
            socket.listen(0, "127.0.0.1", () => resolve(socket));
          }),
      ),
      (socket) =>
        Effect.promise(() => new Promise<void>((resolve) => socket.close(() => resolve()))),
    );
    const port = (listening.address() as NodeNet.AddressInfo).port;
    NodeFS.writeFileSync(
      NodePath.join(NodePath.dirname(dbPath), "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: server.pid,
        host: "127.0.0.1",
        port,
        origin: `http://127.0.0.1:${port}`,
        startedAt: new Date().toISOString(),
      }),
    );
  });

/** Build the persistence layer a CLI command builds, and touch the database once. */
const openAsCli = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.exit,
  );

/** Build the persistence layer as the server holding the database's lease does. */
const openAsServer = (dbPath: string) =>
  openAsCli(dbPath).pipe(
    Effect.provide(
      Layer.effect(DatabaseOwnerLease, acquireDatabaseServer(dbPath, { launcher: "serve" })),
    ),
  );

const blockedError = <A, E>(exit: Exit.Exit<A, E>): DatabaseUpgradeBlockedError => {
  if (Exit.isSuccess(exit)) throw new Error("expected the build to fail");
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure === undefined || failure._tag !== "Fail") throw new Error("expected a typed failure");
  const error = failure.error as { readonly _tag?: string };
  assert.equal(error._tag, "DatabaseUpgradeBlockedError");
  return error as DatabaseUpgradeBlockedError;
};

describe("migrations under database ownership", () => {
  it.live("a CLI never migrates a database a live server owns", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
      const server = yield* spawnIdleProcess;
      const lock = yield* writeLiveOwner(dbPath, server.pid!);
      const before = inspectFile(dbPath);

      const startedAt = Date.now();
      const error = blockedError(yield* openAsCli(dbPath));
      // An owner running other schema code never finishes this upgrade: no wait.
      assert.isBelow(Date.now() - startedAt, 5_000);
      assert.equal(error.from, SUPPORTED_MIGRATION_ID - 1);
      assert.equal(error.to, SUPPORTED_MIGRATION_ID);
      assert.equal(error.owner?.pid, server.pid);
      assert.include(error.message, "never upgrades a database under a running server");
      assert.include(error.message, "reopen the desktop app");

      // Neither the ledger pass nor a repair ran, and the owner's lock is untouched.
      assert.deepEqual(inspectFile(dbPath), before);
      assert.equal(NodeFS.readFileSync(databaseOwnerLockPath(dbPath), "utf8"), lock);
      // Only a process that may migrate backs up: a refused CLI takes no backup.
      assert.deepEqual(backupFiles(dbPath), []);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("treats a repair this database never recorded as an upgrade too", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      forgetRepair(
        dbPath,
        "projection-worktree-title",
        "ALTER TABLE projection_worktrees DROP COLUMN title",
      );
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!, { schemaSupported: SUPPORTED_MIGRATION_ID });
      const before = inspectFile(dbPath);

      const error = blockedError(yield* openAsCli(dbPath));
      assert.deepEqual(error.repairs, ["projection-worktree-title"]);
      assert.include(error.message, "repair the database schema (projection-worktree-title)");
      // Nothing ran: no repair, no record, no backup.
      assert.deepEqual(inspectFile(dbPath), before);
      assert.deepEqual(backupFiles(dbPath), []);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("opens a database from before repair records next to an older running server", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      // Kept current by a release without repair records: every repair ran, none is recorded.
      yield* createDatabase(dbPath);
      const repairs = inspectFile(dbPath).repairs.filter(({ repair_key }) =>
        String(repair_key).startsWith("schema-repair:"),
      );
      forgetRepairRecords(dbPath);
      yield* startLegacyServer(dbPath);
      const before = inspectFile(dbPath);

      assert.isTrue(Exit.isSuccess(yield* openAsCli(dbPath)));
      // Nothing to upgrade: no repair ran, nothing was recorded or backed up.
      assert.deepEqual(inspectFile(dbPath), before);
      assert.deepEqual(backupFiles(dbPath), []);

      // A database with any record keeps the records as the rule: the others are pending.
      execFile(
        dbPath,
        `INSERT INTO ryco_compatibility_repairs (repair_key) VALUES ('${compatibilityRepairMarker("thread-forks")}')`,
      );
      const error = blockedError(yield* openAsCli(dbPath));
      assert.isTrue(error.owner?.legacy);
      assert.lengthOf(error.repairs, repairs.length - 1);
      assert.notInclude(error.repairs, "thread-forks");
      assert.include(error.message, "an older Ryco server");
      assert.deepEqual(backupFiles(dbPath), []);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live(
    "still repairs a database from before repair records that lacks a repair's effect",
    () => {
      const dbPath = makeDbPath();
      return Effect.gen(function* () {
        yield* createDatabase(dbPath);
        const repairs = inspectFile(dbPath).repairs;
        forgetRepairRecords(dbPath);
        execFile(dbPath, "ALTER TABLE projection_worktrees DROP COLUMN title");

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startLegacyServer(dbPath);
            const before = inspectFile(dbPath);
            const error = blockedError(yield* openAsCli(dbPath));
            assert.deepEqual(error.repairs, ["projection-worktree-title"]);
            assert.include(error.message, "repair the database schema (projection-worktree-title)");
            assert.deepEqual(inspectFile(dbPath), before);
            assert.deepEqual(backupFiles(dbPath), []);
          }),
        );

        // The updated server backs up before it repairs, and records every repair.
        assert.isTrue(Exit.isSuccess(yield* openAsServer(dbPath)));
        assert.lengthOf(backupFiles(dbPath), 1);
        assert.deepEqual(inspectFile(dbPath).repairs, repairs);
        const check = new DatabaseSync(dbPath, { readOnly: true });
        const columns = check.prepare("PRAGMA table_info(projection_worktrees)").all() as Array<{
          name: string;
        }>;
        check.close();
        assert.isTrue(columns.some((column) => column.name === "title"));
      }).pipe(Effect.ensuring(removeHome(dbPath)));
    },
  );

  it.live("records the repairs of a database from before repair records without a backup", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      const repairs = inspectFile(dbPath).repairs;
      forgetRepairRecords(dbPath);
      const before = inspectFile(dbPath);

      // The first start of a server of this release: nothing but the records changes.
      assert.isTrue(Exit.isSuccess(yield* openAsServer(dbPath)));
      assert.deepEqual(backupFiles(dbPath), []);
      const after = inspectFile(dbPath);
      assert.deepEqual(after.repairs, repairs);
      assert.deepEqual(after.schema, before.schema);
      assert.equal(after.ledger, before.ledger);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("refuses a newer schema next to a live server, naming the backups", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec(
        `INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES (${SUPPORTED_MIGRATION_ID + 1}, 'now', 'FutureSchema')`,
      );
      db.close();
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!, { schemaSupported: SUPPORTED_MIGRATION_ID + 1 });
      const before = inspectFile(dbPath);

      const exit = yield* openAsCli(dbPath);
      assert.isTrue(Exit.isFailure(exit));
      const message = String(Exit.isFailure(exit) ? exit.cause : "");
      assert.include(message, "newer than this binary supports");
      assert.include(message, `backups are in ${databaseBackupsDirectory(dbPath)}`);
      assert.include(message, "`ryco db list` shows them");
      assert.deepEqual(inspectFile(dbPath), before);
      assert.deepEqual(backupFiles(dbPath), []);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("opens a current database next to a live server without writing to its schema", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!);
      const before = inspectFile(dbPath);

      assert.isTrue(Exit.isSuccess(yield* openAsCli(dbPath)));
      assert.deepEqual(inspectFile(dbPath), before);
      assert.deepEqual(backupFiles(dbPath), []);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("migrates a database nobody owns under maintenance ownership", () => {
    const dbPath = makeDbPath();
    const lockPath = databaseOwnerLockPath(dbPath);
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
      const observed: Array<{
        readonly finalize: boolean;
        readonly lock: Record<string, unknown>;
      }> = [];
      yield* migrateUnderOwnershipPolicy(dbPath, ({ finalize }) =>
        Effect.gen(function* () {
          observed.push({ finalize, lock: JSON.parse(NodeFS.readFileSync(lockPath, "utf8")) });
          yield* runMigrations();
        }),
      ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

      assert.equal(observed.length, 1);
      assert.equal(observed[0]!.finalize, false);
      assert.deepInclude(observed[0]!.lock, {
        pid: process.pid,
        kind: "maintenance",
        purpose: "cli-migration",
        launcher: "cli",
      });
      assert.isFalse(NodeFS.existsSync(lockPath));
      assert.equal(inspectFile(dbPath).ledger, SUPPORTED_MIGRATION_ID);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("applies a repair a database nobody owns never recorded, after one backup", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      forgetRepair(
        dbPath,
        "projection-worktree-title",
        "ALTER TABLE projection_worktrees DROP COLUMN title",
      );

      assert.isTrue(Exit.isSuccess(yield* openAsCli(dbPath)));
      const check = new DatabaseSync(dbPath, { readOnly: true });
      const columns = check.prepare("PRAGMA table_info(projection_worktrees)").all() as Array<{
        name: string;
      }>;
      check.close();
      assert.isTrue(columns.some((column) => column.name === "title"));
      assert.deepInclude(inspectFile(dbPath).repairs, {
        repair_key: compatibilityRepairMarker("projection-worktree-title"),
      });
      assert.isFalse(NodeFS.existsSync(databaseOwnerLockPath(dbPath)));
      assert.lengthOf(backupFiles(dbPath), 1);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("backs up a pending migration exactly once, in the process that migrates", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);

      // A CLI on a database nobody owns migrates it under maintenance ownership.
      assert.isTrue(Exit.isSuccess(yield* openAsCli(dbPath)));
      assert.equal(inspectFile(dbPath).ledger, SUPPORTED_MIGRATION_ID);
      const backups = backupFiles(dbPath);
      assert.lengthOf(backups, 1);
      const pad = (id: number) => String(id).padStart(3, "0");
      assert.match(
        backups[0]!,
        new RegExp(
          `^state-v${pad(SUPPORTED_MIGRATION_ID - 1)}-before-v${pad(SUPPORTED_MIGRATION_ID)}-.*\\.sqlite$`,
        ),
      );
      // Current now: the next process has nothing to upgrade and nothing to back up.
      assert.isTrue(Exit.isSuccess(yield* openAsCli(dbPath)));
      assert.deepEqual(backupFiles(dbPath), backups);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("backs up once in the server that holds the database's lease", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
      const lease = Layer.effect(
        DatabaseOwnerLease,
        acquireDatabaseServer(dbPath, { launcher: "serve" }),
      );
      const exit = yield* openAsCli(dbPath).pipe(Effect.provide(lease));
      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(inspectFile(dbPath).ledger, SUPPORTED_MIGRATION_ID);
      assert.lengthOf(backupFiles(dbPath), 1);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("lets the server holding the database's lease migrate it", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
      const finalizeFlags: Array<boolean> = [];
      yield* migrateUnderOwnershipPolicy(dbPath, ({ finalize }) =>
        Effect.sync(() => finalizeFlags.push(finalize)),
      ).pipe(
        Effect.provideService(DatabaseOwnerLease, {
          dbPath,
          lockPath: databaseOwnerLockPath(dbPath),
          enforced: true,
          owner: {
            pid: process.pid,
            kind: "server",
            startedAt: new Date().toISOString(),
            purpose: "serve",
            launcher: "serve",
            appVersion: "0.1.0",
            schemaSupported: SUPPORTED_MIGRATION_ID,
            schemaDigest: migrationSchemaDigest,
            legacy: false,
            self: true,
          },
        }),
        Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
      );
      assert.deepEqual(finalizeFlags, [true]);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("waits for an owner running this schema code to finish its own upgrade", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!, {
        schemaSupported: SUPPORTED_MIGRATION_ID,
        schemaDigest: migrationSchemaDigest,
      });
      let migratedHere = false;
      const cli = yield* Effect.forkChild(
        migrateUnderOwnershipPolicy(dbPath, () =>
          Effect.sync(() => {
            migratedHere = true;
          }),
        ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
      );
      yield* Effect.sleep(400);
      assert.isUndefined(cli.pollUnsafe());
      // The owner finishes its upgrade.
      yield* createDatabase(dbPath);
      yield* Fiber.join(cli);
      assert.isFalse(migratedHere);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("takes no backup while it waits for an owner running this schema code", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!, {
        schemaSupported: SUPPORTED_MIGRATION_ID,
        schemaDigest: migrationSchemaDigest,
      });
      const cli = yield* Effect.forkChild(openAsCli(dbPath));
      yield* Effect.sleep(400);
      assert.isUndefined(cli.pollUnsafe());
      // The owner backs up (not modelled here) and finishes its upgrade; the CLI only waited.
      yield* createDatabase(dbPath);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(cli)));
      assert.deepEqual(backupFiles(dbPath), []);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("reads a lock that is being written again before it counts as owned", () => {
    const dbPath = makeDbPath();
    const lockPath = databaseOwnerLockPath(dbPath);
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);

      // Created by another process that never writes its record: owned by someone unknown, but
      // only once that has lasted as long as taking ownership would wait.
      NodeFS.writeFileSync(lockPath, "", { mode: 0o600 });
      const startedAt = Date.now();
      const error = blockedError(yield* openAsCli(dbPath));
      assert.isAtLeast(Date.now() - startedAt, 900);
      assert.isNull(error.owner);
      assert.include(error.message, "cannot tell whether a Ryco server is using it");
      assert.equal(inspectFile(dbPath).ledger, SUPPORTED_MIGRATION_ID - 1);

      // That process gives the database up (it found an older server, say): this one migrates.
      NodeFS.writeFileSync(lockPath, "", { mode: 0o600 });
      const cli = yield* Effect.forkChild(openAsCli(dbPath));
      yield* Effect.sleep(300);
      NodeFS.rmSync(lockPath);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(cli)));
      assert.equal(inspectFile(dbPath).ledger, SUPPORTED_MIGRATION_ID);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("reads the database again before it refuses, after trying to take it", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      // One repair this binary runs was never recorded here (another record is): an upgrade.
      execFile(dbPath, deleteRecord("thread-forks"));
      const server = yield* spawnIdleProcess;
      let tookOver = false;
      const environment = {
        pid: process.pid,
        now: Date.now,
        isListening: isAcceptingConnections,
        probe: {
          ...defaultProcessProbe,
          // Looked up first when this process tries to take the database, which it found free:
          // meanwhile a server of other schema code took it and upgraded it.
          bootId: async () => {
            if (!tookOver) {
              tookOver = true;
              await writeLiveOwnerFile(dbPath, server.pid!);
              execFile(
                dbPath,
                `INSERT INTO ryco_compatibility_repairs (repair_key) VALUES ('${compatibilityRepairMarker("thread-forks")}')`,
              );
            }
            return defaultBootId();
          },
        },
      };
      let migratedHere = false;
      const exit = yield* migrateUnderOwnershipPolicy(dbPath, () =>
        Effect.sync(() => {
          migratedHere = true;
        }),
      ).pipe(
        Effect.provideService(DatabaseOwnerLockEnvironment, environment),
        Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
        Effect.exit,
      );
      assert.isTrue(tookOver);
      assert.isTrue(Exit.isSuccess(exit), String(exit));
      assert.isFalse(migratedHere);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "never migrates under a lock it cannot read",
    () => {
      const dbPath = makeDbPath();
      return Effect.gen(function* () {
        yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
        const server = yield* spawnIdleProcess;
        yield* writeLiveOwner(dbPath, server.pid!);
        NodeFS.chmodSync(databaseOwnerLockPath(dbPath), 0o000);

        const error = blockedError(yield* openAsCli(dbPath));
        assert.isNull(error.owner);
        assert.include(error.message, "cannot tell whether a Ryco server is using it");
        assert.equal(inspectFile(dbPath).ledger, SUPPORTED_MIGRATION_ID - 1);
        assert.deepEqual(backupFiles(dbPath), []);
      }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
    },
  );

  it.live("migrates as before when RYCO_DB_OWNER_LOCK=off", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, SUPPORTED_MIGRATION_ID - 1);
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!);
      const exit = yield* openAsCli(dbPath).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ RYCO_DB_OWNER_LOCK: "off" })),
        ),
      );
      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(inspectFile(dbPath).ledger, SUPPORTED_MIGRATION_ID);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });
});
