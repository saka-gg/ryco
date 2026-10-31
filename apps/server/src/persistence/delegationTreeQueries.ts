import type { ThreadId } from "@ryco/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  DELEGATION_TREE_WALK_LIMIT,
  delegationPosition,
  isDelegatedLineage,
  type DelegationNode,
  type DelegationPosition,
} from "../orchestration/delegationLimits.ts";
import { DELEGATED_THREAD_RELATIONSHIP } from "../orchestration/threadLineage.ts";

interface LineageRow {
  readonly thread_id: string;
  readonly lineage_parent_thread_id: string | null;
  readonly lineage_root_thread_id: string | null;
  readonly lineage_relationship: string | null;
}

const toNode = (row: LineageRow): DelegationNode => ({
  id: row.thread_id as ThreadId,
  lineage:
    row.lineage_parent_thread_id === null ||
    row.lineage_root_thread_id === null ||
    row.lineage_relationship === null
      ? null
      : {
          parentThreadId: row.lineage_parent_thread_id as ThreadId,
          rootThreadId: row.lineage_root_thread_id as ThreadId,
          relationship: row.lineage_relationship,
        },
});

/**
 * A thread's place in its delegation tree (`delegationPosition`) and how many tasks the tree has,
 * read from the thread projection. Null when the thread is not projected.
 */
export const readDelegationTree = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<(DelegationPosition & { readonly treeTasks: number }) | null, SqlError> =>
  Effect.gen(function* () {
    const readNode = (id: string) =>
      sql<LineageRow>`
        SELECT thread_id, lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship
        FROM projection_threads WHERE thread_id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : toNode(rows[0]))),
      );
    const start = yield* readNode(threadId);
    if (start === undefined) return null;
    // The chain of delegated parents, read once so the walk itself stays pure.
    const nodes = new Map<ThreadId, DelegationNode>([[start.id, start]]);
    let cursor: DelegationNode | undefined = start;
    for (let hops = 0; hops < DELEGATION_TREE_WALK_LIMIT && cursor !== undefined; hops += 1) {
      if (!isDelegatedLineage(cursor.lineage)) break;
      const parentId: ThreadId = cursor.lineage!.parentThreadId;
      if (nodes.has(parentId)) break;
      cursor = yield* readNode(parentId);
      if (cursor !== undefined) nodes.set(cursor.id, cursor);
    }
    const position = delegationPosition(start, (id) => nodes.get(id));
    const counted = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_threads
      WHERE lineage_relationship = ${DELEGATED_THREAD_RELATIONSHIP}
        AND lineage_root_thread_id = ${position.rootThreadId}
        AND deleted_at IS NULL`;
    return { ...position, treeTasks: Number(counted[0]?.count ?? 0) };
  });
