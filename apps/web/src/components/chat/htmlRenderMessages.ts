import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  HTML_RENDER_MESSAGE_REFUSALS,
  htmlRenderMessageConfirmationTitle,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import type { SendTurnComposerSnapshot, SendTurnSettings } from "../../hooks/executeChatSendTurn";
import type { WebQueuedMessage } from "../../messageQueueStore";

/**
 * Where a page's `ryco.send` goes on web once its frame let the request
 * through (`createHtmlRenderMessageGate`): one confirmation in the app, then
 * the thread's own message queue.
 *
 * The mounted ChatView of a thread registers how that thread takes a message
 * (`registerHtmlRenderMessageSender`), as it registers its queue's foreground
 * sender, so a page can only ever send to the thread whose view is open, and
 * never to another one. A request waits here for the reader: the
 * confirmation shows its exact text, and only the reader's Send in the app
 * queues it. At most one request waits at a time, across every page.
 */

/** Queues a page's message in the thread; rejects with the reason the page sees. */
export type HtmlRenderMessageSender = (text: string) => Promise<void>;

/** What a page's frame hands its request besides the text. */
export interface HtmlRenderMessageRequestOptions {
  /**
   * The element focus returns to when the confirmation closes: the frame's
   * container, never the frame itself, so closing it does not hand the page
   * the focus (and the user activation of the reader's click on Send or
   * Cancel) to ask again with.
   */
  readonly returnFocus?: () => HTMLElement | null;
}

/** A page's `onSendMessage`: its text, and how its confirmation hands focus back. */
export type HtmlRenderPageMessageSender = (
  text: string,
  options?: HtmlRenderMessageRequestOptions,
) => Promise<void>;

/** A page's message waiting for the reader's answer. */
export interface HtmlRenderMessageConfirmationRequest {
  readonly id: number;
  readonly threadKey: string;
  /** The page's title, as the confirmation names it (`htmlRenderMessageConfirmationTitle`). */
  readonly title: string;
  /** Exactly what is sent. */
  readonly text: string;
  readonly returnFocus?: (() => HTMLElement | null) | undefined;
}

interface PendingRequest extends HtmlRenderMessageConfirmationRequest {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const sendersByThreadKey = new Map<string, HtmlRenderMessageSender[]>();
let pending: PendingRequest | null = null;
// The last request asked, kept so its confirmation can close with its text on screen.
let lastAsked: PendingRequest | null = null;
let nextRequestId = 1;
// Confirmations closed so far, however they closed: a frame must take focus
// again after the latest one before its page may ask (`createHtmlRenderFrameFocus`).
let closedConfirmations = 0;
const listeners = new Set<() => void>();

const THREAD_NOT_OPEN = HTML_RENDER_MESSAGE_REFUSALS.threadNotOpen;
const THREAD_CLOSED = HTML_RENDER_MESSAGE_REFUSALS.threadClosed;

function notify() {
  for (const listener of listeners) listener();
}

function setPending(next: PendingRequest | null) {
  if (pending !== null && next === null) closedConfirmations += 1;
  pending = next;
  if (next !== null) lastAsked = next;
  notify();
}

/**
 * Tracks whether a page's frame took focus after the latest confirmation
 * closed, if one closed while the frame was there. Its document calls
 * `focused()` when the frame takes focus (the window's `blur` while the frame
 * is the active element: the reader clicked or tabbed into the page); a page
 * may ask only while `regained()`. Closing a confirmation never focuses a
 * frame, so the reader's click on Send or Cancel (and the user activation it
 * gives the app) cannot be spent by the page on asking again: the reader has
 * to come back to the page first. The confirmation had the focus, so the app's
 * window has it then, and focus moving into the frame blurs it. Before any
 * confirmation closes (when the window may never have had focus to lose, such
 * as the reader's first click in an unfocused window) the other checks apply.
 */
export function createHtmlRenderFrameFocus(): {
  readonly focused: () => void;
  readonly regained: () => boolean;
} {
  let focusedAfter = closedConfirmations;
  return {
    focused: () => {
      focusedAfter = closedConfirmations;
    },
    regained: () => focusedAfter === closedConfirmations,
  };
}

function currentSender(threadKey: string): HtmlRenderMessageSender | undefined {
  return sendersByThreadKey.get(threadKey)?.at(-1);
}

/** Registers how a thread takes page messages while its view is mounted. */
export function registerHtmlRenderMessageSender(
  threadKey: string,
  sender: HtmlRenderMessageSender,
): () => void {
  const stack = sendersByThreadKey.get(threadKey) ?? [];
  stack.push(sender);
  sendersByThreadKey.set(threadKey, stack);
  notify();
  return () => {
    const current = sendersByThreadKey.get(threadKey);
    if (!current) return;
    const index = current.lastIndexOf(sender);
    if (index !== -1) current.splice(index, 1);
    notify();
    if (current.length > 0) return;
    sendersByThreadKey.delete(threadKey);
    // Nothing would take the message any more; the page hears why.
    if (pending?.threadKey === threadKey) {
      const request = pending;
      setPending(null);
      request.reject(new Error(THREAD_CLOSED));
    }
  };
}

/**
 * Asks the reader to confirm a page's message for its thread. Settles when
 * they answer: resolved once the message is queued, rejected on cancel, on a
 * failure to queue, or right away when the thread's view is not open or
 * another message is waiting.
 */
export function requestHtmlRenderMessage(input: {
  readonly threadKey: string;
  readonly title: string;
  readonly text: string;
  readonly returnFocus?: (() => HTMLElement | null) | undefined;
}): Promise<void> {
  if (currentSender(input.threadKey) === undefined) {
    return Promise.reject(new Error(THREAD_NOT_OPEN));
  }
  if (pending !== null) return Promise.reject(new Error(HTML_RENDER_MESSAGE_REFUSALS.pending));
  return new Promise<void>((resolve, reject) => {
    setPending({
      ...input,
      title: htmlRenderMessageConfirmationTitle(input.title),
      id: nextRequestId++,
      resolve,
      reject,
    });
  });
}

/** The reader's answer to the waiting request `id`; any other id is stale and ignored. */
export function answerHtmlRenderMessage(id: number, answer: "send" | "cancel"): void {
  const request = pending;
  if (request === null || request.id !== id) return;
  setPending(null);
  if (answer === "cancel") {
    request.reject(new Error(HTML_RENDER_MESSAGE_REFUSALS.cancelled));
    return;
  }
  const sender = currentSender(request.threadKey);
  if (sender === undefined) {
    request.reject(new Error(THREAD_CLOSED));
    return;
  }
  let sent: Promise<void>;
  try {
    sent = sender(request.text);
  } catch (error) {
    sent = Promise.reject(error);
  }
  sent.then(request.resolve, (error: unknown) =>
    request.reject(error instanceof Error ? error : new Error(HTML_RENDER_MESSAGE_REFUSALS.failed)),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The request waiting for the reader in this thread, if any. */
export function readHtmlRenderMessageConfirmation(
  threadKey: string | null,
): HtmlRenderMessageConfirmationRequest | null {
  return threadKey !== null && pending?.threadKey === threadKey ? pending : null;
}

/**
 * The request waiting for the reader in this thread (`open`), and the one to
 * show: the waiting one, else the last one asked here, while its
 * confirmation closes. Only the view whose `sender` takes the thread's
 * messages now shows it, so two views of one thread never ask twice.
 */
export function useHtmlRenderMessageConfirmation(
  threadKey: string | null,
  sender: HtmlRenderMessageSender,
): {
  readonly open: boolean;
  readonly request: HtmlRenderMessageConfirmationRequest | null;
} {
  const readPending = () =>
    threadKey !== null && currentSender(threadKey) === sender
      ? readHtmlRenderMessageConfirmation(threadKey)
      : null;
  const readShown = () =>
    threadKey !== null && lastAsked?.threadKey === threadKey ? lastAsked : null;
  const waiting = useSyncExternalStore(subscribe, readPending, readPending);
  const shown = useSyncExternalStore(subscribe, readShown, readShown);
  return { open: waiting !== null, request: waiting ?? shown };
}

/**
 * The `onSendMessage` of a page in its thread: requests go to the reader's
 * confirmation for that thread. Undefined unless `enabled` (a page the
 * thread's own agent published) and the page has a thread, and always on the
 * frozen phone tier, which gets no new capabilities.
 */
export function useHtmlRenderMessageSend(input: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly threadId: ThreadId | null | undefined;
  readonly title: string;
  readonly enabled: boolean;
}): HtmlRenderPageMessageSender | undefined {
  const { environmentId, threadId, title } = input;
  const phoneTier = usePresentationTier() === "phone";
  const threadKey =
    input.enabled && !phoneTier && environmentId && threadId
      ? scopedThreadKey(scopeThreadRef(environmentId, threadId))
      : null;
  const send = useCallback<HtmlRenderPageMessageSender>(
    (text, options) =>
      threadKey === null
        ? Promise.reject(new Error(HTML_RENDER_MESSAGE_REFUSALS.unavailable))
        : requestHtmlRenderMessage({ threadKey, title, text, returnFocus: options?.returnFocus }),
    [threadKey, title],
  );
  return threadKey === null ? undefined : send;
}

/** Drops every registration and waiting request; for tests. */
export function __resetHtmlRenderMessagesForTests(): void {
  sendersByThreadKey.clear();
  const request = pending;
  setPending(null);
  lastAsked = null;
  request?.reject(new Error(THREAD_CLOSED));
}

/**
 * A page's message as an entry of the thread's message queue: the reader's
 * text alone, with the model and modes the composer would send now, so the
 * queue sends it as it sends a message the reader typed (its holds, readiness
 * and the node's own queue apply), never with the composer's draft.
 */
export function buildHtmlRenderQueuedMessage(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
  readonly selection: Pick<
    SendTurnComposerSnapshot,
    | "selectedProvider"
    | "selectedModel"
    | "selectedProviderModels"
    | "selectedPromptEffort"
    | "selectedModelSelection"
  >;
  readonly settings: Pick<SendTurnSettings, "runtimeMode" | "interactionMode" | "tokenMode">;
}): WebQueuedMessage {
  const { selection, settings } = input;
  return {
    id: input.id,
    createdAt: input.createdAt,
    composer: {
      prompt: input.text,
      trimmedPrompt: input.text,
      images: [],
      sendableTerminalContexts: [],
      fileReferences: [],
      sourceControlContexts: [],
      selectedProvider: selection.selectedProvider,
      selectedModel: selection.selectedModel,
      selectedProviderModels: selection.selectedProviderModels,
      selectedPromptEffort: selection.selectedPromptEffort,
      selectedModelSelection: selection.selectedModelSelection,
      expiredTerminalContextCount: 0,
    },
    settings: {
      runtimeMode: settings.runtimeMode,
      interactionMode: settings.interactionMode,
      tokenMode: settings.tokenMode,
    },
  };
}
