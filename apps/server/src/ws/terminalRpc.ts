import { Cause, Effect, Queue, Stream } from "effect";
import { type TerminalEvent, TerminalSubscriptionResyncError, WS_METHODS } from "@ryco/contracts";

import {
  approximateJsonBytes,
  recordServerPerfPayload,
} from "../observability/PerfInstrumentation.ts";
import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const TERMINAL_SUBSCRIBER_CAPACITY = 256;
/**
 * Byte ceiling on queued-but-undrained terminal events per subscriber. The
 * event count bound alone lets a stalled client accumulate arbitrarily large
 * output payloads; tripping this budget fails the subscription with the same
 * `slowConsumer` resync signal as count overflow, so the client resynchronizes
 * from the session snapshot (which carries the retained history) instead of
 * the server growing memory without bound.
 */
const TERMINAL_SUBSCRIBER_MAX_BYTES = 4 * 1024 * 1024;

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

  return defineWsHandlers({
    [WS_METHODS.terminalOpen]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalOpen,
        ownerEffect(WS_METHODS.terminalOpen, terminalManager.open(input)),
        {
          "rpc.aggregate": "terminal",
        },
      ),
    [WS_METHODS.terminalWrite]: (input) =>
      observeRpcEffect(
        WS_METHODS.terminalWrite,
        ownerEffect(WS_METHODS.terminalWrite, terminalManager.write(input)),
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
    [WS_METHODS.subscribeTerminalEvents]: (_input) =>
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
              const cursors = new Map(
                snapshots.map((snapshot) => [
                  JSON.stringify([snapshot.threadId, snapshot.terminalId]),
                  snapshot.cursor,
                ]),
              );
              const initial: TerminalEvent[] = snapshots.map((snapshot) => ({
                type: "started",
                threadId: snapshot.threadId,
                terminalId: snapshot.terminalId,
                createdAt: snapshot.updatedAt,
                snapshot,
                ...(snapshot.cursor ? { cursor: snapshot.cursor } : {}),
              }));
              // Bootstrap and live queues share both budgets. Separate queues
              // enforce snapshot-first ordering without exempting retained history
              // from the existing per-subscriber bounds.
              const initialQueue = yield* Queue.dropping<
                TerminalEvent,
                TerminalSubscriptionResyncError | Cause.Done<void>
              >(TERMINAL_SUBSCRIBER_CAPACITY);
              yield* Effect.addFinalizer(() => Queue.shutdown(initialQueue));
              const offerInitial = makeTerminalSubscriberOffer(
                initialQueue,
                TERMINAL_SUBSCRIBER_CAPACITY,
                ledger,
              );
              yield* Effect.forEach(initial, offerInitial, { discard: true });
              return Stream.concat(
                Stream.fromQueue(initialQueue).pipe(
                  Stream.take(initial.length),
                  Stream.tap((event) => releaseTerminalSubscriberEvent(ledger, event)),
                ),
                Stream.fromQueue(queue).pipe(
                  Stream.tap((event) => releaseTerminalSubscriberEvent(ledger, event)),
                  Stream.filter((event) => {
                    const cursor = cursors.get(JSON.stringify([event.threadId, event.terminalId]));
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
