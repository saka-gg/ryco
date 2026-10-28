// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Logger } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";

import {
  BACKUP_NAME_PATTERN,
  BackupEnvironment,
  cleanStaleBackupPartials,
  createManualBackup,
  databaseBackupsDirectory,
  describeDatabaseBackups,
  detectBackupCodec,
  finalizeDatabaseBackups,
  formatBackupName,
  formatBytes,
  listDatabaseBackups,
  parseBackupName,
  pruneDatabaseBackups,
  RESTORE_MIN_HEADROOM_BYTES,
  restoreDatabaseBackup,
  snapshotBeforeMigration,
  type BackupEnvironment as BackupEnvironmentShape,
  type OpenSqlite,
  type PremigrationBackupMode,
} from "./databaseBackups.ts";
import { makeRuntimeSqliteLayer, makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import {
  compatibilityRepairMarker,
  inspectMigrationLedger,
  runMigrations,
  SUPPORTED_MIGRATION_ID,
} from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

// Derived, so that a new migration does not break these tests.
const LATEST = SUPPORTED_MIGRATION_ID;
const BEFORE_LATEST = LATEST - 1;

/** A pre-upgrade backup's name before `from` -> `to`, raw unless `extension` says otherwise. */
const backupNamePattern = (from: number, to: number, extension = "") =>
  new RegExp(
    `^state-v${String(from).padStart(3, "0")}-before-v${String(to).padStart(3, "0")}` +
      `-\\d{8}T\\d{9}Z\\.sqlite${extension.replaceAll(".", "\\.")}$`,
  );

const makeHome = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-backups-"));
  const dbPath = NodePath.join(root, "userdata", "state.sqlite");
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  return {
    root,
    dbPath,
    backupsDir: databaseBackupsDirectory(dbPath),
    cleanup: Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  };
};

const quiet = Logger.layer([]);

/** A WAL database migrated through `through` (all when undefined) with one marker row. */
const buildDatabase = (dbPath: string, through: number | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* runMigrations({ toMigrationInclusive: through });
    yield* sql`CREATE TABLE IF NOT EXISTS backup_marker (id INTEGER PRIMARY KEY, note TEXT)`;
    yield* sql`INSERT INTO backup_marker (note) VALUES ('before-upgrade')`;
  }).pipe(Effect.provide(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath }), quiet)));

const livePersistence = (dbPath: string) =>
  makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));

/** Builds the server's persistence layer once, as a server start does. */
const startServer = (dbPath: string) =>
  Effect.void.pipe(Effect.provide(Layer.provideMerge(livePersistence(dbPath), quiet)));

const backupFiles = (backupsDir: string) =>
  NodeFS.existsSync(backupsDir) ? NodeFS.readdirSync(backupsDir).toSorted() : [];

const readDatabase = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const ledger = db
      .prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations")
      .get() as {
      id: number;
    };
    const markers = db.prepare("SELECT count(*) AS n FROM backup_marker").get() as { n: number };
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const check = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    return {
      ledger: ledger.id,
      markers: markers.n,
      journal: journal.journal_mode,
      quickCheck: check.map((row) => row.quick_check).join("\n"),
    };
  } finally {
    db.close();
  }
};

/** Phase 1 against `dbPath`, on its own main connection. */
const snapshot = (dbPath: string, mode: PremigrationBackupMode = "auto") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* inspectMigrationLedger();
    return yield* snapshotBeforeMigration({
      sql,
      dbPath,
      ledger,
      mode,
      openSqlite: makeRuntimeSqliteLayer,
    });
  }).pipe(Effect.provide(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath }), quiet)));

const finalize = (dbPath: string) =>
  finalizeDatabaseBackups({ dbPath, openSqlite: makeRuntimeSqliteLayer }).pipe(
    Effect.provide(quiet),
  );

const withEnvironment =
  (patch: Partial<BackupEnvironmentShape>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const env = yield* BackupEnvironment;
      return yield* Effect.provideService(effect, BackupEnvironment, { ...env, ...patch });
    });

const captureLogs = () => {
  const lines: Array<{ readonly level: string; readonly text: string }> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      const parts = Array.isArray(options.message) ? options.message : [options.message];
      lines.push({ level: options.logLevel, text: parts.map(String).join(" ") });
    }),
  ]);
  return { lines, layer };
};

describe("backup names", () => {
  it("round-trips every part of the grammar", () => {
    const at = Date.UTC(2026, 9, 23, 15, 12, 30, 123);
    const before = formatBackupName({ stem: "state", from: 93, to: 95, at });
    assert.equal(before, "state-v093-before-v095-20261023T151230123Z.sqlite");
    assert.deepEqual(parseBackupName(before), {
      stem: "state",
      from: 93,
      to: 95,
      at,
      seq: 1,
      unverified: false,
      codec: null,
    });
    const variants = [
      { stem: "state", from: 0, to: 93, at, seq: 2, unverified: false, codec: "zst" as const },
      {
        stem: "state",
        from: 93,
        to: "manual" as const,
        at,
        seq: 1,
        unverified: false,
        codec: "gz" as const,
      },
      { stem: "my.db-x", from: 1234, to: 1235, at, seq: 1, unverified: true, codec: null },
    ];
    for (const variant of variants) {
      const name = formatBackupName(variant);
      assert.match(name, BACKUP_NAME_PATTERN);
      assert.deepEqual(parseBackupName(name), variant);
    }
    assert.equal(
      formatBackupName({ stem: "state", from: 93, to: "manual", at, codec: "zst" }),
      "state-v093-manual-20261023T151230123Z.sqlite.zst",
    );
    for (const foreign of [
      "state.sqlite",
      "notes.txt",
      "state-v93-before-v95-20261023T151230123Z.sqlite",
      "state-v093-before-v095-20261023T151230123Z.sqlite.xz",
      ".state-v093-before-v095-20261023T151230123Z.sqlite.123.partial",
    ]) {
      assert.isUndefined(parseBackupName(foreign), foreign);
    }
  });
});

describe("retention", () => {
  it.effect(
    "keeps the newest three per kind, counts raw and compressed once, keeps the new one",
    () => {
      const home = makeHome();
      return Effect.gen(function* () {
        NodeFS.mkdirSync(home.backupsDir, { recursive: true });
        const at = (minute: number) => Date.UTC(2026, 9, 23, 12, minute);
        const write = (name: string) =>
          NodeFS.writeFileSync(NodePath.join(home.backupsDir, name), "x");
        const before = (minute: number, codec: "zst" | null = null) =>
          formatBackupName({ stem: "state", from: 90, to: 93, at: at(minute), codec });
        const manual = (minute: number) =>
          formatBackupName({ stem: "state", from: 93, to: "manual", at: at(minute), codec: "zst" });
        // Five pre-upgrade backups; the newest exists raw and compressed (one backup).
        for (const minute of [1, 2, 3, 4]) write(before(minute, "zst"));
        write(before(5));
        write(before(5, "zst"));
        for (const minute of [1, 2, 3, 4]) write(manual(minute));
        const unverified = formatBackupName({
          stem: "state",
          from: 80,
          to: 93,
          at: at(0),
          unverified: true,
        });
        write(unverified);
        write("notes.txt");
        write("other-v001-manual-20261023T120000000Z.sqlite.zst");

        const removed = yield* pruneDatabaseBackups(home.dbPath, { keep: before(1, "zst") }).pipe(
          Effect.provide(quiet),
        );
        assert.deepEqual(removed.toSorted(), [before(2, "zst"), manual(1)].toSorted());
        assert.deepEqual(
          backupFiles(home.backupsDir),
          [
            before(1, "zst"),
            before(3, "zst"),
            before(4, "zst"),
            before(5),
            before(5, "zst"),
            manual(2),
            manual(3),
            manual(4),
            unverified,
            "notes.txt",
            "other-v001-manual-20261023T120000000Z.sqlite.zst",
          ].toSorted(),
        );
        const listed = yield* listDatabaseBackups(home.dbPath);
        // Foreign stems and files are not listed; newest first, the compressed twin before raw.
        assert.deepEqual(
          listed.slice(0, 2).map((backup) => backup.name),
          [before(5, "zst"), before(5)],
        );
        assert.isFalse(listed.some((backup) => backup.name.startsWith("other")));
        assert.equal(listed.find((backup) => backup.name === unverified)?.state, "unverified");
      }).pipe(Effect.ensuring(home.cleanup));
    },
  );

  it.effect("keeps the backup before the last schema change when repair-only ones pile up", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      NodeFS.mkdirSync(home.backupsDir, { recursive: true });
      const at = (minute: number) => Date.UTC(2026, 9, 23, 12, minute);
      const name = (from: number, minute: number) =>
        formatBackupName({ stem: "state", from, to: 93, at: at(minute), codec: "zst" });
      // 92 -> 93 migrated, then a repair kept failing part-way: each restart backed up again.
      const names = [name(91, 0), name(92, 1), name(93, 2), name(93, 3), name(93, 4), name(93, 5)];
      for (const file of names) NodeFS.writeFileSync(NodePath.join(home.backupsDir, file), "x");

      const removed = yield* pruneDatabaseBackups(home.dbPath, { keep: name(93, 5) }).pipe(
        Effect.provide(quiet),
      );
      assert.deepEqual(removed.toSorted(), [name(91, 0), name(93, 2)].toSorted());
      assert.deepEqual(
        backupFiles(home.backupsDir),
        [name(92, 1), name(93, 3), name(93, 4), name(93, 5)].toSorted(),
      );
    }).pipe(Effect.ensuring(home.cleanup));
  });
});

describe("pre-migration backups", () => {
  it.effect("backs up an existing database before a pending migration", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      yield* startServer(home.dbPath);

      const files = backupFiles(home.backupsDir);
      assert.equal(files.length, 1, files.join(", "));
      assert.match(files[0]!, backupNamePattern(BEFORE_LATEST, LATEST));
      const backup = readDatabase(NodePath.join(home.backupsDir, files[0]!));
      assert.deepEqual(backup, {
        ledger: BEFORE_LATEST,
        markers: 1,
        journal: "delete",
        quickCheck: "ok",
      });
      if (process.platform !== "win32") {
        assert.equal(
          NodeFS.statSync(NodePath.join(home.backupsDir, files[0]!)).mode & 0o777,
          0o600,
        );
        assert.equal(NodeFS.statSync(home.backupsDir).mode & 0o777, 0o700);
      }
      assert.equal(readDatabase(home.dbPath).ledger, LATEST);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("takes no backup of a new database or of a current one", () => {
    const fresh = makeHome();
    const current = makeHome();
    return Effect.gen(function* () {
      yield* startServer(fresh.dbPath);
      assert.deepEqual(backupFiles(fresh.backupsDir), []);

      yield* buildDatabase(current.dbPath, undefined);
      yield* startServer(current.dbPath);
      assert.deepEqual(backupFiles(current.backupsDir), []);
    }).pipe(Effect.ensuring(fresh.cleanup), Effect.ensuring(current.cleanup));
  });

  it.effect("backs up before a compatibility repair this database has never run", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      // On an empty database every repair is pending, in order: the last is the newest.
      const newestRepair = (yield* inspectMigrationLedger().pipe(
        Effect.provide(NodeSqliteClient.layerMemory()),
      )).repairsPending.at(-1)!;
      // As if this binary added the repair after the database last ran: a repair-only upgrade.
      const db = new DatabaseSync(home.dbPath);
      db.prepare("DELETE FROM ryco_compatibility_repairs WHERE repair_key = ?").run(
        compatibilityRepairMarker(newestRepair),
      );
      db.close();

      yield* startServer(home.dbPath);
      const files = backupFiles(home.backupsDir);
      assert.equal(files.length, 1, files.join(", "));
      assert.match(files[0]!, backupNamePattern(LATEST, LATEST));
      // The repair ran and is recorded, so the next start takes no backup.
      yield* startServer(home.dbPath);
      assert.equal(backupFiles(home.backupsDir).length, 1);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  for (const path of ["platform", "copy"] as const) {
    it.effect(`captures rows that are only in the WAL (${path} path)`, () => {
      const home = makeHome();
      return Effect.gen(function* () {
        yield* buildDatabase(home.dbPath, BEFORE_LATEST);
        // A reader pinned on an older snapshot keeps the checkpoint from emptying the WAL.
        const reader = new DatabaseSync(home.dbPath);
        reader.exec("BEGIN");
        reader.prepare("SELECT count(*) FROM backup_marker").get();
        const writer = new DatabaseSync(home.dbPath);
        writer.exec("PRAGMA wal_autocheckpoint = 0");
        writer.exec("BEGIN");
        const insert = writer.prepare("INSERT INTO backup_marker (note) VALUES (?)");
        for (let index = 0; index < 2_000; index += 1) insert.run(`wal-${index}`);
        writer.exec("COMMIT");

        const outcome = yield* snapshot(home.dbPath).pipe(
          path === "copy" ? withEnvironment({ platform: "win32" }) : (effect) => effect,
          Effect.ensuring(
            Effect.sync(() => {
              reader.exec("ROLLBACK");
              reader.close();
              writer.close();
            }),
          ),
        );
        assert.equal(outcome._tag, "Written");
        if (outcome._tag !== "Written") return;
        assert.isAbove(outcome.walBytes, 0);
        // APFS (macOS temp directories) clones; elsewhere the platform path may fall back to a copy.
        if (path === "copy") assert.equal(outcome.method, "copy");
        else if (process.platform === "darwin") assert.equal(outcome.method, "clone");
        const backup = readDatabase(outcome.path);
        assert.equal(backup.markers, 2_001);
        assert.equal(backup.quickCheck, "ok");
        assert.equal(backup.journal, "delete");
        // Only the published backup is left: no partials, no -wal or -shm.
        assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(outcome.path)]);
      }).pipe(Effect.ensuring(home.cleanup));
    });
  }

  it.effect("RYCO_PREMIGRATION_BACKUP=off takes no backup", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      yield* startServer(home.dbPath).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ RYCO_PREMIGRATION_BACKUP: "off" })),
        ),
      );
      assert.deepEqual(backupFiles(home.backupsDir), []);
      assert.equal(readDatabase(home.dbPath).ledger, LATEST);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("skips with a warning when disk space is low, and still migrates", () => {
    const home = makeHome();
    const logs = captureLogs();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      yield* Effect.void.pipe(
        Effect.provide(livePersistence(home.dbPath)),
        withEnvironment({
          statfs: async () => ({ type: 1, bavail: 10, bsize: 4096 }),
        }),
        Effect.provide(logs.layer),
      );
      assert.deepEqual(
        backupFiles(home.backupsDir).filter((name) => !name.startsWith(".")),
        [],
      );
      assert.equal(readDatabase(home.dbPath).ledger, LATEST);
      const warning = logs.lines.find(
        (line) => line.level === "Warn" && line.text.includes("without a backup"),
      );
      assert.isDefined(warning);
      assert.include(warning!.text, "needed for a");
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("needs a clone above the size limit unless the mode is always", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const noReflink = withEnvironment({
        platform: "linux",
        fullCopyMaxBytes: 1024,
        cloneFile: () => Promise.reject(new Error("EOPNOTSUPP")),
      });
      const skipped = yield* snapshot(home.dbPath).pipe(noReflink);
      assert.deepEqual(
        { tag: skipped._tag, reason: skipped._tag === "Skipped" ? skipped.reason : null },
        { tag: "Skipped", reason: "no-clone-large" },
      );
      // A darwin backups directory on another device cannot hold a clone either.
      const otherDevice = yield* snapshot(home.dbPath).pipe(
        withEnvironment({
          platform: "darwin",
          fullCopyMaxBytes: 1024,
          statfs: async () => ({ type: 26, bavail: 1e9, bsize: 4096 }),
          deviceOf: async (path) => (path.endsWith("backups") ? 2 : 1),
        }),
      );
      assert.equal(otherDevice._tag === "Skipped" && otherDevice.reason, "no-clone-large");
      assert.deepEqual(backupFiles(home.backupsDir), []);

      const copied = yield* snapshot(home.dbPath, "always").pipe(noReflink);
      assert.equal(copied._tag === "Written" && copied.method, "copy");
      assert.equal(backupFiles(home.backupsDir).length, 1);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("reuses an unchanged backup of the same upgrade within ten minutes", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const first = yield* snapshot(home.dbPath);
      assert.equal(first._tag, "Written");
      const second = yield* snapshot(home.dbPath);
      assert.deepEqual(second, {
        _tag: "Reused",
        path: first._tag === "Written" ? first.path : "",
      });

      // A chat event written in between (say, by an older build) makes the old backup stale.
      const db = new DatabaseSync(home.dbPath);
      db.exec(`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         actor_kind, payload_json, metadata_json)
        VALUES ('older-build', 'thread', 't1', 1, 'thread.created', 'now', 'user', '{}', '{}')`);
      db.close();
      yield* TestClock.adjust("1 millis");
      const third = yield* snapshot(home.dbPath);
      assert.equal(third._tag, "Written");

      // Past the window a new copy is taken, and it replaces the unchanged one.
      yield* TestClock.adjust("10 minutes");
      const fourth = yield* snapshot(home.dbPath);
      assert.equal(fourth._tag, "Written");
      assert.deepEqual(
        backupFiles(home.backupsDir),
        [first, fourth].map((outcome) =>
          outcome._tag === "Written" ? NodePath.basename(outcome.path) : "",
        ),
      );
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("keeps older backups through a crash loop longer than the reuse window", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const start = Date.UTC(2026, 9, 24, 12);
      const day = 24 * 60 * 60_000;
      yield* TestClock.setTime(start);
      NodeFS.mkdirSync(home.backupsDir, { recursive: true });
      const older = [
        { from: BEFORE_LATEST - 2, to: BEFORE_LATEST - 1, at: start - 23 * day },
        { from: BEFORE_LATEST - 1, to: BEFORE_LATEST, at: start - 14 * day },
        { from: BEFORE_LATEST, to: BEFORE_LATEST, at: start - 4 * day },
      ].map((name) => formatBackupName({ stem: "state", ...name, codec: "zst" }));
      for (const name of older) NodeFS.writeFileSync(NodePath.join(home.backupsDir, name), "x");

      // The migration fails and rolls back on every start, and the service restarts the server
      // every minute for 35 minutes: each start finds the same upgrade and the same database.
      const outcomes: string[] = [];
      for (let minute = 0; minute < 35; minute += 1) {
        outcomes.push((yield* snapshot(home.dbPath))._tag);
        yield* TestClock.adjust("1 minute");
      }
      assert.deepEqual(
        outcomes.flatMap((tag, minute) => (tag === "Written" ? [minute] : [])),
        [0, 10, 20, 30],
      );
      // One copy of the looping upgrade, which pushed out only what one backup would have.
      const latest = formatBackupName({
        stem: "state",
        from: BEFORE_LATEST,
        to: LATEST,
        at: start + 30 * 60_000,
      });
      assert.deepEqual(backupFiles(home.backupsDir), [...older.slice(1), latest].toSorted());
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("keeps the backups of two repair-only upgrades of the same schema", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      const repairs = (yield* inspectMigrationLedger().pipe(
        Effect.provide(NodeSqliteClient.layerMemory()),
      )).repairsPending;
      const addRepair = (key: string) => {
        const db = new DatabaseSync(home.dbPath);
        db.prepare("DELETE FROM ryco_compatibility_repairs WHERE repair_key = ?").run(
          compatibilityRepairMarker(key),
        );
        db.close();
      };
      // A build adds a repair; a CLI command backs up, runs it and exits before phase 2.
      addRepair(repairs.at(-1)!);
      const first = yield* snapshot(home.dbPath);
      yield* runMigrations().pipe(
        Effect.provide(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: home.dbPath }), quiet),
        ),
      );
      // A later build adds another repair; it changes nothing else the fingerprint reads.
      addRepair(repairs.at(-2)!);
      yield* TestClock.adjust("1 hour");
      const second = yield* snapshot(home.dbPath);
      assert.deepEqual(
        backupFiles(home.backupsDir),
        [first, second].map((outcome) =>
          outcome._tag === "Written" ? NodePath.basename(outcome.path) : outcome._tag,
        ),
      );
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("skips when the schema moved between the inspection and the write lock", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const outcome = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* inspectMigrationLedger();
        return yield* snapshotBeforeMigration({
          sql,
          dbPath: home.dbPath,
          ledger: { ...ledger, latestApplied: ledger.latestApplied - 1 },
          mode: "auto",
          openSqlite: makeRuntimeSqliteLayer,
        });
      }).pipe(
        Effect.provide(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: home.dbPath }), quiet),
        ),
      );
      assert.equal(outcome._tag === "Skipped" && outcome.reason, "already-migrated");
      assert.deepEqual(backupFiles(home.backupsDir), []);
    }).pipe(Effect.ensuring(home.cleanup));
  });
});

describe("finalizing backups", () => {
  it.effect("checks and compresses raw backups with zstd and a checksum", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const written = yield* snapshot(home.dbPath);
      assert.equal(written._tag, "Written");
      yield* finalize(home.dbPath);

      const files = backupFiles(home.backupsDir);
      assert.equal(files.length, 1, files.join(", "));
      assert.match(files[0]!, backupNamePattern(BEFORE_LATEST, LATEST, ".zst"));
      const compressed = NodeFS.readFileSync(NodePath.join(home.backupsDir, files[0]!));
      // zstd frame magic, and the frame header's checksum flag.
      assert.deepEqual([...compressed.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd]);
      assert.equal(compressed[4]! & 0x04, 0x04);
      const restored = NodePath.join(home.root, "restored.sqlite");
      NodeFS.writeFileSync(restored, NodeZlib.zstdDecompressSync(compressed));
      assert.deepEqual(readDatabase(restored), {
        ledger: BEFORE_LATEST,
        markers: 1,
        journal: "delete",
        quickCheck: "ok",
      });
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("keeps a damaged backup as unverified and removes one with the wrong schema", () => {
    const home = makeHome();
    const logs = captureLogs();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const written = yield* snapshot(home.dbPath);
      if (written._tag !== "Written") return assert.fail(written._tag);
      // Damage every b-tree page after the schema page.
      const pageSize = 4096;
      const handle = NodeFS.openSync(written.path, "r+");
      const size = NodeFS.fstatSync(handle).size;
      for (let offset = pageSize; offset < size; offset += pageSize) {
        NodeFS.writeSync(handle, Buffer.alloc(16, 0xff), 0, 16, offset);
      }
      NodeFS.closeSync(handle);
      // A copy named for another schema: not damaged, but misleading.
      const wrong = NodePath.join(
        home.backupsDir,
        formatBackupName({ stem: "state", from: 80, to: 93, at: Date.UTC(2026, 0, 1) }),
      );
      NodeFS.copyFileSync(home.dbPath, wrong);
      const copy = new DatabaseSync(wrong);
      copy.exec("PRAGMA journal_mode = DELETE");
      copy.close();

      yield* finalizeDatabaseBackups({
        dbPath: home.dbPath,
        openSqlite: makeRuntimeSqliteLayer,
      }).pipe(Effect.provide(logs.layer));
      const files = backupFiles(home.backupsDir);
      assert.deepEqual(files, [
        NodePath.basename(written.path).replace(/\.sqlite$/, "-unverified.sqlite"),
      ]);
      assert.isTrue(
        logs.lines.some((line) => line.level === "Error" && line.text.includes("integrity check")),
      );
      assert.isTrue(
        logs.lines.some(
          (line) => line.level === "Error" && line.text.includes(`holds schema ${BEFORE_LATEST}`),
        ),
      );
      const live = readDatabase(home.dbPath);
      assert.equal(live.quickCheck, "ok");
      assert.equal(live.ledger, BEFORE_LATEST);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.live("an interrupted compression leaves the raw backup and no partial", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      // Incompressible content, so the compression runs long enough to be caught mid-stream.
      const db = new DatabaseSync(home.dbPath);
      db.exec(`CREATE TABLE noise (data BLOB);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64)
        INSERT INTO noise (data) SELECT randomblob(1048576) FROM n;`);
      db.close();
      const written = yield* snapshot(home.dbPath);
      if (written._tag !== "Written") return assert.fail(written._tag);

      const fiber = yield* Effect.forkChild(finalize(home.dbPath));
      const partialSeen = yield* Effect.promise(async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (backupFiles(home.backupsDir).some((name) => name.endsWith(".partial"))) return true;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return false;
      });
      assert.isTrue(partialSeen);
      // Cleanup never removes a partial this process is still writing.
      assert.equal(yield* cleanStaleBackupPartials(home.dbPath), 0);
      yield* Fiber.interrupt(fiber);

      assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(written.path)]);
      yield* finalize(home.dbPath);
      const files = backupFiles(home.backupsDir);
      assert.deepEqual(files, [`${NodePath.basename(written.path)}.zst`]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.live("stops a running integrity check at once when it is interrupted", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const written = yield* snapshot(home.dbPath);
      if (written._tag !== "Written") return assert.fail(written._tag);
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let aborted = false;
      // A check that only ends when it is aborted, like a cold quick_check of a large file.
      const fiber = yield* Effect.forkChild(
        finalize(home.dbPath).pipe(
          withEnvironment({
            quickCheck: (_path, signal) =>
              new Promise((resolve) => {
                markStarted();
                signal.addEventListener("abort", () => {
                  aborted = true;
                  resolve({ _tag: "Failed", message: "aborted" });
                });
              }),
          }),
        ),
      );
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(aborted);
      assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(written.path)]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect(
    "compresses in-process and without quick_check where no child is available (Bun)",
    () => {
      const home = makeHome();
      return Effect.gen(function* () {
        yield* buildDatabase(home.dbPath, BEFORE_LATEST);
        const written = yield* snapshot(home.dbPath);
        if (written._tag !== "Written") return assert.fail(written._tag);
        yield* finalize(home.dbPath).pipe(
          withEnvironment({ quickCheck: null, compressFile: null }),
        );
        const files = backupFiles(home.backupsDir);
        assert.deepEqual(files, [`${NodePath.basename(written.path)}.zst`]);
        const restored = NodePath.join(home.root, "restored.sqlite");
        NodeFS.writeFileSync(
          restored,
          NodeZlib.zstdDecompressSync(
            NodeFS.readFileSync(NodePath.join(home.backupsDir, files[0]!)),
          ),
        );
        assert.equal(readDatabase(restored).ledger, BEFORE_LATEST);
      }).pipe(Effect.ensuring(home.cleanup));
    },
  );

  it.effect("removes partials of dead, own and day-old writers and nothing else", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      NodeFS.mkdirSync(home.backupsDir, { recursive: true });
      const name = formatBackupName({ stem: "state", from: 92, to: 93, at: Date.UTC(2026, 0, 1) });
      const files = {
        dead: `.${name}.4242.partial`,
        deadWal: `.${name}.4242.partial-wal`,
        own: `.${name}.${process.pid}.partial`,
        live: `.${name}.5151.partial`,
        cloned: `.${name}.6161.partial`,
        foreignPartial: ".notes.txt.4242.partial",
        foreign: "notes.txt",
      };
      for (const file of Object.values(files)) {
        NodeFS.writeFileSync(NodePath.join(home.backupsDir, file), "x");
      }
      // A clone keeps the database's mtime: a live writer's partial created just now can carry
      // one from days ago.
      const daysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);
      NodeFS.utimesSync(NodePath.join(home.backupsDir, files.cloned), daysAgo, daysAgo);
      const clean = cleanStaleBackupPartials(home.dbPath).pipe(
        withEnvironment({ processAlive: (pid) => pid !== 4242 }),
        Effect.provide(quiet),
      );

      yield* TestClock.setTime(Date.now());
      assert.equal(yield* clean, 3);
      assert.deepEqual(
        backupFiles(home.backupsDir),
        [files.live, files.cloned, files.foreignPartial, files.foreign].toSorted(),
      );
      // A day later a live pid is more likely a reused one: its untouched partials go too.
      yield* TestClock.setTime(Date.now() + 25 * 60 * 60_000);
      assert.equal(yield* clean, 2);
      assert.deepEqual(
        backupFiles(home.backupsDir),
        [files.foreignPartial, files.foreign].toSorted(),
      );
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("drops a raw backup whose compressed file exists, without checking it again", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const written = yield* snapshot(home.dbPath);
      if (written._tag !== "Written") return assert.fail(written._tag);
      // As if the process stopped between publishing the compressed file and removing the raw one.
      const compressed = `${written.path}.zst`;
      NodeFS.writeFileSync(
        compressed,
        NodeZlib.zstdCompressSync(NodeFS.readFileSync(written.path)),
      );
      let checks = 0;
      yield* finalize(home.dbPath).pipe(
        withEnvironment({
          quickCheck: async () => {
            checks += 1;
            return { _tag: "Failed", message: "must not run" };
          },
        }),
      );
      assert.equal(checks, 0);
      assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(compressed)]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("finalizes only after the delay, in the background of the persistence layer", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      yield* Effect.gen(function* () {
        assert.match(backupFiles(home.backupsDir)[0] ?? "", /\.sqlite$/);
        yield* TestClock.adjust("29 seconds");
        assert.match(backupFiles(home.backupsDir)[0] ?? "", /\.sqlite$/);
        yield* TestClock.adjust("2 seconds");
        const compressed = yield* Effect.promise(async () => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const files = backupFiles(home.backupsDir);
            if (files.length === 1 && files[0]!.endsWith(".zst")) return true;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return false;
        });
        assert.isTrue(compressed, backupFiles(home.backupsDir).join(", "));
      }).pipe(Effect.provide(Layer.provideMerge(livePersistence(home.dbPath), quiet)));
    }).pipe(Effect.ensuring(home.cleanup));
  });
});

// ---------------------------------------------------------------------------------------------
// ryco db backup | list | restore
// ---------------------------------------------------------------------------------------------

const manualBackup = (dbPath: string) =>
  createManualBackup({ dbPath, openSqlite: makeRuntimeSqliteLayer }).pipe(Effect.provide(quiet));

/** The error Bun's SQLite gives for a database it cannot open, wrapped as the client wraps it. */
const unableToOpen = (message = "unable to open database file") =>
  new SqlError({
    reason: new ConnectionError({
      cause: new Error(message),
      message: "Failed to execute statement",
    }),
  });

/** `connection`, with the statements `fails` picks failing as {@link unableToOpen}. */
const failingStatements = (
  connection: Layer.Layer<SqlClient.SqlClient, SqlError>,
  fails: (statement: string) => boolean,
  message?: string,
) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient;
      return new Proxy(client, {
        get: (target, property, receiver) =>
          property === "unsafe"
            ? (statement: string, params?: ReadonlyArray<unknown>) =>
                fails(statement)
                  ? Effect.fail(unableToOpen(message))
                  : target.unsafe(statement, params as never)
            : Reflect.get(target, property, receiver),
      });
    }),
  ).pipe(Layer.provide(connection));

/** Writes `count` random 64 KiB blobs, so copying the database takes a measurable time. */
const addNoise = (dbPath: string, count: number) => {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS noise (data BLOB);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO noise (data) SELECT randomblob(65536) FROM n;`);
  db.close();
};

const writerSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
// No busy handler: any wait for a lock shows up as an error instead of a delay.
db.exec("PRAGMA busy_timeout = 0");
const insert = db.prepare("INSERT INTO backup_marker (note) VALUES ('writer')");
let writes = 0;
let busy = 0;
const errors = [];
const times = [];
const timer = setInterval(() => {
  try {
    insert.run();
    writes += 1;
    times.push(Date.now());
    if (writes === 3) process.stdout.write("writing\\n");
  } catch (error) {
    if (/busy|locked/i.test(String(error && error.message))) busy += 1;
    else errors.push(String(error && error.message));
  }
}, 20);
process.stdin.once("data", () => {
  clearInterval(timer);
  const rows = db.prepare("SELECT count(*) AS n FROM backup_marker").get().n;
  db.close();
  process.stdout.write(JSON.stringify({ writes, busy, errors, rows, times }) + "\\n", () => process.exit(0));
});
`;

interface WriterReport {
  readonly writes: number;
  readonly busy: number;
  readonly errors: ReadonlyArray<string>;
  readonly rows: number;
  /** When each write committed (epoch ms). */
  readonly times: ReadonlyArray<number>;
}

/** A process that inserts a row every 20 ms until stopped; resolves once it has written. */
const spawnWriter = (dbPath: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly stop: () => Promise<WriterReport> }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, ["-e", writerSource, dbPath], {
          stdio: ["pipe", "pipe", "inherit"],
        });
        let output = "";
        let onReport: (report: WriterReport) => void = () => {};
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("writing\n")) resolve({ stop });
          const line = output.split("\n").find((candidate) => candidate.startsWith("{"));
          if (line !== undefined) onReport(JSON.parse(line) as WriterReport);
        });
        const stop = () =>
          new Promise<WriterReport>((resolveReport) => {
            onReport = resolveReport;
            child.stdin.write("stop\n");
          });
        child.on("error", reject);
        child.on("exit", () => reject(new Error("writer exited before writing")));
      }),
  );

const readZstDatabase = (path: string, into: string) => {
  NodeFS.writeFileSync(into, NodeZlib.zstdDecompressSync(NodeFS.readFileSync(path)));
  return into;
};

describe("manual backups", () => {
  it.live("backs up while another process writes every 20 ms, without ever blocking it", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      addNoise(home.dbPath, 512);
      const writer = yield* spawnWriter(home.dbPath);
      let report: WriterReport = {
        writes: 0,
        busy: 0,
        errors: ["not stopped"],
        rows: 0,
        times: [],
      };
      const copyWindow = { from: 0, to: 0 };
      const result = yield* createManualBackup({
        dbPath: home.dbPath,
        openSqlite: makeRuntimeSqliteLayer,
        onStep: (step) =>
          Effect.sync(() => {
            if (step === "copy") copyWindow.from = Date.now();
            if (step === "check") copyWindow.to = Date.now();
          }),
      }).pipe(
        Effect.provide(quiet),
        Effect.ensuring(
          Effect.promise(async () => {
            report = await writer.stop();
          }),
        ),
      );

      assert.equal(report.busy, 0, "the writer waited for a lock");
      assert.deepEqual(report.errors, []);
      assert.isAbove(report.writes, 2);
      // The writer committed while VACUUM INTO was copying.
      assert.isTrue(
        report.times.some((time) => time >= copyWindow.from && time <= copyWindow.to),
        `no write between ${copyWindow.from} and ${copyWindow.to}: ${report.times.join(", ")}`,
      );
      assert.match(
        NodePath.basename(result.path),
        new RegExp(`^state-v0${LATEST}-manual-\\d{8}T\\d{9}Z\\.sqlite\\.zst$`),
      );
      assert.equal(result.schema, LATEST);
      assert.equal(result.codec, "zst");
      // A consistent snapshot: the writer's rows up to some point, without a gap.
      const restored = readZstDatabase(result.path, NodePath.join(home.root, "copy.sqlite"));
      const db = new DatabaseSync(restored, { readOnly: true });
      const rows = db.prepare("SELECT count(*) AS n, max(id) AS last FROM backup_marker").get() as {
        n: number;
        last: number;
      };
      const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      db.close();
      assert.equal(rows.n, rows.last);
      assert.isAtLeast(rows.n, 1);
      assert.isAtMost(rows.n, report.rows);
      assert.equal(journal.journal_mode, "delete");
      assert.equal(readDatabase(restored).quickCheck, "ok");
      // Only the finished backup: no partials.
      assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(result.path)]);
      if (process.platform !== "win32") {
        assert.equal(NodeFS.statSync(result.path).mode & 0o777, 0o600);
      }
      // The live database was read, not changed.
      assert.equal(readDatabase(home.dbPath).ledger, LATEST);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("fails without a database, and on low disk space, writing nothing", () => {
    const missing = makeHome();
    const full = makeHome();
    return Effect.gen(function* () {
      const none = yield* Effect.flip(manualBackup(missing.dbPath));
      assert.equal(none.reason, "no-database");
      assert.include(none.message, `No Ryco database at ${missing.dbPath}`);
      assert.isFalse(NodeFS.existsSync(missing.backupsDir));

      yield* buildDatabase(full.dbPath, undefined);
      const lowSpace = yield* Effect.flip(
        manualBackup(full.dbPath).pipe(
          withEnvironment({ statfs: async () => ({ type: 1, bavail: 10, bsize: 4096 }) }),
        ),
      );
      assert.equal(lowSpace.reason, "insufficient-space");
      assert.include(lowSpace.message, "needed for a");
      assert.deepEqual(backupFiles(full.backupsDir), []);
    }).pipe(Effect.ensuring(missing.cleanup), Effect.ensuring(full.cleanup));
  });

  it.effect("keeps the newest three manual backups and leaves pre-upgrade backups alone", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      NodeFS.mkdirSync(home.backupsDir, { recursive: true });
      const at = (day: number) => Date.UTC(2026, 9, day, 12);
      const seeded = [1, 2, 3].map((day) =>
        formatBackupName({ stem: "state", from: LATEST, to: "manual", at: at(day), codec: "zst" }),
      );
      const before = [1, 2, 3, 4].map((day) =>
        formatBackupName({ stem: "state", from: 92, to: LATEST, at: at(day), codec: "zst" }),
      );
      for (const name of [...seeded, ...before]) {
        NodeFS.writeFileSync(NodePath.join(home.backupsDir, name), "x");
      }
      yield* TestClock.setTime(at(10));
      const result = yield* manualBackup(home.dbPath);
      assert.deepEqual(result.pruned, [seeded[0]]);
      assert.deepEqual(
        backupFiles(home.backupsDir),
        [...seeded.slice(1), ...before, NodePath.basename(result.path)].toSorted(),
      );
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("reads through a read-write connection only where read-only cannot open (Bun)", () => {
    const home = makeHome();
    const opened: Array<string> = [];
    // What Bun's SQLite does with a read-only WAL database whose -shm file does not exist yet: the
    // open succeeds, and every statement fails.
    const failReadOnly =
      (message: string): OpenSqlite =>
      (config) => {
        opened.push(`${NodePath.basename(config.filename)}:${config.readonly ? "ro" : "rw"}`);
        return config.readonly
          ? failingStatements(makeRuntimeSqliteLayer(config), () => true, message)
          : makeRuntimeSqliteLayer(config);
      };
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      const result = yield* createManualBackup({
        dbPath: home.dbPath,
        openSqlite: failReadOnly("unable to open database file"),
      }).pipe(Effect.provide(quiet));
      assert.equal(result.schema, LATEST);
      assert.deepEqual(opened.slice(0, 2), ["state.sqlite:ro", "state.sqlite:rw"]);
      // Any other failure is not retried.
      opened.length = 0;
      const error = yield* Effect.flip(
        createManualBackup({
          dbPath: home.dbPath,
          openSqlite: failReadOnly("disk I/O error"),
        }).pipe(Effect.provide(quiet)),
      );
      assert.equal(error.reason, "io");
      assert.deepEqual(opened, ["state.sqlite:ro"]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("never turns a database file that went away into a new, empty one (Bun)", () => {
    const home = makeHome();
    const opened: Array<string> = [];
    // Bun's SQLite fails a read-only open of a missing file at once, with the message it gives
    // for a WAL database it cannot read; a read-write open would create the file.
    const bunLike =
      (before: (filename: string, readonly: boolean) => void): OpenSqlite =>
      (config) => {
        before(config.filename, config.readonly === true);
        opened.push(`${NodePath.basename(config.filename)}:${config.readonly ? "ro" : "rw"}`);
        return config.readonly && !NodeFS.existsSync(config.filename)
          ? Layer.effect(SqlClient.SqlClient, Effect.fail(unableToOpen()))
          : makeRuntimeSqliteLayer(config);
      };
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      const first = yield* manualBackup(home.dbPath);

      // Something removes the plain copy before it is checked (another process's clean-up).
      const copyRemoved = yield* Effect.flip(
        createManualBackup({
          dbPath: home.dbPath,
          openSqlite: bunLike((filename, readonly) => {
            if (readonly && filename.endsWith(".partial")) NodeFS.rmSync(filename, { force: true });
          }),
        }).pipe(Effect.provide(quiet)),
      );
      assert.equal(copyRemoved.reason, "io", copyRemoved.message);
      assert.isFalse(
        opened.some((entry) => entry.endsWith(":rw")),
        opened.join(", "),
      );
      assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(first.path)]);

      // The database is moved aside as the backup starts.
      opened.length = 0;
      const aside = `${home.dbPath}.aside`;
      const moved = yield* Effect.flip(
        createManualBackup({
          dbPath: home.dbPath,
          openSqlite: bunLike((filename) => {
            if (filename === home.dbPath && NodeFS.existsSync(filename)) {
              NodeFS.renameSync(filename, aside);
            }
          }),
        }).pipe(Effect.provide(quiet)),
      );
      assert.equal(moved.reason, "io", moved.message);
      assert.isFalse(
        opened.some((entry) => entry.endsWith(":rw")),
        opened.join(", "),
      );
      assert.isFalse(NodeFS.existsSync(home.dbPath), "an empty database took its place");
      assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(first.path)]);
      NodeFS.renameSync(aside, home.dbPath);

      // A copy whose ledger is behind the database it was taken from is not published.
      const behind = NodePath.join(home.root, "behind.sqlite");
      const stale = yield* Effect.flip(
        createManualBackup({
          dbPath: home.dbPath,
          openSqlite: (config) => {
            if (!config.readonly || !config.filename.endsWith(".partial")) {
              return makeRuntimeSqliteLayer(config);
            }
            // The same pages, with the newest migrations missing from the ledger.
            NodeFS.copyFileSync(config.filename, behind);
            const db = new DatabaseSync(behind);
            db.exec("DELETE FROM effect_sql_migrations WHERE migration_id > 50");
            db.close();
            return makeRuntimeSqliteLayer({ ...config, filename: behind });
          },
        }).pipe(Effect.provide(quiet)),
      );
      assert.equal(stale.reason, "check-failed", stale.message);
      assert.include(stale.message, `schema 50`);
      assert.deepEqual(backupFiles(home.backupsDir), [NodePath.basename(first.path)]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("never repeats a failed backup on a read-write connection", () => {
    const home = makeHome();
    const opened: Array<string> = [];
    // A read-only connection that opens and reads, but whose VACUUM INTO fails with the message
    // Bun gives for a read-only connection that cannot read.
    const failVacuum: OpenSqlite = (config) => {
      opened.push(`${NodePath.basename(config.filename)}:${config.readonly ? "ro" : "rw"}`);
      if (!config.readonly) return makeRuntimeSqliteLayer(config);
      return failingStatements(makeRuntimeSqliteLayer(config), (statement) =>
        statement.startsWith("VACUUM INTO"),
      );
    };
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      const error = yield* Effect.flip(
        createManualBackup({ dbPath: home.dbPath, openSqlite: failVacuum }).pipe(
          Effect.provide(quiet),
        ),
      );
      assert.equal(error.reason, "io");
      assert.deepEqual(opened, ["state.sqlite:ro"]);
      assert.deepEqual(backupFiles(home.backupsDir), []);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("refuses to back up a damaged database and leaves no partial", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      addNoise(home.dbPath, 8);
      const handle = NodeFS.openSync(home.dbPath, "r+");
      const size = NodeFS.fstatSync(handle).size;
      for (let offset = 4096; offset < size; offset += 4096) {
        NodeFS.writeSync(handle, Buffer.alloc(16, 0xff), 0, 16, offset);
      }
      NodeFS.closeSync(handle);
      const error = yield* Effect.flip(manualBackup(home.dbPath));
      assert.oneOf(error.reason, ["check-failed", "io"]);
      assert.deepEqual(backupFiles(home.backupsDir), []);
    }).pipe(Effect.ensuring(home.cleanup));
  });
});

describe("listing backups", () => {
  it.effect("marks backups with a newer schema as not openable by this build", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      NodeFS.mkdirSync(home.backupsDir, { recursive: true });
      const at = Date.UTC(2026, 9, 23, 12);
      const current = formatBackupName({ stem: "state", from: 92, to: 93, at, codec: "zst" });
      const newer = formatBackupName({
        stem: "state",
        from: SUPPORTED_MIGRATION_ID + 5,
        to: "manual",
        at: at + 1,
        codec: "zst",
      });
      for (const name of [current, newer, "notes.txt"]) {
        NodeFS.writeFileSync(NodePath.join(home.backupsDir, name), "x");
      }
      const listing = yield* describeDatabaseBackups(home.dbPath);
      assert.equal(listing.directory, home.backupsDir);
      assert.equal(listing.supportedSchema, SUPPORTED_MIGRATION_ID);
      assert.deepEqual(
        listing.backups.map((backup) => [backup.name, backup.opensWithThisBuild]),
        [
          [newer, false],
          [current, true],
        ],
      );
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("tells the format from the first bytes, not the name", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      const write = (name: string, content: Buffer | string) => {
        const path = NodePath.join(home.root, name);
        NodeFS.writeFileSync(path, content);
        return path;
      };
      yield* buildDatabase(home.dbPath, undefined);
      const sqlite = NodeFS.readFileSync(home.dbPath);
      assert.equal(yield* detectBackupCodec(write("a.sqlite.zst", sqlite)), "sqlite");
      assert.equal(
        yield* detectBackupCodec(write("b.sqlite.zst", NodeZlib.gzipSync(sqlite))),
        "gz",
      );
      assert.equal(
        yield* detectBackupCodec(write("c.sqlite", NodeZlib.zstdCompressSync(sqlite))),
        "zst",
      );
      assert.isUndefined(yield* detectBackupCodec(write("d.sqlite", "hello")));
      assert.isUndefined(yield* detectBackupCodec(write("e.sqlite", "")));
    }).pipe(Effect.ensuring(home.cleanup));
  });
});

/** Every entry under `root` with its size, to show that a refused restore changed nothing. */
const listTree = (root: string) =>
  NodeFS.existsSync(root)
    ? NodeFS.readdirSync(root, { recursive: true })
        .map(String)
        .toSorted()
        .map((entry) => {
          const info = NodeFS.lstatSync(NodePath.join(root, entry));
          return `${entry}:${info.isDirectory() ? "dir" : info.size}`;
        })
    : null;

const makeRestoreTarget = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-restore-"));
  return {
    root,
    cleanup: Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  };
};

const restoreInto = (
  home: ReturnType<typeof makeHome>,
  file: string,
  intoBaseDir: string,
  options: { readonly fullCheck?: boolean } = {},
) =>
  restoreDatabaseBackup({
    file,
    target: {
      baseDir: intoBaseDir,
      dbPath: NodePath.join(intoBaseDir, "userdata", "state.sqlite"),
    },
    live: { baseDir: home.root, stateDir: NodePath.dirname(home.dbPath), dbPath: home.dbPath },
    openSqlite: makeRuntimeSqliteLayer,
    fullCheck: options.fullCheck,
  }).pipe(Effect.provide(quiet));

describe("restoring a backup", () => {
  it.effect("restores zstd, gzip and plain backups into a new data directory", () => {
    const home = makeHome();
    const target = makeRestoreTarget();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, BEFORE_LATEST);
      const raw = yield* snapshot(home.dbPath);
      if (raw._tag !== "Written") return assert.fail(raw._tag);
      const manual = yield* manualBackup(home.dbPath);
      // gzip content behind a .zst name: the first bytes decide.
      const mislabelled = NodePath.join(target.root, "mislabelled.sqlite.zst");
      NodeFS.writeFileSync(mislabelled, NodeZlib.gzipSync(NodeFS.readFileSync(raw.path)));

      const cases = [
        { file: manual.path, format: "zst", ledger: BEFORE_LATEST },
        { file: raw.path, format: "sqlite", ledger: BEFORE_LATEST },
        { file: mislabelled, format: "gz", ledger: BEFORE_LATEST },
      ] as const;
      for (const [index, testCase] of cases.entries()) {
        const into = NodePath.join(target.root, `restored-${index}`);
        const result = yield* restoreInto(home, testCase.file, into, { fullCheck: index === 0 });
        assert.equal(result.format, testCase.format);
        assert.equal(result.schema, testCase.ledger);
        assert.isTrue(result.opensWithThisBuild);
        assert.deepEqual(result.warnings, []);
        assert.equal(result.check, index === 0 ? "integrity_check" : "quick_check");
        assert.equal(result.path, NodePath.join(into, "userdata", "state.sqlite"));
        assert.deepEqual(readDatabase(result.path), {
          ledger: testCase.ledger,
          markers: 1,
          journal: "delete",
          quickCheck: "ok",
        });
        // Only the database: no partial, no sidecar.
        assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(result.path)), ["state.sqlite"]);
        if (process.platform !== "win32") {
          assert.equal(NodeFS.statSync(result.path).mode & 0o777, 0o600);
          assert.equal(NodeFS.statSync(NodePath.dirname(result.path)).mode & 0o777, 0o700);
        }
      }
      // An empty directory is fine too.
      const empty = NodePath.join(target.root, "empty");
      NodeFS.mkdirSync(empty);
      yield* restoreInto(home, manual.path, empty);
      assert.isTrue(NodeFS.existsSync(NodePath.join(empty, "userdata", "state.sqlite")));
    }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
  });

  it.effect("refuses targets that touch the data directory in use, or are not empty", () => {
    const home = makeHome();
    const target = makeRestoreTarget();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      const manual = yield* manualBackup(home.dbPath);
      const symlinkToLive = NodePath.join(target.root, "link-to-live");
      NodeFS.symlinkSync(home.root, symlinkToLive, "dir");
      const nonEmpty = NodePath.join(target.root, "non-empty");
      NodeFS.mkdirSync(nonEmpty);
      NodeFS.writeFileSync(NodePath.join(nonEmpty, "notes.txt"), "keep me");
      const withDatabase = NodePath.join(target.root, "with-database");
      NodeFS.mkdirSync(NodePath.join(withDatabase, "userdata"), { recursive: true });
      NodeFS.copyFileSync(home.dbPath, NodePath.join(withDatabase, "userdata", "state.sqlite"));
      const aFile = NodePath.join(target.root, "a-file");
      NodeFS.writeFileSync(aFile, "x");

      const cases = [
        { into: home.root, reason: "unsafe-target" },
        { into: NodePath.join(home.root, "userdata", "restored"), reason: "unsafe-target" },
        { into: NodePath.join(home.root, "elsewhere"), reason: "unsafe-target" },
        { into: symlinkToLive, reason: "unsafe-target" },
        { into: NodePath.join(symlinkToLive, "userdata", "x"), reason: "unsafe-target" },
        // A parent of the data directory in use.
        { into: NodePath.dirname(home.root), reason: "unsafe-target" },
        { into: nonEmpty, reason: "target-not-empty" },
        { into: withDatabase, reason: "target-not-empty" },
        { into: aFile, reason: "target-not-empty" },
      ] as const;
      for (const testCase of cases) {
        const liveBefore = listTree(home.root);
        const targetBefore = listTree(target.root);
        const error = yield* Effect.flip(restoreInto(home, manual.path, testCase.into));
        assert.equal(error.reason, testCase.reason, `${testCase.into}: ${error.message}`);
        assert.deepEqual(listTree(home.root), liveBefore, testCase.into);
        assert.deepEqual(listTree(target.root), targetBefore, testCase.into);
      }
    }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
  });

  it.effect("fails on truncated, corrupted or foreign input and removes what it created", () => {
    const home = makeHome();
    const target = makeRestoreTarget();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      addNoise(home.dbPath, 4);
      const manual = yield* manualBackup(home.dbPath);
      const compressed = NodeFS.readFileSync(manual.path);
      const write = (name: string, content: Buffer | string) => {
        const path = NodePath.join(target.root, name);
        NodeFS.writeFileSync(path, content);
        return path;
      };
      const flipped = Buffer.from(compressed);
      flipped[Math.floor(flipped.length / 2)]! ^= 0xff;
      const plain = NodeZlib.zstdDecompressSync(compressed);
      const damagedPlain = Buffer.from(plain);
      for (let offset = 4096; offset < damagedPlain.length; offset += 4096) {
        damagedPlain.fill(0xff, offset, offset + 16);
      }
      const noLedger = NodePath.join(target.root, "no-ledger.sqlite");
      const other = new DatabaseSync(noLedger);
      other.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
      other.close();
      const hardLink = NodePath.join(target.root, "linked.sqlite");
      NodeFS.linkSync(home.dbPath, hardLink);

      const cases = [
        {
          file: write("truncated.zst", compressed.subarray(0, compressed.length - 100)),
          reason: "damaged",
        },
        { file: write("flipped.zst", flipped), reason: "damaged" },
        {
          file: write("truncated.gz", NodeZlib.gzipSync(plain).subarray(0, 1000)),
          reason: "damaged",
        },
        { file: write("damaged.sqlite", damagedPlain), reason: "damaged" },
        { file: write("text.gz", NodeZlib.gzipSync("not a database")), reason: "unknown-format" },
        {
          file: write("empty.zst", NodeZlib.zstdCompressSync(Buffer.alloc(0))),
          reason: "unknown-format",
        },
        { file: write("notes.txt", "hello"), reason: "unknown-format" },
        { file: noLedger, reason: "not-a-ryco-database" },
        { file: NodePath.join(target.root, "missing.zst"), reason: "not-a-file" },
        { file: target.root, reason: "not-a-file" },
        // The database in use itself, and under another name.
        { file: home.dbPath, reason: "live-database" },
        { file: hardLink, reason: "live-database" },
      ] as const;
      for (const testCase of cases) {
        const into = NodePath.join(target.root, "restored");
        const error = yield* Effect.flip(restoreInto(home, testCase.file, into));
        assert.equal(error.reason, testCase.reason, `${testCase.file}: ${error.message}`);
        assert.isFalse(NodeFS.existsSync(into), `${testCase.file} left ${into} behind`);
      }
      // A file with a live WAL next to it is a database in use, not a backup.
      const copy = NodePath.join(target.root, "in-use.sqlite");
      NodeFS.copyFileSync(home.dbPath, copy);
      const open = new DatabaseSync(copy);
      open.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO backup_marker (note) VALUES ('x')",
      );
      const inUse = yield* Effect.flip(
        restoreInto(home, copy, NodePath.join(target.root, "restored")),
      ).pipe(Effect.ensuring(Effect.sync(() => open.close())));
      assert.equal(inUse.reason, "live-database");
    }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
  });

  it.effect(
    "needs free space for the restored database, not just for the compressed backup",
    () => {
      const home = makeHome();
      const target = makeRestoreTarget();
      return Effect.gen(function* () {
        yield* buildDatabase(home.dbPath, undefined);
        const manual = yield* manualBackup(home.dbPath);
        const plain = NodeZlib.zstdDecompressSync(NodeFS.readFileSync(manual.path));
        const gz = NodePath.join(target.root, "backup.sqlite.gz");
        NodeFS.writeFileSync(gz, NodeZlib.gzipSync(plain));
        for (const file of [manual.path, gz]) {
          const compressedBytes = NodeFS.statSync(file).size;
          assert.isAbove(plain.length, compressedBytes + 1);
          const into = NodePath.join(target.root, `restored-${NodePath.extname(file)}`);
          // Room for the backup, not for what it decompresses to.
          const error = yield* Effect.flip(
            restoreInto(home, file, into).pipe(
              withEnvironment({
                statfs: async () => ({ type: 1, bavail: compressedBytes + 1, bsize: 1 }),
              }),
            ),
          );
          assert.equal(error.reason, "insufficient-space", error.message);
          assert.include(error.message, `${formatBytes(plain.length)} for the restored database`);
          assert.isFalse(NodeFS.existsSync(into));
          // Room for the restored database only would leave the volume, which can be the one the
          // database in use writes to, full.
          const headroom = Math.max(plain.length, RESTORE_MIN_HEADROOM_BYTES);
          const full = yield* Effect.flip(
            restoreInto(home, file, into).pipe(
              withEnvironment({
                statfs: async () => ({ type: 1, bavail: plain.length, bsize: 1 }),
              }),
            ),
          );
          assert.equal(full.reason, "insufficient-space", full.message);
          assert.include(full.message, `${formatBytes(headroom)} left free`);
          assert.isFalse(NodeFS.existsSync(into));
          // Exactly enough is enough.
          const result = yield* restoreInto(home, file, into).pipe(
            withEnvironment({
              statfs: async () => ({ type: 1, bavail: plain.length + headroom, bsize: 1 }),
            }),
          );
          assert.equal(result.bytes, plain.length);
        }
      }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
    },
  );

  it.effect("never decompresses more than the checks allowed", () => {
    const home = makeHome();
    const target = makeRestoreTarget();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      const manual = yield* manualBackup(home.dbPath);
      const plain = NodeZlib.zstdDecompressSync(NodeFS.readFileSync(manual.path));
      const write = (name: string, content: Buffer) => {
        const path = NodePath.join(target.root, name);
        NodeFS.writeFileSync(path, content);
        return path;
      };
      const zeros = Buffer.alloc(16 * 1024 * 1024);
      const restore = (file: string, bavail?: number) =>
        Effect.flip(
          restoreInto(home, file, NodePath.join(target.root, "restored")).pipe(
            withEnvironment({
              statfs: async () => ({ type: 1, bavail: bavail ?? 1e12, bsize: 1 }),
            }),
          ),
        );

      // An archive that is not a database is refused before it is decompressed.
      const archive = yield* restore(
        write(
          "logs.tar.gz",
          NodeZlib.gzipSync(Buffer.concat([Buffer.from("NOT A DATABASE"), zeros])),
        ),
      );
      assert.equal(archive.reason, "unknown-format", archive.message);

      // A backup that decompresses to more than its SQLite header states stops there.
      const padded = yield* restore(
        write("padded.sqlite.gz", NodeZlib.gzipSync(Buffer.concat([plain, zeros]))),
      );
      assert.equal(padded.reason, "damaged", padded.message);
      assert.include(padded.message, formatBytes(plain.length));
      assert.isFalse(NodeFS.existsSync(NodePath.join(target.root, "restored")));

      // A header that does not state the size (version-valid-for differs from the change
      // counter): the compressed size passes the check, and decompression stops where it would
      // eat into the margin that must stay free.
      const noSize = Buffer.from(plain);
      noSize.writeUInt32BE(noSize.readUInt32BE(24) + 1, 92);
      const unsized = write("unsized.sqlite.gz", NodeZlib.gzipSync(noSize));
      const compressed = NodeFS.statSync(unsized).size;
      const margin = Math.max(compressed, RESTORE_MIN_HEADROOM_BYTES);
      const overflow = yield* restore(unsized, compressed + margin);
      assert.equal(overflow.reason, "insufficient-space", overflow.message);
      assert.isFalse(NodeFS.existsSync(NodePath.join(target.root, "restored")));
      // With room for all of it, the same file restores.
      const fits = yield* restoreInto(home, unsized, NodePath.join(target.root, "restored")).pipe(
        withEnvironment({
          statfs: async () => ({ type: 1, bavail: margin + plain.length, bsize: 1 }),
        }),
      );
      assert.equal(fits.bytes, plain.length);
    }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
  });

  it.effect("warns about another branch's ledger and a newer schema, and restores anyway", () => {
    const home = makeHome();
    const target = makeRestoreTarget();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath, undefined);
      const foreign = NodePath.join(target.root, "foreign.sqlite");
      NodeFS.copyFileSync(home.dbPath, foreign);
      const db = new DatabaseSync(foreign);
      db.exec("PRAGMA journal_mode = DELETE");
      // 50 has no compatibility repair; 93 has one.
      for (const id of [50, LATEST]) {
        db.prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?").run(
          "SomethingElse",
          id,
        );
      }
      db.prepare(
        "INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES (?, 'now', 'FutureSchema')",
      ).run(SUPPORTED_MIGRATION_ID + 2);
      db.close();

      const result = yield* restoreInto(home, foreign, NodePath.join(target.root, "restored"));
      assert.equal(result.schema, SUPPORTED_MIGRATION_ID + 2);
      assert.isFalse(result.opensWithThisBuild);
      assert.equal(result.warnings.length, 2, result.warnings.join(" | "));
      assert.include(result.warnings[0], "migration 50 is SomethingElse there");
      assert.include(result.warnings[0], `migration ${LATEST} is SomethingElse there`);
      assert.include(
        result.warnings[0],
        "This build would skip its own migration 50, so open it with the build that wrote it.",
      );
      assert.include(result.warnings[1], "newer than this build supports");
      assert.isTrue(NodeFS.existsSync(result.path));
    }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
  });

  it.effect("does not send a database this build repairs to the branch that wrote it", () => {
    const home = makeHome();
    const target = makeRestoreTarget();
    return Effect.gen(function* () {
      // Another branch recorded its own migration 92 first; this build then migrated the
      // database, which ran its compatibility repair for 92.
      yield* buildDatabase(home.dbPath, 91);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, created_at, name)
          VALUES (92, 'now', 'SomeOtherBranch')`;
        yield* runMigrations();
      }).pipe(
        Effect.provide(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: home.dbPath }), quiet),
        ),
      );
      const manual = yield* manualBackup(home.dbPath);

      const result = yield* restoreInto(home, manual.path, NodePath.join(target.root, "restored"));
      assert.isTrue(result.opensWithThisBuild);
      assert.equal(result.warnings.length, 1, result.warnings.join(" | "));
      assert.include(
        result.warnings[0],
        "migration 92 is SomeOtherBranch there but LocalTaskDelegations here",
      );
      assert.include(result.warnings[0], "This build still gets its own schema there");
      assert.notInclude(result.warnings[0], "build that wrote it");
      // It does open with this build, with this build's table for 92.
      yield* startServer(result.path);
      const db = new DatabaseSync(result.path, { readOnly: true });
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'local_task_delegations'")
        .get();
      db.close();
      assert.isDefined(table);
    }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
  });
});
