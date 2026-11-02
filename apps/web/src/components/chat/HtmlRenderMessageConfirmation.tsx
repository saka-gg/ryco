import {
  describeHtmlRenderMessageText,
  HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS,
  HTML_RENDER_MESSAGE_REFUSALS,
  isHtmlRenderMessageScrolledToEnd,
} from "@ryco/client-runtime/state/session";
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

/**
 * Send's delay (`HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS`), which starts over
 * with every pointer press or key press while it runs, so a page cannot time a
 * burst of clicks, or a held key, to land on Send the moment it turns on.
 * Returns whether Send counts now, and a check for a click on it: a pointer's
 * click counts only when its press came after Send turned on (a press made
 * while Send was off, released after, never sends). A click from the keyboard
 * or assistive technology needs Send focused, which takes a key press of its
 * own after Cancel had the focus.
 */
function useHtmlRenderMessageSendDelay(requestId: number | null): {
  readonly armed: boolean;
  readonly pressedSinceArmed: (event: { readonly detail: number }) => boolean;
} {
  const [armedId, setArmedId] = useState<number | null>(null);
  const armedAt = useRef(Number.POSITIVE_INFINITY);
  const lastPointerDown = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (requestId === null) return;
    armedAt.current = Number.POSITIVE_INFINITY;
    let armed = false;
    let timeout: number | undefined;
    const start = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        armed = true;
        armedAt.current = performance.now();
        setArmedId(requestId);
      }, HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS);
    };
    const pointerDown = () => {
      lastPointerDown.current = performance.now();
      if (!armed) start();
    };
    const keyDown = () => {
      if (!armed) start();
    };
    start();
    // Capture on the window: the dialog's own handlers stop keys from bubbling.
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("keydown", keyDown, true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("keydown", keyDown, true);
    };
  }, [requestId]);
  return {
    armed: requestId !== null && armedId === requestId,
    // A pointer's click reports how many presses made it; a key's click reports none.
    pressedSinceArmed: (event) => event.detail === 0 || lastPointerDown.current >= armedAt.current,
  };
}

function HtmlRenderMessageConfirmation(props: {
  readonly threadKey: string | null;
  /** The sender the view registered: only the thread's current one asks. */
  readonly sender: HtmlRenderMessageSender;
}) {
  const { open, request: shown } = useHtmlRenderMessageConfirmation(props.threadKey, props.sender);
  const request = open ? shown : null;
  const delay = useHtmlRenderMessageSendDelay(request?.id ?? null);
  // Send also waits until the reader has seen the end of the text: a long
  // message scrolls in its box, and nothing below the fold goes out unseen.
  const [readId, setReadId] = useState<number | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const checkRead = () => {
    const box = textRef.current;
    if (request !== null && box !== null && isHtmlRenderMessageScrolledToEnd(box)) {
      setReadId(request.id);
    }
  };
  useLayoutEffect(checkRead);
  // Cancel has the focus: Enter, or a key the page asked the reader to hold,
  // never sends.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const read = request !== null && readId === request.id;
  const canSend = delay.armed && read;
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
          // Back to the page's container, never into the page: the page gets
          // the focus again only when the reader clicks or tabs into it. Focused
          // here rather than returned, since the dialog would move focus on to
          // the container's first tabbable child, the page's frame.
          finalFocus={() => {
            const container = shown.returnFocus?.() ?? null;
            queueMicrotask(() => {
              if (container?.isConnected) container.focus({ preventScroll: true });
            });
            return false;
          }}
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
              ref={textRef}
              data-html-render-message-text=""
              // Focusable, so the keyboard can scroll it too.
              tabIndex={0}
              role="region"
              aria-label="Message to send"
              onScroll={checkRead}
              className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-3 py-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {shown.text}
            </div>
            <p data-html-render-message-size="" className="mt-2 text-muted-foreground text-xs">
              {describeHtmlRenderMessageText(shown.text)}
              {request !== null && !read ? " · Scroll to the end to send it." : null}
            </p>
          </div>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose ref={cancelRef} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={!canSend}
              onClick={(event) => {
                if (request === null || !canSend || !delay.pressedSinceArmed(event)) return;
                answerHtmlRenderMessage(request.id, "send");
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
        ? Promise.reject(new Error(HTML_RENDER_MESSAGE_REFUSALS.notReady))
        : latest.current(text),
  );
  const canSend = send !== null;
  useEffect(() => {
    if (threadKey === null || !canSend) return;
    return registerHtmlRenderMessageSender(threadKey, sender);
  }, [threadKey, canSend, sender]);
  return <HtmlRenderMessageConfirmation threadKey={threadKey} sender={sender} />;
}
