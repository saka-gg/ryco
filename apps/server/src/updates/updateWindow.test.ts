import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { ProviderInstallLockRuntime } from "../provider/providerInstallLock.ts";
import { ProviderInstallLockError } from "../provider/providerInstallLock.ts";
import { makeClientInteraction } from "./ClientInteraction.ts";
import { makeUpdateWindow } from "./updateWindow.ts";

/**
 * A window over in-memory sources: work, the install locks held on the machine, other processes'
 * busy markers, and real client reports.
 */
const setup = Effect.gen(function* () {
  const interruptible = yield* Ref.make<Effect.Effect<boolean>>(Effect.succeed(false));
  const held = yield* Ref.make<Effect.Effect<ReadonlyArray<string>, ProviderInstallLockError>>(
    Effect.succeed([]),
  );
  const othersBusy = yield* Ref.make<Effect.Effect<boolean, ProviderInstallLockError>>(
    Effect.succeed(false),
  );
  const clientInteraction = yield* makeClientInteraction;
  const heldKeys = Effect.flatten(Ref.get(held));
  const lock = {
    anyHeld: Effect.map(heldKeys, (keys) => keys.length > 0),
    anyHeldExcept: (lockKey: string) =>
      Effect.map(heldKeys, (keys) => keys.some((key) => key !== lockKey)),
    othersBusy: Effect.flatten(Ref.get(othersBusy)),
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
    setHeld: (value: Effect.Effect<ReadonlyArray<string>, ProviderInstallLockError>) =>
      Ref.set(held, value),
    setOthersBusy: (value: Effect.Effect<boolean, ProviderInstallLockError>) =>
      Ref.set(othersBusy, value),
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
      assert.isFalse(yield* window.isOpen({ heldLockKey: "npm-global" }));
    }),
  );

  it.effect("is closed while any install lock is held but the one the caller holds", () =>
    Effect.gen(function* () {
      const { window, setHeld } = yield* setup;
      yield* setHeld(Effect.succeed(["npm-global"]));
      assert.isFalse(yield* window.isOpen());
      assert.isTrue(yield* window.isOpen({ heldLockKey: "npm-global" }));
      // Another Ryco updating Homebrew meanwhile still closes it.
      yield* setHeld(Effect.succeed(["npm-global", "homebrew"]));
      assert.isFalse(yield* window.isOpen({ heldLockKey: "npm-global" }));
    }),
  );

  it.effect("is closed while another Ryco process on this machine has agents working", () =>
    Effect.gen(function* () {
      const { window, setOthersBusy } = yield* setup;
      yield* setOthersBusy(Effect.succeed(true));
      assert.isFalse(yield* window.isOpen());
      assert.isFalse(yield* window.isOpen({ heldLockKey: "npm-global" }));
      yield* setOthersBusy(Effect.succeed(false));
      assert.isTrue(yield* window.isOpen());
    }),
  );

  it.effect("is closed when anything cannot be read", () =>
    Effect.gen(function* () {
      const { window, setHeld, setInterruptible, setOthersBusy } = yield* setup;
      const unreadable = new ProviderInstallLockError({ message: "unreadable folder" });
      yield* setHeld(Effect.fail(unreadable));
      assert.isFalse(yield* window.isOpen());
      yield* setHeld(Effect.succeed([]));
      yield* setOthersBusy(Effect.fail(unreadable));
      assert.isFalse(yield* window.isOpen());
      yield* setOthersBusy(Effect.succeed(false));
      yield* setInterruptible(Effect.die(new Error("model unavailable")));
      assert.isFalse(yield* window.isOpen());
    }),
  );
});
