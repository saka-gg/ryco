import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SourceControlProviderError } from "@ryco/contracts";

import { ForgeRequestPausedError } from "./forgeRateLimit.ts";
import { inBackgroundProcessLane } from "../processGovernor.ts";
import {
  DEFAULT_PAUSE_HOLD_MS,
  LAST_GOOD_MAX_AGE_MS,
  MAX_PAUSE_HOLD_MS,
  MIN_PAUSE_HOLD_MS,
  heldUntil,
  makeLastGood,
  markServedWhilePaused,
  pauseHoldMs,
  pausedUntilOf,
} from "./lastGoodWhilePaused.ts";

const T0 = 1_000_000_000_000;

const rateLimited = (retryAt?: number) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "listChangeRequests",
    detail: "GitHub API rate limit exceeded.",
    reason: "rate-limited",
    ...(retryAt !== undefined ? { retryAt } : {}),
  });

describe("lastGoodWhilePaused", () => {
  it("holds until the pause ends, clamped", () => {
    assert.strictEqual(pauseHoldMs(T0 + 120_000, T0), 120_000);
    assert.strictEqual(pauseHoldMs(T0 + 1_000, T0), MIN_PAUSE_HOLD_MS);
    assert.strictEqual(pauseHoldMs(T0 - 5_000, T0), MIN_PAUSE_HOLD_MS);
    assert.strictEqual(pauseHoldMs(T0 + 3_600_000, T0), MAX_PAUSE_HOLD_MS);
    assert.strictEqual(pauseHoldMs(null, T0), DEFAULT_PAUSE_HOLD_MS);
    assert.strictEqual(pauseHoldMs(T0 + 500, T0, 1_000), 1_000);
  });

  it("holds only a rate limit the forge answered", () => {
    assert.strictEqual(heldUntil(rateLimited(T0 + 60_000), T0), T0 + 60_000);
    assert.strictEqual(heldUntil(rateLimited(), T0), T0 + DEFAULT_PAUSE_HOLD_MS);
    const refused = new SourceControlProviderError({
      provider: "github",
      operation: "listChangeRequests",
      detail: "GitHub requests are paused after a rate limit.",
      reason: "rate-limited",
      retryAt: T0 + 60_000,
      cause: new ForgeRequestPausedError({
        provider: "github",
        host: "github.com",
        retryAt: T0 + 60_000,
      }),
    });
    assert.strictEqual(heldUntil(refused, T0), null);
    const offline = new SourceControlProviderError({
      provider: "github",
      operation: "listChangeRequests",
      detail: "host unreachable",
    });
    assert.strictEqual(heldUntil(offline, T0), null);
    assert.strictEqual(heldUntil("rate limit", T0), null);
  });

  it("marks a copy and leaves the original unmarked", () => {
    const rows = [{ number: 1 }];
    const served = markServedWhilePaused(rows, T0);
    assert.notStrictEqual(served, rows);
    assert.deepStrictEqual(served, rows);
    assert.isTrue(Array.isArray(served));
    assert.strictEqual(pausedUntilOf(served), T0);
    assert.strictEqual(pausedUntilOf(rows), null);

    const detail = { number: 2, title: "Two" };
    const servedDetail = markServedWhilePaused(detail, T0 + 1);
    assert.deepStrictEqual(servedDetail, detail);
    assert.strictEqual(pausedUntilOf(servedDetail), T0 + 1);
    assert.strictEqual(pausedUntilOf(detail), null);
    assert.strictEqual(pausedUntilOf(null), null);
    assert.strictEqual(pausedUntilOf("rows"), null);
  });

  it.effect("serves last good only to a background reader of a rate limit", () =>
    Effect.gen(function* () {
      const lastGood = makeLastGood<ReadonlyArray<number>>(4);
      lastGood.remember("a", [1, 2], T0);

      const served = yield* inBackgroundProcessLane(
        lastGood.serve("a", rateLimited(T0 + 60_000), T0 + 1_000),
      );
      assert.deepStrictEqual(served, [1, 2]);
      assert.strictEqual(pausedUntilOf(served), T0 + 60_000);

      // No time named: marked until the default hold.
      const untimed = yield* inBackgroundProcessLane(lastGood.serve("a", rateLimited(), T0));
      assert.strictEqual(pausedUntilOf(untimed), T0 + DEFAULT_PAUSE_HOLD_MS);

      // An interactive reader gets the error; so does any reader of another failure.
      const interactive = yield* lastGood.serve("a", rateLimited(T0), T0).pipe(Effect.flip);
      assert.strictEqual(interactive.reason, "rate-limited");
      const offline = new Error("offline");
      assert.strictEqual(
        yield* inBackgroundProcessLane(lastGood.serve("a", offline, T0)).pipe(Effect.flip),
        offline,
      );
      // Nothing remembered for the key.
      yield* inBackgroundProcessLane(lastGood.serve("b", rateLimited(), T0)).pipe(Effect.flip);
    }),
  );

  it.effect("drops values older than an hour and beyond capacity", () =>
    Effect.gen(function* () {
      const lastGood = makeLastGood<{ readonly n: number }>(2);
      const serve = (key: string, nowMs: number) =>
        inBackgroundProcessLane(lastGood.serve(key, rateLimited(), nowMs)).pipe(
          Effect.map((value) => value.n),
          Effect.orElseSucceed(() => null),
        );

      lastGood.remember("a", { n: 1 }, T0);
      assert.strictEqual(yield* serve("a", T0 + LAST_GOOD_MAX_AGE_MS), 1);
      assert.strictEqual(yield* serve("a", T0 + LAST_GOOD_MAX_AGE_MS + 1), null);

      // Remembering ages out older values too, and keeps at most `capacity`.
      lastGood.remember("b", { n: 2 }, T0);
      lastGood.remember("c", { n: 3 }, T0 + LAST_GOOD_MAX_AGE_MS + 1);
      assert.strictEqual(yield* serve("b", T0), null);
      lastGood.remember("d", { n: 4 }, T0 + LAST_GOOD_MAX_AGE_MS + 2);
      lastGood.remember("e", { n: 5 }, T0 + LAST_GOOD_MAX_AGE_MS + 3);
      assert.strictEqual(yield* serve("c", T0 + LAST_GOOD_MAX_AGE_MS + 3), null);
      assert.strictEqual(yield* serve("d", T0 + LAST_GOOD_MAX_AGE_MS + 3), 4);
      assert.strictEqual(yield* serve("e", T0 + LAST_GOOD_MAX_AGE_MS + 3), 5);
    }),
  );
});
