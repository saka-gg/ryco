// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { databaseRestoreJournalPath } from "./databaseRestoreJournal.ts";
import {
  finishDatabaseRestoreSwap,
  finishInterruptedDatabaseRestore,
  isPlannedJournal,
  planDatabaseRestoreSwap,
} from "./databaseRestoreSwap.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

/** A data directory mid-swap: the live files, the staged restore and the journal. */
const makeSwap = (nowMs = Date.UTC(2026, 9, 31, 8, 0, 0)) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-restore-swap-"));
  const stateDir = NodePath.join(root, "userdata");
  const dbPath = NodePath.join(stateDir, "state.sqlite");
  const stagingDir = NodePath.join(stateDir, ".restore-staging-20261031T080000000Z");
  NodeFS.mkdirSync(NodePath.join(stateDir, "secrets"), { recursive: true });
  NodeFS.mkdirSync(stagingDir);
  const journal = planDatabaseRestoreSwap({ dbPath, stagingDir, nowMs });
  NodeFS.writeFileSync(journal.moves[0]!.from, "key");
  NodeFS.writeFileSync(dbPath, "old database");
  NodeFS.writeFileSync(`${dbPath}-wal`, "old log");
  NodeFS.writeFileSync(journal.staged, "restored database");
  const journalPath = databaseRestoreJournalPath(dbPath);
  NodeFS.writeFileSync(journalPath, JSON.stringify(journal));
  return {
    root,
    stateDir,
    dbPath,
    journal,
    journalPath,
    cleanup: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

const read = (path: string) => NodeFS.readFileSync(path, "utf8");

describe("in-place restore journal", () => {
  // Every point a swap can stop at: after 0..5 of the planned moves (key, database, -wal, -shm,
  // -journal; the last two do not exist here), and after the staged file got its final name.
  it.each([0, 1, 2, 3, 4, 5, 6])(
    "finishes a swap interrupted after step %i",
    async (completedSteps) => {
      const swap = makeSwap();
      try {
        NodeFS.mkdirSync(swap.journal.aside, { recursive: true });
        for (const move of swap.journal.moves.slice(0, Math.min(completedSteps, 5))) {
          if (NodeFS.existsSync(move.from)) NodeFS.renameSync(move.from, move.to);
        }
        if (completedSteps === 6) NodeFS.renameSync(swap.journal.staged, swap.dbPath);

        await finishDatabaseRestoreSwap(swap.journalPath, swap.journal);

        assert.equal(read(swap.dbPath), "restored database");
        assert.equal(read(NodePath.join(swap.journal.aside, "state.sqlite")), "old database");
        assert.equal(read(NodePath.join(swap.journal.aside, "state.sqlite-wal")), "old log");
        assert.equal(read(NodePath.join(swap.journal.aside, "server-signing-key.bin")), "key");
        assert.isFalse(NodeFS.existsSync(`${swap.dbPath}-wal`));
        assert.isFalse(NodeFS.existsSync(swap.journal.moves[0]!.from));
        assert.isFalse(NodeFS.existsSync(swap.journalPath));
        assert.isFalse(NodeFS.existsSync(swap.journal.stagingDir));

        // Running it again changes nothing.
        await finishDatabaseRestoreSwap(swap.journalPath, swap.journal);
        assert.equal(read(swap.dbPath), "restored database");
      } finally {
        swap.cleanup();
      }
    },
  );

  it("never moves a file over one that is already in the replaced directory", async () => {
    const swap = makeSwap();
    try {
      NodeFS.mkdirSync(swap.journal.aside, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(swap.journal.aside, "state.sqlite"), "someone else's");
      let failure: unknown;
      await finishDatabaseRestoreSwap(swap.journalPath, swap.journal).catch((error: unknown) => {
        failure = error;
      });
      assert.include(String(failure), "already exists");
      assert.equal(read(NodePath.join(swap.journal.aside, "state.sqlite")), "someone else's");
      assert.equal(read(swap.dbPath), "old database");
      // The journal stays, so the swap can still be finished once the conflict is gone.
      assert.isTrue(NodeFS.existsSync(swap.journalPath));
    } finally {
      swap.cleanup();
    }
  });

  it("accepts only journals it would have written for that database", () => {
    const swap = makeSwap();
    try {
      assert.isTrue(isPlannedJournal(swap.journal, swap.dbPath));
      const outside = NodePath.join(NodeOS.tmpdir(), "elsewhere");
      const tampered = [
        { ...swap.journal, target: NodePath.join(swap.stateDir, "other.sqlite") },
        { ...swap.journal, stagingDir: outside, staged: NodePath.join(outside, "state.sqlite") },
        { ...swap.journal, aside: NodePath.join(swap.stateDir, "secrets") },
        {
          ...swap.journal,
          moves: swap.journal.moves.map((move, index) =>
            index === 0
              ? { ...move, from: NodePath.join(NodeOS.homedir(), ".ssh", "id_ed25519") }
              : move,
          ),
        },
        { ...swap.journal, moves: swap.journal.moves.slice(1) },
      ];
      for (const journal of tampered) assert.isFalse(isPlannedJournal(journal, swap.dbPath));
      assert.isFalse(isPlannedJournal(swap.journal, NodePath.join(swap.stateDir, "other.sqlite")));
    } finally {
      swap.cleanup();
    }
  });

  it.effect("refuses a journal that names other files, moving nothing", () => {
    const swap = makeSwap();
    return Effect.gen(function* () {
      NodeFS.writeFileSync(
        swap.journalPath,
        JSON.stringify({ ...swap.journal, aside: NodePath.join(swap.root, "outside") }),
      );
      const failure = yield* finishInterruptedDatabaseRestore(swap.dbPath, { owned: true }).pipe(
        Effect.flip,
      );
      assert.include(failure.message, "was not used");
      assert.equal(read(swap.dbPath), "old database");
      assert.equal(read(swap.journal.moves[0]!.from), "key");
      assert.isTrue(NodeFS.existsSync(swap.journal.staged));
    }).pipe(Effect.ensuring(Effect.sync(swap.cleanup)));
  });

  it.effect("finishes an interrupted swap before the database is opened", () => {
    const swap = makeSwap();
    return Effect.gen(function* () {
      // Real databases this time: the staged one is what the server must open.
      NodeFS.rmSync(swap.dbPath);
      NodeFS.rmSync(`${swap.dbPath}-wal`);
      NodeFS.rmSync(swap.journal.staged);
      for (const [path, note] of [
        [swap.dbPath, "old"],
        [swap.journal.staged, "restored"],
      ] as const) {
        const database = new DatabaseSync(path);
        database.exec(`CREATE TABLE marker (note TEXT); INSERT INTO marker VALUES ('${note}')`);
        database.close();
      }
      // Interrupted right after the key moved.
      NodeFS.mkdirSync(swap.journal.aside, { recursive: true });
      NodeFS.renameSync(swap.journal.moves[0]!.from, swap.journal.moves[0]!.to);

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
      const replaced = new DatabaseSync(NodePath.join(swap.journal.aside, "state.sqlite"), {
        readOnly: true,
      });
      assert.deepEqual(replaced.prepare("SELECT note FROM marker").all(), [{ note: "old" }]);
      replaced.close();
    }).pipe(Effect.ensuring(Effect.sync(swap.cleanup)));
  });
});
