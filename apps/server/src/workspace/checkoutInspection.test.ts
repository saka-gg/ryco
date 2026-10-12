import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { CheckoutInspectionError, makeCheckoutReadCache } from "./checkoutInspection.ts";

describe("makeCheckoutReadCache", () => {
  const counted = (calls: { count: number }, value: string) =>
    Effect.sync(() => {
      calls.count += 1;
      return value;
    });

  it.effect("serves a slot's version from one run until the version changes", () =>
    Effect.gen(function* () {
      const cache = makeCheckoutReadCache();
      const calls = { count: 0 };

      const [first, second] = yield* Effect.all(
        [
          cache.through("status\u0000/repo", "v1", counted(calls, "clean")),
          cache.through("status\u0000/repo", "v1", counted(calls, "clean")),
        ],
        { concurrency: "unbounded" },
      );
      const again = yield* cache.through("status\u0000/repo", "v1", counted(calls, "clean"));
      assert.deepStrictEqual([first, second, again], ["clean", "clean", "clean"]);
      assert.strictEqual(calls.count, 1);

      // The checkout changed: the slot reads again and keeps only the new version.
      const changed = yield* cache.through("status\u0000/repo", "v2", counted(calls, "dirty"));
      assert.strictEqual(changed, "dirty");
      assert.strictEqual(calls.count, 2);
      // Asking for the superseded version reads again rather than serving a kept result.
      yield* cache.through("status\u0000/repo", "v1", counted(calls, "clean"));
      assert.strictEqual(calls.count, 3);
    }),
  );

  it.effect("never keeps a failed read", () =>
    Effect.gen(function* () {
      const cache = makeCheckoutReadCache();
      let attempts = 0;
      const read = Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new CheckoutInspectionError({ detail: "git status failed" }))
          : Effect.succeed("clean");
      });

      const failed = yield* cache.through("status\u0000/repo", "v1", read).pipe(Effect.flip);
      assert.strictEqual(failed.detail, "git status failed");
      assert.strictEqual(yield* cache.through("status\u0000/repo", "v1", read), "clean");
      assert.strictEqual(attempts, 2);
    }),
  );

  it.effect("bounds the slots it keeps", () =>
    Effect.gen(function* () {
      const cache = makeCheckoutReadCache({ capacity: 2 });
      const calls = { count: 0 };
      yield* cache.through("a", "v", counted(calls, "a"));
      yield* cache.through("b", "v", counted(calls, "b"));
      yield* cache.through("c", "v", counted(calls, "c"));
      // "a" was the least recently used slot and was dropped.
      yield* cache.through("a", "v", counted(calls, "a"));
      assert.strictEqual(calls.count, 4);
      yield* cache.through("c", "v", counted(calls, "c"));
      assert.strictEqual(calls.count, 4);
    }),
  );
});
