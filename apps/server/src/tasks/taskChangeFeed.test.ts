import { assert, it } from "@effect/vitest";
import type { LocalTaskChange } from "@ryco/contracts";
import { Effect, Queue, Stream } from "effect";
import { describe } from "vite-plus/test";

import { makeLocalTaskChangeFeed } from "./taskChangeFeed.ts";

describe("local task change feed", () => {
  it.effect(
    "holds each changed task once, a deletion winning, and past its backlog says read all",
    () =>
      Effect.gen(function* () {
        const feed = yield* makeLocalTaskChangeFeed(3);
        const id = (yield* feed.position).feed;
        const received = yield* Queue.unbounded<LocalTaskChange>();
        yield* feed.changes.pipe(
          Stream.runForEach((change) => Queue.offer(received, change)),
          Effect.forkScoped,
        );
        assert.deepEqual(yield* Queue.take(received), { position: { feed: id, sequence: 0 } });

        // A burst before the listener reads: each task once, in the order first changed.
        yield* feed.publish("a");
        yield* feed.publish("b");
        yield* feed.publish("a", true);
        yield* feed.publish("a");
        assert.deepEqual(
          [yield* Queue.take(received), yield* Queue.take(received)],
          [{ taskId: "a", deleted: true }, { taskId: "b" }],
        );

        // A listener that falls further behind than its backlog gets the word to read everything,
        // counting every change published so far.
        for (const taskId of ["c", "d", "e", "f"]) yield* feed.publish(taskId);
        assert.deepEqual(yield* Queue.take(received), { position: { feed: id, sequence: 8 } });
        yield* feed.publish("g");
        assert.deepEqual(yield* Queue.take(received), { taskId: "g" });
      }).pipe(Effect.scoped),
  );

  it.effect("the read-all word counts every change it stands for", () =>
    Effect.gen(function* () {
      const feed = yield* makeLocalTaskChangeFeed();
      const received = yield* Queue.unbounded<LocalTaskChange>();
      yield* feed.changes.pipe(
        Stream.runForEach((change) => Queue.offer(received, change)),
        Effect.forkScoped,
      );
      // Published while the subscription starts: before it listens, after it listens but before
      // its first word, or after that word.
      yield* feed.publish("a");
      const word = yield* Queue.take(received);
      assert.isUndefined(word.taskId);
      yield* feed.publish("b");
      const after: Array<LocalTaskChange> = [];
      while (after.at(-1)?.taskId !== "b") after.push(yield* Queue.take(received));

      // A change is either counted in the word or delivered after it, never neither.
      const aDeliveredSeparately = after.some((change) => change.taskId === "a");
      assert.equal(word.position?.sequence ?? -1, aDeliveredSeparately ? 0 : 1);
      assert.deepEqual(
        after.map((change) => change.taskId),
        aDeliveredSeparately ? ["a", "b"] : ["b"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("positions count publishes, and each feed has its own id", () =>
    Effect.gen(function* () {
      const feed = yield* makeLocalTaskChangeFeed();
      const start = yield* feed.position;
      assert.equal(start.sequence, 0);
      // Counted with nobody listening too.
      yield* feed.publish("a");
      yield* feed.publish("b", true);
      assert.deepEqual(yield* feed.position, { feed: start.feed, sequence: 2 });
      const other = yield* makeLocalTaskChangeFeed();
      assert.notEqual((yield* other.position).feed, start.feed);
    }),
  );
});
