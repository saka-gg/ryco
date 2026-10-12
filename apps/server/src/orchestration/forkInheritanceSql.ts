/**
 * SQL twins of the inherited-history classifiers in forkInheritance.ts, for readers that must
 * leave a fork's inherited copies out (recency, usage statistics, daily recap). Inherited items
 * are display copies of the source's history: they are never activity of the fork.
 *
 * Every fragment is a residual filter on columns of rows the query already reached, so it never
 * changes which index drives a query. Keep it that way: a predicate that makes SQLite pick a
 * different index regresses every thread, forked or not.
 */
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { INHERITED_ITEM_ID_SEGMENT } from "./forkInheritance.ts";

/**
 * True when `itemId` is history the row's thread inherited (`isInheritedItemId`). Both arguments
 * are code-owned column references or expressions, never user input.
 */
export function inheritedItemIdSql(
  sql: SqlClient.SqlClient,
  itemId: Statement.Fragment,
  threadId: Statement.Fragment,
): Statement.Fragment {
  return sql`(${itemId} IS NOT NULL AND substr(${itemId}, 1, length(${threadId}) + ${INHERITED_ITEM_ID_SEGMENT.length}) = ${threadId} || ${INHERITED_ITEM_ID_SEGMENT})`;
}

/** True when a `projection_turns` row (by its alias) is inherited (`isInheritedTurnRow`). */
export function inheritedTurnRowSql(sql: SqlClient.SqlClient, alias: string): Statement.Fragment {
  return inheritedItemIdSql(
    sql,
    sql.literal(`${alias}.assistant_message_id`),
    sql.literal(`${alias}.thread_id`),
  );
}

/** True when a `projection_thread_activities` row (by its alias) is an inherited copy. */
export function inheritedActivityRowSql(
  sql: SqlClient.SqlClient,
  alias: string,
): Statement.Fragment {
  return inheritedItemIdSql(
    sql,
    sql.literal(`${alias}.activity_id`),
    sql.literal(`${alias}.thread_id`),
  );
}
