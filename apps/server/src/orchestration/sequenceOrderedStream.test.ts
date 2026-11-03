import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Schedule, Stream } from "effect";
import type { Array as Arr } from "effect";

import { dedupeBySequence, orderBySequence } from "./sequenceOrderedStream.ts";

interface Item {
  readonly sequence: number;
}

const item = (sequence: number): Item => ({ sequence });
const sequencesOf = (items: Iterable<Item>) => Array.from(items, (entry) => entry.sequence);
const getSequence = (entry: Item) => entry.sequence;

/** A source that emits the given arrays as they are, one pull each. */
const fromArrays = (
  arrays: ReadonlyArray<ReadonlyArray<Item>>,
  onPull?: (items: ReadonlyArray<Item>) => void,
) =>
  Stream.fromPull(
    Effect.sync(() => {
      let index = 0;
      return Effect.suspend(() => {
        const items = arrays[index++];
        if (items === undefined) return Cause.done();
        onPull?.(items);
        return Effect.succeed(items as Arr.NonEmptyReadonlyArray<Item>);
      });
    }),
  );
const itemArrays = (arrays: ReadonlyArray<ReadonlyArray<number>>) =>
  arrays.map((sequences) => sequences.map(item));

/** A gap reader over a persisted log, recording each read. */
const makeLog = (persisted: ReadonlyArray<number>) => {
  const reads: Array<readonly [number, number]> = [];
  const fillGap = (fromExclusive: number, throughInclusive: number) =>
    Stream.suspend(() => {
      reads.push([fromExclusive, throughInclusive]);
      return Stream.fromIterable(
        persisted
          .filter((sequence) => sequence > fromExclusive && sequence <= throughInclusive)
          .map(item),
      );
    });
  return { reads, fillGap };
};

describe("orderBySequence", () => {
  it.effect("drops items at or below the last emitted sequence", () =>
    Effect.gen(function* () {
      const source = Stream.fromIterable([1, 2, 2, 3, 1, 4].map(item));
      const fromZero = yield* Stream.runCollect(source.pipe(dedupeBySequence(getSequence, 0)));
      const fromTwo = yield* Stream.runCollect(source.pipe(dedupeBySequence(getSequence, 2)));
      assert.deepStrictEqual(sequencesOf(fromZero), [1, 2, 3, 4]);
      assert.deepStrictEqual(sequencesOf(fromTwo), [3, 4]);
    }),
  );

  it.effect("lets gaps through without a reader", () =>
    Effect.gen(function* () {
      const output = yield* Stream.runCollect(
        Stream.fromIterable([1, 3, 7].map(item)).pipe(
          orderBySequence({ getSequence, initialSequence: 0 }),
        ),
      );
      assert.deepStrictEqual(sequencesOf(output), [1, 3, 7]);
    }),
  );

  it.effect("fills each jump from the reader, once, before the item that jumped", () =>
    Effect.gen(function* () {
      const log = makeLog([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const output = yield* Stream.runCollect(
        Stream.fromIterable([1, 2, 5, 6, 6, 4, 9].map(item)).pipe(
          orderBySequence({ getSequence, initialSequence: 0, fillGap: log.fillGap }),
        ),
      );
      assert.deepStrictEqual(sequencesOf(output), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.deepStrictEqual(log.reads, [
        [2, 4],
        [6, 8],
      ]);
    }),
  );

  it.effect("stays strictly increasing when the reader repeats or reaches back", () =>
    Effect.gen(function* () {
      const reads: Array<readonly [number, number]> = [];
      const output = yield* Stream.runCollect(
        Stream.fromIterable([1, 2, 6, 7].map(item)).pipe(
          orderBySequence({
            getSequence,
            initialSequence: 0,
            fillGap: (fromExclusive, throughInclusive) => {
              reads.push([fromExclusive, throughInclusive]);
              return Stream.fromIterable([1, 2, 3, 3, 2, 4, 5, 5].map(item));
            },
          }),
        ),
      );
      assert.deepStrictEqual(sequencesOf(output), [1, 2, 3, 4, 5, 6, 7]);
      assert.deepStrictEqual(reads, [[2, 5]]);
    }),
  );

  it.effect("treats what a gap read did not return as a hole and does not read it again", () =>
    Effect.gen(function* () {
      const log = makeLog([1, 2, 3, 5, 6]);
      const output = yield* Stream.runCollect(
        Stream.fromIterable([1, 2, 5, 6].map(item)).pipe(
          orderBySequence({ getSequence, initialSequence: 0, fillGap: log.fillGap }),
        ),
      );
      assert.deepStrictEqual(sequencesOf(output), [1, 2, 3, 5, 6]);
      assert.deepStrictEqual(log.reads, [[2, 4]]);
    }),
  );

  it.effect("keeps the source's arrays on the no-gap path and splits only at a jump", () =>
    Effect.gen(function* () {
      const log = makeLog([1, 2, 3, 4, 5, 6, 7]);
      const first = [1, 2, 5, 6].map(item);
      const second = [7].map(item);
      const arrays = yield* Stream.runCollect(
        fromArrays([first, second]).pipe(
          orderBySequence({ getSequence, initialSequence: 0, fillGap: log.fillGap }),
          Stream.chunks,
        ),
      );
      assert.deepStrictEqual(
        arrays.map((items) => sequencesOf(items)),
        [[1, 2], [3, 4], [5, 6], [7]],
      );
      // Nothing dropped and no jump: the very array the source emitted.
      assert.isTrue(Object.is(arrays[3], second));
    }),
  );

  it.effect("repeats nothing when a failed gap read is retried", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const output = yield* Stream.runCollect(
        fromArrays(itemArrays([[1], [8]])).pipe(
          orderBySequence({
            getSequence,
            initialSequence: 0,
            fillGap: (fromExclusive, throughInclusive) =>
              Stream.suspend(() => {
                attempts += 1;
                const rows = Stream.fromIterable(
                  [2, 3, 4, 5, 6, 7]
                    .filter((sequence) => sequence > fromExclusive && sequence <= throughInclusive)
                    .map(item),
                );
                // The first attempt fails after delivering part of the range.
                return attempts === 1
                  ? Stream.concat(Stream.take(rows, 3), Stream.fail("read failed" as const))
                  : rows;
              }).pipe(Stream.retry(Schedule.recurs(1))),
          }),
        ),
      );
      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(sequencesOf(output), [1, 2, 3, 4, 5, 6, 7, 8]);
    }),
  );

  it.effect("fails with the reader's error and keeps what was emitted before it", () =>
    Effect.gen(function* () {
      const emitted: Array<number> = [];
      const exit = yield* Stream.fromIterable([1, 4].map(item)).pipe(
        orderBySequence({
          getSequence,
          initialSequence: 0,
          fillGap: () => Stream.fail("read failed" as const),
        }),
        Stream.runForEach((entry) => Effect.sync(() => emitted.push(entry.sequence))),
        Effect.flip,
      );
      assert.strictEqual(exit, "read failed");
      assert.deepStrictEqual(emitted, [1]);
    }),
  );

  it.effect(
    "ends with the source when a gap's last page and the jumping item were already sent",
    () =>
      Effect.gen(function* () {
        let sourceEnds = 0;
        const output = yield* Stream.runCollect(
          fromArrays(itemArrays([[1], [3]])).pipe(
            Stream.onEnd(Effect.sync(() => (sourceEnds += 1))),
            orderBySequence({
              getSequence,
              initialSequence: 0,
              // Reads past its bound, then repeats itself: everything after [2, 3] is dropped.
              fillGap: () => fromArrays(itemArrays([[2, 3], [3]])),
            }),
          ),
        );
        assert.deepStrictEqual(sequencesOf(output), [1, 2, 3]);
        assert.strictEqual(sourceEnds, 1);
      }),
  );

  it.effect("gives every run its own cursor", () =>
    Effect.gen(function* () {
      const log = makeLog([1, 2, 3, 4]);
      const ordered = Stream.fromIterable([1, 4].map(item)).pipe(
        orderBySequence({ getSequence, initialSequence: 0, fillGap: log.fillGap }),
      );
      const first = yield* Stream.runCollect(ordered);
      const second = yield* Stream.runCollect(ordered);
      assert.deepStrictEqual(sequencesOf(first), [1, 2, 3, 4]);
      assert.deepStrictEqual(sequencesOf(second), [1, 2, 3, 4]);
      assert.deepStrictEqual(log.reads, [
        [1, 3],
        [1, 3],
      ]);
    }),
  );

  it.effect("closes the gap reader's resources once the gap is filled", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const output = yield* Stream.runCollect(
        fromArrays(itemArrays([[1], [4], [5]]), (items) =>
          events.push(`source ${sequencesOf(items).join(",")}`),
        ).pipe(
          orderBySequence({
            getSequence,
            initialSequence: 0,
            fillGap: () =>
              Stream.fromIterable([2, 3].map(item)).pipe(
                Stream.ensuring(Effect.sync(() => events.push("gap closed"))),
              ),
          }),
        ),
      );
      assert.deepStrictEqual(sequencesOf(output), [1, 2, 3, 4, 5]);
      assert.isTrue(events.indexOf("gap closed") < events.indexOf("source 5"));
    }),
  );
});
