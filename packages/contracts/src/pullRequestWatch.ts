import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode } from "./runtimeMode.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";
import { WorktreeId } from "./worktree.ts";

/**
 * Server-side pull request watches. The server reads a watched pull request on
 * its own (no client needs to be connected) and wakes the thread's agent with
 * a queued turn when a check fails, the required checks pass, someone else
 * comments or reviews, or the branch starts to conflict. With Auto-fix CI on, a
 * failing head gets one bounded fix turn instead. The decision rules live in
 * `@ryco/shared/pullRequestWatch`; the shell summary in
 * `@ryco/shared/pullRequestWatchSummary`.
 */

/** Why a watch ended. Kept on the thread (newest first, a few) so clients can say so. */
export const PullRequestWatchEndReason = Schema.Literals([
  /** The user or the agent turned it off. */
  "unwatched",
  "merged",
  "closed",
  /** Too many updates in a row that only brought comments. */
  "comment-limit",
  /** The pull request could not be read several times in a row. */
  "unreadable",
  "settled",
  "archived",
  "trashed",
  /** The user stopped the thread. */
  "stopped",
  /** The pull request is no longer linked to the workspace, or the workspace is gone. */
  "unlinked",
  /** The thread's permissions or checkout changed since watching began. */
  "scope-changed",
  /** Its updates were refused several times in a row. */
  "rejected",
  /** An update waited a day for a thread that could not take it. */
  "expired",
]);
export type PullRequestWatchEndReason = typeof PullRequestWatchEndReason.Type;

/**
 * - `watching`: waiting for the checks to settle.
 * - `fixing`: a fix turn was requested for `lastHandledHeadSha` and nothing was pushed yet.
 * - `paused`: stopped until the user turns Auto-fix CI on again (see `pauseReason`).
 */
export const PullRequestAutoFixStatus = Schema.Literals(["watching", "fixing", "paused"]);
export type PullRequestAutoFixStatus = typeof PullRequestAutoFixStatus.Type;

/**
 * - `attempt-limit`: the checks still failed after the allowed fix turns.
 * - `no-push`: a fix turn ended and nothing was pushed.
 * - `start-failed`: the fix turn's start failed or a restart cut it off; fix turns are never re-sent.
 */
export const PullRequestAutoFixPauseReason = Schema.Literals([
  "attempt-limit",
  "no-push",
  "start-failed",
]);
export type PullRequestAutoFixPauseReason = typeof PullRequestAutoFixPauseReason.Type;

/** Auto-fix CI on one watch (the user's switch; agents cannot turn it on). */
export const PullRequestWatchAutoFix = Schema.Struct({
  status: PullRequestAutoFixStatus,
  pauseReason: Schema.NullOr(PullRequestAutoFixPauseReason),
  /** Fix turns since the checks were last green. */
  attempts: NonNegativeInt,
  /** Head commit whose failure already got a fix turn; never fixed twice. */
  lastHandledHeadSha: Schema.NullOr(TrimmedNonEmptyString),
  /** The fix wake's command time (equal to its turn start's `requestedAt`). */
  fixRequestedAt: Schema.NullOr(IsoDateTime),
});
export type PullRequestWatchAutoFix = typeof PullRequestWatchAutoFix.Type;

export const PullRequestWatchDeliveryKind = Schema.Literals(["news", "fix"]);
export type PullRequestWatchDeliveryKind = typeof PullRequestWatchDeliveryKind.Type;

/**
 * A wake whose turn start has not bound yet. Only ids and times: the text is
 * in the thread's messages, and a lost news wake is re-derived (see
 * `beforeWake`), never re-sent from storage.
 */
export const PullRequestWatchDelivery = Schema.Struct({
  messageId: MessageId,
  kind: PullRequestWatchDeliveryKind,
  sentAt: IsoDateTime,
});
export type PullRequestWatchDelivery = typeof PullRequestWatchDelivery.Type;

/**
 * What the watch already told the agent (T3 Code's watch fields). Check and
 * remark ids are host ids; check ids are workflow plus check name.
 */
export const PullRequestWatchNewsProgress = Schema.Struct({
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  /** Failed checks on `headSha` already reported. */
  failedChecks: Schema.Array(TrimmedNonEmptyString),
  /** The pass gate passed on `headSha` and was reported. */
  passed: Schema.Boolean,
  /** The gate's checks when it passed, so a newly required check can report a pass again. */
  passedChecks: Schema.Array(TrimmedNonEmptyString),
  /** Remarks up to this time were seen. */
  remarksThrough: IsoDateTime,
  /** Remarks at exactly `remarksThrough` already seen (hosts report whole seconds). */
  remarkIds: Schema.Array(TrimmedNonEmptyString),
  /** Remarks from people without confirmed write access since the last wake: counted, never quoted. */
  outsideRemarks: NonNegativeInt,
  conflicting: Schema.Boolean,
  /** Wakes in a row that only brought comments. */
  wakes: NonNegativeInt,
  /** Wake the agent with news. */
  news: Schema.Boolean,
});
export type PullRequestWatchNewsProgress = typeof PullRequestWatchNewsProgress.Type;

/** One pull request a thread watches. Every change goes through a revision-fenced command. */
export const ThreadPullRequestWatch = Schema.Struct({
  /** `${repositoryKey}#${number}`, the same for every thread watching that pull request. */
  watchId: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  /** The workspace that links the pull request (its checkout is the read cwd); may be another workspace of the project. */
  worktreeId: WorktreeId,
  /** Bumped by every change; an update must name the revision it was derived from. */
  revision: PositiveInt,
  /** Identifies this watch generation: an update must also name it, so a stale pass cannot touch a watch started again. */
  startedAt: IsoDateTime,
  startedBy: Schema.Literals(["agent", "user"]),
  /** The woken thread's runtime when watching began; wakes never run with more. */
  runtimeMode: RuntimeMode,
  /** The woken thread's checkout when watching began. */
  worktreePath: Schema.NullOr(Schema.String),
  ...PullRequestWatchNewsProgress.fields,
  /**
   * Ids of the checks the host required at the last read that said (empty: none
   * required, so every check gates); null until a read says. A read that
   * cannot tell keeps this gate instead of falling back to every check.
   */
  requiredChecks: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
  /** Checks failing on `headSha` at the last read that listed checks, told or not (what clients show). */
  failingChecks: NonNegativeInt,
  /** Null while Auto-fix CI is off. */
  autoFix: Schema.NullOr(PullRequestWatchAutoFix),
  delivery: Schema.NullOr(PullRequestWatchDelivery),
  /** The news progress before the wake in `delivery`; restored when that wake provably never reached the agent. */
  beforeWake: Schema.NullOr(PullRequestWatchNewsProgress),
  /** The last time the watch woke the agent or changed its Auto-fix CI state. */
  lastChangeAt: Schema.NullOr(IsoDateTime),
});
export type ThreadPullRequestWatch = typeof ThreadPullRequestWatch.Type;

export const ThreadPullRequestWatchEnded = Schema.Struct({
  watchId: TrimmedNonEmptyString,
  number: PositiveInt,
  reason: PullRequestWatchEndReason,
  endedAt: IsoDateTime,
});
export type ThreadPullRequestWatchEnded = typeof ThreadPullRequestWatchEnded.Type;

/** A thread's watches: full state, kept on the server's read model. */
export const ThreadPullRequestWatches = Schema.Struct({
  active: Schema.Array(ThreadPullRequestWatch),
  /** Newest first, a few. */
  ended: Schema.Array(ThreadPullRequestWatchEnded),
});
export type ThreadPullRequestWatches = typeof ThreadPullRequestWatches.Type;

export const PullRequestWatchAutoFixSummary = Schema.Struct({
  status: PullRequestAutoFixStatus,
  pauseReason: Schema.NullOr(PullRequestAutoFixPauseReason),
  attempts: NonNegativeInt,
  maxAttempts: PositiveInt,
});
export type PullRequestWatchAutoFixSummary = typeof PullRequestWatchAutoFixSummary.Type;

/** What clients show of one watch (thread shells carry this, not the full state). */
export const ThreadPullRequestWatchSummary = Schema.Struct({
  watchId: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  worktreeId: WorktreeId,
  startedAt: IsoDateTime,
  startedBy: Schema.Literals(["agent", "user"]),
  news: Schema.Boolean,
  autoFix: Schema.NullOr(PullRequestWatchAutoFixSummary),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  /** Checks failing on `headSha` now, including ones Auto-fix CI has not reported yet. */
  failingChecks: NonNegativeInt,
  /** The pass gate passed on `headSha`; a false to true change for the same head is a pass. */
  passed: Schema.Boolean,
  conflicting: Schema.Boolean,
  /** A wake was sent and its turn has not started yet. */
  delivering: Schema.Boolean,
  lastChangeAt: Schema.NullOr(IsoDateTime),
});
export type ThreadPullRequestWatchSummary = typeof ThreadPullRequestWatchSummary.Type;

export const ThreadPullRequestWatchShell = Schema.Struct({
  active: Schema.Array(ThreadPullRequestWatchSummary),
  /** Newest first; entries older than a day are left out. */
  ended: Schema.Array(ThreadPullRequestWatchEnded),
});
export type ThreadPullRequestWatchShell = typeof ThreadPullRequestWatchShell.Type;

/**
 * Start, change or stop a thread's watch. Without `number` and `url` it is
 * the pull request of the thread's workspace; with them it may be a pull
 * request of any workspace in the thread's project, or one not linked yet
 * (linked to the thread's workspace by hand once its repository matches).
 */
export const SourceControlSetPullRequestWatchInput = Schema.Struct({
  threadId: ThreadId,
  number: Schema.optional(PositiveInt),
  url: Schema.optional(TrimmedNonEmptyString),
  /** Start or stop waking the agent with news. */
  news: Schema.optional(Schema.Boolean),
  /** Auto-fix CI on or off; on again resets the attempts and the pause. */
  autoFix: Schema.optional(Schema.Boolean),
});
export type SourceControlSetPullRequestWatchInput =
  typeof SourceControlSetPullRequestWatchInput.Type;

export const SourceControlSetPullRequestWatchResult = Schema.Struct({
  /** Null once the watch ended. */
  watch: Schema.NullOr(ThreadPullRequestWatchSummary),
  /** The pull request's state right now, e.g. "2 checks failing: lint, test. 3 running." */
  now: Schema.String,
});
export type SourceControlSetPullRequestWatchResult =
  typeof SourceControlSetPullRequestWatchResult.Type;

export class PullRequestWatchError extends Schema.TaggedError<PullRequestWatchError>()(
  "PullRequestWatchError",
  {
    reason: Schema.Literals([
      "no-pull-request",
      "not-open",
      "unreadable",
      /** A delegated thread whose result is still awaited reports the pull request instead. */
      "delegated",
      "limit",
      "thread-unavailable",
      /** Another thread already runs Auto-fix CI on this pull request. */
      "auto-fix-owned",
      /** The pull request belongs to another repository than the thread's checkout. */
      "wrong-repository",
      "unsupported",
    ]),
    detail: Schema.String,
  },
) {}
