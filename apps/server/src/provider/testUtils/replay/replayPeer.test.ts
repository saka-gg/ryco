import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";

import { makeReplayGate } from "./replayGate.ts";
import {
  makeReplayPeer,
  raceReplayFailure,
  REPLAY_KILLED_EXIT_CODE,
  type ReplayPeer,
} from "./replayPeer.ts";
import type { ReplayError } from "./replayMatch.ts";
import type { ReplayEntry, ReplayTranscript } from "./replayTranscript.ts";

const transcriptOf = (entries: ReadonlyArray<ReplayEntry>): ReplayTranscript => ({
  header: {
    type: "transcript_start",
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.0.0",
    scenario: "peer-unit",
    source: "hand-authored",
  },
  entries,
});

const encoder = new TextEncoder();

const write = (peer: ReplayPeer, ...chunks: Array<string>) =>
  Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))).pipe(Stream.run(peer.stdin));

/** Collects a byte stream's lines as they arrive. */
const lines = (stream: ReplayPeer["stdout"]) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<string>();
    const done = yield* stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Queue.offer(received, line)),
      Effect.forkScoped,
    );
    return {
      next: Queue.take(received).pipe(Effect.map((line) => JSON.parse(line) as unknown)),
      nextText: Queue.take(received),
      ended: Fiber.join(done),
    };
  });

describe("replay peer", () => {
  it.effect("reassembles a frame split mid-line and answers with the client's id", () =>
    Effect.gen(function* () {
      const peer = yield* makeReplayPeer(
        transcriptOf([
          { type: "expect_outbound", frame: { id: 7, method: "initialize" } },
          { type: "emit_inbound", frame: { id: 7, result: { ok: true } } },
        ]),
      );
      const stdout = yield* lines(peer.stdout);
      yield* write(peer, '{"id":3,"meth', 'od":"initia', 'lize"}\n');
      assert.deepEqual(yield* stdout.next, { id: 3, result: { ok: true } });
      yield* peer.assertConsumed;
      assert.isTrue(yield* peer.handle.isRunning);
    }).pipe(Effect.scoped),
  );

  it.effect("ends with a non-zero exit and a failure on a recorded runtime error", () =>
    Effect.gen(function* () {
      const peer = yield* makeReplayPeer(
        transcriptOf([
          { type: "emit_inbound", frame: { method: "configWarning" } },
          { type: "runtime_exit", status: "error", code: 2, error: { message: "crashed" } },
        ]),
      );
      const stdout = yield* lines(peer.stdout);
      assert.deepEqual(yield* stdout.next, { method: "configWarning" });
      yield* stdout.ended;
      assert.equal(yield* peer.exitCode, 2);
      const failure = yield* Deferred.await(peer.failure);
      assert.equal(failure._tag, "ReplayRuntimeExitError");
      assert.equal((yield* Effect.flip(peer.assertConsumed))._tag, "ReplayRuntimeExitError");
    }).pipe(Effect.scoped),
  );

  it.effect("ends stdout with the recorded code on a successful exit", () =>
    Effect.gen(function* () {
      const peer = yield* makeReplayPeer(
        transcriptOf([
          { type: "emit_inbound", stream: "stderr", frame: "warming up" },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const stderr = yield* lines(peer.stderr);
      assert.equal(yield* stderr.nextText, "warming up");
      yield* stderr.ended;
      assert.equal(yield* peer.exitCode, 0);
      assert.isFalse(yield* peer.handle.isRunning);
      assert.isTrue(Option.isNone(yield* Deferred.poll(peer.failure)));
      yield* peer.assertConsumed;
    }).pipe(Effect.scoped),
  );

  it.effect("reports what a killed replay never reached", () =>
    Effect.gen(function* () {
      const peer = yield* makeReplayPeer(
        transcriptOf([
          { type: "expect_outbound", frame: { id: 1, method: "initialize" } },
          { type: "emit_inbound", frame: { id: 1, result: {} } },
          {
            type: "expect_outbound",
            label: "thread/start",
            frame: { id: 2, method: "thread/start" },
          },
          { type: "emit_inbound", label: "thread-ready", frame: { id: 2, result: {} } },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const stdout = yield* lines(peer.stdout);
      yield* write(peer, '{"id":1,"method":"initialize"}\n');
      yield* stdout.next;
      yield* peer.kill();
      yield* stdout.ended;
      assert.equal(yield* peer.exitCode, REPLAY_KILLED_EXIT_CODE);
      const incomplete = yield* Effect.flip(peer.assertConsumed);
      assert.equal(incomplete._tag, "ReplayIncompleteError");
      assert.deepEqual(incomplete._tag === "ReplayIncompleteError" && incomplete.remainingLabels, [
        "thread/start",
        "thread-ready",
      ]);
      assert.include(peer.describePosition(), "killed");
    }).pipe(Effect.scoped),
  );

  it.effect("fails fast on a mismatch: stdout ends and the failure carries the diff", () =>
    Effect.gen(function* () {
      const peer = yield* makeReplayPeer(
        transcriptOf([
          { type: "expect_outbound", label: "init", frame: { id: 1, method: "initialize" } },
          { type: "emit_inbound", frame: { id: 1, result: {} } },
        ]),
      );
      const stdout = yield* lines(peer.stdout);
      yield* write(peer, '{"id":1,"method":"shutdown"}\n');
      yield* stdout.ended;
      assert.equal(yield* peer.exitCode, 1);
      const failure = yield* Deferred.await(peer.failure);
      assert.equal(failure._tag, "ReplayFrameMismatchError");
      assert.equal(failure._tag === "ReplayFrameMismatchError" && failure.diffPath, "$.method");

      // A caller that failed because the peer died reports the replay failure instead.
      const reported = yield* Effect.flip(
        Effect.fail("transport closed").pipe(raceReplayFailure(peer.failure)),
      );
      assert.equal(typeof reported === "object" && reported._tag, "ReplayFrameMismatchError");
    }).pipe(Effect.scoped),
  );

  it.effect("matches frames written as the process scope closes, then reports the rest", () =>
    Effect.gen(function* () {
      const failure = yield* Deferred.make<ReplayError>();
      yield* Effect.gen(function* () {
        const peer = yield* makeReplayPeer(
          transcriptOf([
            {
              type: "expect_outbound",
              optional: true,
              frame: { id: 1, method: "thread/unsubscribe" },
            },
          ]),
          { failure },
        );
        // The scope closes before the replay fiber is scheduled to take these.
        yield* write(
          peer,
          '{"id":4,"method":"thread/unsubscribe"}\n{"id":0,"result":{"decision":"cancel"}}\n',
        );
      }).pipe(Effect.scoped);

      const late = yield* Deferred.poll(failure);
      assert.isTrue(Option.isSome(late));
      if (Option.isNone(late)) return;
      const error = yield* late.value;
      // The optional entry matched the first frame; the second has nothing left.
      assert.equal(error._tag, "ReplayExhaustedError");
      assert.deepEqual(error._tag === "ReplayExhaustedError" && error.actual, {
        id: 0,
        result: { decision: "cancel" },
      });
    }),
  );

  it.effect("rejects an outbound line that is not JSON", () =>
    Effect.gen(function* () {
      const peer = yield* makeReplayPeer(
        transcriptOf([{ type: "expect_outbound", frame: { id: 1, method: "initialize" } }]),
      );
      yield* write(peer, "Content-Length: 12\n");
      const failure = yield* Deferred.await(peer.failure);
      assert.equal(failure._tag, "ReplayUnexpectedOutboundError");
      assert.include(failure.message, "not a JSON line");
    }).pipe(Effect.scoped),
  );

  it.effect("parks at a gate and queues frames the client writes meanwhile", () =>
    Effect.gen(function* () {
      const gate = yield* makeReplayGate(["delta-2"]);
      const peer = yield* makeReplayPeer(
        transcriptOf([
          { type: "expect_outbound", frame: { id: 1, method: "turn/start" } },
          { type: "emit_inbound", label: "delta-1", frame: { method: "delta", params: 1 } },
          { type: "emit_inbound", label: "delta-2", frame: { method: "delta", params: 2 } },
          { type: "expect_outbound", frame: { id: 2, method: "turn/interrupt" } },
          { type: "emit_inbound", frame: { id: 2, result: {} } },
        ]),
        { gate },
      );
      const stdout = yield* lines(peer.stdout);
      yield* write(peer, '{"id":1,"method":"turn/start"}\n');
      assert.deepEqual(yield* stdout.next, { method: "delta", params: 1 });
      yield* gate.reached("delta-2");
      assert.include(peer.describePosition(), "parked at gate 'delta-2'");

      yield* write(peer, '{"id":5,"method":"turn/interrupt"}\n');
      yield* gate.release("delta-2");
      assert.deepEqual(yield* stdout.next, { method: "delta", params: 2 });
      assert.deepEqual(yield* stdout.next, { id: 5, result: {} });
      yield* peer.assertConsumed;
    }).pipe(Effect.scoped),
  );
});
