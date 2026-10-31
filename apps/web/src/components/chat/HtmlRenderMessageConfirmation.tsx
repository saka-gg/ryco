import { HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS } from "@ryco/client-runtime/state/session";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  answerHtmlRenderMessage,
  registerHtmlRenderMessageSender,
  useHtmlRenderMessageConfirmation,
  type HtmlRenderMessageSender,
} from "./htmlRenderMessages";

function HtmlRenderMessageConfirmation(props: {
  readonly threadKey: string | null;
  /** The sender the view registered: only the thread's current one asks. */
  readonly sender: HtmlRenderMessageSender;
}) {
  const { open, request: shown } = useHtmlRenderMessageConfirmation(props.threadKey, props.sender);
  const request = open ? shown : null;
  // Send stays disabled for a moment (`HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS`).
  const [armedId, setArmedId] = useState<number | null>(null);
  useEffect(() => {
    if (request === null) return;
    const timeout = window.setTimeout(
      () => setArmedId(request.id),
      HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [request]);
  // Cancel has the focus: Enter, or a key the page asked the reader to hold,
  // never sends.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const armed = request !== null && armedId === request.id;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && request !== null) answerHtmlRenderMessage(request.id, "cancel");
      }}
    >
      {shown !== null && (
        <AlertDialogPopup
          morph={false}
          initialFocus={cancelRef}
          className="max-w-md"
          data-html-render-message-confirmation=""
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Send this message?</AlertDialogTitle>
            <AlertDialogDescription>
              The page “{shown.title}” wants to send this to the thread as your message. The agent
              made the page, so check the text first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6 pb-6">
            <div
              data-html-render-message-text=""
              className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-3 py-2 text-foreground text-sm"
            >
              {shown.text}
            </div>
          </div>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose ref={cancelRef} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={!armed}
              onClick={() => {
                if (request !== null) answerHtmlRenderMessage(request.id, "send");
              }}
            >
              Send
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
}

/**
 * Lets the pages of the thread a ChatView shows send the reader's answers:
 * registers how the thread takes them, for as long as the view shows it, and
 * returns the confirmation to render. `send` null (a draft, a thread that
 * cannot take messages) registers nothing, so pages hear the thread is not
 * open.
 */
export function useHtmlRenderMessages(
  threadKey: string | null,
  send: HtmlRenderMessageSender | null,
): ReactNode {
  const latest = useRef(send);
  useLayoutEffect(() => {
    latest.current = send;
  });
  // One sender for the view's lifetime: the registry knows the view by it.
  const [sender] = useState<HtmlRenderMessageSender>(
    () => (text: string) =>
      latest.current === null
        ? Promise.reject(new Error("This thread cannot take messages now."))
        : latest.current(text),
  );
  const canSend = send !== null;
  useEffect(() => {
    if (threadKey === null || !canSend) return;
    return registerHtmlRenderMessageSender(threadKey, sender);
  }, [threadKey, canSend, sender]);
  return <HtmlRenderMessageConfirmation threadKey={threadKey} sender={sender} />;
}
