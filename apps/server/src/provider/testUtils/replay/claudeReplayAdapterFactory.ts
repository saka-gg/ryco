/**
 * The real Claude adapter over replayed Claude Agent SDK queries, for the orchestration
 * integration harness (`adapterFactories`). Only the SDK query is replayed: the adapter,
 * ProviderService, ingestion and projections all run for real.
 *
 * The adapter reads two things outside the query: the Claude store (transcript presence before a
 * resume, session messages for a rewind), which the factory answers from the transcript, and the
 * CLI itself for project commands. The provider binary is a tripwire and HOME, CLAUDE_CONFIG_DIR
 * and XDG_CONFIG_HOME are directories under the harness root, so nothing reaches a real Claude
 * Code CLI or `~/.claude`.
 *
 * One factory plays one transcript across every harness it builds an adapter for: a restart
 * scenario (a second harness on the same database) hands the same factory to both harnesses, and
 * the second harness's first query plays the second transcript segment.
 *
 * @module provider/testUtils/replay/claudeReplayAdapterFactory
 */
import { ClaudeSettings, ProviderDriverKind } from "@ryco/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";

import type { IntegrationAdapterFactory } from "../../../../integration/OrchestrationEngineHarness.integration.ts";
import { makeClaudeAdapter, type ClaudeTranscriptEntry } from "../../Layers/ClaudeAdapter.ts";
import {
  makeClaudeReplayQueryFactory,
  type ClaudeReplayQuery,
  type ClaudeReplayQueryFactory,
} from "./claudeReplayQuery.ts";
import type { ReplayGate } from "./replayGate.ts";
import { materializeWorkspace, type ReplayTranscript } from "./replayTranscript.ts";
import { assertTripwireUntouched, writeTripwireBinary } from "./tripwire.ts";

export interface ClaudeReplayAdapterFactoryOptions {
  /**
   * Unmaterialized: `<workspace>` becomes the first harness's workspace. Header metadata may
   * carry `sessionMessages` (what reading the session's transcript returns) and
   * `initializationResult` (how the CLI answered initialize).
   */
  readonly transcript: ReplayTranscript;
  readonly gate?: ReplayGate;
}

export interface ClaudeReplayAdapterFactory extends IntegrationAdapterFactory {
  /** The queries the adapters opened, across every harness, in order. */
  readonly queries: ReadonlyArray<ClaudeReplayQuery>;
}

const CLAUDE = ProviderDriverKind.make("claudeAgent");

export function claudeReplayAdapterFactory(
  options: ClaudeReplayAdapterFactoryOptions,
): ClaudeReplayAdapterFactory {
  let replay: ClaudeReplayQueryFactory | undefined;
  const tripwireDirectories: Array<string> = [];
  const metadata = options.transcript.header.metadata;
  const sessionMessages = (
    Array.isArray(metadata?.sessionMessages) ? metadata.sessionMessages : []
  ) as ReadonlyArray<ClaudeTranscriptEntry>;

  return {
    kind: CLAUDE,
    get queries() {
      return replay?.queries ?? [];
    },
    make: ({ rootDir, workspaceDir }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tripwireDirectory = path.join(rootDir, "provider-bin");
        const homePath = path.join(rootDir, "provider-home", "claudeAgent");
        const configDir = path.join(homePath, ".claude");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        const binaryPath = yield* writeTripwireBinary(tripwireDirectory, "claude");
        tripwireDirectories.push(tripwireDirectory);

        replay ??= yield* makeClaudeReplayQueryFactory(
          materializeWorkspace(options.transcript, { workspace: workspaceDir, home: rootDir }),
          options.gate ? { gate: options.gate } : {},
        );
        const queries = replay;
        // This harness's queries close with it, not with the harness that made the replay.
        const createQuery = yield* queries.createQueryInScope;

        const adapter = yield* makeClaudeAdapter(
          Schema.decodeSync(ClaudeSettings)({ binaryPath, homePath }),
          {
            // Only a launch that bypasses the replay would read it; the tripwire answers that.
            environment: {
              HOME: homePath,
              CLAUDE_CONFIG_DIR: configDir,
              XDG_CONFIG_HOME: path.join(homePath, ".config"),
              PATH: process.env.PATH ?? "/usr/bin:/bin",
            },
            createQuery,
            // Never the developer's own Claude store.
            readTranscriptPresence: async () => "present",
            readSessionMessages: async () => sessionMessages,
          },
        );

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
            failure: queries.failure,
            assertConsumed: queries.assertConsumed.pipe(Effect.andThen(assertTripwiresUntouched)),
            describePosition: queries.describePosition,
            ...(options.gate ? { releaseAll: options.gate.releaseAll } : {}),
          },
        };
      }).pipe(Effect.orDie),
  };
}
