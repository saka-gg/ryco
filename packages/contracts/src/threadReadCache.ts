import { Schema } from "effect";

import { IsoDateTime, MessageId, ThreadId, TurnId } from "./baseSchemas.ts";
import { RelayNodeId } from "./relay.ts";
import { OrchestrationMessageRole, OrchestrationShellSnapshot } from "./orchestration.ts";

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
export const ThreadReadCacheProof = Schema.Struct({
  nodeId: RelayNodeId,
  protocolMajor: SafeCounter,
  protocolMinor: SafeCounter,
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)),
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{85}[AQgw]$/)),
});
export type ThreadReadCacheProof = typeof ThreadReadCacheProof.Type;

export const ThreadReadCacheBeginInput = Schema.Struct({ proof: ThreadReadCacheProof });
export type ThreadReadCacheBeginInput = typeof ThreadReadCacheBeginInput.Type;
export const ThreadReadCacheClearInput = ThreadReadCacheBeginInput;
export type ThreadReadCacheClearInput = typeof ThreadReadCacheClearInput.Type;
export const ThreadReadCacheBeginResponse = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  generation: SafeCounter,
});
export type ThreadReadCacheBeginResponse = typeof ThreadReadCacheBeginResponse.Type;

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
