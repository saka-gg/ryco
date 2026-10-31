/**
 * How a chat shows a message another chat sent it: who sent it, how that chat relates to this
 * one, and what happened. A delegated task reporting back is not the task taking charge of its
 * parent, so the copy names the sender and its relation and never a manager.
 */
import type { ThreadId } from "@ryco/contracts";
import type { ThreadLineage } from "@ryco/contracts/orchestration";
import {
  agentSentMessageSenderThreadId,
  isAgentSentMessageId,
  isDelegationResultMessageId,
  parseDelegationReturnSections,
  type DelegationReturnSection,
} from "@ryco/shared/interThreadMessage";

import { isDelegatedThreadLineage } from "./threadLineage.ts";

export type { DelegationReturnSection } from "@ryco/shared/interThreadMessage";

export type InterThreadMessage =
  /** An agent's `ryco_send_message`. No sender when the node predates it or no chat sent it. */
  | { readonly kind: "agent-message"; readonly senderThreadId: ThreadId | null }
  /** Results of tasks this chat delegated. Empty sections when the text has none known. */
  | {
      readonly kind: "delegation-result";
      readonly sections: ReadonlyArray<DelegationReturnSection>;
    };

/** A message from another chat, from its node-minted id; null for any other message. */
export function interThreadMessageOf(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
}): InterThreadMessage | null {
  const id = message.id;
  if (message.role !== "user" || id === undefined) return null;
  if (isAgentSentMessageId(id)) {
    return {
      kind: "agent-message",
      senderThreadId: agentSentMessageSenderThreadId(id) as ThreadId | null,
    };
  }
  if (isDelegationResultMessageId(id)) {
    return { kind: "delegation-result", sections: parseDelegationReturnSections(message.text) };
  }
  return null;
}

/**
 * How the sending chat relates to this one: a task this chat delegated, the chat that delegated
 * this one, or neither.
 */
export type InterThreadRelation = "delegated-task" | "delegating-parent" | "unlinked";

export function interThreadRelationOf(input: {
  readonly threadId: ThreadId;
  readonly threadLineage: ThreadLineage | null | undefined;
  readonly senderThreadId: ThreadId | null;
  readonly senderLineage: ThreadLineage | null | undefined;
}): InterThreadRelation {
  if (input.senderThreadId === null) return "unlinked";
  if (
    isDelegatedThreadLineage(input.senderLineage) &&
    input.senderLineage.parentThreadId === input.threadId
  ) {
    return "delegated-task";
  }
  if (
    isDelegatedThreadLineage(input.threadLineage) &&
    input.threadLineage.parentThreadId === input.senderThreadId
  ) {
    return "delegating-parent";
  }
  return "unlinked";
}

export const INTER_THREAD_COPY = {
  /** What the sender did, after its name. */
  verb: {
    "delegated-task": "reported back",
    "delegating-parent": "sent a follow-up",
    unlinked: "sent a message",
  } satisfies Record<InterThreadRelation, string>,
  /** The relation line under it. */
  relation: {
    "delegated-task": "your delegated task",
    "delegating-parent": "delegated this chat",
    unlinked: "not linked to this chat",
  } satisfies Record<InterThreadRelation, string>,
  delegatedTasks: "your delegated tasks",
  /** A message whose id names no chat (an external integration, or an older node). */
  unknownSender: "Another agent",
  /** A chat this client does not know (yet). */
  unknownThread: "Another chat",
  /** A returned task this client does not know (yet). */
  unknownTask: "A delegated task",
  /** A returned task with no summary. */
  noSummary: "It returned no summary.",
} as const;

const RETURN_VERBS: Readonly<Record<string, string>> = {
  completed: "finished and returned its result",
  error: "failed",
  interrupted: "was interrupted",
  stopped: "stopped without finishing",
  "start-failed": "failed to start",
  advanced: "got a follow-up before its result",
  archived: "was archived",
  "request-failed": "was never created",
  expired: "ran out of time",
};

/** What a returned task did, after its name ("finished and returned its result"). */
export function delegationReturnVerb(section: Pick<DelegationReturnSection, "state">): string {
  return RETURN_VERBS[section.state] ?? "returned";
}

export type DelegationReturnTone = "success" | "danger" | "muted";

export function delegationReturnTone(
  section: Pick<DelegationReturnSection, "state">,
): DelegationReturnTone {
  if (section.state === "completed") return "success";
  if (section.state === "error" || section.state === "start-failed") return "danger";
  return "muted";
}

/** The heading of a result with several tasks ("3 delegated tasks reported back"). */
export function delegationReturnsHeadline(count: number): string {
  return `${count} delegated tasks reported back`;
}
