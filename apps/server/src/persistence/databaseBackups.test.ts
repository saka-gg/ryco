// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Logger } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  BACKUP_NAME_PATTERN,
  BackupEnvironment,
  cleanStaleBackupPartials,
  databaseBackupsDirectory,
  finalizeDatabaseBackups,
  formatBackupName,
  listDatabaseBackups,
  parseBackupName,
  pruneDatabaseBackups,
  snapshotBeforeMigration,
  type BackupEnvironment as BackupEnvironmentShape,
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
