// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
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
  defaultProcessStartTime,
} from "../processLock/processIdentity.ts";
import {
  DatabaseOwnerLease,
  databaseOwnerLockPath,
  type DatabaseUpgradeBlockedError,
} from "./databaseOwnerLock.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { latestMigrationId, migrationSchemaDigest, runMigrations } from "./Migrations.ts";
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
    };
  } finally {
    db.close();
  }
};

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
const writeLiveOwner = (dbPath: string, pid: number, overrides: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
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
      schemaSupported: latestMigrationId - 1,
      schemaDigest: "0000000000000000",
      ...overrides,
    };
    NodeFS.writeFileSync(lockPath, `${JSON.stringify(record)}\n`);
    return NodeFS.readFileSync(lockPath, "utf8");
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
      yield* createDatabase(dbPath, latestMigrationId - 1);
      const server = yield* spawnIdleProcess;
      const lock = yield* writeLiveOwner(dbPath, server.pid!);
      const before = inspectFile(dbPath);

      const startedAt = Date.now();
      const error = blockedError(yield* openAsCli(dbPath));
      // An owner running other schema code never finishes this upgrade: no wait.
      assert.isBelow(Date.now() - startedAt, 5_000);
      assert.equal(error.from, latestMigrationId - 1);
      assert.equal(error.to, latestMigrationId);
      assert.equal(error.owner?.pid, server.pid);
      assert.include(error.message, "never upgrades a database under a running server");
      assert.include(error.message, "reopen the desktop app");

      // Neither the ledger pass nor a repair ran, and the owner's lock is untouched.
      assert.deepEqual(inspectFile(dbPath), before);
      assert.equal(NodeFS.readFileSync(databaseOwnerLockPath(dbPath), "utf8"), lock);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("treats a repair that would write as an upgrade too", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec("ALTER TABLE projection_worktrees DROP COLUMN title");
      db.close();
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!, { schemaSupported: latestMigrationId });
      const before = inspectFile(dbPath);

      const error = blockedError(yield* openAsCli(dbPath));
      assert.deepEqual(error.repairs, ["repairProjectionWorktreeTitleColumn"]);
      assert.include(
        error.message,
        "repair the database schema (repairProjectionWorktreeTitleColumn)",
      );
      assert.deepEqual(inspectFile(dbPath), before);
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
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });

  it.live("migrates a database nobody owns under maintenance ownership", () => {
    const dbPath = makeDbPath();
    const lockPath = databaseOwnerLockPath(dbPath);
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, latestMigrationId - 1);
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
      assert.equal(inspectFile(dbPath).ledger, latestMigrationId);
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("applies a missing repair to a database nobody owns", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec("ALTER TABLE projection_worktrees DROP COLUMN title");
      db.close();

      assert.isTrue(Exit.isSuccess(yield* openAsCli(dbPath)));
      const check = new DatabaseSync(dbPath, { readOnly: true });
      const columns = check.prepare("PRAGMA table_info(projection_worktrees)").all() as Array<{
        name: string;
      }>;
      check.close();
      assert.isTrue(columns.some((column) => column.name === "title"));
      assert.isFalse(NodeFS.existsSync(databaseOwnerLockPath(dbPath)));
    }).pipe(Effect.ensuring(removeHome(dbPath)));
  });

  it.live("lets the server holding the database's lease migrate it", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, latestMigrationId - 1);
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
            schemaSupported: latestMigrationId,
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
      yield* createDatabase(dbPath, latestMigrationId - 1);
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!, {
        schemaSupported: latestMigrationId,
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

  it.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "never migrates under a lock it cannot read",
    () => {
      const dbPath = makeDbPath();
      return Effect.gen(function* () {
        yield* createDatabase(dbPath, latestMigrationId - 1);
        const server = yield* spawnIdleProcess;
        yield* writeLiveOwner(dbPath, server.pid!);
        NodeFS.chmodSync(databaseOwnerLockPath(dbPath), 0o000);

        const error = blockedError(yield* openAsCli(dbPath));
        assert.isNull(error.owner);
        assert.include(error.message, "cannot tell whether a Ryco server is using it");
        assert.equal(inspectFile(dbPath).ledger, latestMigrationId - 1);
      }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
    },
  );

  it.live("migrates as before when RYCO_DB_OWNER_LOCK=off", () => {
    const dbPath = makeDbPath();
    return Effect.gen(function* () {
      yield* createDatabase(dbPath, latestMigrationId - 1);
      const server = yield* spawnIdleProcess;
      yield* writeLiveOwner(dbPath, server.pid!);
      const exit = yield* openAsCli(dbPath).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ RYCO_DB_OWNER_LOCK: "off" })),
        ),
      );
      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(inspectFile(dbPath).ledger, latestMigrationId);
    }).pipe(Effect.scoped, Effect.ensuring(removeHome(dbPath)));
  });
});
