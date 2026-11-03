/**
 * Messages one chat receives from another: an agent's `ryco_send_message` and the result of a
 * task the chat delegated. Both are user-role messages the node mints (and refuses from
 * clients), so their ids carry where they came from: the node builds them here and clients
 * read them back to show the sending chat instead of "another agent".
 *
 * @module interThreadMessage
 */
import {
  AGENT_CONTROL_MESSAGE_ID_PREFIX,
  AGENT_SENT_MESSAGE_ID_SUFFIX,
  DELEGATION_RESULT_MESSAGE_ID_PREFIX,
} from "@ryco/contracts/orchestration";

/** Marks the sending chat inside an agent-sent message id; operation slugs hold no colon. */
const AGENT_SENT_MESSAGE_SENDER_MARKER = "-from:";

/**
 * The id of an agent's message to another chat:
 * `message-agent-control-<operation>-from:<sender>-send-message`, or without `-from:<sender>`
 * when no chat sent it (an external integration). The id keeps its suffix, so clients that
 * predate the sender still fold it as another agent's message.
 */
export function agentSentMessageId(input: {
  readonly operationSlug: string;
  readonly senderThreadId: string | null;
}): string {
  const sender =
    input.senderThreadId === null
      ? ""
      : `${AGENT_SENT_MESSAGE_SENDER_MARKER}${encodeURIComponent(input.senderThreadId)}`;
  return `${AGENT_CONTROL_MESSAGE_ID_PREFIX}${input.operationSlug}${sender}${AGENT_SENT_MESSAGE_ID_SUFFIX}`;
}

export function isAgentSentMessageId(id: string): boolean {
  return (
    id.startsWith(AGENT_CONTROL_MESSAGE_ID_PREFIX) && id.endsWith(AGENT_SENT_MESSAGE_ID_SUFFIX)
  );
}

/** The chat that sent an agent-sent message; null when the id names none (older nodes). */
export function agentSentMessageSenderThreadId(id: string): string | null {
  if (!isAgentSentMessageId(id)) return null;
  const middle = id.slice(
    AGENT_CONTROL_MESSAGE_ID_PREFIX.length,
    id.length - AGENT_SENT_MESSAGE_ID_SUFFIX.length,
  );
  const marker = middle.indexOf(AGENT_SENT_MESSAGE_SENDER_MARKER);
  if (marker < 0) return null;
  const encoded = middle.slice(marker + AGENT_SENT_MESSAGE_SENDER_MARKER.length);
  try {
    const senderThreadId = decodeURIComponent(encoded);
    return senderThreadId.trim().length > 0 ? senderThreadId : null;
  } catch {
    return null;
  }
}

export function isDelegationResultMessageId(id: string): boolean {
  return id.startsWith(DELEGATION_RESULT_MESSAGE_ID_PREFIX);
}

/** One returned task of a delegation result message. */
export interface DelegationReturnSection {
  /** The delegated chat; null when its line is missing. */
  readonly childThreadId: string | null;
  /** `result`: the task's own output. `notice`: a node-written note, no output. */
  readonly kind: "result" | "notice";
  /** `completed` and `error` for results; the notice's outcome (`interrupted`, `expired`…). */
  readonly state: string;
  /** The task's summary, or the notice's sentence. */
  readonly text: string;
}

const SECTION_SPLIT = /\n\n\[\d+\/\d+\]\n/;
const SECTION_HEAD = /^Delegated (initial-run result|result|task notice) \(([a-z-]+)[,)]/m;
const CHILD_LINE = /^Child: \[[^\]]*\]\(\/ryco\/thread\/([^)\s]+)\)$/m;
const NOTICE_LEAD_LINE = /^(?:Child|Origin|Initial message): /;

function decodeThreadId(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function resultText(section: string): string {
  const json = section.split("\n").findLast((line) => line.startsWith("{") && line.endsWith("}"));
  if (json === undefined) return "";
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return "";
    const { summary, error } = parsed as { readonly summary?: unknown; readonly error?: unknown };
    if (typeof summary === "string" && summary.trim().length > 0) return summary;
    return typeof error === "string" ? error : "";
  } catch {
    return "";
  }
}

/**
 * The returned tasks of a delegation result message, in order. Reads the sections the node
 * renders (`completionReturnMessages.ts`); empty when the text has none it knows.
 */
export function parseDelegationReturnSections(text: string): DelegationReturnSection[] {
  const sections: DelegationReturnSection[] = [];
  for (const section of text.split(SECTION_SPLIT).slice(1)) {
    const head = SECTION_HEAD.exec(section);
    if (head === null) continue;
    const childLine = CHILD_LINE.exec(section);
    const childThreadId = childLine === null ? null : decodeThreadId(childLine[1]!);
    const kind = head[1] === "task notice" ? "notice" : "result";
    sections.push({
      childThreadId,
      kind,
      state: head[2]!,
      text:
        kind === "result"
          ? resultText(section)
          : section
              .split("\n")
              .slice(1)
              .filter((line) => !NOTICE_LEAD_LINE.test(line))
              .join("\n")
              .trim(),
    });
  }
  return sections;
}
