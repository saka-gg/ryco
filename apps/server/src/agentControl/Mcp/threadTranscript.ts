/**
 * The bounded transcript page `ryco_read_thread` returns and `ryco thread read`
 * prints: a thread summary and its messages, each message capped and the page
 * held to one text budget, a cut message with a continuation, and on a first page the
 * thread's follow-up queue. No services, so the CLI loads it without the read services;
 * the paging rules that cut a text load on first use.
 *
 * @module agentControl/Mcp/threadTranscript
 */
import {
  AGENT_CONTROL_MCP_MESSAGE_LIMIT_DEFAULT,
  AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX,
  AGENT_CONTROL_MCP_MESSAGE_PAGE_MAX_CHARS,
  AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS,
  AGENT_CONTROL_MCP_QUEUED_TEXT_MAX_CHARS,
  AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS,
  AGENT_CONTROL_TASK_RESULT_MAX_CHARS,
  AgentControlMcpReadThreadResult,
  type AgentControlMcpMessage,
  type AgentControlMcpQueuedFollowUp,
  type AgentControlMcpThreadSummary,
  type OrchestrationMessage,
  type OrchestrationThreadHistoryPageInfo,
  type OrchestrationThreadShell,
  type ThreadFollowUpQueue,
} from "@ryco/contracts";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { Effect, Schema } from "effect";

import type { PageLimits } from "../messagePages.ts";
import { redactAgentControlSecretText } from "../secretRedaction.ts";

/** Paging rules, loaded on the first read that cuts a text so they stay off the boot path. */
export const loadMessagePages = Effect.promise(() => import("../messagePages.ts"));

export const MESSAGE_PAGE_LIMITS: PageLimits = {
  messageMaxChars: AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS,
  pageBudgetChars: AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS,
  continuationMaxChars: AGENT_CONTROL_MCP_MESSAGE_PAGE_MAX_CHARS,
  taskResultMaxChars: AGENT_CONTROL_TASK_RESULT_MAX_CHARS,
};

/** How many messages one page holds: `requested`, else the default, never above the maximum. */
export const readThreadMessageLimit = (requested: number | undefined): number =>
  Math.min(
    requested ?? AGENT_CONTROL_MCP_MESSAGE_LIMIT_DEFAULT,
    AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX,
  );

/** The thread fields a summary reads: a shell or a thread window's thread. */
export type ThreadSummarySource = Pick<
  OrchestrationThreadShell,
  "id" | "projectId" | "title" | "session" | "archivedAt" | "createdAt" | "updatedAt"
>;

export const toThreadSummary = (shell: ThreadSummarySource): AgentControlMcpThreadSummary => ({
  threadId: shell.id,
  projectId: shell.projectId,
  title: shell.title,
  status: shell.session?.status ?? "idle",
  activeTurnId: shell.session?.activeTurnId ?? null,
  providerInstanceId: shell.session?.providerInstanceId ?? null,
  archived: shell.archivedAt !== null,
  createdAt: shell.createdAt,
  updatedAt: shell.updatedAt,
});

const toWholeMcpMessage = (message: OrchestrationMessage): AgentControlMcpMessage => ({
  messageId: message.id,
  role: message.role,
  text: message.text,
  truncated: false,
  turnId: message.turnId,
  attachmentCount: message.attachments?.length ?? 0,
  createdAt: message.createdAt,
});

/**
 * Messages of a page as they are, or null when one of them must be cut (longer than the
 * per-message cap, or past the page's text budget): those pages go through the lazy
 * paging rules, which add continuations.
 */
const wholeMcpMessages = (
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<AgentControlMcpMessage> | null => {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    if (message.text.length > AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS) return null;
  }
  if (total > AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS) return null;
  return messages.map(toWholeMcpMessage);
};

/**
 * A thread's follow-up queue as a page shows it: who queued what, each text cut short. A hold's
 * detail can be a provider's raw error, so it is redacted like other diagnostics an agent reads.
 */
export const toMcpFollowUpQueue = (
  queue: ThreadFollowUpQueue,
  /** `ryco_queue_list`: marks the caller's own entries and names each one's revision. */
  caller?: { readonly threadId: string },
): NonNullable<AgentControlMcpReadThreadResult["followUpQueue"]> => ({
  hold:
    queue.hold === null
      ? null
      : {
          reason: queue.hold.reason,
          detail:
            queue.hold.detail === null
              ? null
              : redactDiagnosticText(
                  redactAgentControlSecretText(queue.hold.detail.slice(0, 2_000)),
                ),
          heldAt: queue.hold.heldAt,
        },
  entries: queue.entries.map((entry): AgentControlMcpQueuedFollowUp => {
    const truncated = entry.text.length > AGENT_CONTROL_MCP_QUEUED_TEXT_MAX_CHARS;
    return {
      messageId: entry.messageId,
      author: entry.author,
      ...(caller === undefined
        ? {}
        : { revision: entry.revision, mine: entry.queuedBy === caller.threadId }),
      status: entry.status,
      text: truncated ? entry.text.slice(0, AGENT_CONTROL_MCP_QUEUED_TEXT_MAX_CHARS) : entry.text,
      ...(truncated ? { textTruncated: true as const } : {}),
      attachmentCount: entry.attachments.length,
      createdAt: entry.createdAt,
    };
  }),
});

/** A bounded transcript page, as `ryco_read_thread` returns it and `ryco thread read` prints it. */
export const toReadThreadResult = (input: {
  readonly shell: ThreadSummarySource;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly pageInfo: OrchestrationThreadHistoryPageInfo;
  /** The thread's follow-up queue, on a first page only; shown unless it is empty. */
  readonly followUpQueue?: ThreadFollowUpQueue | undefined;
  /**
   * Every message whole, none cut: `ryco thread read` holds the messages in full already, and
   * prints them so (no page budget applies to it).
   */
  readonly wholeMessages?: boolean;
}) =>
  Effect.gen(function* () {
    const messages =
      input.wholeMessages === true
        ? input.messages.map(toWholeMcpMessage)
        : (wholeMcpMessages(input.messages) ??
          (yield* loadMessagePages).toBudgetedMcpMessages(input.messages, MESSAGE_PAGE_LIMITS));
    const queue = input.followUpQueue;
    return Schema.encodeSync(AgentControlMcpReadThreadResult)({
      thread: toThreadSummary(input.shell),
      messages,
      hasMoreBefore: input.pageInfo.hasMoreBefore,
      nextCursor: input.pageInfo.hasMoreBefore ? input.pageInfo.oldestCursor : null,
      ...(queue === undefined || queue.entries.length === 0
        ? {}
        : { followUpQueue: toMcpFollowUpQueue(queue) }),
    });
  });
