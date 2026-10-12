/**
 * One thread-shell read per (thread, event) for every shell subscriber.
 *
 * Each shell subscription maps a thread event to a `thread-upserted` by
 * re-reading the thread's shell row (three SQL reads plus decode on the
 * synchronous main-thread connection). Every open tab and client did that
 * read for the same event. Reads are keyed by the thread and the sequence of
 * the event that triggered them: a read made after that event committed is a
 * correct answer for every subscriber mapping the same event, and a later
 * event of the thread has a later sequence, so it reads again. Concurrent
 * subscribers share one in-flight read.
 *
 * Entries live for {@link SHARED_THREAD_SHELL_TTL_MS} at most (fields such as
 * background liveness change without events) and the table is bounded.
 * Failures are not shared: the entry is dropped, so the next subscriber reads
 * again.
 *
 * @module sharedThreadShellReads
 */
import type { OrchestrationThreadShell, ThreadId } from "@ryco/contracts";
import { Deferred, Effect, Exit, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const SHARED_THREAD_SHELL_TTL_MS = 2_000;
const MAX_ENTRIES = 512;

type ThreadShellRead = Option.Option<OrchestrationThreadShell>;

interface Entry {
  readonly result: Deferred.Deferred<ThreadShellRead, ProjectionRepositoryError>;
  readonly createdAt: number;
}

const tables = new WeakMap<object, Map<string, Entry>>();

/** Reads counted per query instance (tests and diagnostics). */
const readCounts = new WeakMap<object, number>();
export const sharedThreadShellReadCount = (query: object): number => readCounts.get(query) ?? 0;

export const readSharedThreadShell = (
  query: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">,
  threadId: ThreadId,
  sequence: number,
  now: () => number = Date.now,
): Effect.Effect<ThreadShellRead, ProjectionRepositoryError> =>
  Effect.suspend(() => {
    let table = tables.get(query);
    if (table === undefined) {
      table = new Map();
      tables.set(query, table);
    }
    const key = `${threadId}\u0000${sequence}`;
    const existing = table.get(key);
    if (existing !== undefined && now() - existing.createdAt < SHARED_THREAD_SHELL_TTL_MS) {
      return Deferred.await(existing.result);
    }
    const result = Deferred.makeUnsafe<ThreadShellRead, ProjectionRepositoryError>();
    table.delete(key);
    table.set(key, { result, createdAt: now() });
    // Oldest first: Map iteration follows insertion order.
    while (table.size > MAX_ENTRIES) table.delete(table.keys().next().value!);
    readCounts.set(query, (readCounts.get(query) ?? 0) + 1);
    const owner = table;
    return query.getThreadShellById(threadId).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && owner.get(key)?.result === result) owner.delete(key);
          Deferred.doneUnsafe(result, exit);
        }),
      ),
    );
  });
