/**
 * Lossless paging of long texts for Agent Control reads (`ryco_read_thread`,
 * `ryco_task_status`): a page names where it starts, how long the whole text is and
 * where the next page starts, and a version that changes whenever the text does, so a
 * reader never stitches pages of two different texts together.
 *
 * Offsets count UTF-16 code units (JavaScript string indices), and a page never ends
 * between the two halves of a surrogate pair.
 *
 * Pure, and loaded through `import()` on the first read that cuts a text, so it stays off
 * the server boot path. It imports no values (callers pass the limits): a value import
 * shared with boot code would make the bundler split a shared chunk into boot.
 *
 * @module agentControl/messagePages
 */
import { createHash } from "node:crypto";
import type {
  AgentControlMcpMessage,
  AgentControlMcpMessageContinuation,
  AgentControlTaskStatusEntry,
  OrchestrationMessage,
} from "@ryco/contracts";

/** The caps a page read obeys (`AGENT_CONTROL_MCP_*`, `AGENT_CONTROL_TASK_RESULT_MAX_CHARS`). */
export interface PageLimits {
  /** Per message in a history page. */
  readonly messageMaxChars: number;
  /** All messages of a history page together. */
  readonly pageBudgetChars: number;
  /** One continuation slice of one message. */
  readonly continuationMaxChars: number;
  /** One page of a task result. */
  readonly taskResultMaxChars: number;
}

export interface TextPage {
  readonly text: string;
  readonly offsetChars: number;
  readonly totalChars: number;
  /** Null once the page reaches the end of the text. */
  readonly nextOffsetChars: number | null;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Whether `offset` falls between the two halves of a surrogate pair. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  return isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset));
}

/**
 * The page of at most `maxChars` starting at `offsetChars`, or null when the offset is
 * past the end or inside a surrogate pair. A page that would end inside a pair ends
 * before it, unless that would leave it empty: then it takes the whole pair. A
 * `maxChars` of 0 gives an empty page that points at `offsetChars`.
 */
export function pageText(text: string, offsetChars: number, maxChars: number): TextPage | null {
  if (offsetChars > text.length || splitsSurrogatePair(text, offsetChars)) return null;
  if (maxChars <= 0) {
    return {
      text: "",
      offsetChars,
      totalChars: text.length,
      nextOffsetChars: offsetChars < text.length ? offsetChars : null,
    };
  }
  let end = Math.min(text.length, offsetChars + maxChars);
  if (splitsSurrogatePair(text, end)) end = end - 1 > offsetChars ? end - 1 : end + 1;
  return {
    text: text.slice(offsetChars, end),
    offsetChars,
    totalChars: text.length,
    nextOffsetChars: end < text.length ? end : null,
  };
}

/** An opaque version of a message's text: it changes whenever the text does. */
export function textVersion(input: { readonly id: string; readonly text: string }): string {
  return createHash("sha256")
    .update(input.id)
    .update("\u0000")
    .update(input.text)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * One message as a page of at most `maxChars` from `offsetChars`. A slice of a settled
 * message carries its continuation; a streaming message has none (its text still
 * changes), so the reader reads it again once it settles.
 */
const toMcpMessage = (
  message: OrchestrationMessage,
  maxChars: number,
  offsetChars = 0,
): AgentControlMcpMessage => {
  // Offset 0 is always a valid page start.
  const page = pageText(message.text, offsetChars, maxChars)!;
  const truncated = page.offsetChars > 0 || page.nextOffsetChars !== null;
  return {
    messageId: message.id,
    role: message.role,
    text: page.text,
    truncated,
    turnId: message.turnId,
    attachmentCount: message.attachments?.length ?? 0,
    createdAt: message.createdAt,
    ...(truncated && !message.streaming
      ? {
          version: textVersion(message),
          offsetChars: page.offsetChars,
          totalChars: page.totalChars,
          nextOffsetChars: page.nextOffsetChars,
        }
      : {}),
  };
};

/**
 * Map an ascending-order page under the aggregate transcript budget. Newest messages
 * keep their text (up to the per-message cap); once the budget is exhausted walking
 * backwards, older messages are cut (possibly to empty) and carry a continuation. The
 * message set itself is untouched, so history cursors stay exact, and the bounded page
 * can never blow the listener's response cap.
 */
export const toBudgetedMcpMessages = (
  messages: ReadonlyArray<OrchestrationMessage>,
  limits: PageLimits,
): ReadonlyArray<AgentControlMcpMessage> => {
  let remaining = limits.pageBudgetChars;
  const bounded: AgentControlMcpMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = toMcpMessage(messages[index]!, Math.min(limits.messageMaxChars, remaining));
    remaining = Math.max(0, remaining - message.text.length);
    bounded.push(message);
  }
  return bounded.reverse();
};

/** The next slice of one long message, or why it cannot be read. */
export const continueMessage = (
  message: OrchestrationMessage,
  continuation: AgentControlMcpMessageContinuation,
  limits: PageLimits,
): { readonly message: AgentControlMcpMessage } | { readonly failure: string } => {
  if (message.streaming) {
    return { failure: "The message is still streaming. Read the thread again after it settles." };
  }
  if (textVersion(message) !== continuation.version) {
    return {
      failure: "The message changed since that version. Read the thread again before continuing.",
    };
  }
  if (pageText(message.text, continuation.offsetChars, 0) === null) {
    return { failure: "Invalid offset for this message." };
  }
  return {
    message: toMcpMessage(message, limits.continuationMaxChars, continuation.offsetChars),
  };
};

type TaskResult = NonNullable<AgentControlTaskStatusEntry["result"]>;

/**
 * A delegated task's result as one page, or null when a continuation no longer fits it.
 * `whole` is the reply message read whole (null for a list, a streaming reply or a result
 * of attachment notes): it is redacted as a whole and then cut, so pages line up and a
 * secret is never shown in pieces. Otherwise only the start (`text`, already cut a little
 * past the page) is shown, without a continuation.
 */
export const pageTaskResult = (input: {
  readonly state: TaskResult["state"];
  readonly text: string;
  readonly whole: OrchestrationMessage | null;
  readonly redact: (text: string) => string;
  readonly continuation: { readonly version: string; readonly offsetChars: number } | undefined;
  readonly limits: PageLimits;
}): TaskResult | null => {
  const whole = input.whole !== null && !input.whole.streaming ? input.whole : null;
  const text = input.redact(whole !== null ? whole.text : input.text);
  const version = whole !== null ? textVersion({ id: whole.id, text }) : null;
  if (input.continuation !== undefined && input.continuation.version !== version) return null;
  const maxChars = input.limits.taskResultMaxChars;
  const page = pageText(text, input.continuation?.offsetChars ?? 0, maxChars);
  if (page === null) return null;
  const truncated =
    page.offsetChars > 0 ||
    page.nextOffsetChars !== null ||
    (whole === null && input.text.length > maxChars);
  return {
    untrustedChildOutput: true,
    state: input.state,
    text: page.text,
    truncated,
    ...(truncated && version !== null
      ? {
          version,
          offsetChars: page.offsetChars,
          totalChars: page.totalChars,
          nextOffsetChars: page.nextOffsetChars,
        }
      : {}),
  };
};
