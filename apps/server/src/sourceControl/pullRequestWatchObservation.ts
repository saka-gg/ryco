/**
 * Host reads → what a pull request watch decides on. Pure: the watch sweep reads the detail and
 * the activity (and the tails of long review threads), and this module turns them into one
 * `PullRequestWatchObservation` per watching thread (the remark watermark is per thread).
 *
 * Loaded only with the sweep (`pullRequestWatchSweep.ts`), never on the boot path: it imports the
 * shared decision module.
 *
 * @module pullRequestWatchObservation
 */
import type {
  ChangeRequestActivity,
  ChangeRequestReviewThread,
  SourceControlChangeRequestDetail,
} from "@ryco/contracts";
import {
  pullRequestWatchRequiredKnown,
  remarksFromChangeRequestActivity,
  watchChecksFromRollup,
  type PullRequestWatchObservation,
} from "@ryco/shared/pullRequestWatch";

/**
 * Review threads the activity read carried only the first page of (GitHub sends the first 30
 * comments per thread): their newest comments are missing until the thread itself is read.
 */
export function pagedReviewThreadIds(activity: ChangeRequestActivity): ReadonlyArray<string> {
  return activity.reviewThreads
    .filter((thread) => thread.comments.length < thread.totalComments)
    .map((thread) => thread.id);
}

/**
 * The activity with each paged thread replaced by its own read. A thread that is still longer
 * than its read (more than the host returns for one thread) stays paged, so the conversation
 * counts as not read whole and the watch never moves its remark watermark past it.
 */
export function withReviewThreadTails(
  activity: ChangeRequestActivity,
  tails: ReadonlyMap<string, ChangeRequestReviewThread>,
): ChangeRequestActivity {
  if (tails.size === 0) return activity;
  return {
    ...activity,
    reviewThreads: activity.reviewThreads.map((thread) => {
      const tail = tails.get(thread.id);
      return tail !== undefined && tail.comments.length >= thread.comments.length ? tail : thread;
    }),
  };
}

/**
 * One thread's view of a group read. `activity` is the last activity read (null before the
 * first one); `remarksThrough` is that thread's watermark, which decides whether a truncated
 * GitHub timeline still holds every remark it has not seen.
 */
export function pullRequestWatchObservation(input: {
  readonly detail: SourceControlChangeRequestDetail;
  readonly activity: ChangeRequestActivity | null;
  readonly remarksThrough: string;
  readonly observedAtMs: number;
}): PullRequestWatchObservation {
  const { detail } = input;
  const checks = watchChecksFromRollup(detail.checkRollup);
  const remarks =
    input.activity === null
      ? { remarks: null, viewerLogin: null }
      : remarksFromChangeRequestActivity(input.activity, input.remarksThrough);
  return {
    state: detail.state,
    url: detail.url,
    headSha: detail.headSha ?? null,
    headBranch: detail.headRefName,
    baseBranch: detail.baseRefName,
    mergeability: detail.mergeability ?? null,
    checks,
    requiredKnown: pullRequestWatchRequiredKnown(detail.provider, checks),
    viewerLogin: remarks.viewerLogin,
    authorLogin: detail.author ?? null,
    remarks: remarks.remarks,
    observedAtMs: input.observedAtMs,
  };
}
