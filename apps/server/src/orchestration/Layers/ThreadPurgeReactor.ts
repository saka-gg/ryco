/**
 * ThreadPurgeReactor - deletes trashed conversations permanently after the undo grace period.
 *
 * "Delete" moves a conversation to the server's Trash state (hidden everywhere) and the client
 * offers Undo (`thread.untrash`). Each `thread.trashed` schedules a `thread.delete` at
 * `trashedAt + THREAD_DELETE_GRACE_MS`; a startup sweep and a periodic sweep schedule whatever is
 * due (also after a restart) and retry failed purges. Undo always wins: the purge is admitted only
 * while the engine's command read model still holds the thread in Trash with the same
 * `trashedAt`, checked inside the engine's serialized commit, so a restore committed first makes
 * the purge a no-op instead of a rejected command.
 *
 * Ordering with the Trash retirement: every purge first awaits `retireThreadTrash`, which moves
 * conversations that were in Trash before this change to Archive and records `trash_retired_at`.
 * Only threads trashed strictly after that marker are purged; without a marker nothing is.
 *
 * Tombstoned workspace records (`checkoutRemovalReason: "deleted"`) only stay as provenance for
 * the conversations kept from them. Once the last live or trashed conversation referencing one is
 * deleted, the record is dropped (`worktree.delete`), and the sweeps drop any left over.
 *
 * @module ThreadPurgeReactor
 */
import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
  type WorktreeId,
} from "@ryco/contracts";
import { makeDrainableWorker } from "@ryco/shared/DrainableWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { THREAD_DELETE_GRACE_MS } from "@ryco/shared/workspaceLifecycle";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import {
  findThreadById,
  findThreadWorktree,
  findWorktreeById,
  isThreadLive,
  isThreadTrashed,
  listThreadsByWorktree,
} from "../commandInvariants.ts";
import { currentCommandReadModel } from "../currentCommandReadModel.ts";
import { OrchestrationCommandAdmissionError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadPurgeReactor,
  type ThreadPurgeReactorShape,
} from "../Services/ThreadPurgeReactor.ts";
import { retireThreadTrash } from "./ThreadTrashRetirement.ts";

export interface ThreadPurgeReactorOptions {
  /** Undo window before a trashed conversation is deleted (default `THREAD_DELETE_GRACE_MS`). */
  readonly graceMs?: number;
  /** How often due purges and leftover workspace records are swept again (default 1 minute). */
  readonly sweepInterval?: Duration.Input;
}

type Worktree = NonNullable<OrchestrationReadModel["worktrees"]>[number];

export const threadPurgeCommandId = (threadId: ThreadId, trashedAt: string) =>
  CommandId.make(`thread-purge:${threadId}:${trashedAt}`);

export const worktreeCollectCommandId = (worktreeId: WorktreeId) =>
  CommandId.make(`worktree-collect:${worktreeId}`);

/** Threads trashed before the Trash retirement (or while it is unrecorded) are never purged. */
export const isTrashedAfterRetirement = (trashedAt: string, retiredAt: string | null): boolean =>
  retiredAt !== null && Date.parse(trashedAt) > Date.parse(retiredAt);

const isStillTrashed = (model: OrchestrationReadModel, threadId: ThreadId, trashedAt: string) =>
  findThreadById(model, threadId)?.trashedAt === trashedAt;

/** A deleted workspace's record once no live or trashed conversation references it. */
export const isCollectableWorktree = (model: OrchestrationReadModel, worktree: Worktree): boolean =>
  worktree.checkoutRemovalReason === "deleted" &&
  worktree.origin !== "main" &&
  listThreadsByWorktree(model, worktree).every(
    (thread) => !isThreadLive(thread) && !isThreadTrashed(thread),
  );

const isAdmissionError = Schema.is(OrchestrationCommandAdmissionError);

const logFailure =
  (message: string, annotations: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const error = Cause.squash(cause);
        // Refused at admission: the state changed (Undo, a new reference) before the commit.
        if (isAdmissionError(error)) {
          return Effect.logDebug(`${message}: ${error.detail}`, annotations);
        }
        return Effect.logWarning(message, { ...annotations, cause: Cause.pretty(cause) });
      }),
    );

export const makeThreadPurgeReactor = (options: ThreadPurgeReactorOptions = {}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    const graceMs = options.graceMs ?? THREAD_DELETE_GRACE_MS;
    const sweepInterval = options.sweepInterval ?? "1 minute";

    const readModel = currentCommandReadModel(engine, projectionSnapshotQuery);
    const retirement = yield* Deferred.make<string | null>();
    const startupSweep = yield* Deferred.make<string | null>();
    // One purge or collection at a time: the engine serializes commands anyway, and a burst of
    // due purges after a restart should not crowd out user commands in its queue.
    const dispatchLock = yield* Semaphore.make(1);

    /** Dispatch only if `refusal` still finds nothing wrong inside the engine's commit. */
    const dispatchGuarded = (
      command: OrchestrationCommand,
      refusal: (model: OrchestrationReadModel) => string | null,
    ) =>
      engine.dispatch(command, {
        admit: <A, E>(
          commit: Effect.Effect<A, E>,
        ): Effect.Effect<A, E | OrchestrationCommandAdmissionError> =>
          Effect.gen(function* () {
            const model = yield* readModel.pipe(
              Effect.mapError(
                () => new OrchestrationCommandAdmissionError({ detail: "Read model unavailable." }),
              ),
            );
            const detail = refusal(model);
            if (detail !== null) {
              return yield* new OrchestrationCommandAdmissionError({ detail });
            }
            return yield* commit;
          }),
      });

    const purgeWhenDue = (threadId: ThreadId, trashedAt: string) =>
      Effect.gen(function* () {
        const retiredAt = yield* Deferred.await(retirement);
        if (!isTrashedAfterRetirement(trashedAt, retiredAt)) return;
        const dueAtMs = Date.parse(trashedAt) + graceMs;
        const nowMs = yield* Clock.currentTimeMillis;
        if (dueAtMs > nowMs) yield* Effect.sleep(Duration.millis(dueAtMs - nowMs));
        yield* dispatchLock.withPermits(1)(
          Effect.gen(function* () {
            if (!isStillTrashed(yield* readModel, threadId, trashedAt)) return;
            yield* dispatchGuarded(
              {
                type: "thread.delete",
                commandId: threadPurgeCommandId(threadId, trashedAt),
                threadId,
              },
              (model) =>
                isStillTrashed(model, threadId, trashedAt)
                  ? null
                  : "The conversation was restored or deleted meanwhile.",
            );
          }),
        );
      }).pipe(logFailure("thread purge failed; retrying on the next sweep", { threadId }));

    const collectWorktree = (worktreeId: WorktreeId) =>
      dispatchLock
        .withPermits(1)(
          Effect.gen(function* () {
            const model = yield* readModel;
            const worktree = findWorktreeById(model, worktreeId);
            if (worktree === undefined || !isCollectableWorktree(model, worktree)) return;
            const deletedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
            yield* dispatchGuarded(
              {
                type: "worktree.delete",
                commandId: worktreeCollectCommandId(worktreeId),
                worktreeId,
                deletedAt,
                deletedBranch: false,
              },
              (model) => {
                const current = findWorktreeById(model, worktreeId);
                return current !== undefined && isCollectableWorktree(model, current)
                  ? null
                  : "The workspace record is referenced again or gone.";
              },
            );
          }),
        )
        .pipe(logFailure("deleted workspace record cleanup failed", { worktreeId }));

    const collectThreadWorktree = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const model = yield* readModel;
        const thread = findThreadById(model, threadId);
        const worktree = thread === undefined ? undefined : findThreadWorktree(model, thread);
        if (worktree !== undefined) yield* collectWorktree(worktree.worktreeId);
      }).pipe(logFailure("deleted workspace record cleanup failed", { threadId }));

    const start: ThreadPurgeReactorShape["start"] = Effect.fn("ThreadPurgeReactor.start")(
      function* () {
        // Acquire synchronously so a trash committed right after start is not missed.
        const subscription = yield* engine.subscribeDomainEvents;
        const scheduled = yield* FiberMap.make<string>();

        const schedulePurge = (threadId: ThreadId, trashedAt: string, onlyIfMissing: boolean) =>
          FiberMap.run(scheduled, `purge:${threadId}`, purgeWhenDue(threadId, trashedAt), {
            onlyIfMissing,
          }).pipe(Effect.asVoid);

        const sweep = Effect.gen(function* () {
          const retiredAt = yield* Deferred.await(retirement);
          const model = yield* readModel;
          for (const thread of model.threads) {
            if (
              thread.trashedAt == null ||
              !isTrashedAfterRetirement(thread.trashedAt, retiredAt)
            ) {
              continue;
            }
            yield* schedulePurge(thread.id, thread.trashedAt, true);
          }
          for (const worktree of model.worktrees ?? []) {
            if (!isCollectableWorktree(model, worktree)) continue;
            yield* FiberMap.run(
              scheduled,
              `collect:${worktree.worktreeId}`,
              collectWorktree(worktree.worktreeId),
              { onlyIfMissing: true },
            );
          }
        }).pipe(logFailure("thread purge sweep failed", {}));

        // Handing off only forks (never waits on a dispatch), so the engine's publisher is never
        // held up by this subscriber.
        const worker = yield* makeDrainableWorker({
          policy: losslessBackpressureQueuePolicy({
            component: "ThreadPurgeReactor",
            capacity: 128,
          }),
          process: (event: OrchestrationEvent) => {
            if (event.type === "thread.trashed") {
              return schedulePurge(event.payload.threadId, event.payload.trashedAt, false);
            }
            if (event.type === "thread.deleted") {
              return FiberMap.run(
                scheduled,
                `collect-thread:${event.payload.threadId}`,
                collectThreadWorktree(event.payload.threadId),
              ).pipe(Effect.asVoid);
            }
            return Effect.void;
          },
        });
        yield* Effect.forkScoped(
          Stream.runForEach(Stream.fromSubscription(subscription), (event) =>
            event.type === "thread.trashed" || event.type === "thread.deleted"
              ? worker.enqueue(event)
              : Effect.void,
          ),
        );

        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const retiredAt = yield* retireThreadTrash({
              dispatch: engine.dispatch,
              readModel,
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            yield* Deferred.succeed(retirement, retiredAt);
            yield* sweep;
            yield* Deferred.succeed(startupSweep, retiredAt);
            yield* Effect.sleep(sweepInterval);
            yield* Effect.repeat(sweep, Schedule.spaced(sweepInterval));
          }),
        );
      },
    );

    return {
      start,
      awaitStartupSweep: Deferred.await(startupSweep),
    } satisfies ThreadPurgeReactorShape;
  });

export const makeThreadPurgeReactorLive = (options?: ThreadPurgeReactorOptions) =>
  Layer.effect(ThreadPurgeReactor, makeThreadPurgeReactor(options));

export const ThreadPurgeReactorLive = makeThreadPurgeReactorLive();
