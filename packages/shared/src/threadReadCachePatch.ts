/**
 * How a cloud thread history patch (`patch-v1`, `@ryco/contracts/thread-read-cache`) applies to
 * what the Hub stores. The Hub applies uploads with these functions (it vendors this package), and
 * the node's tests check its patches against them, so both sides share one definition.
 *
 * Pure functions over decoded values: no hashing, no I/O. The caller re-validates the result with
 * the contract schema and, for a thread, compares its digest.
 *
 * @module threadReadCachePatch
 */
import type {
  ThreadReadCacheContent,
  ThreadReadCacheShell,
  ThreadReadCacheShellPatch,
  ThreadReadCacheThreadPatch,
} from "@ryco/contracts/thread-read-cache";

export type ThreadReadCachePatchResult<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "conflict"; readonly reason: string };

const conflict = (reason: string) => ({ kind: "conflict", reason }) as const;

/**
 * The stored shell with `patch` applied: rows replaced in place by id, new rows appended in patch
 * order, removed rows dropped; `snapshotSequence` from the patch's revision, `updatedAt` from the
 * patch, and projects, worktrees and settlement policy from `rest` when present.
 */
export function applyThreadReadCacheShellPatch(
  stored: ThreadReadCacheShell,
  patch: ThreadReadCacheShellPatch,
): ThreadReadCachePatchResult<ThreadReadCacheShell> {
  const removed = new Set<string>(patch.removedThreadIds);
  const upserts = new Map<string, ThreadReadCacheShell["threads"][number]>();
  for (const thread of patch.threads) {
    if (upserts.has(thread.id) || removed.has(thread.id)) return conflict("duplicate_thread");
    upserts.set(thread.id, thread);
  }
  const threads: Array<ThreadReadCacheShell["threads"][number]> = [];
  for (const thread of stored.threads) {
    if (removed.has(thread.id)) continue;
    const replacement = upserts.get(thread.id);
    threads.push(replacement ?? thread);
    upserts.delete(thread.id);
  }
  for (const thread of patch.threads) if (upserts.has(thread.id)) threads.push(thread);
  if (threads.length !== patch.threadCount) return conflict("thread_count");
  const rest = patch.rest;
  const worktrees = rest === undefined ? stored.worktrees : rest.worktrees;
  const settlementPolicy = rest === undefined ? stored.settlementPolicy : rest.settlementPolicy;
  return {
    kind: "ok",
    value: {
      snapshotSequence: patch.revision,
      projects: rest === undefined ? stored.projects : rest.projects,
      ...(worktrees === undefined ? {} : { worktrees }),
      threads,
      updatedAt: patch.updatedAt,
      ...(settlementPolicy === undefined ? {} : { settlementPolicy }),
    },
  };
}

/**
 * The stored messages with `patch` applied: from `firstMessageId` on, each replaced by the patch's
 * message with its id, then the patch's messages the stored ones did not hold, in order.
 */
export function applyThreadReadCacheThreadPatch(
  stored: ThreadReadCacheContent,
  patch: ThreadReadCacheThreadPatch,
): ThreadReadCachePatchResult<ThreadReadCacheContent> {
  const start = stored.messages.findIndex((message) => message.id === patch.firstMessageId);
  if (start < 0) return conflict("first_message");
  const replacements = new Map<string, ThreadReadCacheContent["messages"][number]>();
  for (const message of patch.messages) {
    if (replacements.has(message.id)) return conflict("duplicate_message");
    replacements.set(message.id, message);
  }
  const messages: Array<ThreadReadCacheContent["messages"][number]> = [];
  for (const message of stored.messages.slice(start)) {
    messages.push(replacements.get(message.id) ?? message);
    replacements.delete(message.id);
  }
  for (const message of patch.messages) if (replacements.has(message.id)) messages.push(message);
  return { kind: "ok", value: { messages } };
}
