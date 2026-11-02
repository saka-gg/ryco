import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeClientInteraction } from "./ClientInteraction.ts";

const seconds = (duration: Duration.Duration) => Duration.toSeconds(duration);

describe("ClientInteraction", () => {
  it.effect("counts quiet time from this server's start until a client reports", () =>
    Effect.gen(function* () {
      const interaction = yield* makeClientInteraction;
      yield* TestClock.adjust("90 seconds");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 90);
      yield* interaction.note("session-a");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 0);
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 120);
    }),
  );

  it.effect("counts one report per session every 15 seconds", () =>
    Effect.gen(function* () {
      const interaction = yield* makeClientInteraction;
      yield* interaction.note("session-a");
      yield* TestClock.adjust("14 seconds");
      // Dropped: the quiet time keeps running from the counted report.
      yield* interaction.note("session-a");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 14);
      // Another session is not held back by the first one's limit.
      yield* interaction.note("session-b");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 0);
      yield* TestClock.adjust("1 second");
      yield* interaction.note("session-a");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 0);
    }),
  );

  it.effect("keeps the limit for a bounded number of sessions", () =>
    Effect.gen(function* () {
      const interaction = yield* makeClientInteraction;
      for (let index = 0; index < 1_000; index += 1) {
        yield* interaction.note(`session-${index}`);
      }
      yield* TestClock.adjust("5 seconds");
      // The newest sessions are still limited; the oldest were forgotten and count again.
      yield* interaction.note("session-999");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 5);
      yield* interaction.note("session-0");
      assert.strictEqual(seconds(yield* interaction.sinceLast), 0);
    }),
  );
});
