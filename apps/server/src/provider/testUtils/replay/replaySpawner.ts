/**
 * A `ChildProcessSpawner` that answers provider launches with replay peers: spawn #n plays the
 * transcript segment before the n-th `spawn` entry, and anything else fails at spawn. Provided
 * where an adapter or session runtime captures its spawner, it replaces only the transport.
 *
 * @module provider/testUtils/replay/replaySpawner
 */
import { Deferred, Effect, Option } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeReplayPeer, type ReplayPeer } from "./replayPeer.ts";
import type { ReplayGate } from "./replayGate.ts";
import {
  ReplayIncompleteError,
  ReplayUnexpectedSpawnError,
  type ReplayBindingRules,
  type ReplayError,
  type ReplayFrameNormalizer,
} from "./replayMatch.ts";
import type { ReplayTranscript } from "./replayTranscript.ts";

/** One transcript per process: the entries between `spawn` entries (which are dropped). */
export function splitReplaySegments(transcript: ReplayTranscript): ReadonlyArray<ReplayTranscript> {
  const segments: Array<ReplayTranscript> = [];
  let entries: Array<ReplayTranscript["entries"][number]> = [];
  for (const entry of transcript.entries) {
    if (entry.type === "spawn") {
      segments.push({ header: transcript.header, entries });
      entries = [];
      continue;
    }
    entries.push(entry);
  }
  segments.push({ header: transcript.header, entries });
  // A leading `spawn` marks the first process explicitly; it starts no extra segment.
  return transcript.entries[0]?.type === "spawn" ? segments.slice(1) : segments;
}

const basename = (command: string) => command.slice(command.lastIndexOf("/") + 1);

/**
 * Matches `binaryPath ...args`, directly or behind `nice -n <n>` (`spawnAgentProcess`'s
 * exec-nice launch).
 */
export function matchReplayCommand(
  binaryPath: string,
  args: ReadonlyArray<string>,
): (command: ChildProcess.StandardCommand) => boolean {
  const tail = [binaryPath, ...args];
  return (command) => {
    if (command.command === binaryPath) {
      return command.args.length === args.length && args.every((arg, i) => command.args[i] === arg);
    }
    if (basename(command.command) !== "nice" || command.args.length < tail.length) return false;
    const offset = command.args.length - tail.length;
    return tail.every((arg, i) => command.args[offset + i] === arg);
  };
}

export interface ReplaySpawnerOptions {
  readonly transcript: ReplayTranscript;
  /** Which launches replay; usually `matchReplayCommand(tripwirePath, ["app-server"])`. */
  readonly match: (command: ChildProcess.StandardCommand) => boolean;
  readonly normalize?: ReplayFrameNormalizer;
  readonly bindings?: ReplayBindingRules;
  readonly gate?: ReplayGate;
  /** Spawns every launch `match` rejects; without it they fail and count as unexpected. */
  readonly fallthrough?: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

export interface ReplaySpawner {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Launches that got a replay peer, in order. */
  readonly spawned: Array<ChildProcess.StandardCommand>;
  /** Launches that failed: unmatched without a fallthrough, or beyond the last segment. */
  readonly unexpected: Array<ChildProcess.Command>;
  readonly peers: ReadonlyArray<ReplayPeer>;
  /** Completed with the first failure of any peer or launch. */
  readonly failure: Deferred.Deferred<ReplayError>;
  /** Fails with that failure, or when any segment was not fully played or never spawned. */
  readonly assertConsumed: Effect.Effect<void, ReplayError>;
  readonly describePosition: () => string;
}

const describeCommand = (command: ChildProcess.Command) =>
  ChildProcess.isStandardCommand(command)
    ? [command.command, ...command.args].join(" ")
    : "<piped command>";

export const makeReplaySpawner = (options: ReplaySpawnerOptions): Effect.Effect<ReplaySpawner> =>
  Effect.gen(function* () {
    const scenario = options.transcript.header.scenario;
    const segments = splitReplaySegments(options.transcript);
    const failure = yield* Deferred.make<ReplayError>();
    const spawned: Array<ChildProcess.StandardCommand> = [];
    const unexpected: Array<ChildProcess.Command> = [];
    const peers: Array<ReplayPeer> = [];

    const refuse = (command: ChildProcess.Command, spawnNumber: number) =>
      Effect.gen(function* () {
        unexpected.push(command);
        yield* Deferred.succeed(
          failure,
          new ReplayUnexpectedSpawnError({
            scenario,
            spawn: spawnNumber,
            command: describeCommand(command),
          }),
        );
        return yield* Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `replay: no transcript for spawn #${spawnNumber}`,
          }),
        );
      });

    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const matched = ChildProcess.isStandardCommand(command) && options.match(command);
        if (!matched) {
          return options.fallthrough
            ? yield* options.fallthrough.spawn(command)
            : yield* refuse(command, spawned.length + 1);
        }
        const spawnNumber = spawned.length + 1;
        const segment = segments[spawnNumber - 1];
        if (segment === undefined) return yield* refuse(command, spawnNumber);
        spawned.push(command);
        const peer = yield* makeReplayPeer(segment, {
          spawn: spawnNumber,
          failure,
          ...(options.normalize ? { normalize: options.normalize } : {}),
          ...(options.bindings ? { bindings: options.bindings } : {}),
          ...(options.gate ? { gate: options.gate } : {}),
        });
        peers.push(peer);
        // Like a real spawner, a closed spawn scope ends the process.
        yield* Effect.addFinalizer(() => peer.kill());
        return peer.handle;
      }),
    );

    const assertConsumed = Effect.gen(function* () {
      const failed = yield* Deferred.poll(failure);
      if (Option.isSome(failed)) return yield* Effect.flatMap(failed.value, Effect.fail);
      for (const peer of peers) yield* peer.assertConsumed;
      if (spawned.length < segments.length) {
        return yield* new ReplayIncompleteError({
          scenario,
          spawn: spawned.length + 1,
          cursor: 0,
          remainingLabels: segments
            .slice(spawned.length)
            .map((_, index) => `spawn #${spawned.length + index + 1}`),
        });
      }
    });

    const describePosition = () =>
      peers.length === 0
        ? `replay '${scenario}': no process spawned yet (${segments.length} expected)`
        : peers.map((peer) => peer.describePosition()).join("; ");

    return {
      spawner,
      spawned,
      unexpected,
      peers,
      failure,
      assertConsumed,
      describePosition,
    } satisfies ReplaySpawner;
  });
