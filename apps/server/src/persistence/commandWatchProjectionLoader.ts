/**
 * The cached `import()` of the command watches' SQL (`commandWatchProjection.ts`), shared by the
 * projection pipeline and the snapshot query, so neither carries it on the boot path.
 *
 * @module commandWatchProjectionLoader
 */
import { Effect } from "effect";

type CommandWatchProjection = typeof import("./commandWatchProjection.ts");

let loaded: Promise<CommandWatchProjection> | undefined;

export const loadCommandWatchProjection: Effect.Effect<CommandWatchProjection> = Effect.promise(
  () => (loaded ??= import("./commandWatchProjection.ts")),
);
