import { LogOnceEveryLimiter } from "@ryco/shared/logOnceEvery";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Logger } from "effect";
import { TestClock } from "effect/testing";

import { briefCause, ignoreCauseLogOnceEvery, makeLogOnceEvery } from "./logOnceEvery.ts";

interface CapturedLine {
  readonly level: string;
  readonly message: ReadonlyArray<unknown>;
  readonly cause: Cause.Cause<unknown>;
}

const capture = () => {
  const lines: Array<CapturedLine> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      lines.push({
        level: options.logLevel,
        message: Array.isArray(options.message) ? options.message : [options.message],
        cause: options.cause,
      });
    }),
  ]);
  return { lines, layer };
};

describe("logOnceEvery", () => {
  it.effect("logs the cause once, then one summary per window while failures repeat", () => {
    const { lines, layer } = capture();
    const logOnceEvery = makeLogOnceEvery(new LogOnceEveryLimiter());
    const failure = Cause.fail(new Error("gh: not logged in\nrun gh auth login"));
    const occur = logOnceEvery({
      key: "vcs.remoteStatusRefresh:/repo",
      message: "VCS remote status refresh failed",
      window: "1 minute",
      fields: { cwd: "/repo" },
      cause: failure,
    });
    return Effect.gen(function* () {
      yield* occur;
      for (let index = 0; index < 5; index += 1) {
        yield* TestClock.adjust("10 seconds");
        yield* occur;
      }
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.level, "Warn");
      assert.deepEqual(lines[0]?.message, ["VCS remote status refresh failed", { cwd: "/repo" }]);
      assert.isTrue(Cause.hasFails(lines[0]!.cause));

      yield* TestClock.adjust("15 seconds");
      yield* occur;
      assert.equal(lines.length, 2);
      const [summaryMessage, summaryFields] = lines[1]!.message as [string, object];
      assert.match(summaryMessage, /^VCS remote status refresh failed \(repeated 6 times since /);
      assert.deepEqual(summaryFields, {
        cwd: "/repo",
        repeated: 6,
        lastCause: "Error: gh: not logged in",
      });
      assert.isFalse(Cause.hasFails(lines[1]!.cause));
    }).pipe(Effect.provide(layer));
  });

  it.effect("logs a new burst in full after a quiet window", () => {
    const { lines, layer } = capture();
    const logOnceEvery = makeLogOnceEvery(new LogOnceEveryLimiter());
    const occur = logOnceEvery({
      key: "sourceControl.discoverPullRequest:/repo",
      message: "Failed to discover the checkout's pull request",
      level: "Info",
      window: "1 minute",
      cause: new Error("network down"),
    });
    return Effect.gen(function* () {
      yield* occur;
      yield* TestClock.adjust("1 second");
      yield* occur;
      yield* TestClock.adjust("1 hour");
      yield* occur;
      assert.equal(lines.length, 2);
      assert.equal(lines[1]?.level, "Info");
      assert.deepEqual(lines[1]?.message[1], {
        earlierRepeats: 1,
        cause: new Error("network down"),
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignoreCauseLogOnceEvery ignores failures and logs them once per key", () => {
    const { lines, layer } = capture();
    const key = `sourceControl.refresh:test-${crypto.randomUUID()}`;
    const refresh = Effect.fail(new Error("detectProvider failed")).pipe(
      ignoreCauseLogOnceEvery({ key, message: "Source control refresh failed" }),
    );
    return Effect.gen(function* () {
      yield* refresh;
      yield* refresh;
      yield* Effect.interrupt.pipe(
        ignoreCauseLogOnceEvery({ key: `${key}:interrupt`, message: "interrupted" }),
      );
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.level, "Info");
      assert.deepEqual(lines[0]?.message, ["Source control refresh failed"]);
      assert.isTrue(Cause.hasFails(lines[0]!.cause));
    }).pipe(Effect.provide(layer));
  });

  it("briefCause keeps the first line of a failure, bounded", () => {
    assert.equal(briefCause(Cause.fail(new TypeError("bad\nstack"))), "TypeError: bad");
    assert.equal(briefCause("plain detail"), "plain detail");
    assert.equal(briefCause("x".repeat(500)).length, 241);
  });
});
