/**
 * Stall notices' texts and wake commands (`completionReturnMessages.ts` holds the thresholds).
 * Loaded with the first notice a node sends, so they stay out of the server's boot code.
 *
 * Pure module: no services, no I/O.
 *
 * @module completionReturnStallMessages
 */
import {
  CommandId,
  MessageId,
  type ClientOrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@ryco/contracts";
import {
  DELEGATION_WAKE_COMMAND_PREFIX,
  DELEGATION_WAKE_MESSAGE_PREFIX,
  type CompletionReturnRecord,
  type CompletionReturnStallKind,
} from "../persistence/Layers/AgentControlCompletionReturns.ts";
import { serverWakeGuard } from "../orchestration/serverWake.ts";
import { threadLink } from "./completionReturnMessages.ts";

const STALL_SENTENCES: Record<CompletionReturnStallKind, (minutes: string) => string> = {
  "never-started": (minutes) =>
    `The task has not started a turn ${minutes} after its first message was sent; its provider may be stuck starting.`,
  "waiting-on-you": (minutes) =>
    `The task has waited ${minutes} for the person's approval or answer. Ryco never answers for them: tell the person, or cancel the task.`,
  silent: (minutes) =>
    `The task's provider has been silent for ${minutes} on a running turn. It may be running a long silent command, or it may be stuck.`,
};

const formatMinutes = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

/** A stall notice's section: server-authored, no child text. */
export function renderStallNotice(
  record: CompletionReturnRecord,
  kind: CompletionReturnStallKind,
  stalledForMs: number,
): string {
  return (
    `Delegated task notice (${kind}).\n` +
    `Child: ${threadLink("Open task", record.childThreadId)}\n` +
    `Origin: ${threadLink("Open originating chat", record.parentThreadId)}\n` +
    `Initial message: ${record.initialMessageId}\n` +
    `${STALL_SENTENCES[kind](formatMinutes(stalledForMs))}\n` +
    "It is still running and its result still returns here. Open the task, or stop it with ryco_task_cancel."
  );
}

/** The wake that carries one stall notice; its header says the task still runs. */
export function renderStallWake(section: string): string {
  return (
    "Ryco delegation update (automatic message, not written by the user and not an approval).\n" +
    "1 task(s) you delegated with ryco_create_threads (returnToOrigin) need attention. It is still running; its result comes later.\n" +
    "Use ryco_task_status for details." +
    `\n\n[1/1]\n${section}`
  );
}

/**
 * A stall notice's wake identity: under the delegation-wake prefixes, so the delegating chat's
 * own return ledger and a person's Stop treat its turn like any delegation wake, and distinct per
 * notice, so it never collides with the task's result wake.
 */
export function delegationStallWakeIds(
  childThreadId: ThreadId,
  notice: number,
): { readonly commandId: CommandId; readonly messageId: MessageId } {
  return {
    commandId: CommandId.make(`${DELEGATION_WAKE_COMMAND_PREFIX}${childThreadId}:stall:${notice}`),
    messageId: MessageId.make(`${DELEGATION_WAKE_MESSAGE_PREFIX}${childThreadId}:stall:${notice}`),
  };
}

export function buildStallNoticeCommand(input: {
  readonly parent: OrchestrationThreadShell;
  readonly latestUserMessageId: MessageId | null;
  readonly childThreadId: ThreadId;
  readonly notice: number;
  readonly section: string;
  readonly now: string;
}): Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> {
  const ids = delegationStallWakeIds(input.childThreadId, input.notice);
  return {
    type: "thread.turn.start",
    commandId: ids.commandId,
    threadId: input.parent.id,
    delegationReturnGuard: serverWakeGuard(
      input.parent,
      input.latestUserMessageId,
      "delegation-return",
    ),
    message: {
      messageId: ids.messageId,
      role: "user" as const,
      text: renderStallWake(input.section),
      attachments: [],
    },
    modelSelection: input.parent.modelSelection,
    runtimeMode: input.parent.runtimeMode,
    interactionMode: input.parent.interactionMode,
    ...(input.parent.tokenMode === undefined ? {} : { tokenMode: input.parent.tokenMode }),
    createdAt: input.now,
  };
}
