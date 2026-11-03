/**
 * Replay proof: the REAL CodexSessionRuntime and app-server client against a transcript played by
 * the replay spawner, with no process and no provider home involved. The inbound frames come
 * from the codex-cli 0.145.0 capture (codexMultiAgentWire.json) plus agent message frames built
 * from the generated protocol schema; the client validates every one of them, and a
 * notification it cannot decode fails the test instead of being dropped quietly.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Effect, Fiber, FileSystem, Layer, Logger, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { assert, describe } from "vite-plus/test";

import { normalizeCodexOutbound } from "../testUtils/replay/replayMatch.ts";
import { raceReplayFailure } from "../testUtils/replay/replayPeer.ts";
import { makeReplaySpawner, matchReplayCommand } from "../testUtils/replay/replaySpawner.ts";
import { materializeWorkspace, readReplayFixture } from "../testUtils/replay/replayTranscript.ts";
import { assertTripwireUntouched, writeTripwireBinary } from "../testUtils/replay/tripwire.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const FIXTURE = new URL(
  "../../../integration/replay/fixtures/codex/runtime-simple.ndjson",
  import.meta.url,
);

/** Client log lines that mean a replayed frame was dropped instead of handled. */
const DROPPED_FRAME_LOGS = [
  "Codex notification could not be processed",
  "Ignoring non-protocol Codex stdout message",
  "Ignoring malformed Codex stdout line",
];

describe.skipIf(process.platform === "win32")("CodexSessionRuntime replay", () => {
  // it.live: the runtime's startup deadlines and the replay fiber run on the live clock.
  it.live("streams a replayed turn through the real runtime to turn/completed", () => {
    const droppedFrames: Array<string> = [];
    const captureLogs = Logger.layer([
      Logger.make(({ message }) => {
        const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
        if (DROPPED_FRAME_LOGS.some((line) => text.includes(line))) droppedFrames.push(text);
      }),
    ]);
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-codex-replay-" });
      const workspace = path.join(rootDir, "workspace");
      const homePath = path.join(rootDir, "provider-home", "codex");
      const binDir = path.join(rootDir, "bin");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      yield* fileSystem.makeDirectory(homePath, { recursive: true });
      const binaryPath = yield* writeTripwireBinary(binDir, "codex");

      const transcript = materializeWorkspace(yield* readReplayFixture(FIXTURE), { workspace });
      const replay = yield* makeReplaySpawner({
        transcript,
        match: matchReplayCommand(binaryPath, ["app-server"]),
        normalize: normalizeCodexOutbound,
      });

      // The runtime closes the scope it is given, so it gets one of its own.
      const scenario = Effect.gen(function* () {
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-codex-replay"),
          runtimeSessionId: RuntimeSessionId.make("runtime-codex-replay"),
          binaryPath,
          homePath,
          environment: { HOME: rootDir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          cwd: workspace,
          runtimeMode: "full-access",
          tokenMode: "balanced",
          // Never rely on the collab reconcile timer firing.
          collabReconcileInterval: "1 hour",
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, replay.spawner));

        const eventsFiber = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.method === "turn/completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const session = yield* runtime.start();
        assert.equal(session.status, "ready");
        assert.deepEqual(session.resumeCursor, {
          threadId: "019fcfd6-17bb-72f0-ae12-a1f2dee6e3e5",
        });

        const turn = yield* runtime.sendTurn({ input: "Say hello." });
        assert.equal(turn.turnId, "019fcfd6-1806-7de1-8564-de69fd55bffb");

        const events = Array.from(yield* Fiber.join(eventsFiber));
        yield* runtime.close;
        return events;
      }).pipe(Effect.scoped);

      const events = yield* scenario.pipe(raceReplayFailure(replay.failure));
      assert.deepEqual(droppedFrames, [], "the client dropped replayed frames");
      const methods = events.map((event) => event.method);
      assert.includeMembers(methods, [
        "session/ready",
        "turn/started",
        "item/started",
        "item/agentMessage/delta",
        "item/completed",
        "turn/completed",
      ]);
      const deltas = events
        .filter((event) => event.method === "item/agentMessage/delta")
        .map((event) => (event.payload as { readonly delta?: string }).delta);
      assert.deepEqual(deltas, ["Hello", " from replay."]);
      const completed = events.find((event) => event.method === "turn/completed")?.payload as
        | { readonly turn?: { readonly status?: string } }
        | undefined;
      assert.equal(completed?.turn?.status, "completed");

      yield* replay.assertConsumed;
      assert.deepEqual(replay.unexpected, []);
      assert.equal(replay.spawned.length, 1);
      yield* assertTripwireUntouched(binDir);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(captureLogs, NodeServices.layer)));
  });
});
