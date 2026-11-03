/**
 * The boot side of the follow-up queue's rules (`followUpQueue.ts`): a cached `import()` of
 * them, with the boot-side rules they use, and the cheap check that tells the decider whether a
 * command's events concern a queue at all. Until a thread has a queue, the rules never load.
 *
 * @module followUpQueueLoader
 */
import {
  AGENT_CONTROL_MESSAGE_ID_PREFIX,
  DEFAULT_AGENT_TOKEN_MODE,
  MAX_FOLLOW_UP_QUEUE_ENTRIES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  SERVER_MINTED_MESSAGE_ID_PREFIXES,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { Effect } from "effect";

import { isThreadLive, isThreadTrashed, threadLifecycleTurnBlocker } from "./commandInvariants.ts";
import { isUserOriginatedCommandId } from "./commandOrigin.ts";
import { reservedForkItemIdBlocker } from "./forkInheritance.ts";
import type { FollowUpQueueDraft, FollowUpQueueHost, FollowUpQueueRules } from "./followUpQueue.ts";
import { runtimeModePrivilegeRank } from "./serverWake.ts";
import { findThreadInArray } from "./threadIndex.ts";
import { threadReferencesPayload } from "./threadReferences.ts";

const host: FollowUpQueueHost = {
  isThreadLive,
  isThreadTrashed,
  threadLifecycleTurnBlocker,
  reservedForkItemIdBlocker,
  runtimeModePrivilegeRank,
  findThread: (threads, threadId) => findThreadInArray(threads, threadId),
  threadReferencesPayload,
  orphanedSessionError: ORPHANED_PROVIDER_SESSION_ERROR,
  isUserOriginatedCommandId,
  maxEntries: MAX_FOLLOW_UP_QUEUE_ENTRIES,
  maxAttachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  defaultTokenMode: DEFAULT_AGENT_TOKEN_MODE,
  serverMintedMessageIdPrefixes: SERVER_MINTED_MESSAGE_ID_PREFIXES,
  agentControlMessageIdPrefix: AGENT_CONTROL_MESSAGE_ID_PREFIX,
};

let loaded: Promise<FollowUpQueueRules> | undefined;

/** The queue rules, loaded once per process on first use. */
export const loadFollowUpQueueRules: Effect.Effect<FollowUpQueueRules> = Effect.promise(
  () =>
    (loaded ??= import("./followUpQueue.ts").then((module) => module.makeFollowUpQueueRules(host))),
);

/**
 * Whether any of `events` belongs to a thread whose queue holds an entry or a hold: only then can
 * the command's events cause queue events (`FollowUpQueueRules.followOns`). One indexed lookup
 * per thread, so commands of threads without a queue never load the rules.
 */
export function followUpQueueConcernedBy(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Pick<OrchestrationEvent, "aggregateKind" | "aggregateId">>,
): boolean {
  let checked: string | undefined;
  for (const event of events) {
    if (event.aggregateKind !== "thread" || event.aggregateId === checked) continue;
    checked = event.aggregateId;
    if (findThreadInArray(readModel.threads, checked)?.followUpQueue !== undefined) return true;
  }
  return false;
}

/** When a queue draft happened: its own timestamp, for the event envelope. */
export function followUpQueueDraftOccurredAt(draft: FollowUpQueueDraft): string {
  switch (draft.type) {
    case "thread.queue-entry-added":
    case "thread.queue-entry-edited":
      return draft.payload.entry.updatedAt;
    case "thread.turn-steer-requested":
      return draft.payload.requestedAt;
    default:
      return draft.payload.updatedAt;
  }
}
