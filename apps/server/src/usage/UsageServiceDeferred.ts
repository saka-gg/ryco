/**
 * UsageServiceDeferred - the server's `UsageService`, with the usage pipeline loaded on first use.
 *
 * The pipeline (`UsageService.ts`: the transcript and OpenCode readers, the scan cache and
 * pricing) is about 110 KB of bundled code that most boots never run. It is loaded with
 * `import()` when the first summary is read, so it stays off the boot path
 * (serverBundleBoundaries.test.ts). Nothing runs at boot: the price list is refreshed when Usage
 * or Statistics is first read (stale-while-revalidate, `UsageService.ts`), not 30 s after every
 * start as before.
 *
 * @module UsageServiceDeferred
 */
import { UsageReadError } from "@ryco/contracts";
import { Cause, Deferred, Effect, Exit, type FileSystem, Layer, type Path, Scope } from "effect";
import type { HttpClient } from "effect/http";

import type { ServerConfig } from "../config.ts";
import type { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import { UsageService, type UsageServiceShape } from "./UsageServiceTag.ts";

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
  readonly makeUsageService: () => Effect.Effect<
    UsageServiceShape,
    never,
    UsageServiceServices | Scope.Scope
  >;
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

  let built: Deferred.Deferred<UsageServiceShape, UsageReadError> | null = null;
  const build = (done: Deferred.Deferred<UsageServiceShape, UsageReadError>) =>
    Effect.promise(() => load()).pipe(
      Effect.flatMap((module) => module.makeUsageService()),
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
  const service = Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      if (built !== null) return restore(Deferred.await(built));
      const done = Deferred.makeUnsafe<UsageServiceShape, UsageReadError>();
      built = done;
      return Effect.forkIn(build(done), scope).pipe(Effect.andThen(restore(Deferred.await(done))));
    }),
  );
  return UsageService.of({
    readSummary: (input) => Effect.flatMap(service, (usage) => usage.readSummary(input)),
    // Statistics stay readable when the pipeline cannot load: their buckets are just unpriced.
    priceStatistics: (snapshot) =>
      Effect.flatMap(service, (usage) => usage.priceStatistics(snapshot)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(snapshot),
        ),
      ),
  });
});

export const UsageServiceDeferredLive = Layer.effect(UsageService, makeUsageServiceDeferred());
