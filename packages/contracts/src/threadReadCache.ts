import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ThreadId, TurnId } from "./baseSchemas.ts";
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

/** A non-negative safe integer (generations, revisions, timestamps). */
export const ThreadReadCacheSafeCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
const envelope = {
  protocolVersion: Schema.Literal(1),
  generation: ThreadReadCacheSafeCounter,
  revision: ThreadReadCacheSafeCounter,
  storedAt: ThreadReadCacheSafeCounter,
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

// What a node uploads (proofs, begin, snapshot items and patches) lives in
// `@ryco/contracts/thread-read-cache-upload`: only nodes and the Hub load it, never a client boot.
