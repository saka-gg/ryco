import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  AGENT_CONTROL_WAIT_RECHECK_MS,
  AGENT_CONTROL_WAIT_WAKE_SPACING_MS,
  waitUntil,
  wakeOnStream,
  wakeOnSubscription,
  type WaitCheck,
  type WaitWakeSource,
} from "./eventDrivenWait.ts";

/** Lets forked fibers run without advancing the test clock; true once `fiber` has ended. */
const awaitDone = (fiber: Fiber.Fiber<unknown, unknown>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 50 && fiber.pollUnsafe() === undefined; turn += 1) {
      yield* Effect.yieldNow;
    }
    return fiber.pollUnsafe() !== undefined;
  });

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow;
});

/** A feed whose subscriptions and drainers are counted while they are live. */
const makeFeed = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<string>();
  const live = { subscriptions: 0, drainers: 0 };
  let subscribed = 0;
  const subscribe = Effect.acquireRelease(
    PubSub.subscribe(pubsub).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          live.subscriptions++;
          subscribed++;
        }),
      ),
    ),
    () => Effect.sync(() => live.subscriptions--),
  ).pipe(
    Effect.map((subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.onStart(Effect.sync(() => live.drainers++)),
        Stream.ensuring(Effect.sync(() => live.drainers--)),
      ),
    ),
  );
  const source: WaitWakeSource = wakeOnStream(subscribe, (item) => item.startsWith("relevant"));
  return {
    source,
    live,
    /** Subscriptions ever taken, released or not. */
    subscribed: () => subscribed,
    publish: (item: string) => PubSub.publish(pubsub, item),
  };
});

const makeCheck = (input: { readonly fails?: (run: number) => boolean } = {}) => {
  let done = false;
  let runs = 0;
  return {
    runs: () => runs,
    finish: () => {
      done = true;
    },
    check: Effect.suspend(() => {
      runs += 1;
      return input.fails?.(runs)
        ? Effect.fail(new Error(`check ${runs} failed`))
        : Effect.succeed({ done, value: runs });
    }),
  };
};

it.effect("wakes on a relevant item without waiting for the re-check", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    const check = makeCheck();
    const fiber = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: check.check, timeoutMs: 30_000 }),
    );
    assert.isFalse(yield* awaitDone(fiber));
    assert.strictEqual(check.runs(), 1);

    check.finish();
    yield* feed.publish("relevant: settled");
    assert.isTrue(yield* awaitDone(fiber));
    assert.deepStrictEqual(yield* Fiber.join(fiber), { value: 2, timedOut: false });
    assert.strictEqual(check.runs(), 2);
  }),
);

it.effect("never re-checks for irrelevant items", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    const check = makeCheck();
    const fiber = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: check.check, timeoutMs: 30_000 }),
    );
    yield* settle;
    for (let index = 0; index < 200; index += 1) yield* feed.publish(`noise ${index}`);
    assert.isFalse(yield* awaitDone(fiber));
    assert.strictEqual(check.runs(), 1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("re-checks on the fallback interval without a wake", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    const check = makeCheck();
    const fiber = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: check.check, timeoutMs: 30_000 }),
    );
    yield* settle;
    yield* TestClock.adjust(AGENT_CONTROL_WAIT_RECHECK_MS - 1);
    yield* settle;
    assert.strictEqual(check.runs(), 1);
    yield* TestClock.adjust(1);
    yield* settle;
    assert.strictEqual(check.runs(), 2);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("checks last at the deadline and reports the timeout", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    const check = makeCheck();
    const fiber = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: check.check, timeoutMs: 12_000 }),
    );
    yield* settle;
    yield* TestClock.adjust(12_000);
    assert.isTrue(yield* awaitDone(fiber));
    // Checks at 0, 5, 10 and 12 s.
    assert.deepStrictEqual(yield* Fiber.join(fiber), { value: 4, timedOut: true });
  }),
);

it.effect("performs exactly one check with a zero timeout and subscribes to nothing", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    const check = makeCheck();
    const result = yield* waitUntil({ sources: [feed.source], check: check.check, timeoutMs: 0 });
    assert.deepStrictEqual(result, { value: 1, timedOut: true });
    assert.strictEqual(feed.subscribed(), 0);
  }),
);

it.effect("coalesces a burst of wakes into one trailing check per spacing interval", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    const check = makeCheck();
    const fiber = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: check.check, timeoutMs: 30_000 }),
    );
    yield* settle;
    // The first wake after a quiet period checks at once.
    yield* feed.publish("relevant 1");
    yield* settle;
    assert.strictEqual(check.runs(), 2);
    // Fifty more within the spacing interval: one trailing check, not fifty.
    for (let index = 0; index < 50; index += 1) {
      yield* feed.publish(`relevant burst ${index}`);
      yield* Effect.yieldNow;
    }
    yield* settle;
    assert.strictEqual(check.runs(), 2);
    yield* TestClock.adjust(AGENT_CONTROL_WAIT_WAKE_SPACING_MS - 1);
    yield* settle;
    assert.strictEqual(check.runs(), 2);
    yield* TestClock.adjust(1);
    yield* settle;
    assert.strictEqual(check.runs(), 3);
    // Quiet again: nothing more until the fallback.
    yield* TestClock.adjust(AGENT_CONTROL_WAIT_WAKE_SPACING_MS * 2);
    yield* settle;
    assert.strictEqual(check.runs(), 3);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("keeps a wake that lands while a check runs", () =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<string>();
    let runs = 0;
    const fiber = yield* Effect.forkChild(
      waitUntil({
        sources: [wakeOnSubscription(PubSub.subscribe(pubsub), () => true)],
        // The first read observes stale state; the change commits (and publishes) before it returns.
        check: Effect.suspend((): Effect.Effect<WaitCheck<number>> => {
          runs += 1;
          return runs === 1
            ? PubSub.publish(pubsub, "committed during the read").pipe(
                Effect.andThen(Effect.yieldNow),
                Effect.as({ done: false, value: runs }),
              )
            : Effect.succeed({ done: true, value: runs });
        }),
        timeoutMs: 30_000,
      }),
    );
    assert.isTrue(yield* awaitDone(fiber));
    assert.deepStrictEqual(yield* Fiber.join(fiber), { value: 2, timedOut: false });
  }),
);

it.effect("propagates a check failure", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    const check = makeCheck({ fails: (run) => run === 2 });
    const fiber = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: check.check, timeoutMs: 30_000 }),
    );
    yield* settle;
    yield* feed.publish("relevant");
    assert.isTrue(yield* awaitDone(fiber));
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit));
    assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "check 2 failed");
  }),
);

it.effect("wakes on any of several sources", () =>
  Effect.gen(function* () {
    const first = yield* makeFeed;
    const second = yield* makeFeed;
    const check = makeCheck();
    const fiber = yield* Effect.forkChild(
      waitUntil({ sources: [first.source, second.source], check: check.check, timeoutMs: 30_000 }),
    );
    assert.isFalse(yield* awaitDone(fiber));
    check.finish();
    yield* second.publish("relevant on the second feed");
    assert.isTrue(yield* awaitDone(fiber));
    assert.deepStrictEqual(yield* Fiber.join(fiber), { value: 2, timedOut: false });
  }),
);

it.effect("releases every subscription and drainer when the wait ends", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;

    // Done.
    const done = makeCheck();
    const finished = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: done.check, timeoutMs: 30_000 }),
    );
    yield* settle;
    assert.deepStrictEqual(feed.live, { subscriptions: 1, drainers: 1 });
    done.finish();
    yield* feed.publish("relevant");
    assert.isTrue(yield* awaitDone(finished));
    yield* settle;
    assert.deepStrictEqual(feed.live, { subscriptions: 0, drainers: 0 });

    // Timed out.
    const timedOut = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: makeCheck().check, timeoutMs: 1_000 }),
    );
    yield* settle;
    yield* TestClock.adjust(1_000);
    assert.isTrue(yield* awaitDone(timedOut));
    yield* settle;
    assert.deepStrictEqual(feed.live, { subscriptions: 0, drainers: 0 });

    // Failed.
    const failing = makeCheck({ fails: (run) => run === 2 });
    const failed = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: failing.check, timeoutMs: 30_000 }),
    );
    yield* settle;
    yield* feed.publish("relevant");
    assert.isTrue(yield* awaitDone(failed));
    yield* settle;
    assert.deepStrictEqual(feed.live, { subscriptions: 0, drainers: 0 });

    // Interrupted (a disconnected MCP client).
    const interrupted = yield* Effect.forkChild(
      waitUntil({ sources: [feed.source], check: makeCheck().check, timeoutMs: 30_000 }),
    );
    yield* settle;
    assert.deepStrictEqual(feed.live, { subscriptions: 1, drainers: 1 });
    yield* Fiber.interrupt(interrupted);
    yield* settle;
    assert.deepStrictEqual(feed.live, { subscriptions: 0, drainers: 0 });
  }),
);

it.effect("drains its feed while a check is still running", () =>
  Effect.gen(function* () {
    // A bounded, back-pressured feed like the engine's event bus: a publisher blocks while any
    // subscriber has a full buffer.
    const pubsub = yield* PubSub.bounded<string>(4);
    let release: (() => void) | undefined;
    let runs = 0;
    const fiber = yield* Effect.forkChild(
      waitUntil({
        sources: [wakeOnSubscription(PubSub.subscribe(pubsub), () => false)],
        check: Effect.suspend(() => {
          runs += 1;
          // The second check blocks (a slow SQLite read) until the test releases it.
          return runs === 2
            ? Effect.callback<{ done: boolean; value: number }>((resume) => {
                release = () => resume(Effect.succeed({ done: true, value: runs }));
              })
            : Effect.succeed({ done: false, value: runs });
        }),
        timeoutMs: 30_000,
      }),
    );
    yield* settle;
    yield* TestClock.adjust(AGENT_CONTROL_WAIT_RECHECK_MS);
    yield* settle;
    assert.strictEqual(runs, 2);
    // Twenty publishes would block on a 4-slot buffer nobody drains.
    const publisher = yield* Effect.forkChild(
      Effect.forEach(
        Array.from({ length: 20 }, (_, index) => `event ${index}`),
        (item) => PubSub.publish(pubsub, item),
      ),
    );
    assert.isTrue(yield* awaitDone(publisher));
    release?.();
    assert.isTrue(yield* awaitDone(fiber));
  }),
);

it.effect("releases a feed whose filter throws and falls back to the re-check", () =>
  Effect.gen(function* () {
    // A bounded, back-pressured feed: a subscription left behind by a stopped drainer would block
    // the publisher once its buffer fills.
    const pubsub = yield* PubSub.bounded<string>(2);
    const check = makeCheck();
    const fiber = yield* Effect.forkChild(
      waitUntil({
        sources: [
          wakeOnSubscription(PubSub.subscribe(pubsub), () => {
            throw new Error("broken filter");
          }),
        ],
        check: check.check,
        timeoutMs: 30_000,
      }),
    );
    assert.isFalse(yield* awaitDone(fiber));
    yield* PubSub.publish(pubsub, "anything");
    assert.isFalse(yield* awaitDone(fiber));
    const publisher = yield* Effect.forkChild(
      Effect.forEach(
        Array.from({ length: 10 }, (_, index) => `after the filter broke ${index}`),
        (item) => PubSub.publish(pubsub, item),
      ),
    );
    assert.isTrue(yield* awaitDone(publisher));
    assert.strictEqual(check.runs(), 1);
    check.finish();
    yield* TestClock.adjust(AGENT_CONTROL_WAIT_RECHECK_MS);
    assert.isTrue(yield* awaitDone(fiber));
    assert.deepStrictEqual(yield* Fiber.join(fiber), { value: 2, timedOut: false });
  }),
);
