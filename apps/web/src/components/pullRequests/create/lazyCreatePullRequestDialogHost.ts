import { preloadableLazy } from "../../../lib/preloadableLazy";

/**
 * The palette's "New pull request…" host, code-split: it loads with the first
 * request and mounts once loaded, so the first open never commits a Suspense
 * fallback or waits on React's 300 ms reveal throttle.
 */
export const LazyCreatePullRequestDialogHost = preloadableLazy(() =>
  import("./CreatePullRequestDialogHost").then((module) => module.CreatePullRequestDialogHost),
);
