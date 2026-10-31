import { ThreadId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { readDelegationTree } from "./delegationTreeQueries.ts";

const AT = "2026-10-31T00:00:00.000Z";

const insertThread = (
  threadId: string,
  lineage?: { readonly parent: string; readonly root: string; readonly relationship: string },
  deletedAt: string | null = null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, created_at, updated_at, deleted_at,
        lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship)
      VALUES (${threadId}, 'project', ${threadId}, '{}', 'full-access', 'default', ${AT}, ${AT},
        ${deletedAt}, ${lineage?.parent ?? null}, ${lineage?.root ?? null},
        ${lineage?.relationship ?? null})`;
  });

it.layer(SqlitePersistenceMemory)("readDelegationTree", (it) => {
  it.effect("reads a thread's depth, root and the tree's live task count", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread("root");
      yield* insertThread("a", { parent: "root", root: "root", relationship: "delegated" });
      yield* insertThread("b", { parent: "a", root: "root", relationship: "delegated" });
      yield* insertThread("gone", { parent: "root", root: "root", relationship: "delegated" }, AT);
      yield* insertThread("fork", { parent: "b", root: "root", relationship: "forked" });

      assert.deepStrictEqual(yield* readDelegationTree(sql, ThreadId.make("b")), {
        depth: 2,
        rootThreadId: ThreadId.make("root"),
        treeTasks: 2,
      });
      assert.deepStrictEqual(yield* readDelegationTree(sql, ThreadId.make("root")), {
        depth: 0,
        rootThreadId: ThreadId.make("root"),
        treeTasks: 2,
      });
      // A fork starts its own tree.
      assert.deepStrictEqual(yield* readDelegationTree(sql, ThreadId.make("fork")), {
        depth: 0,
        rootThreadId: ThreadId.make("fork"),
        treeTasks: 0,
      });
      assert.isNull(yield* readDelegationTree(sql, ThreadId.make("missing")));
    }),
  );
});
