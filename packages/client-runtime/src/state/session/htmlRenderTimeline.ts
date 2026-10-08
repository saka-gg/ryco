import type { MessageId, TurnId } from "@ryco/contracts";
import { htmlRenderOfAttachment, type HtmlRenderMetadata } from "@ryco/shared/htmlRender";

import {
  isChatFileAttachment,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatMessage,
} from "../threads/types.ts";
import type { TimelineEntry } from "./session-logic.ts";

/**
 * How a thread's timeline places agent HTML renders, shared by every client:
 * a render is shown above its turn's reply, is never the reply itself, and a
 * blank reply after a render adds nothing.
 */

export interface HtmlRenderAttachment {
  readonly attachment: ChatFileAttachment;
  /** Validated and clamped. */
  readonly htmlRender: HtmlRenderMetadata;
}

// Thread objects are replaced, never changed in place, and every client reads
// each page several times per update; each attachment and message is read once.
const renderByAttachment = new WeakMap<ChatAttachment, HtmlRenderAttachment | null>();
const renderOnlyByMessage = new WeakMap<ChatMessage, boolean>();

/** The attachment as an HTML render, when it is one. */
export function readHtmlRenderAttachment(
  attachment: ChatAttachment,
): HtmlRenderAttachment | undefined {
  const cached = renderByAttachment.get(attachment);
  if (cached !== undefined) return cached ?? undefined;
  let render: HtmlRenderAttachment | undefined;
  if (isChatFileAttachment(attachment)) {
    const htmlRender = htmlRenderOfAttachment(attachment);
    if (htmlRender !== undefined) render = { attachment, htmlRender };
  }
  renderByAttachment.set(attachment, render ?? null);
  return render;
}

/**
 * A finished assistant message that only carries HTML renders, as
 * `ryco_html_render` publishes them: no text of its own, so a timeline shows
 * the pages in place of the message, and it is never the turn's reply.
 */
export function isHtmlRenderOnlyMessage(message: ChatMessage): boolean {
  const cached = renderOnlyByMessage.get(message);
  if (cached !== undefined) return cached;
  const renderOnly =
    message.role === "assistant" &&
    !message.streaming &&
    message.attachments !== undefined &&
    message.attachments.length > 0 &&
    message.text.trim() === "" &&
    message.attachments.every((attachment) => readHtmlRenderAttachment(attachment) !== undefined);
  renderOnlyByMessage.set(message, renderOnly);
  return renderOnly;
}

/** A finished reply with nothing in it; after a render, the page is the reply. */
export function isBlankSettledReply(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.streaming &&
    message.text.trim() === "" &&
    (message.attachments?.length ?? 0) === 0
  );
}

/** The last assistant message of each response, never a render carrier. */
export function deriveTerminalAssistantMessageIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlySet<string> {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    // A render is shown above the reply; it never stands in for the reply.
    if (message.role !== "assistant" || isHtmlRenderOnlyMessage(message)) {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

/**
 * The entries with each turn's reply after that turn's HTML renders. A
 * provider can open its reply before it publishes a page (Codex keeps a
 * placeholder from the turn's start), which would put the page under the
 * reply; the page always reads above it. While a turn runs, only a reply that
 * is still streaming moves: a finished message may be followed by the real
 * reply, and moving it now would move it back later.
 */
export function placeRepliesAfterHtmlRenders(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  terminalAssistantMessageIds: ReadonlySet<string>,
  options: { readonly runningTurnId?: TurnId | string | null } = {},
): ReadonlyArray<TimelineEntry> {
  const lastRenderIndexByTurn = new Map<TurnId, number>();
  timelineEntries.forEach((entry, index) => {
    if (
      entry.kind === "message" &&
      entry.message.turnId &&
      isHtmlRenderOnlyMessage(entry.message)
    ) {
      lastRenderIndexByTurn.set(entry.message.turnId, index);
    }
  });
  if (lastRenderIndexByTurn.size === 0) return timelineEntries;
  const deferredAfter = new Map<number, TimelineEntry[]>();
  const deferredIds = new Set<string>();
  timelineEntries.forEach((entry, index) => {
    if (entry.kind !== "message" || !terminalAssistantMessageIds.has(entry.message.id)) return;
    if (
      options.runningTurnId != null &&
      entry.message.turnId === options.runningTurnId &&
      !entry.message.streaming
    ) {
      return;
    }
    const lastRender = entry.message.turnId
      ? lastRenderIndexByTurn.get(entry.message.turnId)
      : undefined;
    if (lastRender === undefined || lastRender < index) return;
    deferredIds.add(entry.id);
    deferredAfter.set(lastRender, [...(deferredAfter.get(lastRender) ?? []), entry]);
  });
  if (deferredIds.size === 0) return timelineEntries;
  return timelineEntries.flatMap((entry, index) => [
    ...(deferredIds.has(entry.id) ? [] : [entry]),
    ...(deferredAfter.get(index) ?? []),
  ]);
}

/**
 * The HTML renders each turn published, in order, keyed by turn: what a
 * client lists under the turn's reply.
 */
export function collectTurnHtmlRenders(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<TurnId, ReadonlyArray<HtmlRenderAttachment & { readonly messageId: MessageId }>> {
  const byTurn = new Map<TurnId, Array<HtmlRenderAttachment & { readonly messageId: MessageId }>>();
  for (const entry of timelineEntries) {
    if (entry.kind !== "message" || !entry.message.turnId) continue;
    if (!isHtmlRenderOnlyMessage(entry.message)) continue;
    for (const attachment of entry.message.attachments ?? []) {
      const render = readHtmlRenderAttachment(attachment);
      if (render === undefined) continue;
      const list = byTurn.get(entry.message.turnId) ?? [];
      list.push({ ...render, messageId: entry.message.id });
      byTurn.set(entry.message.turnId, list);
    }
  }
  return byTurn;
}
