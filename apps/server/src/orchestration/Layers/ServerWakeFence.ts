/**
 * The process-wide server wake fence (`ServerWakeFence`), extracted from delegated-result
 * delivery so every wake source shares one set of pending-start sightings and one cold-start
 * budget.
 */
import type { MessageId, OrchestrationThreadShell, ThreadId } from "@ryco/contracts";
import { QUEUED_TURN_START_GRACE_MS, queuedTurnIdleBlocker } from "@ryco/shared/threadSettlement";
import { applicableUsageLimit } from "@ryco/shared/usageLimit";
import { Effect, Layer, Option, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  readLatestUserMessageId,
  readPendingTurnStart,
  readWakeStartState,
} from "../../persistence/serverWakeQueries.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { isCheckpointRevertEntryPending } from "../checkpointRevertPolicy.ts";
import {
  COLD_WAKE_GRACE_MS,
  followUpQueueHoldsWake,
  MAX_COLD_WAKES_IN_FLIGHT,
  queuedTurnIdleInputFromShell,
} from "../serverWake.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerWakeFence, type ServerWakeFenceShape } from "../Services/ServerWakeFence.ts";

/** An accepted cold wake whose start may still be running. */
interface AcceptedColdWake {
  readonly messageId: MessageId;
  readonly sinceMs: number;
}

/**
 * When the budget is full, `coldStart` and `reserveColdSlot` run a release pass of their own,
 * at most this often: stale slots only matter once the budget is full.
 */
const RELEASE_PASS_MIN_INTERVAL_MS = 1_000;

export const makeServerWakeFence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  // Serialises every change of the cold-start budget, so two callers never both take the last
  // slot. Never held across a read: the release pass reads first, then drops only the slots
  // that did not change meanwhile.
  const lock = yield* Semaphore.make(1);
  /** Accepted cold wakes, one per thread (the latest noted). */
  const accepted = new Map<ThreadId, AcceptedColdWake>();
  /** Reservations of wakes not accepted yet, per thread: message id → when it was taken. */
  const reserved = new Map<ThreadId, Map<MessageId, number>>();
  let lastReleasePassMs: number | null = null;
  // Changed only in one synchronous step, so concurrent callers keep the first sighting.
  const pendingStartSeen = new Map<ThreadId, { messageId: string; firstSeenMs: number }>();

  /** Threads holding a slot: an accepted wake or a reservation (one slot per thread). */
  const slotsTaken = () => {
    let taken = accepted.size;
    for (const threadId of reserved.keys()) if (!accepted.has(threadId)) taken += 1;
    return taken;
  };
  const budgetFull = () => slotsTaken() >= MAX_COLD_WAKES_IN_FLIGHT;
  const dropReservation = (threadId: ThreadId, messageId: MessageId) => {
    const held = reserved.get(threadId);
    if (held === undefined) return;
    held.delete(messageId);
    if (held.size === 0) reserved.delete(threadId);
  };

  const safe = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError("ServerWakeFence")));

  const wakeStartState: ServerWakeFenceShape["wakeStartState"] = (threadId, messageId) =>
    safe(readWakeStartState(sql, { threadId, messageId }));

  /** A pending start blocks for at most the grace of this process's time from its first sighting. */
  const pendingStartBlocks = (threadId: ThreadId, nowMs: number) =>
    safe(readPendingTurnStart(sql, threadId)).pipe(
      Effect.map((pending) => {
        if (!pending || pending.startFailed) {
          pendingStartSeen.delete(threadId);
          return false;
        }
        const seen = pendingStartSeen.get(threadId);
        let firstSeenMs = nowMs;
        if (seen?.messageId === pending.messageId) firstSeenMs = seen.firstSeenMs;
        else pendingStartSeen.set(threadId, { messageId: pending.messageId, firstSeenMs });
        return nowMs - firstSeenMs < QUEUED_TURN_START_GRACE_MS;
      }),
    );

  const idle = (shell: OrchestrationThreadShell, nowMs: number) =>
    pendingStartBlocks(shell.id, nowMs).pipe(
      Effect.map(
        (blocks) =>
          !blocks && queuedTurnIdleBlocker(queuedTurnIdleInputFromShell(shell, nowMs)) === null,
      ),
    );

  const holdReason: ServerWakeFenceShape["holdReason"] = (shell, nowMs, source) =>
    applicableUsageLimit(shell) !== null
      ? Effect.succeed("usage-limited" as const)
      : followUpQueueHoldsWake(shell, source)
        ? Effect.succeed("busy" as const)
        : idle(shell, nowMs).pipe(Effect.map((ready) => (ready ? null : ("busy" as const))));

  const reverting: ServerWakeFenceShape["reverting"] = (threadId, nowMs) =>
    projections.getLatestCheckpointRevert
      ? projections
          .getLatestCheckpointRevert(threadId)
          .pipe(
            Effect.map(
              (latest) => latest !== null && isCheckpointRevertEntryPending(latest, nowMs),
            ),
          )
      : Effect.succeed(false);

  const releaseColdSlots: ServerWakeFenceShape["releaseColdSlots"] = (nowMs) =>
    Effect.gen(function* () {
      lastReleasePassMs = nowMs;
      const ended: Array<readonly [ThreadId, AcceptedColdWake]> = [];
      // Reads run outside the lock, so other callers reserve and note meanwhile.
      for (const [threadId, wake] of accepted) {
        if (nowMs - wake.sinceMs >= COLD_WAKE_GRACE_MS) ended.push([threadId, wake]);
        else {
          const state = yield* wakeStartState(threadId, wake.messageId);
          if (state === "bound" || state === "failed") ended.push([threadId, wake]);
        }
      }
      yield* lock.withPermit(
        Effect.sync(() => {
          // Only the wakes read above: one noted meanwhile is newer and keeps its slot.
          for (const [threadId, wake] of ended)
            if (accepted.get(threadId) === wake) accepted.delete(threadId);
          // Each caller gives its own reservation back; this bounds one that never was.
          // (Deleting the entry being visited is safe while iterating a Map.)
          for (const [threadId, held] of reserved)
            for (const [messageId, sinceMs] of held)
              if (nowMs - sinceMs >= COLD_WAKE_GRACE_MS) dropReservation(threadId, messageId);
        }),
      );
    });

  /** A release pass when the budget is full and none ran in the last second. */
  const releaseWhenFull = (nowMs: number) =>
    Effect.suspend(() =>
      budgetFull() &&
      !(
        lastReleasePassMs !== null &&
        nowMs >= lastReleasePassMs &&
        nowMs - lastReleasePassMs < RELEASE_PASS_MIN_INTERVAL_MS
      )
        ? // A failed read frees nothing; the budget stays as it was.
          releaseColdSlots(nowMs).pipe(Effect.catch(() => Effect.void))
        : Effect.void,
    );

  const coldStart: ServerWakeFenceShape["coldStart"] = (threadId, nowMs) =>
    providers.getSession(threadId).pipe(
      Effect.map(Option.isNone),
      Effect.catch(() => Effect.succeed(true)),
      Effect.tap((cold) => (cold ? releaseWhenFull(nowMs) : Effect.void)),
      Effect.map((cold) => ({ cold, budgetFull: budgetFull() })),
    );

  const reserveColdSlot: ServerWakeFenceShape["reserveColdSlot"] = (threadId, messageId, nowMs) =>
    releaseWhenFull(nowMs).pipe(
      Effect.andThen(
        lock.withPermit(
          Effect.sync(() => {
            if (budgetFull()) return false;
            const held = reserved.get(threadId);
            if (held === undefined) reserved.set(threadId, new Map([[messageId, nowMs]]));
            else held.set(messageId, nowMs);
            return true;
          }),
        ),
      ),
    );

  const noteColdWake: ServerWakeFenceShape["noteColdWake"] = (threadId, messageId, sinceMs) =>
    lock.withPermit(
      Effect.sync(() => {
        accepted.set(threadId, { messageId, sinceMs });
        dropReservation(threadId, messageId);
      }),
    );

  const releaseColdSlot: ServerWakeFenceShape["releaseColdSlot"] = (threadId, messageId) =>
    lock.withPermit(Effect.sync(() => dropReservation(threadId, messageId)));

  const latestUserMessageId: ServerWakeFenceShape["latestUserMessageId"] = (threadId) =>
    safe(readLatestUserMessageId(sql, threadId));

  return {
    holdReason,
    reverting,
    coldStart,
    reserveColdSlot,
    noteColdWake,
    releaseColdSlot,
    releaseColdSlots,
    wakeStartState,
    latestUserMessageId,
  } satisfies ServerWakeFenceShape;
});

export const ServerWakeFenceLive = Layer.effect(ServerWakeFence, makeServerWakeFence);
