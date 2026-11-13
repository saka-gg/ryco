/**
 * Reads of one thread's activities of a few kinds (pending requests, task records).
 *
 * `projection_thread_activities` is the largest projection table, and a long thread with
 * subagents holds tens of thousands of rows. Filtered by `kind IN (...) AND thread_id = ?` and
 * ordered by sequence, SQLite (which runs without ANALYZE statistics here, see `Sqlite.ts`)
 * prefers the thread's `(thread_id, sequence, ...)` index because it also gives the order. It then
 * looks up every activity row of the thread to test its kind: on a real 36,000-activity thread
 * that cost 6 to 21 ms per read, on paths that run at every turn boundary or task-output poll.
 *
 * The kind-leading index (migration 085, also ensured as a post-migrator repair) seeks each
 * kind's rows of the thread directly; the few matches are sorted afterwards. Single-kind reads
 * already get it from the planner; reads of several kinds name it here.
 *
 * @module persistence/threadActivityKindReads
 */
import type * as SqlClient from "effect/sql/SqlClient";

export const THREAD_ACTIVITY_KIND_INDEX = "idx_projection_thread_activities_kind_order";

/** `projection_thread_activities`, read through the kind-leading index. */
export const threadActivitiesByKind = (sql: SqlClient.SqlClient) =>
  sql.literal(`projection_thread_activities INDEXED BY ${THREAD_ACTIVITY_KIND_INDEX}`);

/**
 * Every kind a task record is stored under (provider task lifecycle, see
 * `ProviderRuntimeIngestion`). Task linkage (`runHandles`, `outputFile`) rides only on these.
 */
export const TASK_ACTIVITY_KINDS = [
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
] as const;
