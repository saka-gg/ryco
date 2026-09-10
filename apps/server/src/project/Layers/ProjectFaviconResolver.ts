import { Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver.ts";
import { readProjectFavicon } from "../readProjectFavicon.ts";

export const makeProjectFaviconResolver = Effect.gen(function* () {
  const workers = yield* Semaphore.make(2);
  return {
    readIcon: (cwd) =>
      workers.withPermit(Effect.promise((signal) => readProjectFavicon(cwd, { signal }))).pipe(
        // Bound queueing as well as the child read. Icons never gate a usable node.
        Effect.timeout("5 seconds"),
        Effect.catch(() => Effect.succeed(null)),
      ),
  } satisfies ProjectFaviconResolverShape;
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
