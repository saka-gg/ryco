import type { ChatAttachment, ChatMessage } from "@ryco/client-runtime/state/threads";
import type { MessageId } from "@ryco/contracts";

import type { DraftComposerAttachment } from "../lib/composerFiles";

// A message this device sent that the node has not echoed yet (web's
// `optimisticUserMessages` in ChatView). It shows in the timeline at once and
// the echo, which carries the same message id, replaces it.

export type OptimisticUserMessagePhase =
  /** The send is on its way. */
  | "sending"
  /** The node took the turn; the echo has not arrived yet. */
  | "dispatched"
  /** The send failed while its screen was gone: the draft goes back when the screen returns. */
  | "failed";

export interface OptimisticUserMessage {
  readonly message: ChatMessage;
  readonly phase: OptimisticUserMessagePhase;
  /** The draft as sent, restored to the composer when the send fails. */
  readonly draft: {
    readonly prompt: string;
    readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  };
  readonly error?: string | undefined;
}

/** A thread keeps at most this many unconfirmed sends; older ones drop first. */
export const MAX_OPTIMISTIC_MESSAGES_PER_THREAD = 16;
/** Threads with unconfirmed sends kept at once; the oldest thread drops first. */
export const MAX_OPTIMISTIC_THREADS = 32;

export type OptimisticMessagesByThreadKey = Readonly<
  Record<string, ReadonlyArray<OptimisticUserMessage>>
>;

const NO_MESSAGES: ReadonlyArray<OptimisticUserMessage> = [];

/** The bubble's attachments: local previews of the images, plain rows for files. */
export function optimisticAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ChatAttachment[] {
  return attachments.map((attachment) =>
    attachment.type === "image"
      ? {
          type: "image",
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: attachment.previewUri,
        }
      : {
          type: "file",
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        },
  );
}

export function buildOptimisticUserMessage(input: {
  readonly messageId: MessageId;
  readonly text: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
}): OptimisticUserMessage {
  const attachments = optimisticAttachments(input.attachments);
  return {
    message: {
      id: input.messageId,
      role: "user",
      text: input.text,
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: input.createdAt,
      streaming: false,
    },
    phase: "sending",
    draft: { prompt: input.prompt, attachments: input.attachments },
  };
}

export function addOptimisticMessage(
  state: OptimisticMessagesByThreadKey,
  threadKey: string,
  entry: OptimisticUserMessage,
): OptimisticMessagesByThreadKey {
  const existing = state[threadKey] ?? NO_MESSAGES;
  if (existing.some((current) => current.message.id === entry.message.id)) return state;
  const next = [...existing, entry].slice(-MAX_OPTIMISTIC_MESSAGES_PER_THREAD);
  const { [threadKey]: _previous, ...rest } = state;
  const keys = Object.keys(rest);
  // Insertion order is recency: the thread just written goes last, the oldest is dropped.
  const kept =
    keys.length >= MAX_OPTIMISTIC_THREADS
      ? Object.fromEntries(
          keys.slice(keys.length - MAX_OPTIMISTIC_THREADS + 1).map((key) => [key, rest[key]!]),
        )
      : rest;
  return { ...kept, [threadKey]: next };
}

export function updateOptimisticMessage(
  state: OptimisticMessagesByThreadKey,
  threadKey: string,
  messageId: string,
  update: (entry: OptimisticUserMessage) => OptimisticUserMessage | null,
): OptimisticMessagesByThreadKey {
  const existing = state[threadKey];
  if (!existing) return state;
  let changed = false;
  const next: OptimisticUserMessage[] = [];
  for (const entry of existing) {
    if (entry.message.id !== messageId) {
      next.push(entry);
      continue;
    }
    const updated = update(entry);
    if (updated !== entry) changed = true;
    if (updated !== null) next.push(updated);
  }
  if (!changed) return state;
  if (next.length > 0) return { ...state, [threadKey]: next };
  const { [threadKey]: _removed, ...rest } = state;
  return rest;
}

/** Drops the sends the node's messages already hold: the echo replaced them. */
export function settleOptimisticMessages(
  state: OptimisticMessagesByThreadKey,
  threadKey: string,
  serverMessageIds: ReadonlySet<string>,
): OptimisticMessagesByThreadKey {
  const existing = state[threadKey];
  if (!existing?.some((entry) => serverMessageIds.has(entry.message.id))) return state;
  const next = existing.filter((entry) => !serverMessageIds.has(entry.message.id));
  if (next.length > 0) return { ...state, [threadKey]: next };
  const { [threadKey]: _removed, ...rest } = state;
  return rest;
}

/**
 * The thread's messages with its unconfirmed sends after them. Returns the node's own array
 * when nothing is pending, so a memo keyed on it does not rebuild.
 */
export function mergeOptimisticMessages(
  serverMessages: ReadonlyArray<ChatMessage>,
  pending: ReadonlyArray<OptimisticUserMessage> | undefined,
): ReadonlyArray<ChatMessage> {
  if (!pending || pending.length === 0) return serverMessages;
  const visible = pending.filter((entry) => entry.phase !== "failed");
  if (visible.length === 0) return serverMessages;
  const serverIds = new Set(serverMessages.map((message) => message.id as string));
  const unconfirmed = visible.filter((entry) => !serverIds.has(entry.message.id));
  if (unconfirmed.length === 0) return serverMessages;
  return [...serverMessages, ...unconfirmed.map((entry) => entry.message)];
}

/** The draft to put back after failed sends: their prompts in order, then what is typed now. */
export function mergeRestoredDraft(
  failed: ReadonlyArray<OptimisticUserMessage["draft"]>,
  current: OptimisticUserMessage["draft"],
): OptimisticUserMessage["draft"] {
  const prompts = [...failed.map((draft) => draft.prompt), current.prompt].filter(
    (prompt) => prompt.trim().length > 0,
  );
  const seen = new Set<string>();
  const attachments: DraftComposerAttachment[] = [];
  for (const attachment of [
    ...failed.flatMap((draft) => draft.attachments),
    ...current.attachments,
  ]) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    attachments.push(attachment);
  }
  return { prompt: prompts.join("\n\n"), attachments };
}
