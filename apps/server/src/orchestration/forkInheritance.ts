/**
 * Identity of history a forked thread inherited from its source.
 *
 * Message, activity and proposed-plan ids are global primary keys, so a fork never reuses its
 * source's ids. Inherited items get `<forkThreadId>:inherited:<original id>`. The shared prefix
 * keeps the source's `(createdAt, id)` tie order, and lets server logic that must treat inherited
 * history differently (checkpoint revert retention, baseline capture, provider history repair)
 * recognize it after a restart without another column.
 *
 * The id format itself is defined once in `@ryco/shared/threadFork` (clients order a fork's
 * timeline by it) and re-exported here; this module adds the server-only classifiers.
 *
 * Pure functions, no Effect services.
 */
import { CONTEXT_HANDOFF_ACTIVITY_KIND, THREAD_FORKED_ACTIVITY_KIND } from "@ryco/contracts";
import type {
  OrchestrationThreadActivity,
  ThreadForkedActivityPayload,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import {
  INHERITED_ITEM_ID_SEGMENT,
  isInheritedItemId,
  readThreadForkedActivity,
  threadForkedActivityId,
} from "@ryco/shared/threadFork";

export {
  INHERITED_ITEM_ID_SEGMENT,
  inheritedItemId,
  inheritedItemIdPrefix,
  isForkBaseItemId,
  isInheritedItemId,
  originalItemId,
  threadForkedActivityId,
} from "@ryco/shared/threadFork";

/**
 * Whether a projected turn row belongs to a fork's inherited history. Fork publication sends no
 * turn start, session or checkpoint event, so an inherited turn row is only ever created by an
 * inherited assistant message and its assistant message id is the row's one marker (a fork's
 * own turns start from client message ids, which can never be inherited ids). The SQL twin is
 * `inheritedTurnRowSql` (forkInheritanceSql.ts).
 */
export function isInheritedTurnRow(
  threadId: ThreadId | string,
  turn: { readonly assistantMessageId: string | null },
): boolean {
  return turn.assistantMessageId !== null && isInheritedItemId(threadId, turn.assistantMessageId);
}

/**
 * Inherited turns that did not complete in the fork's source, as `threadId`'s own provenance
 * activity records them; empty for any other activity. An inherited turn row is created from an
 * inherited reply and reads as completed, so the projection applies these outcomes to it once the
 * provenance (published after every inherited message) arrives.
 */
export function inheritedTurnOutcomes(
  threadId: ThreadId | string,
  activity: Pick<OrchestrationThreadActivity, "id" | "kind" | "payload">,
): NonNullable<ThreadForkedActivityPayload["inheritedTurnOutcomes"]> {
  if (activity.id !== threadForkedActivityId(threadId)) return [];
  return readThreadForkedActivity(activity)?.inheritedTurnOutcomes ?? [];
}

/**
 * Why a message id sent into `threadId` is refused, or null when it may be used. Inherited and
 * provenance ids are minted by the server when it publishes a fork; every classifier above keys
 * on them alone. Any `:inherited:` segment is refused (not only this thread's prefix), so a
 * later fork of this thread can never collapse two ids into one inherited copy.
 */
export function reservedForkItemIdBlocker(
  threadId: ThreadId | string,
  messageId: string,
): string | null {
  return messageId.includes(INHERITED_ITEM_ID_SEGMENT) ||
    messageId === threadForkedActivityId(threadId)
    ? `Message id '${messageId}' is reserved for forked history.`
    : null;
}

/**
 * Whether a message counts toward the thread's own user recency (`latestUserMessageAt`). A
 * fork's inherited prompts are its source's activity, not the fork's. The one rule for the
 * projected shell and the server's settlement input, so both agree with clients.
 */
export function countsTowardUserRecency(
  threadId: ThreadId | string,
  message: { readonly role: string; readonly id: string },
): boolean {
  return message.role === "user" && !isInheritedItemId(threadId, message.id);
}

/**
 * The turn a native fork's provider conversation ends at before any turn of its own: the
 * source's boundary turn. Null for a handoff fork (its provider conversation starts with its
 * own first turn) and for threads that were not forked.
 */
export function nativeForkBaseTurnId(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): TurnId | null {
  for (const activity of activities) {
    const forked = readThreadForkedActivity(activity);
    if (forked !== null) return forked.providerContext === "native" ? forked.sourceTurnId : null;
  }
  return null;
}

/** Turns of `threadId`'s inherited history, read from its inherited items. */
export function inheritedTurnIds(
  threadId: ThreadId | string,
  items: Iterable<{ readonly id: string; readonly turnId: string | null }>,
): ReadonlySet<string> {
  const turnIds = new Set<string>();
  for (const item of items) {
    if (item.turnId !== null && isInheritedItemId(threadId, item.id)) turnIds.add(item.turnId);
  }
  return turnIds;
}

const UNINHERITABLE_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  THREAD_FORKED_ACTIVITY_KIND,
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  "history.imported",
]);
const UNINHERITABLE_ACTIVITY_KIND_PREFIXES = [
  "approval.",
  "user-input.",
  "provider.",
  "checkpoint.",
  "task.",
  "background-work.",
  "setup-script.",
] as const;

/**
 * Activity kinds a fork never inherits. They drive server state (pending requests, context
 * handoffs, checkpoint reverts, turn-start intents, background work) or record provenance, so an
 * inherited copy would block, corrupt or mislabel the fork. The decider refuses a fork that
 * carries one; fork planning copies only display-only kinds.
 */
export function isUninheritableActivityKind(kind: string): boolean {
  return (
    UNINHERITABLE_ACTIVITY_KINDS.has(kind) ||
    UNINHERITABLE_ACTIVITY_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix))
  );
}
