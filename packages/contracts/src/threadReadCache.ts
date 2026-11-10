import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ThreadId, TurnId } from "./baseSchemas.ts";
import { NodeHubProof } from "./nodeProof.ts";
import {
  OrchestrationMessageRole,
  OrchestrationProjectShell,
  OrchestrationShellSettlementPolicy,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  OrchestrationWorktreeShell,
} from "./orchestration.ts";

export const THREAD_READ_CACHE_MESSAGE_LIMIT = 150;
export const THREAD_READ_CACHE_TEXT_LIMIT = 1_000_000;

/** Display-only projection. A cached response never establishes a live session. */
export const ThreadReadCacheShell = OrchestrationShellSnapshot.check(
  Schema.makeFilter(
    (snapshot) =>
      snapshot.projects.length <= 2_000 &&
      (snapshot.worktrees?.length ?? 0) <= 10_000 &&
      snapshot.threads.length <= 10_000,
    { message: "Thread read cache shell exceeds its row limits" },
  ),
);
export type ThreadReadCacheShell = typeof ThreadReadCacheShell.Type;

/** Explicit allowlist: no attachments, credentials, pending actions, or live flags. */
export const ThreadReadCacheMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  createdAt: IsoDateTime,
  completedAt: Schema.optionalKey(IsoDateTime),
  turnId: Schema.optionalKey(Schema.NullOr(TurnId)),
});
export type ThreadReadCacheMessage = typeof ThreadReadCacheMessage.Type;

export const ThreadReadCacheContent = Schema.Struct({
  messages: Schema.Array(ThreadReadCacheMessage).check(
    Schema.isMaxLength(THREAD_READ_CACHE_MESSAGE_LIMIT),
  ),
}).check(
  Schema.makeFilter(
    (content) =>
      content.messages.reduce((total, message) => total + message.text.length, 0) <=
        THREAD_READ_CACHE_TEXT_LIMIT &&
      new Set(content.messages.map((message) => message.id)).size === content.messages.length,
    { message: "Thread read cache content exceeds its text limit or repeats message IDs" },
  ),
);
export type ThreadReadCacheContent = typeof ThreadReadCacheContent.Type;

const SafeCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
const envelope = {
  protocolVersion: Schema.Literal(1),
  generation: SafeCounter,
  revision: SafeCounter,
  storedAt: SafeCounter,
};

export const ThreadReadCacheShellResponse = Schema.Struct({
  ...envelope,
  snapshot: ThreadReadCacheShell,
});
export type ThreadReadCacheShellResponse = typeof ThreadReadCacheShellResponse.Type;

export const ThreadReadCacheThreadResponse = Schema.Struct({
  ...envelope,
  threadId: ThreadId,
  snapshot: ThreadReadCacheContent,
});
export type ThreadReadCacheThreadResponse = typeof ThreadReadCacheThreadResponse.Type;

/** Fresh node-identity challenge proof; signatures are verified by the Hub. */
export const ThreadReadCacheProof = NodeHubProof;
export type ThreadReadCacheProof = NodeHubProof;

export const ThreadReadCacheBeginInput = Schema.Struct({ proof: ThreadReadCacheProof });
export type ThreadReadCacheBeginInput = typeof ThreadReadCacheBeginInput.Type;
export const ThreadReadCacheClearInput = ThreadReadCacheBeginInput;
export type ThreadReadCacheClearInput = typeof ThreadReadCacheClearInput.Type;
/**
 * Upload forms a Hub accepts beyond whole items, announced in its `begin` answer. A node sends
 * them only to a Hub that named them; an older Hub names none and receives whole items, and an
 * older node ignores the field.
 *
 * - `patch-v1`: `shellPatch` and `threadPatch` items.
 * - `deflate`: a `snapshot` body may be sent with `content-encoding: deflate` (zlib). The
 *   inflated body has the same limit as a plain one.
 */
export const THREAD_READ_CACHE_FEATURES = ["patch-v1", "deflate"] as const;
export type ThreadReadCacheFeature = (typeof THREAD_READ_CACHE_FEATURES)[number];

export const ThreadReadCacheBeginResponse = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  generation: SafeCounter,
  /** Unknown names are ignored, so a newer Hub can announce forms this node does not know. */
  features: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(32)),
  ),
});
export type ThreadReadCacheBeginResponse = typeof ThreadReadCacheBeginResponse.Type;

/** sha256 of a stored payload's JSON, base64url without padding. */
const PayloadDigest = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));

/**
 * The stored shell, changed (`patch-v1`). Applies only to the stored shell whose revision is
 * `baseRevision`; anything else is a revision conflict, after which the node uploads whole items
 * again. The result keeps the stored rows in place, replaces each row of `threads` by id (adding
 * the new ones at the end), drops `removedThreadIds`, takes `snapshotSequence` from `revision`,
 * `updatedAt` from the patch, and projects, worktrees and settlement policy from `rest` when it is
 * present (otherwise the stored ones). It must list exactly `threadCount` threads and satisfy every
 * limit of `ThreadReadCacheShell`.
 */
export const ThreadReadCacheShellPatch = Schema.Struct({
  kind: Schema.Literal("shellPatch"),
  baseRevision: SafeCounter,
  revision: SafeCounter,
  updatedAt: IsoDateTime,
  threads: Schema.Array(OrchestrationThreadShell).check(Schema.isMaxLength(10_000)),
  removedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(10_000)),
  threadCount: SafeCounter,
  rest: Schema.optionalKey(
    Schema.Struct({
      projects: Schema.Array(OrchestrationProjectShell).check(Schema.isMaxLength(2_000)),
      worktrees: Schema.optionalKey(
        Schema.Array(OrchestrationWorktreeShell).check(Schema.isMaxLength(10_000)),
      ),
      settlementPolicy: Schema.optionalKey(OrchestrationShellSettlementPolicy),
    }),
  ),
});
export type ThreadReadCacheShellPatch = typeof ThreadReadCacheShellPatch.Type;

/**
 * One stored thread's messages, changed (`patch-v1`). Applies only to the stored content whose
 * revision is `baseRevision`. The result is the stored messages from `firstMessageId` on, each
 * replaced by the message of `messages` with its id, followed by the messages of `messages` it did
 * not hold, in order. Its `JSON.stringify` must hash to `digest` (sha256, base64url) and it must
 * satisfy `ThreadReadCacheContent`; anything else is a revision conflict. A patch whose base the
 * Hub no longer holds is skipped and named in the answer's `stalePatches`.
 */
export const ThreadReadCacheThreadPatch = Schema.Struct({
  kind: Schema.Literal("threadPatch"),
  threadId: ThreadId,
  baseRevision: SafeCounter,
  revision: SafeCounter,
  firstMessageId: MessageId,
  messages: Schema.Array(ThreadReadCacheMessage).check(
    Schema.isMaxLength(THREAD_READ_CACHE_MESSAGE_LIMIT),
  ),
  digest: PayloadDigest,
});
export type ThreadReadCacheThreadPatch = typeof ThreadReadCacheThreadPatch.Type;

export const ThreadReadCacheSnapshotItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("shell"),
    revision: SafeCounter,
    snapshot: ThreadReadCacheShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
    revision: SafeCounter,
    snapshot: ThreadReadCacheContent,
  }),
  Schema.Struct({ kind: Schema.Literal("deleted"), threadId: ThreadId, revision: SafeCounter }),
  ThreadReadCacheShellPatch,
  ThreadReadCacheThreadPatch,
]);
export type ThreadReadCacheSnapshotItem = typeof ThreadReadCacheSnapshotItem.Type;
export const ThreadReadCacheSnapshotInput = Schema.Struct({
  proof: ThreadReadCacheProof,
  generation: SafeCounter,
  items: Schema.Array(ThreadReadCacheSnapshotItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type ThreadReadCacheSnapshotInput = typeof ThreadReadCacheSnapshotInput.Type;

/**
 * The Hub's answer to a `snapshot` upload. `stalePatches` (only for `patch-v1` uploads) names the
 * threads whose `threadPatch` found no stored content at its base revision, for example because
 * the Hub evicted the body under its byte limit. Everything else in the batch was stored; the node
 * uploads those threads whole next.
 */
export const ThreadReadCacheSnapshotResponse = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  generation: SafeCounter,
  revision: SafeCounter,
  stalePatches: Schema.optionalKey(Schema.Array(ThreadId).check(Schema.isMaxLength(16))),
});
export type ThreadReadCacheSnapshotResponse = typeof ThreadReadCacheSnapshotResponse.Type;
