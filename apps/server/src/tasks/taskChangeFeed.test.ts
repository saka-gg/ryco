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
        const received = yield* Queue.unbounded<LocalTaskChange>();
        yield* feed.changes.pipe(
          Stream.runForEach((change) => Queue.offer(received, change)),
          Effect.forkScoped,
        );
        assert.deepEqual(yield* Queue.take(received), {});

        // A burst before the listener reads: each task once, in the order first changed.
        yield* feed.publish("a");
        yield* feed.publish("b");
        yield* feed.publish("a", true);
        yield* feed.publish("a");
        assert.deepEqual(
          [yield* Queue.take(received), yield* Queue.take(received)],
          [{ taskId: "a", deleted: true }, { taskId: "b" }],
        );

        // A listener that falls further behind than its backlog gets the word to read everything.
        for (const taskId of ["c", "d", "e", "f"]) yield* feed.publish(taskId);
        assert.deepEqual(yield* Queue.take(received), {});
        yield* feed.publish("g");
        assert.deepEqual(yield* Queue.take(received), { taskId: "g" });
      }).pipe(Effect.scoped),
  );
});
