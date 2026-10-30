// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@ryco/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";
import { Command } from "effect/cli";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../cli.ts";
import { DatabaseBackupCommandError } from "../persistence/databaseBackups.ts";
import { acquireDatabaseMaintenance } from "../persistence/databaseOwnerLock.ts";
import { databaseRestoreJournalPath } from "../persistence/databaseRestoreJournal.ts";
import {
  DatabaseRestoreSwapError,
  replaceDatabaseWithBackup,
  SESSION_SIGNING_KEY_FILE,
} from "../persistence/databaseRestoreSwap.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const lines = (yield* TestConsole.logLines).filter(
      (line): line is string => typeof line === "string",
    );
    return { result, lines, output: lines.join("\n") };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, Layer.fresh(TestConsole.layer))));

const makeHome = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-replace-"));
  const stateDir = NodePath.join(root, "userdata");
  return {
    root,
    stateDir,
    dbPath: NodePath.join(stateDir, "state.sqlite"),
    keyPath: NodePath.join(stateDir, "secrets", SESSION_SIGNING_KEY_FILE),
    here: ["--base-dir", root],
    cleanup: Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  };
};

/** A current database with one marker row and a signing key, as a server leaves them. */
const buildHome = (home: ReturnType<typeof makeHome>) =>
  Effect.gen(function* () {
    NodeFS.mkdirSync(NodePath.dirname(home.keyPath), { recursive: true });
    NodeFS.writeFileSync(home.keyPath, "signing-key");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* runMigrations();
      yield* sql`CREATE TABLE cli_marker (note TEXT)`;
      yield* sql`INSERT INTO cli_marker (note) VALUES ('kept')`;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: home.dbPath }), Logger.layer([])),
      ),
    );
    const backup = yield* capture(runCli(["db", "backup", ...home.here, "--json"]));
    return (JSON.parse(backup.lines[0]!) as { readonly path: string }).path;
  });

/** Adds a row after the backup, leaving it in the write-ahead log. */
const writeAfterBackup = (dbPath: string) => {
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO cli_marker (note) VALUES ('later')");
  return database;
};

const notes = (dbPath: string) => {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      database.prepare("SELECT note FROM cli_marker ORDER BY rowid").all() as Array<{
        note: string;
      }>
    ).map((row) => row.note);
  } finally {
    database.close();
  }
};

const listTree = (root: string) =>
  NodeFS.readdirSync(root, { recursive: true }).map(String).toSorted();

/** {@link listTree} without SQLite's `-wal`/`-shm`, which folding the log into the file removes. */
const listFiles = (root: string) =>
  listTree(root).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"));

describe("ryco db restore --replace", () => {
  it.effect(
    "makes the backup the database in use and keeps what it replaced, signing devices out",
    () => {
      const home = makeHome();
      return Effect.gen(function* () {
        const backup = yield* buildHome(home);
        writeAfterBackup(home.dbPath).close();

        const restore = yield* capture(
          runCli(["db", "restore", backup, "--replace", ...home.here, "--json"]),
        );
        assert.equal(restore.lines.length, 1, restore.lines.join(" | "));
        const document = JSON.parse(restore.lines[0]!) as {
          readonly path: string;
          readonly replacedDir: string;
          readonly signedOut: boolean;
        };
        assert.equal(document.path, home.dbPath);
        assert.isTrue(document.signedOut);
        assert.equal(NodePath.dirname(document.replacedDir), home.stateDir);

        // The database in use is the backup now; the replaced one keeps the later row.
        assert.deepEqual(notes(home.dbPath), ["kept"]);
        assert.deepEqual(notes(NodePath.join(document.replacedDir, "state.sqlite")), [
          "kept",
          "later",
        ]);
        // Every session token was signed with the key that moved aside.
        assert.isFalse(NodeFS.existsSync(home.keyPath));
        assert.equal(
          NodeFS.readFileSync(
            NodePath.join(document.replacedDir, SESSION_SIGNING_KEY_FILE),
            "utf8",
          ),
          "signing-key",
        );
        // Nothing of the swap is left behind.
        assert.isFalse(NodeFS.existsSync(databaseRestoreJournalPath(home.dbPath)));
        assert.deepEqual(
          NodeFS.readdirSync(home.stateDir).filter((name) => name.startsWith(".restore-staging-")),
          [],
        );
      }).pipe(Effect.ensuring(home.cleanup));
    },
  );

  it.effect("says what it did in readable output", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      const backup = yield* buildHome(home);
      const restore = yield* capture(runCli(["db", "restore", backup, "--replace", ...home.here]));
      assert.include(restore.output, `in place of ${home.dbPath}`);
      assert.include(restore.output, "Nothing was deleted.");
      assert.include(restore.output, "Every device was signed out");
      assert.include(restore.output, "revoke");
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("refuses while another connection reads the database, changing nothing", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      const backup = yield* buildHome(home);
      const reader = writeAfterBackup(home.dbPath);
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM cli_marker").get();
      try {
        const before = listTree(home.root);
        const refused = yield* runCli(["db", "restore", backup, "--replace", ...home.here]).pipe(
          Effect.provide(CliRuntimeLayer),
          Effect.flip,
        );
        assert.instanceOf(refused, DatabaseBackupCommandError);
        assert.equal((refused as DatabaseBackupCommandError).reason, "live-database");
        assert.deepEqual(listTree(home.root), before);
        assert.isTrue(NodeFS.existsSync(home.keyPath));
      } finally {
        reader.exec("COMMIT");
        reader.close();
      }
      assert.deepEqual(notes(home.dbPath), ["kept", "later"]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("refuses while another process owns the database", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      const backup = yield* buildHome(home);
      const refused = yield* Effect.scoped(
        acquireDatabaseMaintenance(home.dbPath, "a running server").pipe(
          Effect.andThen(
            runCli(["db", "restore", backup, "--replace", ...home.here]).pipe(
              Effect.provide(CliRuntimeLayer),
              Effect.flip,
            ),
          ),
        ),
      );
      assert.equal((refused as { readonly _tag?: string })._tag, "DatabaseOwnedError");
      assert.deepEqual(notes(home.dbPath), ["kept"]);
      assert.isTrue(NodeFS.existsSync(home.keyPath));
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("takes --into or --replace, exactly one of them", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      const backup = yield* buildHome(home);
      for (const flags of [[], ["--replace", "--into", NodePath.join(home.root, "elsewhere")]]) {
        const refused = yield* runCli(["db", "restore", backup, ...flags, ...home.here]).pipe(
          Effect.provide(CliRuntimeLayer),
          Effect.flip,
        );
        assert.instanceOf(refused, DatabaseBackupCommandError);
      }
      assert.deepEqual(notes(home.dbPath), ["kept"]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("refuses while another process has the file open, or when that is unknown", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      const backup = yield* buildHome(home);
      const before = listFiles(home.root);
      for (const [answer, expected] of [
        [
          { kind: "checked", others: [{ pid: 4242, command: "DB Browser" }] },
          "pid 4242 (DB Browser)",
        ],
        [{ kind: "unavailable", reason: "not supported on win32" }, "not supported on win32"],
      ] as const) {
        const refused = yield* replaceDatabaseWithBackup({
          file: backup,
          live: { baseDir: home.root, stateDir: home.stateDir, dbPath: home.dbPath },
          openSqlite: makeRuntimeSqliteLayer,
          nowMs: Date.now(),
          fileHolders: async () => answer,
        }).pipe(Effect.provide(NodeServices.layer), Effect.flip);
        assert.instanceOf(refused, DatabaseBackupCommandError);
        assert.equal((refused as DatabaseBackupCommandError).reason, "live-database");
        assert.include(refused.message, expected);
        assert.include(refused.message, "Nothing was changed.");
      }
      assert.deepEqual(listFiles(home.root), before);
      assert.deepEqual(notes(home.dbPath), ["kept"]);
    }).pipe(Effect.ensuring(home.cleanup));
  });

  it.effect("moves back what it moved when the swap fails part-way", () => {
    const home = makeHome();
    return Effect.gen(function* () {
      const backup = yield* buildHome(home);
      const nowMs = Date.UTC(2026, 9, 31, 1, 2, 3);
      // Something already sits where the replaced database would go: the key moves first, then
      // the database's move fails.
      const aside = NodePath.join(home.stateDir, "replaced-20261031T010203000Z");
      NodeFS.mkdirSync(aside);
      NodeFS.writeFileSync(NodePath.join(aside, "state.sqlite"), "in the way");

      const failure = yield* replaceDatabaseWithBackup({
        file: backup,
        live: { baseDir: home.root, stateDir: home.stateDir, dbPath: home.dbPath },
        openSqlite: makeRuntimeSqliteLayer,
        nowMs,
      }).pipe(Effect.provide(NodeServices.layer), Effect.flip);
      assert.instanceOf(failure, DatabaseRestoreSwapError);
      assert.include(failure.message, "Nothing was changed.");

      assert.deepEqual(notes(home.dbPath), ["kept"]);
      assert.equal(NodeFS.readFileSync(home.keyPath, "utf8"), "signing-key");
      assert.isFalse(NodeFS.existsSync(databaseRestoreJournalPath(home.dbPath)));
      // What was in the way stays; nothing else is left there.
      assert.deepEqual(NodeFS.readdirSync(aside), ["state.sqlite"]);
      assert.equal(NodeFS.readFileSync(NodePath.join(aside, "state.sqlite"), "utf8"), "in the way");
    }).pipe(Effect.ensuring(home.cleanup));
  });
});
