import * as Schema from "effect/Schema";

import {
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { WorktreeId } from "./worktree.ts";

/**
 * Chat forking: branch an existing thread at a completed turn into a new thread.
 *
 * One server operation (`threads.fork`) serves every client. The boundary is the selected
 * assistant reply of a completed turn; the fork's visible history and its provider context
 * both end there (see docs/thread-forks.md).
 */

/** Client-chosen idempotency key. Retries reuse it; a different request needs a new key. */
export const ThreadForkKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
);
export type ThreadForkKey = typeof ThreadForkKey.Type;

/** A branch, tag or commit the user typed. Validated by Git on the node. */
export const ThreadForkBaseRef = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ThreadForkBaseRef = typeof ThreadForkBaseRef.Type;

/**
 * Where a new worktree starts:
 * - `checkpoint`: the selected turn's saved checkpoint, overlaid on the source checkout's
 *   current commit. Refused with `checkpoint-unavailable` when it cannot be materialized.
 * - `base-ref`: an explicit branch or commit; its files may differ from the conversation point.
 */
export const ThreadForkWorktreeStart = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("checkpoint") }),
  Schema.Struct({ kind: Schema.Literal("base-ref"), baseRef: ThreadForkBaseRef }),
]);
export type ThreadForkWorktreeStart = typeof ThreadForkWorktreeStart.Type;

/**
 * - `current-checkout`: share the source's checkout. Files are never rewound or copied.
 * - `new-worktree`: a new managed worktree (Git projects only, never chats).
 * - `new-chat`: a new chat with an empty folder (projectless chats only).
 */
export const ThreadForkDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("current-checkout") }),
  Schema.Struct({ kind: Schema.Literal("new-worktree"), start: ThreadForkWorktreeStart }),
  Schema.Struct({ kind: Schema.Literal("new-chat") }),
]);
export type ThreadForkDestination = typeof ThreadForkDestination.Type;

export const ThreadForkInput = Schema.Struct({
  forkKey: ThreadForkKey,
  sourceThreadId: ThreadId,
  /** The terminal assistant reply of a completed turn; the boundary is inclusive. */
  sourceMessageId: MessageId,
  destination: ThreadForkDestination,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

/**
 * How the fork's provider continues:
 * - `native`: an independent provider-native copy that ends at the boundary.
 * - `handoff`: the next message starts a fresh session that receives the inherited
 *   conversation as a context document. Native tool and reasoning state is not carried.
 */
export const ThreadForkProviderContext = Schema.Literals(["native", "handoff"]);
export type ThreadForkProviderContext = typeof ThreadForkProviderContext.Type;

/** Why a fork uses a context handoff instead of a native copy. */
export const ThreadForkHandoffReason = Schema.Literals([
  /** The provider has no native fork that can stop at a selected turn. */
  "provider-unsupported",
  /** The source has no resumable native session for this provider instance. */
  "no-native-session",
  /** The selected turn is not part of the source's current native session. */
  "turn-not-in-native-session",
  /** The provider refused the native fork. */
  "native-fork-failed",
  /** The native fork's outcome is unknown; Ryco did not repeat it and does not use any copy. */
  "native-fork-uncertain",
]);
export type ThreadForkHandoffReason = typeof ThreadForkHandoffReason.Type;

export const ThreadForkCheckout = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("current-checkout"),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    branch: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("new-worktree"),
    worktreeId: WorktreeId,
    worktreePath: TrimmedNonEmptyString,
    branch: TrimmedNonEmptyString,
    start: Schema.Literals(["checkpoint", "base-ref"]),
    /** The ref the user chose (`base-ref`), or the source commit the checkpoint was laid on. */
    baseRef: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("new-chat"),
    folder: TrimmedNonEmptyString,
  }),
]);
export type ThreadForkCheckout = typeof ThreadForkCheckout.Type;

const ThreadForkNotices = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
  Schema.isMaxLength(8),
);

export const ThreadForkResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  /** The key was already completed; nothing new was created. */
  replayed: Schema.Boolean,
  providerContext: ThreadForkProviderContext,
  checkout: ThreadForkCheckout,
  notices: ThreadForkNotices,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export const ThreadForkErrorReason = Schema.Literals([
  /** Forking is unavailable on this server or for this thread. */
  "unavailable",
  /** The source thread is missing, deleted or in Trash. */
  "source-unavailable",
  /** The message is not the reply of a completed turn. */
  "boundary-unsupported",
  /** The message no longer exists or its turn changed. Refresh and pick again. */
  "boundary-stale",
  /** The source is reverting or otherwise cannot be read consistently right now. */
  "source-busy",
  /** The destination cannot be used for this thread (no Git, chats unavailable, removed checkout). */
  "destination-unavailable",
  /** The selected turn has no checkpoint that can start a new worktree. Choose a base ref. */
  "checkpoint-unavailable",
  /** Git could not resolve the base ref. */
  "base-ref-invalid",
  /** The key was used for a different request. */
  "idempotency-conflict",
  /**
   * Preparing or publishing the fork failed. `attempt` tells whether the node released what the
   * attempt created (`stopped`) or still holds an unfinished attempt it keeps driving (`running`).
   */
  "preparation-failed",
  /** The fork completed earlier but its thread was deleted since. */
  "deleted",
]);
export type ThreadForkErrorReason = typeof ThreadForkErrorReason.Type;

/**
 * What the node holds for the request's key when it reports an error. Clients decide from this
 * whether a different request may use a new key without risking a second fork:
 * - `none`: nothing was recorded for the key.
 * - `stopped`: a recorded attempt ended and released what it created; it never resumes on its own.
 *   Retrying the same request restarts it when `retryable`; a different request needs a new key.
 * - `running`: a recorded attempt is unfinished. The node keeps driving it, also after a restart,
 *   until it completes. When its runs keep stopping (for about an hour), the node instead removes
 *   what it created and records a failure, and the key then reports `stopped`; a removal that
 *   fails keeps the key `running` while the node retries it. Retry the same request to learn its
 *   outcome; never start another fork meanwhile.
 */
export const ThreadForkAttemptState = Schema.Literals(["none", "stopped", "running"]);
export type ThreadForkAttemptState = typeof ThreadForkAttemptState.Type;

export class ThreadForkError extends Schema.TaggedError<ThreadForkError>()("ThreadForkError", {
  message: Schema.String,
  reason: ThreadForkErrorReason,
  /** Retrying with the same key can succeed. */
  retryable: Schema.Boolean,
  attempt: ThreadForkAttemptState,
}) {}

/** Provenance activity appended once to a fork, after its inherited history. */
export const THREAD_FORKED_ACTIVITY_KIND = "thread.forked";

export const ThreadForkedActivityPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceThreadId: ThreadId,
  sourceMessageId: MessageId,
  sourceTurnId: TurnId,
  /** The source title when the fork was created, for display after the source is deleted. */
  sourceTitle: TrimmedNonEmptyString,
  inheritedMessageCount: NonNegativeInt,
  /**
   * Inherited turns that did not complete in the source. Their rows in the fork keep this
   * outcome, so a fork of the fork refuses them as boundaries. Absent when every turn completed.
   */
  inheritedTurnOutcomes: Schema.optional(
    Schema.Array(
      Schema.Struct({ turnId: TurnId, state: Schema.Literals(["interrupted", "error"]) }),
    ).check(Schema.isMaxLength(2000)),
  ),
  providerContext: ThreadForkProviderContext,
  handoffReason: Schema.optional(ThreadForkHandoffReason),
  checkout: ThreadForkCheckout,
  notices: ThreadForkNotices,
});
export type ThreadForkedActivityPayload = typeof ThreadForkedActivityPayload.Type;
