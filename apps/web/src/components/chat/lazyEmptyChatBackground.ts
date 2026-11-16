import { preloadableLazy } from "../../lib/preloadableLazy";

/**
 * The empty chat's animated background, split out of the chat route: it only
 * mounts on the new-thread surface, after the chat has painted.
 */
export const LazyEmptyChatBackground = preloadableLazy(() =>
  import("./EmptyChatBackground").then((module) => module.EmptyChatBackground),
);
