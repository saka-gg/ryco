/**
 * AgentControlNodeDirectoryDeferred - the server's node directory, loaded on first use.
 *
 * The directory's store (`AgentControlNodeDirectoryLive.ts`: its file format, merge and
 * persistence) is loaded with `import()` and built the first time a client publishes or an agent
 * lists nodes, so it stays off the server's boot path (serverBundleBoundaries.test.ts). Concurrent
 * first callers wait for the same build; a failed load leaves the next caller to try again.
 *
 * @module AgentControlNodeDirectoryDeferred
 */
import { Effect, FileSystem, Layer, Path } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { AgentControlNodeDirectoryError } from "../Errors.ts";
import {
  AgentControlNodeDirectory,
  type AgentControlNodeDirectoryShape,
} from "../Services/AgentControlNodeDirectory.ts";

/** What the store module gives this layer; a test passes its own. */
export interface AgentControlNodeDirectoryModule {
  readonly makeServerAgentControlNodeDirectory: Effect.Effect<
    AgentControlNodeDirectoryShape,
    never,
    ServerConfig | ServerEnvironment | FileSystem.FileSystem | Path.Path
  >;
}

const loadAgentControlNodeDirectoryModule = (): Promise<AgentControlNodeDirectoryModule> =>
  import("./AgentControlNodeDirectoryLive.ts");

export const makeAgentControlNodeDirectoryDeferred = Effect.fnUntraced(function* (
  load: () => Promise<AgentControlNodeDirectoryModule> = loadAgentControlNodeDirectoryModule,
) {
  const context = yield* Effect.context<
    ServerConfig | ServerEnvironment | FileSystem.FileSystem | Path.Path
  >();
  const lock = yield* Semaphore.make(1);
  let directory: AgentControlNodeDirectoryShape | null = null;

  const loaded = lock.withPermits(1)(
    Effect.suspend(() =>
      directory !== null
        ? Effect.succeed(directory)
        : Effect.tryPromise({
            try: load,
            catch: () =>
              new AgentControlNodeDirectoryError({
                reason: "unavailable",
                detail: "The node directory could not be loaded on this node.",
              }),
          }).pipe(
            Effect.flatMap((module) => module.makeServerAgentControlNodeDirectory),
            Effect.provideContext(context),
            Effect.tap((built) =>
              Effect.sync(() => {
                directory = built;
              }),
            ),
          ),
    ),
  );

  return AgentControlNodeDirectory.of({
    publish: (input) => Effect.flatMap(loaded, (store) => store.publish(input)),
    list: () => Effect.flatMap(loaded, (store) => store.list()),
  });
});

export const AgentControlNodeDirectoryDeferredLive = Layer.effect(
  AgentControlNodeDirectory,
  makeAgentControlNodeDirectoryDeferred(),
);
