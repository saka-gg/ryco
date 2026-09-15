import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Queue, Stream } from "effect";
import {
  type TerminalEvent,
  type TerminalSessionSnapshot,
  TerminalSubscriptionResyncError,
  WS_METHODS,
} from "@ryco/contracts";

import {
  makeTerminalHandlers,
  makeTerminalSubscriberOffer,
  releaseTerminalSubscriberEvent,
} from "./terminalRpc.ts";
import type { WsRpcContext } from "./context.ts";

const snapshot: TerminalSessionSnapshot = {
  threadId: "thread-1",
  terminalId: "default",
  cwd: "/tmp",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "history",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-08-12T00:00:00.000Z",
};

describe("terminal subscription bootstrap", () => {
  const fixture = (
    read: (
      emit: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<ReadonlyArray<TerminalSessionSnapshot>>,
  ) => {
    let listener: (event: TerminalEvent) => Effect.Effect<void> = () => Effect.void;
    let unsubscribed = false;
    const handlers = makeTerminalHandlers({
      ownerStream: (_method: string, stream: Stream.Stream<TerminalEvent>) => stream,
      terminalManager: {
        subscribe: (next: typeof listener) =>
          Effect.sync(() => {
            listener = next;
            return () => {
              unsubscribed = true;
            };
          }),
        listSessions: Effect.suspend(() => read(listener)),
      },
    } as unknown as WsRpcContext);
    return {
      stream: handlers[WS_METHODS.subscribeTerminalEvents]({}),
      unsubscribed: () => unsubscribed,
    };
  };

  it.effect(
    "removes bytes already captured in a snapshot without dropping same-millisecond live bytes",
    () =>
      Effect.gen(function* () {
        const cursor = { generation: "server", sequence: 1 };
        const { stream } = fixture((emit) =>
          Effect.gen(function* () {
            yield* emit({ ...event("history"), cursor });
            yield* emit({ ...event("live🙂"), cursor: { ...cursor, sequence: 2 } });
            yield* emit({
              ...event(""),
              type: "exited",
              exitCode: 0,
              exitSignal: null,
              cursor: { ...cursor, sequence: 3 },
            });
            return [{ ...snapshot, cursor }];
          }),
        );
        const events = yield* stream.pipe(Stream.take(3), Stream.runCollect);
        assert.deepEqual(
          events.map((next) => next.type),
          ["started", "output", "exited"],
        );
        assert.equal(
          events
            .map((next) =>
              next.type === "started"
                ? next.snapshot.history
                : next.type === "output"
                  ? next.data
                  : "",
            )
            .join(""),
          "historylive🙂",
        );
      }),
  );

  it.effect("applies the existing byte budget to multiple retained bootstrap histories", () =>
    Effect.gen(function* () {
      const { stream, unsubscribed } = fixture(() =>
        Effect.succeed(
          Array.from({ length: 3 }, (_, i) => ({
            ...snapshot,
            terminalId: `terminal-${i}`,
            history: "x".repeat(2 * 1024 * 1024),
          })),
        ),
      );
      const received: TerminalEvent[] = [];
      const result = yield* stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        ),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.match(result.cause.toString(), /resynchronize/);
      // Two 2 MiB histories plus their envelopes exceed the 4 MiB budget.
      assert.equal(received.length, 1);
      assert.isTrue(unsubscribed());
    }),
  );

  it.effect("does not replay or charge closed terminal histories during bootstrap", () =>
    Effect.gen(function* () {
      const { stream } = fixture(() =>
        Effect.succeed([
          ...Array.from({ length: 128 }, (_, i) => ({
            ...snapshot,
            terminalId: `closed-${i}`,
            status: "exited" as const,
            pid: null,
            history: "x".repeat(2 * 1024 * 1024),
          })),
          snapshot,
        ]),
      );
      const events = yield* stream.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.terminalId, "default");
    }),
  );

  it.effect(
    "fails bounded overflow explicitly, releases the subscription, and recovers running history before a live exit",
    () =>
      Effect.gen(function* () {
        const stalled = fixture((emit) =>
          Effect.gen(function* () {
            for (let i = 0; i < 300; i++) yield* emit(event(String(i)));
            return [snapshot];
          }),
        );
        const result = yield* stalled.stream.pipe(Stream.runDrain, Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.match(result.cause.toString(), /resynchronize/);
        assert.isTrue(stalled.unsubscribed());
        const recovered = fixture((emit) =>
          Effect.gen(function* () {
            yield* emit({
              ...event(""),
              type: "exited",
              exitCode: 0,
              exitSignal: null,
              cursor: { generation: "new-server", sequence: 2 },
            });
            return [
              {
                ...snapshot,
                history: "final retained output",
                cursor: { generation: "new-server", sequence: 1 },
              },
            ];
          }),
        );
        const events = yield* recovered.stream.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(
          events.map((next) => next.type),
          ["started", "exited"],
        );
        assert.equal(
          events[0]?.type === "started" && events[0].snapshot.history,
          "final retained output",
        );
        assert.isTrue(recovered.unsubscribed());
      }),
  );
  it.effect("delivers the captured snapshot before live output arriving during bootstrap", () =>
    Effect.gen(function* () {
      let listener: (event: TerminalEvent) => Effect.Effect<void> = () => Effect.void;
      let unsubscribed = false;
      const handlers = makeTerminalHandlers({
        ownerStream: (_method: string, stream: Stream.Stream<TerminalEvent>) => stream,
        terminalManager: {
          subscribe: (next: typeof listener) =>
            Effect.sync(() => {
              listener = next;
              return () => {
                unsubscribed = true;
              };
            }),
          listSessions: Effect.gen(function* () {
            yield* listener(event("live"));
            return [snapshot];
          }),
        },
      } as unknown as WsRpcContext);
      const received = yield* handlers[WS_METHODS.subscribeTerminalEvents]({}).pipe(
        Stream.take(2),
        Stream.runCollect,
      );
      assert.deepEqual(
        received.map((next) => next.type),
        ["started", "output"],
      );
      assert.isTrue(unsubscribed);
    }),
  );
});

const event = (data: string): Extract<TerminalEvent, { type: "output" }> => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "default",
  createdAt: "2026-08-12T00:00:00.000Z",
  data,
});

describe("makeTerminalSubscriberOffer", () => {
  it.effect("releases both budgets when an active stream takes events immediately", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.dropping<
        TerminalEvent,
        TerminalSubscriptionResyncError | Cause.Done<void>
      >(256);
      const ledger = { bytes: 0, events: 0 };
      const offer = makeTerminalSubscriberOffer(queue, 256, ledger);
      const consumer = yield* Stream.fromQueue(queue).pipe(
        Stream.tap((event) => releaseTerminalSubscriberEvent(ledger, event)),
        Stream.take(600),
        Stream.runDrain,
        Effect.forkScoped,
      );
      for (let i = 0; i < 600; i++) {
        yield* offer(event("x".repeat(8192)));
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(consumer);
      assert.deepEqual(ledger, { bytes: 0, events: 0 });
    }),
  );
  it.effect("fails only a terminal subscriber that exhausts its bounded buffer", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.dropping<
        TerminalEvent,
        TerminalSubscriptionResyncError | Cause.Done<void>
      >(1);
      const offer = makeTerminalSubscriberOffer(queue, 1);

      yield* offer(event("first"));
      yield* offer(event("overflow"));

      const first = yield* Queue.take(queue);
      assert.equal(first.type === "output" ? first.data : null, "first");
      const exit = yield* Queue.take(queue).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.match(exit.cause.toString(), /reconnect to resynchronize/);
      }
    }),
  );

  it.effect("fails with the same resync signal when the queued byte budget trips", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.dropping<
        TerminalEvent,
        TerminalSubscriptionResyncError | Cause.Done<void>
      >(16);
      const ledger = { bytes: 0 };
      // Each event serializes well past 150 bytes (fixed fields plus data);
      // two fit the 400-byte budget, a third queued frame does not.
      const chunk = event("x".repeat(40));
      const offer = makeTerminalSubscriberOffer(queue, 16, ledger, 400);

      yield* offer(chunk);
      yield* offer(chunk);
      assert.isAbove(ledger.bytes, 0);

      // The release tap models the transport draining: ledger returns to 0.
      for (let index = 0; index < 2; index += 1) {
        const drained = yield* Queue.take(queue);
        yield* releaseTerminalSubscriberEvent(ledger, drained);
      }
      assert.equal(ledger.bytes, 0);

      // A fully drained subscriber is live again.
      yield* offer(chunk);
      assert.isAbove(ledger.bytes, 0);

      // Two more queued frames trip the byte budget while the count bound is
      // nowhere near exhausted; the same slowConsumer resync signal fires.
      yield* offer(chunk);
      yield* offer(chunk);
      // The two queued frames are delivered before the queued failure.
      for (let index = 0; index < 2; index += 1) {
        const drained = yield* Queue.take(queue);
        assert.equal(drained.type === "output" ? drained.data : null, chunk.data);
      }
      const exit = yield* Queue.take(queue).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, TerminalSubscriptionResyncError);
        assert.equal(error.reason, "slowConsumer");
      }
    }),
  );
});
