import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Duration, Effect, Exit, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";
import { makeOpenCodeServerOwner } from "./OpenCodeServerOwner.ts";

const state = { starts: 0, closes: 0, refuseNextStart: false };

const runtime: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.gen(function* () {
      state.starts += 1;
      if (state.refuseNextStart) {
        state.refuseNextStart = false;
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: "OpenCode v2.0.18 is not supported yet.",
        });
      }
      const url = `http://127.0.0.1:${4_300 + state.starts}`;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.closes += 1;
        }),
      );
      return { url, exitCode: Effect.never };
    }),
  connectToOpenCodeServer: () => Effect.die("unused"),
  runOpenCodeCommand: () => Effect.die("unused"),
  createOpenCodeSdkClient: () => Effect.die("unused") as Effect.Effect<OpencodeClient, never>,
  loadOpenCodeInventory: () => Effect.die("unused"),
};

it.layer(Layer.succeed(OpenCodeRuntime, runtime).pipe(Layer.provideMerge(TestClock.layer())))(
  "OpenCodeServerOwner",
  (it) => {
    it.effect("shares leases and closes the process only after its idle timeout", () =>
      Effect.scoped(
        Effect.gen(function* () {
          state.starts = 0;
          state.closes = 0;
          const owner = yield* makeOpenCodeServerOwner({
            binaryPath: "opencode",
            serverPassword: "",
          });
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const first = yield* owner.acquire.pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* owner.acquire.pipe(Effect.provideService(Scope.Scope, secondScope));

          assert.equal(first.url, second.url);
          assert.equal(state.starts, 1);
          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
          yield* TestClock.adjust(Duration.seconds(29));
          assert.equal(state.closes, 0);

          const thirdScope = yield* Scope.make();
          const third = yield* owner.acquire.pipe(Effect.provideService(Scope.Scope, thirdScope));
          assert.equal(third.url, first.url);
          yield* Scope.close(thirdScope, Exit.void);
          yield* TestClock.adjust(Duration.seconds(30));
          yield* Effect.yieldNow;

          assert.equal(state.closes, 1);
        }),
      ),
    );

    it.effect("never caches a refused start, so a fixed binary recovers without a restart", () =>
      Effect.scoped(
        Effect.gen(function* () {
          state.starts = 0;
          state.closes = 0;
          state.refuseNextStart = true;
          const owner = yield* makeOpenCodeServerOwner({
            binaryPath: "opencode",
            serverPassword: "",
          });

          const refused = yield* owner.acquire.pipe(Effect.scoped, Effect.flip);
          assert.ok(refused.detail.includes("not supported yet"));
          assert.equal(state.starts, 1);

          const leaseScope = yield* Scope.make();
          const server = yield* owner.acquire.pipe(Effect.provideService(Scope.Scope, leaseScope));
          assert.equal(state.starts, 2);
          assert.ok(server.url.startsWith("http://127.0.0.1:"));
          yield* Scope.close(leaseScope, Exit.void);
        }),
      ),
    );
  },
);
