import { whenReviewDraftsHydrated } from "@ryco/client-runtime/state/pull-request-review";
import type { EnvironmentId } from "@ryco/contracts";

import { usePullRequestReviewDrafts } from "./pullRequestReviewDrafts";
import { resetPullRequestTabState } from "./usePullRequestTabState";

/**
 * What the PRs feature keeps on the device outside the snapshot database,
 * cleared with one environment's cached content (registered with
 * `registerEnvironmentDevicePurge`): its review drafts, and the PRs tab's
 * saved place, which names a repository.
 */
export async function clearPullRequestDeviceData(environmentId: EnvironmentId): Promise<void> {
  resetPullRequestTabState();
  // A clear before the saved drafts load would be undone when they merge in.
  await whenReviewDraftsHydrated(usePullRequestReviewDrafts);
  usePullRequestReviewDrafts.getState().clearEnvironment(environmentId);
}
