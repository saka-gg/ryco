/**
 * The cached `import()` of the follow-up queue's SQL (`followUpQueueProjection.ts`), shared by
 * the projection pipeline and the snapshot query, so neither carries it on the boot path.
 *
 * @module followUpQueueProjectionLoader
 */
import { Effect } from "effect";

type FollowUpQueueProjection = typeof import("./followUpQueueProjection.ts");

let loaded: Promise<FollowUpQueueProjection> | undefined;

export const loadFollowUpQueueProjection: Effect.Effect<FollowUpQueueProjection> = Effect.promise(
  () => (loaded ??= import("./followUpQueueProjection.ts")),
);
