import type {
  EnvironmentApi,
  EnvironmentId,
  MessageId,
  OrchestrationGetMessageTextResult,
  ThreadId,
} from "@ryco/contracts";

/** What a message row says around a preview of a very long message, on web and phone alike. */
export const MESSAGE_TEXT_PREVIEW_COPY = {
  show: (fullLength: number) =>
    `Show whole message (${fullLength.toLocaleString("en-US")} characters)`,
  loading: "Loading whole message…",
  failed: "Couldn't load the whole message.",
  retry: "Retry",
  tooLong: "This message is too long to show whole.",
} as const;

export interface WholeMessageTextInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId | string;
  /** The environment's `orchestration.getMessageText`; absent on a server without it. */
  readonly read: EnvironmentApi["orchestration"]["getMessageText"];
  /**
   * Puts the whole text into the thread store (`setWholeMessageText`), so the
   * row, copy, search and caches all see it. Not called for a text still cut
   * short (longer than one response): that one stays a preview.
   */
  readonly apply: (text: string) => void;
}

const inFlight = new Map<string, Promise<OrchestrationGetMessageTextResult>>();

/**
 * Reads the whole text of a message a window or history page sent as a
 * preview (`OrchestrationMessage.textPreview`, `orchestration.getMessageText`)
 * and puts it into the store. Requests for the same message while one runs
 * share it. Rejects when the read fails.
 */
export function loadWholeMessageText(
  input: WholeMessageTextInput,
): Promise<OrchestrationGetMessageTextResult> {
  const key = `${input.environmentId}\u0000${input.threadId}\u0000${input.messageId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const read = input.read;
  if (!read) return Promise.reject(new Error("This environment cannot load the whole message."));
  const request = read({ threadId: input.threadId, messageId: input.messageId as MessageId })
    .then((result) => {
      if (!result.truncated) input.apply(result.text);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
