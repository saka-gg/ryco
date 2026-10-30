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
import { DatabaseBackupCommandError, formatBackupName } from "../persistence/databaseBackups.ts";
import { runMigrations, SUPPORTED_MIGRATION_ID } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

/**
 * Everything one command wrote, isolated from every other: `Layer.fresh` gives each call its own
 * console (see cli.test.ts's `captureStdout`, which this mirrors). The default logger writes
 * through the console too, so a log line on stdout shows up in `lines`.
 */
const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const lines = (yield* TestConsole.logLines).filter(
      (line): line is string => typeof line === "string",
    );
    const errorLines = (yield* TestConsole.errorLines).filter(
      (line): line is string => typeof line === "string",
    );
    return { result, lines, errorLines, output: lines.join("\n") };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, Layer.fresh(TestConsole.layer))));

const makeHome = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-cli-db-"));
  return {
    root,
    dbPath: NodePath.join(root, "userdata", "state.sqlite"),
    backupsDir: NodePath.join(root, "userdata", "backups"),
    cleanup: Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  };
};

/** A current database with one marker row, as a server leaves it. */
const buildDatabase = (dbPath: string) =>
  Effect.gen(function* () {
    NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* runMigrations();
      yield* sql`CREATE TABLE cli_marker (note TEXT)`;
      yield* sql`INSERT INTO cli_marker (note) VALUES ('kept')`;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath }), Logger.layer([])),
      ),
    );
  });

describe("ryco db", () => {
  it.effect(
    "backs up, lists and restores, each --json command writing one document and nothing else",
    () => {
      const home = makeHome();
      const target = makeHome();
      return Effect.gen(function* () {
        yield* buildDatabase(home.dbPath);
        const here = ["--base-dir", home.root];
        // The loudest level the CLI accepts: a single log line would break the document.
        const backup = yield* capture(
          runCli(["--log-level", "debug", "db", "backup", ...here, "--json"]),
        );
        assert.equal(backup.lines.length, 1, backup.lines.join(" | "));
        const backupDocument = JSON.parse(backup.lines[0]!) as {
          readonly path: string;
          readonly schema: number;
          readonly codec: string;
          readonly bytes: number;
        };
        assert.equal(backupDocument.schema, SUPPORTED_MIGRATION_ID);
        assert.equal(NodePath.dirname(backupDocument.path), home.backupsDir);
        assert.isTrue(NodeFS.existsSync(backupDocument.path));
        // No progress on stderr either under --json.
        assert.deepEqual(backup.errorLines, []);

        const list = yield* capture(
          runCli(["--log-level", "debug", "db", "list", ...here, "--json"]),
        );
        assert.equal(list.lines.length, 1, list.lines.join(" | "));
        const listDocument = JSON.parse(list.lines[0]!) as {
          readonly directory: string;
          readonly supportedSchema: number;
          readonly backups: ReadonlyArray<{
            readonly path: string;
            readonly kind: string;
            readonly opensWithThisBuild: boolean;
            readonly createdAt: string;
          }>;
        };
        assert.equal(listDocument.directory, home.backupsDir);
        assert.equal(listDocument.supportedSchema, SUPPORTED_MIGRATION_ID);
        assert.deepEqual(
          listDocument.backups.map((entry) => [entry.path, entry.kind, entry.opensWithThisBuild]),
          [[backupDocument.path, "manual", true]],
        );

        const into = NodePath.join(target.root, "restored");
        const restore = yield* capture(
          runCli([
            "--log-level",
            "debug",
            "db",
            "restore",
            backupDocument.path,
            "--into",
            into,
            ...here,
            "--json",
          ]),
        );
        assert.equal(restore.lines.length, 1, restore.lines.join(" | "));
        const restoreDocument = JSON.parse(restore.lines[0]!) as {
          readonly path: string;
          readonly baseDir: string;
          readonly schema: number;
        };
        assert.equal(restoreDocument.path, NodePath.join(into, "userdata", "state.sqlite"));
        assert.equal(restoreDocument.schema, SUPPORTED_MIGRATION_ID);
        const restored = new DatabaseSync(restoreDocument.path, { readOnly: true });
        const marker = restored.prepare("SELECT note FROM cli_marker").get() as { note: string };
        restored.close();
        assert.equal(marker.note, "kept");
      }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
    },
  );

  it.effect("prints readable output with the paths to restore from", () => {
    const home = makeHome();
    const target = makeHome();
    return Effect.gen(function* () {
      yield* buildDatabase(home.dbPath);
      const here = ["--base-dir", home.root];
      const empty = yield* capture(runCli(["db", "list", ...here]));
      assert.equal(empty.output, `No database backups in ${home.backupsDir}.`);

      const backup = yield* capture(runCli(["db", "backup", ...here]));
      assert.include(backup.output, `Backed up the database (schema ${SUPPORTED_MIGRATION_ID})`);
      assert.include(backup.output, home.backupsDir);
      // Progress goes to stderr, so stdout stays the result.
      assert.deepEqual(backup.errorLines, [
        "Copying the database (VACUUM INTO)...",
        "Checking the copy (quick_check)...",
        "Compressing the copy...",
      ]);

      const newer = formatBackupName({
        stem: "state",
        from: SUPPORTED_MIGRATION_ID + 3,
        to: "manual",
        at: Date.UTC(2026, 0, 1),
        codec: "zst",
      });
      NodeFS.writeFileSync(NodePath.join(home.backupsDir, newer), "x");
      const list = yield* capture(runCli(["db", "list", ...here]));
      assert.include(list.output, `this build opens schema ${SUPPORTED_MIGRATION_ID} and older`);
      const listLines = list.output.split("\n");
      const newerRow = listLines.findIndex((line) => line.includes("needs a newer Ryco build"));
      assert.isAtLeast(newerRow, 0, list.output);
      assert.equal(listLines[newerRow + 1]?.trim(), NodePath.join(home.backupsDir, newer));
      assert.include(list.output, `manual, schema ${SUPPORTED_MIGRATION_ID}`);
      assert.include(list.output, "ryco db restore <file> --into <new directory>");

      const manual = NodeFS.readdirSync(home.backupsDir).find(
        (name) => name !== newer && name.endsWith(".zst"),
      );
      const into = NodePath.join(target.root, "restored");
      const restore = yield* capture(
        runCli(["db", "restore", NodePath.join(home.backupsDir, manual!), "--into", into, ...here]),
      );
      assert.include(restore.output, `ryco serve --base-dir ${into}`);
      assert.include(restore.output, "pair your devices with it again");
      // Making it the database in use is `--replace`, which signs every device out: an old
      // database would accept again every session revoked after the backup.
      assert.include(
        restore.output,
        `ryco db restore ${NodePath.join(home.backupsDir, manual!)} --replace`,
      );
      assert.include(restore.output, "signs every device out");
      assert.include(restore.output, "revoked since the backup");
    }).pipe(Effect.ensuring(home.cleanup), Effect.ensuring(target.cleanup));
  });

  it.effect(
    "fails with one clear message, and never restores into the data directory in use",
    () => {
      const home = makeHome();
      return Effect.gen(function* () {
        const here = ["--base-dir", home.root];
        const missing = yield* runCli(["db", "backup", ...here]).pipe(
          Effect.provide(CliRuntimeLayer),
          Effect.flip,
        );
        assert.instanceOf(missing, DatabaseBackupCommandError);
        assert.equal((missing as DatabaseBackupCommandError).reason, "no-database");
        assert.include(missing.message, `No Ryco database at ${home.dbPath}`);

        yield* buildDatabase(home.dbPath);
        const backup = yield* capture(runCli(["db", "backup", ...here, "--json"]));
        const { path } = JSON.parse(backup.lines[0]!) as { readonly path: string };
        const before = NodeFS.readdirSync(home.root, { recursive: true }).map(String).toSorted();
        const refused = yield* runCli([
          "db",
          "restore",
          path,
          "--into",
          NodePath.join(home.root, "userdata", "restored"),
          ...here,
        ]).pipe(Effect.provide(CliRuntimeLayer), Effect.flip);
        assert.instanceOf(refused, DatabaseBackupCommandError);
        assert.equal((refused as DatabaseBackupCommandError).reason, "unsafe-target");
        assert.include(refused.message, "data directory in use");
        assert.deepEqual(
          NodeFS.readdirSync(home.root, { recursive: true }).map(String).toSorted(),
          before,
        );
      }).pipe(Effect.ensuring(home.cleanup));
    },
  );
});
