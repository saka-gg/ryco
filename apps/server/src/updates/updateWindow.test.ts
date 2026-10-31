import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { ProviderInstallLockRuntime } from "../provider/providerInstallLock.ts";
import { ProviderInstallLockError } from "../provider/providerInstallLock.ts";
import { makeClientInteraction } from "./ClientInteraction.ts";
import { makeUpdateWindow } from "./updateWindow.ts";

/** A window over in-memory sources: work, installs held elsewhere, and real client reports. */
const setup = Effect.gen(function* () {
  const interruptible = yield* Ref.make<Effect.Effect<boolean>>(Effect.succeed(false));
  const held = yield* Ref.make<Effect.Effect<boolean, ProviderInstallLockError>>(
    Effect.succeed(false),
  );
  const clientInteraction = yield* makeClientInteraction;
  const lock = {
    anyHeld: Effect.flatten(Ref.get(held)),
  } as unknown as ProviderInstallLockRuntime;
  const window = makeUpdateWindow({
    agentWork: { interruptible: Effect.flatten(Ref.get(interruptible)) },
    clientInteraction,
    installLock: { lock: Effect.succeed(lock) },
  });
  // Quiet since the server started.
  yield* TestClock.adjust("10 minutes");
  return {
    window,
    note: clientInteraction.note("session"),
    setInterruptible: (value: Effect.Effect<boolean>) => Ref.set(interruptible, value),
    setHeld: (value: Effect.Effect<boolean, ProviderInstallLockError>) => Ref.set(held, value),
  };
});

describe("updateWindow", () => {
  it.effect("is open when nobody uses a client, nothing runs and no install is held", () =>
    Effect.gen(function* () {
      const { window } = yield* setup;
      assert.isTrue(yield* window.isOpen());
      assert.deepStrictEqual(yield* window.runIfOpen(Effect.succeed("ran")), Option.some("ran"));
    }),
  );

  it.effect("stays closed for 2 minutes after a client reports input", () =>
    Effect.gen(function* () {
      const { window, note } = yield* setup;
      yield* note;
      yield* TestClock.adjust("119 seconds");
      assert.isFalse(yield* window.isOpen());
      assert.deepStrictEqual(yield* window.runIfOpen(Effect.succeed("ran")), Option.none());
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* window.isOpen());
    }),
  );

  it.effect("is closed while an update would interrupt agent work", () =>
    Effect.gen(function* () {
      const { window, setInterruptible } = yield* setup;
      // Working, stopped under 2 minutes ago, a starting session, or a pending approval or
      // question: `AgentWorkActivity.interruptible`.
      yield* setInterruptible(Effect.succeed(true));
      assert.isFalse(yield* window.isOpen());
      assert.isFalse(yield* window.isOpen({ ignoreInstallLocks: true }));
    }),
  );

  it.effect("is closed while any install lock is held, unless the caller holds it", () =>
    Effect.gen(function* () {
      const { window, setHeld } = yield* setup;
      yield* setHeld(Effect.succeed(true));
      assert.isFalse(yield* window.isOpen());
      assert.isTrue(yield* window.isOpen({ ignoreInstallLocks: true }));
    }),
  );

  it.effect("is closed when anything cannot be read", () =>
    Effect.gen(function* () {
      const { window, setHeld, setInterruptible } = yield* setup;
      yield* setHeld(Effect.fail(new ProviderInstallLockError({ message: "unreadable folder" })));
      assert.isFalse(yield* window.isOpen());
      yield* setHeld(Effect.succeed(false));
      yield* setInterruptible(Effect.die(new Error("model unavailable")));
      assert.isFalse(yield* window.isOpen());
    }),
  );
});
