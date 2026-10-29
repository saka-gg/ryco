import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeReplaySpawner, matchReplayCommand, splitReplaySegments } from "./replaySpawner.ts";
import type { ReplayEntry, ReplayTranscript } from "./replayTranscript.ts";
import { assertTripwireUntouched, TRIPWIRE_EXIT_CODE, writeTripwireBinary } from "./tripwire.ts";

const BINARY = "/replay/bin/codex";

const transcriptOf = (entries: ReadonlyArray<ReplayEntry>): ReplayTranscript => ({
  header: {
    type: "transcript_start",
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.0.0",
    scenario: "spawner-unit",
    source: "hand-authored",
  },
  entries,
});

const banner = (text: string): ReplayEntry => ({
  type: "emit_inbound",
  frame: { method: "banner", params: { text } },
});

const firstLine = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.take(1),
    Stream.runCollect,
    Effect.map((collected) => JSON.parse(collected[0]!) as unknown),
  );

describe("replay spawner", () => {
  it("splits a transcript into one segment per process", () => {
    const segments = splitReplaySegments(
      transcriptOf([
        { type: "spawn", label: "first" },
        banner("one"),
        { type: "spawn", label: "restart" },
        banner("two"),
      ]),
    );
    assert.deepEqual(
      segments.map((segment) => segment.entries),
      [[banner("one")], [banner("two")]],
    );
    assert.equal(splitReplaySegments(transcriptOf([banner("only")])).length, 1);
  });

  it("matches the binary directly and behind nice", () => {
    const match = matchReplayCommand(BINARY, ["app-server"]);
    assert.isTrue(match(ChildProcess.make(BINARY, ["app-server"])));
    assert.isTrue(match(ChildProcess.make("/usr/bin/nice", ["-n", "5", BINARY, "app-server"])));
    assert.isFalse(match(ChildProcess.make(BINARY, ["--version"])));
    assert.isFalse(match(ChildProcess.make("/usr/bin/nice", ["-n", "5", "codex", "app-server"])));
    assert.isFalse(match(ChildProcess.make("/usr/bin/env", [BINARY, "app-server"])));
  });

  it.effect("plays one segment per spawn and refuses a spawn beyond them", () =>
    Effect.gen(function* () {
      const replay = yield* makeReplaySpawner({
        transcript: transcriptOf([banner("one")]),
        match: matchReplayCommand(BINARY, ["app-server"]),
      });
      const first = yield* replay.spawner.spawn(
        ChildProcess.make("/usr/bin/nice", ["-n", "5", BINARY, "app-server"]),
      );
      assert.deepEqual(yield* firstLine(first), { method: "banner", params: { text: "one" } });

      const second = yield* Effect.flip(
        replay.spawner.spawn(ChildProcess.make(BINARY, ["app-server"])),
      );
      assert.equal(second._tag, "PlatformError");
      assert.include(second.message, "replay: no transcript for spawn #2");
      assert.equal(replay.spawned.length, 1);
      assert.equal(replay.unexpected.length, 1);
      const failure = yield* Deferred.await(replay.failure);
      assert.equal(failure._tag, "ReplayUnexpectedSpawnError");
      assert.equal((yield* Effect.flip(replay.assertConsumed))._tag, "ReplayUnexpectedSpawnError");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses unmatched launches unless a fallthrough spawner takes them", () =>
    Effect.gen(function* () {
      const refused = yield* makeReplaySpawner({
        transcript: transcriptOf([]),
        match: matchReplayCommand(BINARY, ["app-server"]),
      });
      yield* Effect.flip(refused.spawner.spawn(ChildProcess.make("git", ["status"])));
      assert.equal(refused.unexpected.length, 1);
      assert.equal(refused.spawned.length, 0);

      const fallthroughCommands: Array<ChildProcess.Command> = [];
      const fallthrough = ChildProcessSpawner.make((command) => {
        fallthroughCommands.push(command);
        return Effect.die(new Error("fallthrough reached"));
      });
      const passed = yield* makeReplaySpawner({
        transcript: transcriptOf([]),
        match: matchReplayCommand(BINARY, ["app-server"]),
        fallthrough,
      });
      yield* Effect.exit(passed.spawner.spawn(ChildProcess.make("git", ["status"])));
      assert.equal(fallthroughCommands.length, 1);
      assert.equal(passed.unexpected.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reports segments that were never spawned", () =>
    Effect.gen(function* () {
      const replay = yield* makeReplaySpawner({
        transcript: transcriptOf([banner("one"), { type: "spawn" }, banner("two")]),
        match: matchReplayCommand(BINARY, ["app-server"]),
      });
      const first = yield* replay.spawner.spawn(ChildProcess.make(BINARY, ["app-server"]));
      yield* firstLine(first);
      const incomplete = yield* Effect.flip(replay.assertConsumed);
      assert.equal(incomplete._tag, "ReplayIncompleteError");
      assert.deepEqual(incomplete._tag === "ReplayIncompleteError" && incomplete.remainingLabels, [
        "spawn #2",
      ]);
      assert.include(replay.describePosition(), "spawn #1");
    }).pipe(Effect.scoped),
  );
});

describe.skipIf(process.platform === "win32")("replay tripwire", () => {
  it.effect("records a launch that bypassed the replay", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-tripwire-" }),
        "bin",
      );
      const binaryPath = yield* writeTripwireBinary(directory, "codex");
      yield* assertTripwireUntouched(directory);

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const exitCode = yield* spawner.exitCode(
        ChildProcess.make(binaryPath, ["app-server", "--listen", "stdio://"]),
      );
      assert.equal(exitCode, TRIPWIRE_EXIT_CODE);
      const touched = yield* Effect.flip(assertTripwireUntouched(directory));
      assert.equal(touched._tag, "ReplayTripwireTouchedError");
      assert.deepEqual(touched._tag === "ReplayTripwireTouchedError" && touched.invocations, [
        "codex app-server --listen stdio://",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
