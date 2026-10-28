import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { stallingChildSpawner } from "../testing/eventLoopStall.ts";
import * as VcsProcess from "./VcsProcess.ts";

const encoder = new TextEncoder();

/** A spawner whose child either exits with `exitCode` or runs until killed. */
function stubSpawner(exitCode: number | "never") {
  const kills = { count: 0 };
  let running = exitCode === "never";
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
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
  );
  return { kills, layer: VcsProcess.layer.pipe(Layer.provide(layer)) };
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
});
