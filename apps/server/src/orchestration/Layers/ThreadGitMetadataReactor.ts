import type { ProviderRuntimeEvent } from "@ryco/contracts";
import { Cause, Effect, Layer, Scope, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadGitMetadataReactor,
  type ThreadGitMetadataReactorShape,
} from "../Services/ThreadGitMetadataReactor.ts";
import type {
  ThreadGitMetadataOptions,
  ThreadGitMetadataRuntime,
} from "../threadGitMetadataRuntime.ts";

/**
 * The provider events that can ask for a sync (the runtime decides). Everything
 * else, every streaming delta included, stops here and never loads the runtime.
 */
export const mayRequestThreadGitSync = (event: ProviderRuntimeEvent): boolean =>
  event.type === "turn.started" ||
  event.type === "turn.completed" ||
  event.type === "turn.aborted" ||
  event.type === "session.exited" ||
  event.type === "vcs.state.changed" ||
  (event.type === "item.completed" && event.payload.itemType === "command_execution");

export const makeThreadGitMetadataReactorLive = (options?: ThreadGitMetadataOptions) =>
  Layer.effect(
    ThreadGitMetadataReactor,
    Effect.gen(function* () {
      const providerService = yield* ProviderService;
      const deps = {
        engine: yield* OrchestrationEngineService,
        snapshots: yield* ProjectionSnapshotQuery,
        vcsStatus: yield* VcsStatusBroadcaster,
        settings: yield* ServerSettingsService,
      };
      let load: Effect.Effect<ThreadGitMetadataRuntime | null> | null = null;

      const start: ThreadGitMetadataReactorShape["start"] = Effect.fn("start")(function* () {
        const scope = yield* Effect.scope;
        // The sync code loads with the first event that can use it, off the boot path.
        const loadRuntime = yield* Effect.cached(
          Effect.promise(() => import("../threadGitMetadataRuntime.ts")).pipe(
            Effect.flatMap(({ makeThreadGitMetadataRuntime }) =>
              makeThreadGitMetadataRuntime(deps, options).pipe(Scope.provide(scope)),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError("thread git metadata runtime failed to load", {
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(null)),
            ),
          ),
        );
        load = loadRuntime;
        yield* Effect.forkScoped(
          Stream.runForEach(providerService.streamEvents, (event) =>
            mayRequestThreadGitSync(event)
              ? Effect.flatMap(loadRuntime, (runtime) =>
                  runtime === null ? Effect.void : runtime.offer(event),
                )
              : Effect.void,
          ),
        );
      });

      return {
        start,
        // Tests only: loads the runtime when no event did yet, so a drain never races the load.
        drain: Effect.suspend(() =>
          load === null
            ? Effect.void
            : Effect.flatMap(load, (runtime) => (runtime === null ? Effect.void : runtime.drain)),
        ),
      } satisfies ThreadGitMetadataReactorShape;
    }),
  );

export const ThreadGitMetadataReactorLive = makeThreadGitMetadataReactorLive();
