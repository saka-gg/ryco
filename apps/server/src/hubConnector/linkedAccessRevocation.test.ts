import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  LINKED_REVOCATION_RESWEEP_MS,
  LINKED_REVOCATION_RETRY_DELAYS_MS,
  linkedAccessRevocation,
} from "./linkedAccessRevocation.ts";

describe("linkedAccessRevocation", () => {
  it.effect("ends codes before sessions, and sweeps the sessions again later", () =>
    Effect.gen(function* () {
      const steps: string[] = [];
      const revocation = linkedAccessRevocation({
        revokeCodes: Effect.sync(() => steps.push("codes")),
        revokeSessions: Effect.sync(() => steps.push("sessions")),
      });
      yield* revocation.now;
      assert.deepEqual(steps, ["codes", "sessions"]);
      const resweep = yield* Effect.forkChild(revocation.resweep);
      yield* TestClock.adjust(LINKED_REVOCATION_RESWEEP_MS - 1);
      assert.deepEqual(steps, ["codes", "sessions"]);
      yield* TestClock.adjust(1);
      yield* Fiber.join(resweep);
      assert.deepEqual(steps, ["codes", "sessions", "sessions"]);
    }),
  );

  it.effect("retries a failed attempt a bounded number of times, then gives up", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const revocation = linkedAccessRevocation({
        revokeCodes: Effect.suspend(() => {
          attempts += 1;
          return attempts < 3 ? Effect.fail("busy") : Effect.void;
        }),
        revokeSessions: Effect.void,
      });
      const run = yield* Effect.forkChild(revocation.now);
      for (const delayMs of LINKED_REVOCATION_RETRY_DELAYS_MS) yield* TestClock.adjust(delayMs);
      yield* Fiber.join(run);
      assert.equal(attempts, 3);

      let failures = 0;
      const failing = linkedAccessRevocation({
        revokeCodes: Effect.suspend(() => {
          failures += 1;
          return Effect.fail("still busy");
        }),
        revokeSessions: Effect.void,
      });
      const gaveUp = yield* Effect.forkChild(failing.now);
      for (const delayMs of LINKED_REVOCATION_RETRY_DELAYS_MS) yield* TestClock.adjust(delayMs);
      yield* Fiber.join(gaveUp);
      assert.equal(failures, LINKED_REVOCATION_RETRY_DELAYS_MS.length + 1);
    }),
  );
});
