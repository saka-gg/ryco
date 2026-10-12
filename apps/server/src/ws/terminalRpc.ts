import { Cause, Effect, Option, Queue, Stream } from "effect";
import {
  ThreadId,
  TerminalInputRejectedError,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type TerminalSubscribeEventsInput,
  TerminalSubscriptionResyncError,
  WS_METHODS,
} from "@ryco/contracts";

import {
  approximateJsonBytes,
  recordServerPerfPayload,
} from "../observability/PerfInstrumentation.ts";
import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const TERMINAL_SUBSCRIBER_CAPACITY = 256;
/**
 * Byte ceiling on queued-but-undrained live terminal events per subscriber.
 * The event count bound alone lets a stalled client accumulate arbitrarily
 * large output payloads; tripping this budget fails the subscription with the
 * same `slowConsumer` resync signal as count overflow, so the client
 * resynchronizes instead of the server growing memory without bound.
 *
 * Bootstrap snapshots are not charged: they reference histories the manager
 * already retains, and charging them made a few large running terminals trip
 * the budget on every resubscribe, a deterministic resync loop.
 */
const TERMINAL_SUBSCRIBER_MAX_BYTES = 4 * 1024 * 1024;

const terminalSessionKey = (threadId: string, terminalId: string) =>
  JSON.stringify([threadId, terminalId]);

/**
 * Catch-up event for a session that was already running when the subscription
 * opened. `metadata` replays omit retained history (clients re-hydrate through
 * `terminal.open`) and are marked so clients never treat them as fresh starts;
 * full replays keep the legacy shape for clients that did not ask for metadata.
 */
export function terminalBootstrapEvent(
  snapshot: TerminalSessionSnapshot,
  replay: TerminalSubscribeEventsInput["replay"],
  hasRunningSubprocess: boolean | undefined,
): TerminalEvent {
  const base = {
    type: "started" as const,
    threadId: snapshot.threadId,
    terminalId: snapshot.terminalId,
    createdAt: snapshot.updatedAt,
    ...(snapshot.cursor ? { cursor: snapshot.cursor } : {}),
  };
  if (replay !== "metadata") return { ...base, snapshot };
  return {
    ...base,
    snapshot: { ...snapshot, history: "" },
    replay: true,
    ...(hasRunningSubprocess === undefined ? {} : { hasRunningSubprocess }),
  };
}

export interface TerminalSubscriberLedger {
  bytes: number;
  events?: number;
}

export const releaseTerminalSubscriberEvent = (
  ledger: TerminalSubscriberLedger,
  event: TerminalEvent,
): Effect.Effect<void> =>
  Effect.sync(() => {
    ledger.bytes = Math.max(0, ledger.bytes - approximateJsonBytes(event));
    ledger.events = Math.max(0, (ledger.events ?? 0) - 1);
  });

export function makeTerminalSubscriberOffer(
  queue: Queue.Queue<TerminalEvent, TerminalSubscriptionResyncError | Cause.Done<void>>,
  capacity = TERMINAL_SUBSCRIBER_CAPACITY,
  ledger: TerminalSubscriberLedger = { bytes: 0 },
  byteBudget = TERMINAL_SUBSCRIBER_MAX_BYTES,
) {
  let overflowed = false;
  const failWithResync = () =>
    Effect.gen(function* () {
      if (overflowed) return;
      overflowed = true;
      yield* Queue.fail(
        queue,
        new TerminalSubscriptionResyncError({
          reason: "slowConsumer",
          capacity,
        }),
      );
    });
  return (event: TerminalEvent) =>
    Effect.gen(function* () {
      if (overflowed) return;
      recordServerPerfPayload("server.ws.terminal.events", event);
      const eventBytes = approximateJsonBytes(event);
      if (ledger.bytes + eventBytes > byteBudget || (ledger.events ?? 0) >= capacity) {
        yield* failWithResync();
        return;
      }
      if (Queue.offerUnsafe(queue, event)) {
        ledger.bytes += eventBytes;
        ledger.events = (ledger.events ?? 0) + 1;
        return;
      }
      yield* failWithResync();
    });
}

export const makeTerminalHandlers = (ctx: WsRpcContext) => {
  const { ownerEffect, ownerStream, terminalManager } = ctx;
  const assertCurrentWorkspace = (input: {
    threadId: string;
    cwd: string;
    worktreePath?: string | null | undefined;
  }) =>
    Effect.gen(function* () {
      const thread = yield* ctx.projectionSnapshotQuery
        .getThreadShellById(ThreadId.make(input.threadId))
        .pipe(
          Effect.mapError(
            () =>
              new TerminalInputRejectedError({
                message: "Current thread workspace is unavailable.",
              }),
          ),
        );
      if (Option.isNone(thread)) {
        return yield* new TerminalInputRejectedError({
          message: "Current thread workspace is unavailable.",
        });
      }
      const project = yield* ctx.projectionSnapshotQuery
        .getProjectShellById(thread.value.projectId)
        .pipe(
          Effect.mapError(
            () =>
              new TerminalInputRejectedError({
                message: "Current thread workspace is unavailable.",
              }),
          ),
        );
      if (
        Option.isNone(project) ||
        (thread.value.worktreePath ?? project.value.workspaceRoot) !== input.cwd ||
        thread.value.worktreePath !== (input.worktreePath ?? null)
      ) {
        return yield* new TerminalInputRejectedError({
          message: "Thread workspace changed or is unavailable. Insert the snippet again.",
        });
      }
    });

  return defineWsHandlers({
    [WS_METHODS.terminalOpen]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalOpen,
        ownerEffect(
          WS_METHODS.terminalOpen,
          Effect.gen(function* () {
            if (input.requireCurrentWorkspace) yield* assertCurrentWorkspace(input);
            return yield* terminalManager.open(input);
          }),
        ),
        {
          "rpc.aggregate": "terminal",
        },
      ),
    [WS_METHODS.terminalWrite]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalWrite,
        ownerEffect(
          WS_METHODS.terminalWrite,
          Effect.gen(function* () {
            if (!input.guard) return yield* terminalManager.write(input);
            const canCommit = ctx.orchestrationEngine.captureThreadWorkspace?.({
              threadId: input.threadId,
              ...input.guard,
            });
            if (!canCommit)
              return yield* new TerminalInputRejectedError({
                message: "Current thread workspace authority is unavailable. Nothing was sent.",
              });
            return yield* terminalManager.write(input, canCommit);
          }),
        ),
        {
          "rpc.aggregate": "terminal",
        },
      ),
    [WS_METHODS.terminalResize]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalResize,
        ownerEffect(WS_METHODS.terminalResize, terminalManager.resize(input)),
        {
          "rpc.aggregate": "terminal",
        },
      ),
    [WS_METHODS.terminalClear]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalClear,
        ownerEffect(WS_METHODS.terminalClear, terminalManager.clear(input)),
        {
          "rpc.aggregate": "terminal",
        },
      ),
    [WS_METHODS.terminalRestart]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalRestart,
        ownerEffect(WS_METHODS.terminalRestart, terminalManager.restart(input)),
        {
          "rpc.aggregate": "terminal",
        },
      ),
    [WS_METHODS.terminalClose]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalClose,
        ownerEffect(WS_METHODS.terminalClose, terminalManager.close(input)),
        {
          "rpc.aggregate": "terminal",
        },
      ),
    [WS_METHODS.subscribeTerminalEvents]: (input) =>
      observeRpcStream(
        WS_METHODS.subscribeTerminalEvents,
        ownerStream(
          WS_METHODS.subscribeTerminalEvents,
          Stream.unwrap(
            Effect.gen(function* () {
              const ledger: TerminalSubscriberLedger = { bytes: 0 };
              const queue = yield* Queue.dropping<
                TerminalEvent,
                TerminalSubscriptionResyncError | Cause.Done<void>
              >(TERMINAL_SUBSCRIBER_CAPACITY);
              yield* Effect.addFinalizer(() => Queue.shutdown(queue));
              yield* Effect.acquireRelease(
                terminalManager.subscribe(
                  makeTerminalSubscriberOffer(queue, TERMINAL_SUBSCRIBER_CAPACITY, ledger),
                ),
                (unsubscribe) => Effect.sync(unsubscribe),
              );
              // Subscribe first to avoid a gap, but do not expose queued live events
              // until the snapshot has been delivered. The captured cursor removes
              // events already represented by history, even within one millisecond.
              const snapshots = (yield* terminalManager.listSessions).filter(
                (snapshot) => snapshot.status === "running",
              );
              const subprocessActivity =
                input.replay === "metadata"
                  ? new Map(
                      (yield* terminalManager.listDiagnostics).map((process) => [
                        terminalSessionKey(process.threadId, process.terminalId),
                        process.hasRunningSubprocess,
                      ]),
                    )
                  : null;
              const cursors = new Map(
                snapshots.map((snapshot) => [
                  terminalSessionKey(snapshot.threadId, snapshot.terminalId),
                  snapshot.cursor,
                ]),
              );
              const initial = snapshots.map((snapshot) =>
                terminalBootstrapEvent(
                  snapshot,
                  input.replay,
                  subprocessActivity?.get(
                    terminalSessionKey(snapshot.threadId, snapshot.terminalId),
                  ),
                ),
              );
              // Snapshot-first ordering comes from the concat; only live events are
              // queued, so only they are charged against the subscriber budgets.
              return Stream.concat(
                Stream.fromIterable(initial).pipe(
                  Stream.tap((event) =>
                    Effect.sync(() => recordServerPerfPayload("server.ws.terminal.events", event)),
                  ),
                ),
                Stream.fromQueue(queue).pipe(
                  Stream.tap((event) => releaseTerminalSubscriberEvent(ledger, event)),
                  Stream.filter((event) => {
                    const cursor = cursors.get(
                      terminalSessionKey(event.threadId, event.terminalId),
                    );
                    return (
                      !cursor ||
                      !event.cursor ||
                      (cursor.generation === event.cursor.generation &&
                        event.cursor.sequence > cursor.sequence)
                    );
                  }),
                ),
              );
            }),
          ),
        ),
        { "rpc.aggregate": "terminal" },
      ),
  });
};
