import { assert, describe, it } from "@effect/vitest";
import { Data, Effect, Fiber, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  FORGE_PROCESS_LIMIT,
  inBackgroundProcessLane,
  processGovernorStats,
} from "../processGovernor.ts";
import { stallingChildSpawner } from "../testing/eventLoopStall.ts";
import * as VcsProcess from "./VcsProcess.ts";

const encoder = new TextEncoder();

/** A spawner whose child either exits with `exitCode` or runs until killed. */
function stubSpawner(exitCode: number | "never") {
  const kills = { count: 0 };
  const spawns = { count: 0 };
  let running = exitCode === "never";
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        spawns.count += 1;
      }).pipe(
        Effect.as(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode:
              exitCode === "never"
                ? Effect.never
                : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.sync(() => running),
            kill: () =>
              Effect.sync(() => {
                kills.count += 1;
                running = false;
              }),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode("out")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      ),
    ),
  );
  return { kills, spawns, layer: VcsProcess.layer.pipe(Layer.provide(layer)) };
}

const input = {
  operation: "VcsProcess.test",
  command: "git",
  args: ["status"],
  cwd: "/repo",
  allowNonZeroExit: true,
} satisfies VcsProcess.VcsProcessInput;

describe("VcsProcess", () => {
  for (const exitCode of [0, 1]) {
    it.effect(`does not kill a child that already exited with code ${exitCode}`, () => {
      const { kills, layer } = stubSpawner(exitCode);
      return Effect.gen(function* () {
        const output = yield* (yield* VcsProcess.VcsProcess).run(input);
        assert.equal(output.exitCode, exitCode);
        assert.equal(output.stdout, "out");
        assert.equal(kills.count, 0);
      }).pipe(Effect.provide(layer));
    });
  }

  it.live("a server stall does not time out a child that exited during it", () => {
    // The child exits 250 ms in, while the loop is blocked for 600 ms; its exit
    // is read only after the stall, past the 300 ms budget's plain timer.
    const { kills, spawner } = stallingChildSpawner({ exitAfterMs: 250, stallMs: 600 });
    return Effect.gen(function* () {
      const output = yield* (yield* VcsProcess.VcsProcess).run({ ...input, timeoutMs: 300 });
      assert.equal(output.exitCode, 0);
      assert.equal(output.stdout, "out");
      assert.equal(kills.count, 0);
    }).pipe(
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );
  });

  it.live("kills a child that is still running when it times out", () => {
    const { kills, layer } = stubSpawner("never");
    return Effect.gen(function* () {
      const error = yield* (yield* VcsProcess.VcsProcess)
        .run({ ...input, timeoutMs: 10 })
        .pipe(Effect.flip);
      assert.equal(error._tag, "VcsProcessTimeoutError");
      assert.equal(kills.count, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("admits a child after its forge permit, so a refusal there spawns nothing", () => {
    class Paused extends Data.TaggedError("Paused") {}
    const { spawns, layer } = stubSpawner("never");
    const forgeInFlight = () =>
      processGovernorStats().find((stats) => stats.pool === "forge")!.inFlight;
    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const gh = { ...input, command: "gh", args: ["pr", "list"] };
      // Fill the forge pool with children that never exit.
      const holders = yield* Effect.forEach(Array.from({ length: FORGE_PROCESS_LIMIT }), () =>
        process.run(gh).pipe(inBackgroundProcessLane, Effect.forkChild),
      );
      yield* Effect.yieldNow;
      assert.strictEqual(spawns.count, FORGE_PROCESS_LIMIT);

      let paused = false;
      const admit = Effect.suspend(() => (paused ? Effect.fail(new Paused()) : Effect.void));
      const queued = yield* process
        .run({ ...gh, admit })
        .pipe(inBackgroundProcessLane, Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      // The host is paused while the child waits for a permit.
      paused = true;
      yield* Fiber.interrupt(holders[0]!);
      const error = yield* Fiber.join(queued);

      assert.strictEqual(error._tag, "VcsProcessSpawnError");
      assert.instanceOf(error._tag === "VcsProcessSpawnError" ? error.cause : null, Paused);
      assert.strictEqual(spawns.count, FORGE_PROCESS_LIMIT);
      // The refused child gave its permit back.
      assert.strictEqual(forgeInFlight(), FORGE_PROCESS_LIMIT - 1);
      // The pool is process-wide: free it for the other tests.
      yield* Fiber.interruptAll(holders);
      assert.strictEqual(forgeInFlight(), 0);
    }).pipe(Effect.provide(layer));
  });
});
