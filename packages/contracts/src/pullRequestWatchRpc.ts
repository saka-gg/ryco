import * as Schema from "effect/Schema";

import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadPullRequestWatchSummary } from "./pullRequestWatch.ts";

/**
 * The pull request watch RPC's input, result and error. Apart from the watch schemas
 * (`./pullRequestWatch.ts`) because thread shells and orchestration events need only those:
 * every client loads them at startup, while these load with the controls that send the RPC.
 */

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
