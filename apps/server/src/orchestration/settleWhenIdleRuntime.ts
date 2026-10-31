/**
 * The settle-when-idle runtime (T3 Code #18606), loaded behind `import()` by `SettleWhenIdleLive`
 * once commands are ready.
 *
 * A person who settles a thread while it works files it (`thread.settle-deferred`); this settles
 * it once that work ends. A pass looks at a filed thread's shell after each of its events, and at
 * every filed thread every 30 seconds (background work can end without an event, and the filings
 * are read again from the command read model, so a filing from before this process started is
 * found too). When the thread is idle it sends `thread.settle-when-idle`, and the decider
 * decides: it settles a thread whose turn finished, clears the filing of one whose turn failed or
 * was stopped, and refuses one that is busy again (a later pass looks again).
 *
 * It imports no value from a module the server's boot graph loads (only `effect`): everything
 * else comes in through `SettleWhenIdleDeps`.
 *
 * @module settleWhenIdleRuntime
 */
import type {
  CommandId,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThreadShell,
  ThreadId,
} from "@ryco/contracts";
import { Cause, Clock, Effect, Option, Stream } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationDispatchError } from "./Errors.ts";

/** How often every filed thread is looked at, whatever events arrive. */
export const SETTLE_WHEN_IDLE_SWEEP_MS = 30_000;

export interface SettleWhenIdleCommand {
  readonly type: "thread.settle-when-idle";
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}

export interface SettleWhenIdleDeps {
  /** The command read model as the engine holds it now (`currentCommandReadModel`). */
  readonly readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;
  readonly readShell: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;
  /** Whether the thread's work ended: no turn, request, queued follow-up or background work. */
  readonly isIdle: (shell: OrchestrationThreadShell, nowMs: number) => boolean;
  readonly dispatch: (
    command: SettleWhenIdleCommand,
  ) => Effect.Effect<unknown, OrchestrationDispatchError>;
  /** Unique to this process start: prefixes every command id it mints. */
  readonly bootId: string;
}

/** What a settle was sent for: the same filing in the same state is never sent twice. */
const settleKey = (shell: OrchestrationThreadShell) =>
  JSON.stringify([
    shell.settleWhenIdleAt,
    shell.updatedAt,
    shell.session?.status ?? null,
    shell.session?.updatedAt ?? null,
    shell.latestTurn?.turnId ?? null,
    shell.latestTurn?.state ?? null,
  ]);

export const makeSettleWhenIdle = (deps: SettleWhenIdleDeps) => {
  /** Threads a filing is known for; rebuilt from the read model on every sweep. */
  const filed = new Set<ThreadId>();
  const dirty = new Set<ThreadId>();
  const sent = new Map<ThreadId, string>();
  let serial = 0;
  let nextSweepAtMs = 0;

  const forget = (threadId: ThreadId) => {
    filed.delete(threadId);
    dirty.delete(threadId);
    sent.delete(threadId);
  };

  /** Marks the threads a pass must look at; true when the event needs a pass. */
  const observe = (event: OrchestrationEvent): boolean => {
    if (event.aggregateKind !== "thread") return false;
    const threadId = event.aggregateId as ThreadId;
    switch (event.type) {
      case "thread.settle-deferred":
        filed.add(threadId);
        dirty.add(threadId);
        return true;
      // Each of these ends the filing.
      case "thread.settled":
      case "thread.unsettled":
      case "thread.snoozed":
      case "thread.archived":
      case "thread.trashed":
      case "thread.deleted":
        forget(threadId);
        return false;
      default:
        if (!filed.has(threadId)) return false;
        dirty.add(threadId);
        return true;
    }
  };

  const evaluate = (threadId: ThreadId, nowMs: number) =>
    Effect.gen(function* () {
      const shell = yield* deps.readShell(threadId);
      if (
        Option.isNone(shell) ||
        shell.value.settleWhenIdleAt == null ||
        shell.value.archivedAt !== null
      ) {
        forget(threadId);
        return;
      }
      if (!deps.isIdle(shell.value, nowMs)) return;
      const key = settleKey(shell.value);
      if (sent.get(threadId) === key) return;
      sent.set(threadId, key);
      serial += 1;
      yield* deps
        .dispatch({
          type: "thread.settle-when-idle",
          commandId: `server:settle-when-idle:${threadId}:${deps.bootId}:${serial}` as CommandId,
          threadId,
          createdAt: new Date(nowMs).toISOString(),
        })
        .pipe(
          // A refusal means the thread is busy again; its next change brings another pass.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logDebug("settle when idle refused", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
    });

  /** One pass. Returns how long to wait before the next one when no event arrives. */
  const step = (nowMs: number) =>
    Effect.gen(function* () {
      if (nowMs >= nextSweepAtMs) {
        nextSweepAtMs = nowMs + SETTLE_WHEN_IDLE_SWEEP_MS;
        const model = yield* deps.readModel.pipe(Effect.option);
        if (Option.isSome(model)) {
          filed.clear();
          for (const thread of model.value.threads) {
            if (thread.settleWhenIdleAt != null && thread.archivedAt === null) {
              filed.add(thread.id);
            }
          }
          for (const threadId of sent.keys()) if (!filed.has(threadId)) sent.delete(threadId);
        }
        for (const threadId of filed) dirty.add(threadId);
      }
      const threadIds = [...dirty];
      dirty.clear();
      for (const threadId of threadIds) {
        // One thread's failure never starves the others.
        yield* evaluate(threadId, nowMs).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("settle when idle check failed", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      }
      return filed.size === 0 ? null : Math.max(0, nextSweepAtMs - nowMs);
    });

  return { observe, step, filed };
};

export type SettleWhenIdle = ReturnType<typeof makeSettleWhenIdle>;

/** Runs it: events mark threads, a pass handles them, and a sweep runs while any is filed. */
export const runSettleWhenIdle = (
  settleWhenIdle: SettleWhenIdle,
  events: Stream.Stream<OrchestrationEvent>,
) =>
  Effect.gen(function* () {
    let signalled = false;
    let wake: (() => void) | undefined;
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        Effect.sync(() => {
          if (!settleWhenIdle.observe(event)) return;
          signalled = true;
          wake?.();
        }),
      ),
    );
    const untilSignalled = Effect.callback<void>((resume) => {
      wake = () => resume(Effect.void);
      if (signalled) wake();
      return Effect.sync(() => {
        wake = undefined;
      });
    });
    return yield* Effect.forever(
      Effect.gen(function* () {
        signalled = false;
        const nextMs = yield* settleWhenIdle.step(yield* Clock.currentTimeMillis);
        yield* nextMs === null ? untilSignalled : Effect.race(Effect.sleep(nextMs), untilSignalled);
      }),
    );
  }).pipe(Effect.scoped);
