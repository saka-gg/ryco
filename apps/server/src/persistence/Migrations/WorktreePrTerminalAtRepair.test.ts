import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { repairProjectionWorktreePrTerminalAtColumn, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("repairProjectionWorktreePrTerminalAtColumn", (it) => {
  it.effect("adds the column once and backfills terminal rows from updated_at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 29 });
      yield* sql`
        CREATE TABLE projection_worktrees (
          worktree_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          origin TEXT NOT NULL,
          pr_number INTEGER,
          issue_number INTEGER,
          pr_title TEXT,
          issue_title TEXT,
          pr_state TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          manual_position INTEGER NOT NULL DEFAULT 0
        )
      `;
      const insert = (worktreeId: string, prState: string | null, updatedAt: string) => sql`
        INSERT INTO projection_worktrees (
          worktree_id, project_id, branch, origin, pr_state, created_at, updated_at
        )
        VALUES (
          ${worktreeId}, 'project-1', ${`feature/${worktreeId}`}, 'pr', ${prState},
          '2026-01-01T00:00:00.000Z', ${updatedAt}
        )
      `;
      yield* insert("merged", "merged", "2026-01-02T00:00:00.000Z");
      yield* insert("closed", "closed", "2026-01-03T00:00:00.000Z");
      yield* insert("open", "open", "2026-01-04T00:00:00.000Z");
      yield* insert("unknown", null, "2026-01-05T00:00:00.000Z");

      yield* repairProjectionWorktreePrTerminalAtColumn();

      const readTerminalAt = () =>
        sql<{ readonly worktreeId: string; readonly prTerminalAt: string | null }>`
          SELECT worktree_id AS "worktreeId", pr_terminal_at AS "prTerminalAt"
          FROM projection_worktrees
          ORDER BY worktree_id ASC
        `;
      assert.deepStrictEqual(
        (yield* readTerminalAt()).map((row) => [row.worktreeId, row.prTerminalAt]),
        [
          ["closed", "2026-01-03T00:00:00.000Z"],
          ["merged", "2026-01-02T00:00:00.000Z"],
          ["open", null],
          ["unknown", null],
        ],
      );

      // The backfill runs only in the transaction that adds the column.
      yield* sql`
        UPDATE projection_worktrees SET pr_terminal_at = 'X' WHERE worktree_id = 'merged'
      `;
      yield* repairProjectionWorktreePrTerminalAtColumn();
      const afterSecondRun = yield* readTerminalAt();
      assert.equal(afterSecondRun.find((row) => row.worktreeId === "merged")?.prTerminalAt, "X");
    }),
  );

  it.effect("skips databases without the projection_worktrees table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS projection_worktrees`;
      yield* repairProjectionWorktreePrTerminalAtColumn();
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_worktrees'
      `;
      assert.equal(tables.length, 0);
    }),
  );
});

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("repairProjectionWorktreePrTerminalAtColumn on a fresh database", (it) => {
  it.effect("runMigrations through 39 provides the column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_worktrees)
      `;
      assert.include(
        columns.map((column) => column.name),
        "pr_terminal_at",
      );
    }),
  );
});
