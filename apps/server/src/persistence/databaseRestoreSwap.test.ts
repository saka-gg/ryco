// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { classifyFatalStartupError } from "../startupFailure.ts";
import { databaseRestoreJournalPath } from "./databaseRestoreJournal.ts";
import {
  finishDatabaseRestoreSwap,
  finishInterruptedDatabaseRestore,
  isPlannedJournal,
  planDatabaseRestoreSwap,
  restoreSwapPaths,
} from "./databaseRestoreSwap.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

/** A data directory mid-swap: the live files, the staged restore and the journal. */
const makeSwap = (nowMs = Date.UTC(2026, 9, 31, 8, 0, 0)) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-restore-swap-"));
  const stateDir = NodePath.join(root, "userdata");
  const dbPath = NodePath.join(stateDir, "state.sqlite");
  const journal = planDatabaseRestoreSwap(nowMs);
  const paths = restoreSwapPaths(dbPath, journal);
  NodeFS.mkdirSync(NodePath.join(stateDir, "secrets"), { recursive: true });
  NodeFS.mkdirSync(paths.stagingDir);
  NodeFS.writeFileSync(paths.sideMoves[0]!.from, "key");
  NodeFS.writeFileSync(dbPath, "old database");
  NodeFS.writeFileSync(`${dbPath}-wal`, "old log");
  NodeFS.writeFileSync(paths.staged, "restored database");
  const journalPath = databaseRestoreJournalPath(dbPath);
  NodeFS.writeFileSync(journalPath, JSON.stringify(journal));
  return {
    root,
    stateDir,
    dbPath,
    journal,
    paths,
    journalPath,
    cleanup: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

const read = (path: string) => NodeFS.readFileSync(path, "utf8");

describe("in-place restore journal", () => {
  /** Each step of a swap, in the order it runs. */
  const steps: ReadonlyArray<(swap: ReturnType<typeof makeSwap>) => void> = [
    (swap) => NodeFS.mkdirSync(swap.paths.aside, { recursive: true }),
    (swap) => NodeFS.renameSync(swap.paths.sideMoves[0]!.from, swap.paths.sideMoves[0]!.to),
    (swap) => NodeFS.renameSync(swap.paths.sideMoves[1]!.from, swap.paths.sideMoves[1]!.to),
    (swap) => NodeFS.linkSync(swap.dbPath, swap.paths.asideDatabase),
    (swap) => NodeFS.renameSync(swap.paths.staged, swap.dbPath),
  ];

  it.each([0, 1, 2, 3, 4, 5])("finishes a swap interrupted after %i of its steps", async (done) => {
    const swap = makeSwap();
    try {
      for (const step of steps.slice(0, done)) step(swap);

      await finishDatabaseRestoreSwap(swap.journalPath, swap.dbPath, swap.journal);

      assert.equal(read(swap.dbPath), "restored database");
      assert.equal(read(swap.paths.asideDatabase), "old database");
      assert.equal(read(NodePath.join(swap.paths.aside, "state.sqlite-wal")), "old log");
      assert.equal(read(NodePath.join(swap.paths.aside, "server-signing-key.bin")), "key");
      assert.isFalse(NodeFS.existsSync(`${swap.dbPath}-wal`));
      assert.isFalse(NodeFS.existsSync(swap.paths.sideMoves[0]!.from));
      assert.isFalse(NodeFS.existsSync(swap.journalPath));
      assert.isFalse(NodeFS.existsSync(swap.paths.stagingDir));

      // Running it again changes nothing.
      await finishDatabaseRestoreSwap(swap.journalPath, swap.dbPath, swap.journal);
      assert.equal(read(swap.dbPath), "restored database");
    } finally {
      swap.cleanup();
    }
  });

  it("only removes the journal when the restored file already has its name", async () => {
    const swap = makeSwap();
    try {
      for (const step of steps) step(swap);
      assert.isFalse(await finishDatabaseRestoreSwap(swap.journalPath, swap.dbPath, swap.journal));
      assert.equal(read(swap.dbPath), "restored database");
      assert.isFalse(NodeFS.existsSync(swap.journalPath));
    } finally {
      swap.cleanup();
    }
  });

  it("never leaves the database's name missing while it swaps", async () => {
    const swap = makeSwap();
    try {
      for (const step of steps.slice(0, 4)) step(swap);
      // Linked, not moved: the live name still opens the old database until the rename.
      assert.equal(read(swap.dbPath), "old database");
      await finishDatabaseRestoreSwap(swap.journalPath, swap.dbPath, swap.journal);
      assert.equal(read(swap.dbPath), "restored database");
    } finally {
      swap.cleanup();
    }
  });

  it("never moves a file over one that is already in the replaced directory", async () => {
    const swap = makeSwap();
    try {
      NodeFS.mkdirSync(swap.paths.aside, { recursive: true });
      NodeFS.writeFileSync(swap.paths.asideDatabase, "someone else's");
      let failure: unknown;
      await finishDatabaseRestoreSwap(swap.journalPath, swap.dbPath, swap.journal).catch(
        (error: unknown) => {
          failure = error;
        },
      );
      assert.include(String(failure), "already exists");
      assert.equal(read(swap.paths.asideDatabase), "someone else's");
      assert.equal(read(swap.dbPath), "old database");
      // The journal stays, so the swap can still be finished once the conflict is gone.
      assert.isTrue(NodeFS.existsSync(swap.journalPath));
    } finally {
      swap.cleanup();
    }
  });

  it("accepts only directory names it would have written", () => {
    const journal = planDatabaseRestoreSwap(Date.UTC(2026, 9, 31));
    assert.isTrue(isPlannedJournal(journal));
    for (const tampered of [
      { ...journal, staging: "../../.ssh" },
      { ...journal, aside: "secrets" },
      { ...journal, aside: "replaced-x/../../etc" },
      { ...journal, staging: ".restore-staging-20261031T000000000Z/.." },
    ]) {
      assert.isFalse(isPlannedJournal(tampered));
    }
  });

  it.effect("refuses a journal that names other directories, moving nothing", () => {
    const swap = makeSwap();
    return Effect.gen(function* () {
      NodeFS.writeFileSync(swap.journalPath, JSON.stringify({ ...swap.journal, aside: ".." }));
      const failure = yield* finishInterruptedDatabaseRestore(swap.dbPath).pipe(Effect.flip);
      assert.include(failure.message, "was not used");
      // Startup stops with a reason instead of crash-looping.
      assert.equal(classifyFatalStartupError(failure), "database-restore-interrupted");
      assert.equal(read(swap.dbPath), "old database");
      assert.equal(read(swap.paths.sideMoves[0]!.from), "key");
      assert.isTrue(NodeFS.existsSync(swap.paths.staged));
    }).pipe(Effect.ensuring(Effect.sync(swap.cleanup)));
  });

  it.effect("finishes an interrupted swap before the database is opened", () => {
    const swap = makeSwap();
    return Effect.gen(function* () {
      // Real databases this time: the staged one is what the server must open.
      NodeFS.rmSync(swap.dbPath);
      NodeFS.rmSync(`${swap.dbPath}-wal`);
      NodeFS.rmSync(swap.paths.staged);
      for (const [path, note] of [
        [swap.dbPath, "old"],
        [swap.paths.staged, "restored"],
      ] as const) {
        const database = new DatabaseSync(path);
        database.exec(`CREATE TABLE marker (note TEXT); INSERT INTO marker VALUES ('${note}')`);
        database.close();
      }
      // Interrupted right after the key moved.
      NodeFS.mkdirSync(swap.paths.aside, { recursive: true });
      NodeFS.renameSync(swap.paths.sideMoves[0]!.from, swap.paths.sideMoves[0]!.to);

      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly note: string }>`SELECT note FROM marker`;
      }).pipe(
        Effect.provide(
          makeSqlitePersistenceLive(swap.dbPath).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      assert.deepEqual(
        rows.map((row) => row.note),
        ["restored"],
      );
      assert.isFalse(NodeFS.existsSync(swap.journalPath));
      const replaced = new DatabaseSync(swap.paths.asideDatabase, { readOnly: true });
      assert.deepEqual(replaced.prepare("SELECT note FROM marker").all(), [{ note: "old" }]);
      replaced.close();
    }).pipe(Effect.ensuring(Effect.sync(swap.cleanup)));
  });
});
