import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Effect, Queue, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const posix = process.platform !== "win32";

// The browser's commands go in on fd 3, the way `launchBrowser` sends them.
// Closing the scope stops the writer before it stops the browser, and on
// Linux a child killed with commands still unread resets that pipe. The
// patched spawner keeps that late reset from becoming an uncaught exception,
// which Vitest reports as an unhandled error.
describe("the browser's command pipe", () => {
  it.live.skipIf(!posix)("outlives a browser stopped with commands unread", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const outgoing = yield* Queue.unbounded<Uint8Array>();
      yield* Effect.gen(function* () {
        yield* spawner.spawn(
          ChildProcess.make("/bin/sh", ["-c", "exec sleep 30"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            additionalFds: { fd3: { type: "input", stream: Stream.fromQueue(outgoing) } },
          }),
        );
        yield* Queue.offer(outgoing, new Uint8Array(16 * 1024).fill(0x7b));
        // Let the write reach the child's unread buffer before the scope closes.
        yield* Effect.sleep("100 millis");
      }).pipe(Effect.scoped);
      // The reset lands after the scope closed; wait for it inside the test.
      yield* Effect.sleep("300 millis");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
