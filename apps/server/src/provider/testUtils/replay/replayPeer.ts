// Partly adapted from pingdotgg/t3code packages/effect-codex-app-server/src/replay.ts
// (91992bd5d464d6a01b2a5c1e7926e68ad09ea40e). Copyright (c) 2026 T3 Tools Inc. MIT; see
// THIRD_PARTY_NOTICES.md.
/**
 * An in-memory line-JSON peer that plays one provider process from a transcript segment: the
 * client writes newline-delimited JSON to its stdin, and its stdout answers with the recorded
 * inbound frames. It stands in for the process behind a `ChildProcessHandle`, so the real
 * protocol client, session runtime and adapter run unchanged.
 *
 * The replay runs on `runReplayCursor` (`replayDriver.ts`): frames the client writes while the
 * replay is parked at a gate wait their turn, as they would in a real pipe.
 *
 * @module provider/testUtils/replay/replayPeer
 */
import { Cause, Deferred, Effect, Option, Queue, type Scope, Sink, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import { runReplayCursor, type ReplayEmitStep, type ReplayExitStep } from "./replayDriver.ts";
import { openReplayGate, type ReplayGate } from "./replayGate.ts";
import {
  makeReplayCursor,
  ReplayRuntimeExitError,
  ReplayUnexpectedOutboundError,
  type ReplayBindingRules,
  type ReplayError,
  type ReplayFrameNormalizer,
} from "./replayMatch.ts";
import type { ReplayTranscript } from "./replayTranscript.ts";

/** What `kill` makes the exit code: a SIGTERM death, as a shell reports it. */
export const REPLAY_KILLED_EXIT_CODE = 143;

export interface ReplayPeerOptions {
  readonly normalize?: ReplayFrameNormalizer;
  /** Defaults to JSON-RPC ids. */
  readonly bindings?: ReplayBindingRules;
  readonly gate?: ReplayGate;
  /** 1-based process number, for messages. */
  readonly spawn?: number;
  /** Shared with other peers of one replay; the first failure wins. */
  readonly failure?: Deferred.Deferred<ReplayError>;
}

export interface ReplayPeer {
  /** The peer as a process handle, for a `ChildProcessSpawner`. */
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly stdin: Sink.Sink<void, Uint8Array, never, PlatformError>;
  readonly stdout: Stream.Stream<Uint8Array, PlatformError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError>;
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError>;
  readonly kill: () => Effect.Effect<void>;
  /** Completed with the first replay failure; stdout ends with it. */
  readonly failure: Deferred.Deferred<ReplayError>;
  /** Fails with the replay failure, or with the entries the scenario never reached. */
  readonly assertConsumed: Effect.Effect<void, ReplayError>;
  readonly describePosition: () => string;
}

type PeerState = "running" | "exited" | "killed" | "failed";

/**
 * Starts the replay of a transcript without `spawn` entries (`makeReplaySpawner` splits
 * multi-process transcripts). The replay fiber lives in the current scope.
 */
export const makeReplayPeer = (
  transcript: ReplayTranscript,
  options: ReplayPeerOptions = {},
): Effect.Effect<ReplayPeer, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (transcript.entries.some((entry) => entry.type === "spawn")) {
      return yield* Effect.die(
        new Error("makeReplayPeer plays one process; split spawn segments with makeReplaySpawner."),
      );
    }
    const scenario = transcript.header.scenario;
    const spawn = options.spawn ?? 1;
    const gate = options.gate ?? openReplayGate;
    const cursor = makeReplayCursor(transcript.entries, {
      scenario,
      spawn,
      ...(options.normalize ? { normalize: options.normalize } : {}),
      ...(options.bindings ? { bindings: options.bindings } : {}),
    });
    const failure = options.failure ?? (yield* Deferred.make<ReplayError>());
    const stdoutQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const stderrQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const allQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const outbound = yield* Queue.unbounded<unknown>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let state: PeerState = "running";
    let remainder = "";

    /** Ends stdout and stderr the way a dying process closes its pipes. */
    const end = (next: PeerState, code: number) =>
      Effect.gen(function* () {
        if (state !== "running") return;
        state = next;
        yield* Queue.end(stdoutQueue);
        yield* Queue.end(stderrQueue);
        yield* Queue.end(allQueue);
        yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(code));
      });

    const emit = (step: ReplayEmitStep) => {
      const text = step.stream === "stderr" ? String(step.frame) : JSON.stringify(step.frame);
      const bytes = encoder.encode(`${text}\n`);
      return Queue.offer(step.stream === "stderr" ? stderrQueue : stdoutQueue, bytes).pipe(
        Effect.andThen(Queue.offer(allQueue, bytes)),
        Effect.asVoid,
      );
    };

    const finish = (step: ReplayExitStep) =>
      step.status === "success"
        ? end("exited", step.code ?? 0)
        : Effect.fail(
            new ReplayRuntimeExitError({
              scenario,
              spawn,
              cursor: step.cursor,
              status: step.status,
              code: step.code ?? 1,
              ...(step.error !== undefined ? { error: step.error } : {}),
            }),
          );

    const replay = yield* runReplayCursor({
      cursor,
      scenario,
      spawn,
      name: `spawn #${spawn}`,
      gate,
      failure,
      outbound,
      frameOf: (frame) => frame,
      state: () => state,
      deliver: emit,
      finish,
      onFail: (error) => end("failed", error._tag === "ReplayRuntimeExitError" ? error.code : 1),
    });

    const parseLine = (line: string) => {
      try {
        return { frame: JSON.parse(line) as unknown };
      } catch {
        return undefined;
      }
    };

    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        const lines = `${remainder}${decoder.decode(chunk, { stream: true })}`.split("\n");
        remainder = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.replace(/\r$/u, "").trim();
          if (line.length === 0) continue;
          const parsed = parseLine(line);
          if (parsed === undefined) {
            yield* replay.fail(
              new ReplayUnexpectedOutboundError({
                scenario,
                spawn,
                cursor: cursor.position(),
                reason: "not a JSON line",
                actual: line,
              }),
            );
            continue;
          }
          yield* Queue.offer(outbound, parsed.frame);
        }
      }),
    );

    const stdout = Stream.fromQueue(stdoutQueue);
    const stderr = Stream.fromQueue(stderrQueue);
    const exitCode = Deferred.await(exit);
    const kill = () => end("killed", REPLAY_KILLED_EXIT_CODE);

    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(90_000 + spawn),
      exitCode,
      isRunning: Effect.sync(() => state === "running"),
      kill,
      stdin,
      stdout,
      stderr,
      all: Stream.fromQueue(allQueue),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });

    return {
      handle,
      stdin,
      stdout,
      stderr,
      exitCode,
      kill,
      failure,
      assertConsumed: replay.assertConsumed,
      describePosition: replay.describePosition,
    } satisfies ReplayPeer;
  });

/**
 * Runs `effect`, failing with the replay failure as soon as there is one. When `effect` fails
 * while a replay failure exists (the client usually fails because the peer died), the replay
 * failure wins: it names the transcript entry and the differing path.
 */
export const raceReplayFailure =
  (failure: Deferred.Deferred<ReplayError>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ReplayError, R> =>
    Effect.raceFirst(effect, Deferred.await(failure).pipe(Effect.flatMap(Effect.fail))).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Deferred.poll(failure).pipe(
              Effect.flatMap((failed) =>
                Option.isSome(failed)
                  ? Effect.flatMap(failed.value, Effect.fail)
                  : Effect.failCause(cause),
              ),
            ),
      ),
    );
