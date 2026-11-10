import type {
  EnvironmentApi,
  EnvironmentId,
  MessageId,
  OrchestrationGetMessageTextResult,
  ThreadId,
} from "@ryco/contracts";

import {
  createKeyedQueryRegistry,
  defineKeyedQueryByKey,
  KEY_SEP,
  type KeyedQueryByKey,
} from "../../rpc/keyedQuery.ts";

/** A finished message's text never changes, so a fetched one stays fresh until collected. */
export const MESSAGE_TEXT_STALE_TIME_MS = Number.POSITIVE_INFINITY;
/** Long enough to scroll away from a message and back, short enough to drop MBs of text. */
export const MESSAGE_TEXT_GC_TIME_MS = 5 * 60_000;
export const MESSAGE_TEXT_MAX_ENTRIES = 16;

export interface MessageTextQueryState {
  readonly data: OrchestrationGetMessageTextResult | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

export interface MessageTextInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** Null while the whole text is not wanted: the message is whole, or not expanded. */
  readonly messageId: MessageId | string | null;
}

export type MessageTextQuery = KeyedQueryByKey<
  MessageTextInput,
  OrchestrationGetMessageTextResult,
  MessageTextQueryState
>;

const INITIAL_QUERY_STATE: MessageTextQueryState = Object.freeze({
  data: null,
  isLoading: false,
  error: null,
});

/**
 * The whole text of a message a window or history page sent as a preview
 * (`OrchestrationMessage.textPreview`), read when the user asks for all of it
 * (`orchestration.getMessageText`). Each app builds one over its own
 * environment API lookup; the lookup runs per request, never at module load.
 */
export function createMessageTextQuery(options: {
  readonly resolveGetMessageText: (
    environmentId: EnvironmentId,
  ) => EnvironmentApi["orchestration"]["getMessageText"];
}): { readonly query: MessageTextQuery; readonly resetForTests: () => void } {
  const registry = createKeyedQueryRegistry<MessageTextQueryState>({
    labelPrefix: "message-text",
    initialState: INITIAL_QUERY_STATE,
    gcTime: MESSAGE_TEXT_GC_TIME_MS,
    maxEntries: MESSAGE_TEXT_MAX_ENTRIES,
    buildFetchingState: (current) => ({
      data: current.data,
      isLoading: current.data === null,
      error: null,
    }),
    buildSuccessState: (data) => ({
      data: data as OrchestrationGetMessageTextResult,
      isLoading: false,
      error: null,
    }),
    buildErrorState: (current, error) => ({ data: current.data, isLoading: false, error }),
    isErrorState: (state) => state.error !== null,
  });
  const query: MessageTextQuery = defineKeyedQueryByKey(
    registry,
    {
      label: "messageText",
      staleTime: MESSAGE_TEXT_STALE_TIME_MS,
      isEnabled: (input: MessageTextInput) =>
        input.environmentId !== null && input.threadId !== null && input.messageId !== null,
      buildKey: (input: MessageTextInput) =>
        `${input.environmentId}${KEY_SEP}${input.threadId}${KEY_SEP}${input.messageId}`,
      resolveEnvironmentId: (input: MessageTextInput) => input.environmentId as EnvironmentId,
      run: (input: MessageTextInput) => {
        const read = options.resolveGetMessageText(input.environmentId as EnvironmentId);
        if (!read) {
          return Promise.reject(new Error("This environment cannot load the whole message."));
        }
        return read({
          threadId: input.threadId as ThreadId,
          messageId: input.messageId as MessageId,
        });
      },
      createControllerFields: () => ({}),
    },
    (controller) => !controller.hasData,
  );
  return { query, resetForTests: () => registry.resetForTests() };
}

export interface MessageTextView {
  readonly status: "idle" | "loading" | "loaded" | "error";
  /** The text to show: the whole text once loaded, else the preview the message holds. */
  readonly text: string;
  /** Whether what `text` shows is still cut short (a preview, or longer than one response). */
  readonly truncated: boolean;
  /** Length of the whole text, when the message is a preview. */
  readonly fullLength: number | null;
}

/**
 * What a message row shows: its own text when whole; for a preview, the head
 * it holds until the whole text was asked for and arrived.
 */
export function resolveMessageTextView(
  message: { readonly text: string; readonly textPreview?: { readonly fullLength: number } },
  cacheKey: string | null,
  state: MessageTextQueryState,
): MessageTextView {
  const preview = message.textPreview;
  if (preview === undefined) {
    return { status: "idle", text: message.text, truncated: false, fullLength: null };
  }
  if (cacheKey !== null && state.data) {
    return {
      status: "loaded",
      text: state.data.text,
      truncated: state.data.truncated,
      fullLength: state.data.fullLength,
    };
  }
  return {
    status: cacheKey === null ? "idle" : state.error ? "error" : "loading",
    text: message.text,
    truncated: true,
    fullLength: preview.fullLength,
  };
}
