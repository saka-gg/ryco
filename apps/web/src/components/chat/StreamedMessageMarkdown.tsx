import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import type { MessageId } from "@ryco/contracts";
import type { ComponentProps } from "react";

import { useStore } from "../../store";
import { selectThreadMessageText } from "../../storeSelectors";
import ChatMarkdown from "../ChatMarkdown";

/**
 * The text a transcript row shows for a message that may be streaming. The chat
 * view holds the thread's structure while a reply streams
 * (`createThreadStructureSelectorByRef`), so the row's message carries the text
 * of the thread's last structural change; this reads the store's current text
 * for that one message. Any other message, and a message the store does not
 * hold (a draft, a row built from props), shows `text` as given.
 */
export function useStreamedMessageText(
  routeThreadKey: string,
  streamingMessageId: MessageId | null,
  text: string,
): string {
  const threadRef = parseScopedThreadKey(routeThreadKey);
  const liveText = useStore((state) =>
    streamingMessageId !== null && threadRef !== null
      ? selectThreadMessageText(state, threadRef, streamingMessageId)
      : undefined,
  );
  return liveText !== undefined && liveText.length > 0 ? liveText : text;
}

/**
 * `ChatMarkdown` for a transcript message: the one part of the chat that
 * follows streamed text. It renders `ChatMarkdown` where the row did, so the
 * streaming smoothing and the deferred markdown parse stay with the message.
 */
export function StreamedMessageMarkdown({
  routeThreadKey,
  streamingMessageId,
  text,
  ...markdownProps
}: ComponentProps<typeof ChatMarkdown> & {
  readonly routeThreadKey: string;
  /** The message's id while it streams, else null (the store selector then reads nothing). */
  readonly streamingMessageId: MessageId | null;
}) {
  return (
    <ChatMarkdown
      {...markdownProps}
      text={useStreamedMessageText(routeThreadKey, streamingMessageId, text)}
    />
  );
}
