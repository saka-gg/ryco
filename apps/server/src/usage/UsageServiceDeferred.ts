/**
 * UsageServiceDeferred - the server's `UsageService`, with the usage pipeline loaded on first use.
 *
 * The pipeline (`UsageService.ts`: the transcript and OpenCode readers, the scan cache and
 * pricing) is about 110 KB of bundled code that most boots never run. It is loaded with
 * `import()` when the first summary is read, so it stays off the boot path
 * (serverBundleBoundaries.test.ts). Users who opened usage before still get fresh rates before
 * their next visit: shortly after boot, a node that has downloaded rates loads the pipeline,
 * which refreshes them if they are stale.
 *
 * @module UsageServiceDeferred
 */
import { UsageReadError } from "@ryco/contracts";
import { Cause, Deferred, Duration, Effect, Exit, FileSystem, Layer, Path, Scope } from "effect";
import type { HttpClient } from "effect/http";

import { ServerConfig } from "../config.ts";
import type { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { UsageServiceOptions } from "./UsageService.ts";
import {
  USAGE_RATES_WARM_DELAY_MS,
  UsageService,
  type UsageServiceShape,
  usageRatesCachePath,
} from "./UsageServiceTag.ts";

/** The services the pipeline is built with, captured when this layer is built. */
type UsageServiceServices =
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService
  | ServerEnvironment
  | HttpClient.HttpClient;

/** What this layer needs from the lazily loaded `UsageService.ts`. */
export interface UsageServiceModule {
  readonly makeUsageService: (
    options: UsageServiceOptions,
  ) => Effect.Effect<UsageServiceShape, never, UsageServiceServices | Scope.Scope>;
}

const loadUsageServiceModule = (): Promise<UsageServiceModule> => import("./UsageService.ts");

/**
 * `UsageService` with the pipeline loaded on first use. The pipeline is built once, in a fiber of
 * this layer's scope: concurrent first callers wait for the same build, and a caller that goes
 * away (a closed socket) leaves it to the next one. A failed load is retried by the next caller.
 */
export const makeUsageServiceDeferred = Effect.fnUntraced(function* (
  load: () => Promise<UsageServiceModule> = loadUsageServiceModule,
) {
  const services = yield* Effect.context<UsageServiceServices>();
  const scope = yield* Effect.scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  let built: Deferred.Deferred<UsageServiceShape, UsageReadError> | null = null;
  const build = (
    done: Deferred.Deferred<UsageServiceShape, UsageReadError>,
    options: UsageServiceOptions,
  ) =>
    Effect.promise(() => load()).pipe(
      Effect.flatMap((module) => module.makeUsageService(options)),
      Effect.provideContext(services),
      Scope.provide(scope),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.fail(
              new UsageReadError({
                reason: "scan-failed",
                detail: "Usage could not be loaded on this node.",
                cause: Cause.squash(cause),
              }),
            ),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && built === done) built = null;
        }).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
    );
  // Starting the build is uninterruptible, so a caller interrupted right after claiming it
  // cannot leave later callers waiting for a build that never started.
  const service = (options: UsageServiceOptions) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (built !== null) return restore(Deferred.await(built));
        const done = Deferred.makeUnsafe<UsageServiceShape, UsageReadError>();
        built = done;
        return Effect.forkIn(build(done, options), scope).pipe(
          Effect.andThen(restore(Deferred.await(done))),
        );
      }),
    );
  // A summary refreshes stale rates itself, so the pipeline it loads skips its own warm-up.
  const serviceForSummary = service({ ratesWarmDelayMs: null });

  // Users who opened usage before get fresh rates before their next visit: the pipeline this
  // loads refreshes stale rates at once.
  yield* Effect.sleep(Duration.millis(USAGE_RATES_WARM_DELAY_MS)).pipe(
    Effect.andThen(fileSystem.exists(usageRatesCachePath(path, config.stateDir))),
    Effect.flatMap((exists) => (exists ? service({ ratesWarmDelayMs: 0 }) : Effect.void)),
    Effect.catchCause(() => Effect.void),
    Effect.forkIn(scope),
  );

  return UsageService.of({
    readSummary: (input) => Effect.flatMap(serviceForSummary, (usage) => usage.readSummary(input)),
  });
});

export const UsageServiceDeferredLive = Layer.effect(UsageService, makeUsageServiceDeferred());
