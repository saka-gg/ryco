/**
 * The recoverable Git action runner itself; see `GitActionRunner.ts`. Loaded on the first
 * recoverable action, not at boot.
 *
 * @module gitActionRunnerCore
 */
import path from "node:path";

import {
  type GitActionProgressEvent,
  type GitActionProgressPhase,
  GitActionResultUnavailableError,
  GitActionStoppedError,
  GitManagerError,
  type GitManagerServiceError,
  type GitRunStackedActionInput,
  type GitStackedAction,
  PROJECT_RELOCATION_PENDING_MESSAGE,
  StorageError,
} from "@ryco/contracts";
import { Cause, Clock, Effect, Exit, Fiber, Option, Queue, Schema, Stream } from "effect";
import type { Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { canonicalJson, sha256Hex } from "../canonicalJson.ts";
import { acquireStoragePathUseLease } from "../storage/lifecycle.ts";
import {
  GIT_ACTION_OBSERVER_BUFFER,
  GIT_ACTION_RECEIPT_TTL_MS,
  GIT_ACTION_RECEIPTS_TO_KEEP,
  type GitActionRunnerShape,
  type GitActionStopReason,
  type GitResumeStackedActionStreamError,
  type GitStackedActionStreamError,
} from "./GitActionRunner.ts";

type Observer = Queue.Enqueue<GitActionProgressEvent, GitStackedActionStreamError | Cause.Done>;

interface ActionRecord {
  readonly kind: "action";
  readonly owner: string;
  readonly actionId: string;
  readonly cwd: string;
  /** `cwd` resolved, so two spellings of one checkout count as one for the busy guard. */
  readonly checkout: string;
  readonly action: GitStackedAction;
  readonly fingerprint: string;
  readonly observers: Set<Observer>;
  /** What a late observer needs to show the current step (at most three events). */
  structural: ReadonlyArray<GitActionProgressEvent>;
  latest: GitActionProgressEvent | null;
  phase: GitActionProgressPhase | null;
  /** `action_finished` or `action_failed` went out: the result is reported, Stop is too late. */
  reported: boolean;
  finished: boolean;
  fiber: Fiber.Fiber<void, GitManagerServiceError> | null;
  stopReason: GitActionStopReason | null;
  outcome: Exit.Exit<void, GitStackedActionStreamError> | null;
}

/** A resume that found nothing: a start that arrives later must not run. */
interface Tombstone {
  readonly kind: "tombstone";
}

interface Settled {
  readonly key: string;
  readonly atMs: number;
}

const RANDOM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Revoked owners remembered so a start that was already on its way never runs. */
const REVOKED_OWNERS_TO_KEEP = 1_024;

const ACTION_LABELS: Record<GitStackedAction, string> = {
  commit: "commit",
  push: "push",
  create_pr: "pull request",
  commit_push: "commit and push",
  commit_push_pr: "commit, push and pull request",
};

const recordKey = (owner: string, actionId: string) => JSON.stringify([owner, actionId]);

/** The input's identity; `recoverable` says how it runs, not what. */
const fingerprintOf = (command: GitRunStackedActionInput) =>
  sha256Hex(canonicalJson({ ...command, recoverable: undefined }));

const gitActionError = (detail: string, cause?: unknown) =>
  new GitManagerError({
    operation: "git.runStackedAction",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const finishObserver = (
  observer: Observer,
  outcome: Exit.Exit<void, GitStackedActionStreamError>,
) => {
  if (Exit.isFailure(outcome)) Queue.failCauseUnsafe(observer, outcome.cause);
  else Queue.endUnsafe(observer);
};

/**
 * Built in a scope: closing it (server shutdown) interrupts running actions and kills their
 * Git children. With a `SqlClient`, a running action holds its checkout's use lease.
 */
export const makeGitActionRunner: Effect.Effect<GitActionRunnerShape, never, Scope.Scope> =
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const storage = yield* Effect.serviceOption(SqlClient.SqlClient);
    const entries = new Map<string, ActionRecord | Tombstone>();
    // Settle order of records, and separately of tombstones, so resume misses never push out
    // another action's receipt: the oldest of each go first.
    const settled: Settled[] = [];
    const tombstones: Settled[] = [];
    // Revocation is final: the owner's starts that were already on their way are refused.
    const revokedOwners = new Set<string>();

    const evictFrom = (order: Settled[], nowMs: number) => {
      while (
        order.length > 0 &&
        (order.length > GIT_ACTION_RECEIPTS_TO_KEEP ||
          nowMs - order[0]!.atMs > GIT_ACTION_RECEIPT_TTL_MS)
      ) {
        entries.delete(order.shift()!.key);
      }
    };
    const evict = (nowMs: number) => {
      evictFrom(settled, nowMs);
      evictFrom(tombstones, nowMs);
    };

    const publishTo = (record: ActionRecord, event: GitActionProgressEvent) => {
      switch (event.kind) {
        case "action_started":
          record.structural = [event];
          break;
        case "phase_started":
          record.phase = event.phase;
          record.structural = [
            ...record.structural.filter((item) => item.kind === "action_started"),
            event,
          ];
          break;
        case "hook_started":
        case "hook_finished":
          record.structural = [
            ...record.structural.filter(
              (item) => item.kind === "action_started" || item.kind === "phase_started",
            ),
            event,
          ];
          break;
        case "action_finished":
          record.finished = true;
          record.reported = true;
          record.structural = [];
          break;
        case "action_failed":
          record.reported = true;
          record.structural = [];
          break;
        case "hook_output":
          break;
      }
      record.latest = event;
      for (const observer of record.observers) Queue.offerUnsafe(observer, event);
    };

    const settle = (record: ActionRecord, key: string, exit: Exit.Exit<void, unknown>) =>
      Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
        Effect.sync(() => {
          let outcome: Exit.Exit<void, GitStackedActionStreamError>;
          const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
          if (interrupted && record.finished) {
            // Interrupted after it reported its result (a Stop that raced the end): the
            // result stands.
            outcome = Exit.void;
          } else if (interrupted && record.reported) {
            // It reported its own failure, and a Stop that raced the end replaced the error
            // with the interruption: the failure it reported stands.
            outcome = Exit.fail(
              gitActionError(
                record.latest?.kind === "action_failed"
                  ? record.latest.message
                  : "The Git action failed.",
              ),
            );
          } else if (interrupted && record.stopReason !== null) {
            const stopped = new GitActionStoppedError({
              actionId: record.actionId,
              phase: record.phase,
              reason: record.stopReason,
            });
            publishTo(record, {
              actionId: record.actionId,
              cwd: record.cwd,
              action: record.action,
              kind: "action_failed",
              phase: record.phase,
              message: "Stopped.",
            });
            outcome = Exit.fail(stopped);
          } else {
            outcome = exit as Exit.Exit<void, GitStackedActionStreamError>;
          }
          record.outcome = outcome;
          record.fiber = null;
          for (const observer of record.observers) finishObserver(observer, outcome);
          record.observers.clear();
          settled.push({ key, atMs: nowMs });
          evict(nowMs);
        }),
      );

    const attach = (record: ActionRecord, observer: Observer) =>
      Effect.gen(function* () {
        for (const event of record.structural) Queue.offerUnsafe(observer, event);
        if (record.latest !== null && !record.structural.includes(record.latest)) {
          Queue.offerUnsafe(observer, record.latest);
        }
        if (record.outcome !== null) {
          finishObserver(observer, record.outcome);
          return;
        }
        record.observers.add(observer);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            record.observers.delete(observer);
          }),
        );
      });

    /**
     * Holds the checkout for the run's lifetime, as a client's connection did while it owned
     * the action: storage cleanup must not remove a checkout a push still runs in.
     */
    const holdCheckout = <A, E>(cwd: string, effect: Effect.Effect<A, E>) =>
      Option.isNone(storage)
        ? effect
        : Effect.acquireUseRelease(
            acquireStoragePathUseLease(storage.value, cwd).pipe(
              Effect.mapError((cause) =>
                gitActionError(
                  // A refusal names why; anything else (the database, the path) says what failed.
                  !Schema.is(StorageError)(cause)
                    ? `Couldn't check the checkout before running the Git action: ${cause.message}`
                    : cause.detail === PROJECT_RELOCATION_PENDING_MESSAGE
                      ? PROJECT_RELOCATION_PENDING_MESSAGE
                      : "This checkout is being cleaned up or was removed. Restore it before running Git actions.",
                  cause,
                ),
              ),
            ),
            () => effect,
            (release) => release,
          );

    const runningInCheckout = (checkout: string): ActionRecord | null => {
      for (const entry of entries.values()) {
        if (entry.kind === "action" && entry.outcome === null && entry.checkout === checkout) {
          return entry;
        }
      }
      return null;
    };

    const start: GitActionRunnerShape["start"] = ({ owner, command, run }) =>
      Stream.callback<GitActionProgressEvent, GitStackedActionStreamError>(
        (queue) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            evict(nowMs);
            if (!RANDOM_UUID.test(command.actionId)) {
              return yield* gitActionError("A recoverable Git action needs a random action id.");
            }
            const key = recordKey(owner, command.actionId);
            const fingerprint = fingerprintOf(command);
            const existing = entries.get(key);
            if (existing?.kind === "tombstone") {
              return yield* gitActionError(
                "This Git action was already reported as unavailable. Check the repository status before trying again.",
              );
            }
            if (existing !== undefined) {
              if (existing.fingerprint !== fingerprint) {
                return yield* gitActionError(
                  "This action id was already used for a different Git action.",
                );
              }
              return yield* attach(existing, queue);
            }
            if (revokedOwners.has(owner)) {
              return yield* gitActionError(
                "Access to this machine was revoked. Pair again to run Git actions.",
              );
            }
            const checkout = path.resolve(command.cwd);
            const running = runningInCheckout(checkout);
            if (running !== null) {
              return yield* gitActionError(
                `A ${ACTION_LABELS[running.action]} is already running in this checkout. Wait for it to finish or stop it first.`,
              );
            }
            const record: ActionRecord = {
              kind: "action",
              owner,
              actionId: command.actionId,
              cwd: command.cwd,
              checkout,
              action: command.action,
              fingerprint,
              observers: new Set(),
              structural: [],
              latest: null,
              phase: null,
              reported: false,
              finished: false,
              fiber: null,
              stopReason: null,
              outcome: null,
            };
            entries.set(key, record);
            yield* attach(record, queue);
            // Forked from the request fiber, so the work keeps its refs (the RPC span as parent,
            // the interactive process lane) while its lifetime is the runner's.
            record.fiber = yield* holdCheckout(
              command.cwd,
              Effect.suspend(() =>
                run((event) =>
                  Effect.sync(() => {
                    publishTo(record, event);
                  }),
                ),
              ),
            ).pipe(
              Effect.onExit((exit) => settle(record, key, exit)),
              Effect.forkIn(scope, { uninterruptible: false }),
            );
            // A stop that came in before the fork had a fiber to interrupt.
            if (record.stopReason !== null) {
              yield* Fiber.interrupt(record.fiber).pipe(Effect.forkIn(scope));
            }
          }).pipe(Effect.uninterruptible),
        { bufferSize: GIT_ACTION_OBSERVER_BUFFER, strategy: "sliding" },
      );

    const resume: GitActionRunnerShape["resume"] = ({ owner, command }) =>
      Stream.callback<GitActionProgressEvent, GitResumeStackedActionStreamError>(
        (queue) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            evict(nowMs);
            const key = recordKey(owner, command.actionId);
            const existing = entries.get(key);
            if (existing === undefined || existing.kind === "tombstone") {
              if (existing === undefined) {
                entries.set(key, { kind: "tombstone" });
                tombstones.push({ key, atMs: nowMs });
                evict(nowMs);
              }
              return yield* new GitActionResultUnavailableError({
                actionId: command.actionId,
                reason: "missing",
              });
            }
            if (existing.fingerprint !== fingerprintOf(command)) {
              return yield* gitActionError(
                "This action id was already used for a different Git action.",
              );
            }
            yield* attach(existing, queue);
          }).pipe(Effect.uninterruptible),
        { bufferSize: GIT_ACTION_OBSERVER_BUFFER, strategy: "sliding" },
      );

    /**
     * Interrupts in the runner's scope, so the asking request answers at once. Before the run
     * is forked, its start interrupts it as soon as it is.
     */
    const stop = (record: ActionRecord, reason: GitActionStopReason) => {
      if (record.outcome !== null || record.reported) return Effect.succeed(false);
      record.stopReason ??= reason;
      const fiber = record.fiber;
      return fiber === null
        ? Effect.succeed(true)
        : Fiber.interrupt(fiber).pipe(Effect.forkIn(scope), Effect.as(true));
    };

    const cancel: GitActionRunnerShape["cancel"] = ({ owner, actionId }) =>
      Effect.suspend(() => {
        const entry = entries.get(recordKey(owner, actionId));
        return entry?.kind === "action" ? stop(entry, "requested") : Effect.succeed(false);
      });

    const stopOwner: GitActionRunnerShape["stopOwner"] = (owner, reason) =>
      Effect.suspend(() => {
        revokedOwners.delete(owner);
        revokedOwners.add(owner);
        if (revokedOwners.size > REVOKED_OWNERS_TO_KEEP) {
          revokedOwners.delete(revokedOwners.values().next().value!);
        }
        const owned: ActionRecord[] = [];
        for (const entry of entries.values()) {
          if (entry.kind === "action" && entry.owner === owner) owned.push(entry);
        }
        return Effect.forEach(owned, (record) => stop(record, reason)).pipe(
          Effect.map((stopped) => stopped.filter(Boolean).length),
        );
      });

    return { start, resume, cancel, stopOwner } satisfies GitActionRunnerShape;
  });
