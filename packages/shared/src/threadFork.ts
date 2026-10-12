/**
 * Shared facts about forked threads that the server and every client read the same way:
 * - the identity of history a fork inherited (`<forkThreadId>:inherited:<original id>`) and of
 *   its single `thread.forked` provenance activity (`<forkThreadId>:forked`);
 * - the provenance activity itself, which the server decider writes once when it publishes a
 *   fork and the decider, clients and exports read back;
 * - whether a thread holds a conversation, which a fresh fork does before its first own message.
 *
 * Pure module.
 */
import type { ThreadId } from "@ryco/contracts";
import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
} from "@ryco/contracts/orchestration";
import {
  THREAD_FORKED_ACTIVITY_KIND,
  ThreadForkedActivityPayload,
} from "@ryco/contracts/thread-fork";
import * as Schema from "effect/Schema";

// ── Inherited item identity ───────────────────────────────────────────

/**
 * Joins the fork's thread id and the original id in an inherited item's id.
 *
 * Message, activity and proposed-plan ids are global primary keys, so a fork never reuses its
 * source's ids. The shared prefix keeps the source's `(createdAt, id)` tie order and lets server
 * and client logic that treats inherited history differently (revert retention, timeline order)
 * recognize it without another column.
 */
export const INHERITED_ITEM_ID_SEGMENT = ":inherited:";

export function inheritedItemIdPrefix(forkThreadId: ThreadId | string): string {
  return `${forkThreadId}${INHERITED_ITEM_ID_SEGMENT}`;
}

/**
 * The id the item had where it was first created. A fork of a fork keeps the original id, so the
 * copies' order and the provider's native ids still line up with it.
 */
export function originalItemId(threadId: ThreadId | string, itemId: string): string {
  const prefix = inheritedItemIdPrefix(threadId);
  return itemId.startsWith(prefix) ? itemId.slice(prefix.length) : itemId;
}

/** The id an inherited copy of `sourceItemId` gets in `forkThreadId`. */
export function inheritedItemId(input: {
  readonly forkThreadId: ThreadId | string;
  readonly sourceThreadId: ThreadId | string;
  readonly sourceItemId: string;
}): string {
  return `${inheritedItemIdPrefix(input.forkThreadId)}${originalItemId(input.sourceThreadId, input.sourceItemId)}`;
}

/** Whether `itemId` is history `threadId` inherited when it was forked. */
export function isInheritedItemId(threadId: ThreadId | string, itemId: string): boolean {
  return itemId.startsWith(inheritedItemIdPrefix(threadId));
}

const THREAD_FORKED_ACTIVITY_ID_SUFFIX = ":forked";

/** Id of the single `thread.forked` provenance activity. Not an inherited item. */
export function threadForkedActivityId(forkThreadId: ThreadId | string): string {
  return `${forkThreadId}${THREAD_FORKED_ACTIVITY_ID_SUFFIX}`;
}

/**
 * Whether a checkpoint revert of `threadId` keeps this item whatever checkpoint it targets. A
 * fork's inherited history and its provenance activity predate every checkpoint the fork owns,
 * so no revert of the fork reaches before them. The one rule the server's projections and every
 * client's store apply to a revert; the count-based fallback for own messages must run on the
 * fork's own items only.
 */
export function isForkBaseItemId(threadId: ThreadId | string, itemId: string): boolean {
  return isInheritedItemId(threadId, itemId) || itemId === threadForkedActivityId(threadId);
}

/** The fork a provenance activity id belongs to (`threadForkedActivityId`'s inverse), else null. */
export function threadIdOfForkedActivityId(activityId: string): string | null {
  if (!activityId.endsWith(THREAD_FORKED_ACTIVITY_ID_SUFFIX)) return null;
  const threadId = activityId.slice(0, -THREAD_FORKED_ACTIVITY_ID_SUFFIX.length);
  return threadId.length > 0 ? threadId : null;
}

// ── Lineage ────────────────────────────────────────────────────────────

/** `ThreadLineage.relationship` of a fork: `parentThreadId` is its source. */
export const FORKED_THREAD_RELATIONSHIP = "forked";

/**
 * Whether a thread holds a conversation, which lifecycle actions (archive, confirm before Trash,
 * archive with a removed checkout) treat as a used thread. `latestUserMessageAt` is the thread's
 * own recency and leaves out a fork's inherited prompts, so a fork that has not sent anything yet
 * still counts through its lineage. The rule the server's `isNeverUsedThread` applies too.
 */
export function threadHasConversation(thread: {
  readonly latestUserMessageAt?: string | null | undefined;
  readonly lineage?: { readonly relationship: string } | null | undefined;
}): boolean {
  return (
    thread.latestUserMessageAt != null ||
    thread.lineage?.relationship === FORKED_THREAD_RELATIONSHIP
  );
}

// ── Provenance activity ────────────────────────────────────────────────

interface ActivityLike {
  readonly kind: string;
  readonly payload: unknown;
}

const decodeThreadForkedPayload = Schema.decodeUnknownOption(ThreadForkedActivityPayload);
const decodeContextHandoffPayload = Schema.decodeUnknownOption(ContextHandoffActivityPayload);

/** The fork's provenance, or null for other kinds and payloads this build cannot read. */
export function readThreadForkedActivity(
  activity: ActivityLike,
): ThreadForkedActivityPayload | null {
  if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return null;
  const decoded = decodeThreadForkedPayload(activity.payload);
  return decoded._tag === "Some" ? decoded.value : null;
}

function isConsumedContextHandoff(activity: ActivityLike): boolean {
  if (activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) return false;
  const decoded = decodeContextHandoffPayload(activity.payload);
  return decoded._tag === "Some" && decoded.value.status === "consumed";
}

/**
 * Whether a fork still owes a provider its inherited conversation: it was published with
 * `handoff` provider context and no context handoff has been consumed on it yet. A failed or
 * uncertain handoff keeps it pending, so the next send tries again. Both the decider
 * (`thread.turn.start`) and clients read this one rule. Both activities are milestones, so the
 * activity cap never drops them.
 */
export function forkContextHandoffPending(activities: ReadonlyArray<ActivityLike>): boolean {
  let handoffFork = false;
  for (const activity of activities) {
    if (isConsumedContextHandoff(activity)) return false;
    handoffFork ||= readThreadForkedActivity(activity)?.providerContext === "handoff";
  }
  return handoffFork;
}
