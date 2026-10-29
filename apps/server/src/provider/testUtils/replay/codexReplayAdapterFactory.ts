/**
 * The real Codex adapter over a replayed `codex app-server`, for the orchestration integration
 * harness (`adapterFactories`). Only the transport is replayed: the app-server client, session
 * runtime, adapter, ProviderService, ingestion and projections all run for real.
 *
 * The provider binary is a tripwire and the provider home a directory under the harness root, so
 * nothing reaches a real Codex CLI or `~/.codex`.
 *
 * One factory plays one transcript across every harness it builds an adapter for: a restart
 * scenario (a second harness on the same database) hands the same factory to both harnesses, and
 * the second process plays the second transcript segment.
 *
 * @module provider/testUtils/replay/codexReplayAdapterFactory
 */
import { CodexSettings, ProviderDriverKind } from "@ryco/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcessSpawner, type ChildProcess } from "effect/process";

import type { IntegrationAdapterFactory } from "../../../../integration/OrchestrationEngineHarness.integration.ts";
import { makeCodexAdapter } from "../../Layers/CodexAdapter.ts";
import type { ReplayGate } from "./replayGate.ts";
import { normalizeCodexOutbound } from "./replayMatch.ts";
import { makeReplaySpawner, matchReplayCommand, type ReplaySpawner } from "./replaySpawner.ts";
import { materializeWorkspace, type ReplayTranscript } from "./replayTranscript.ts";
import { assertTripwireUntouched, writeTripwireBinary } from "./tripwire.ts";

export interface CodexReplayAdapterFactoryOptions {
  /** Unmaterialized: `<workspace>` becomes the first harness's workspace. */
  readonly transcript: ReplayTranscript;
  readonly gate?: ReplayGate;
}

export interface CodexReplayAdapterFactory extends IntegrationAdapterFactory {
  /** App-server launches that got a replay peer, across every harness, in order. */
  readonly spawned: ReadonlyArray<ChildProcess.StandardCommand>;
}

const CODEX = ProviderDriverKind.make("codex");

export function codexReplayAdapterFactory(
  options: CodexReplayAdapterFactoryOptions,
): CodexReplayAdapterFactory {
  let replay: ReplaySpawner | undefined;
  const binaryPaths: Array<string> = [];
  const tripwireDirectories: Array<string> = [];
  // Every harness gets its own tripwire; a launch of any of them replays.
  const match = (command: ChildProcess.StandardCommand) =>
    binaryPaths.some((binaryPath) => matchReplayCommand(binaryPath, ["app-server"])(command));

  return {
    kind: CODEX,
    get spawned() {
      return replay?.spawned ?? [];
    },
    make: ({ rootDir, workspaceDir }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tripwireDirectory = path.join(rootDir, "provider-bin");
        const homePath = path.join(rootDir, "provider-home", "codex");
        yield* fileSystem.makeDirectory(homePath, { recursive: true });
        const binaryPath = yield* writeTripwireBinary(tripwireDirectory, "codex");
        binaryPaths.push(binaryPath);
        tripwireDirectories.push(tripwireDirectory);

        replay ??= yield* makeReplaySpawner({
          transcript: materializeWorkspace(options.transcript, {
            workspace: workspaceDir,
            home: rootDir,
          }),
          match,
          normalize: normalizeCodexOutbound,
          ...(options.gate ? { gate: options.gate } : {}),
        });
        const spawner = replay;

        const adapter = yield* makeCodexAdapter(
          Schema.decodeSync(CodexSettings)({ binaryPath, homePath }),
          // Only a launch that bypasses the replay would read it; the tripwire answers that.
          { environment: { HOME: rootDir, PATH: process.env.PATH ?? "/usr/bin:/bin" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.spawner));

        // A launch that bypassed the replay is a broken test, not a replay mismatch.
        const assertTripwiresUntouched = Effect.forEach(
          tripwireDirectories,
          (directory) => assertTripwireUntouched(directory),
          { discard: true },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.orDie,
        );

        return {
          adapter,
          replay: {
            failure: spawner.failure,
            assertConsumed: spawner.assertConsumed.pipe(Effect.andThen(assertTripwiresUntouched)),
            describePosition: spawner.describePosition,
            ...(options.gate ? { releaseAll: options.gate.releaseAll } : {}),
          },
        };
      }).pipe(Effect.orDie),
  };
}
