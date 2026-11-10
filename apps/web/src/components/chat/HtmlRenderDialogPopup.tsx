import { DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { useState } from "react";

import type { HtmlRenderOpenRequest } from "./HtmlRenderDialog";
import { HtmlRenderFullView, HtmlRenderViewActions } from "./HtmlRenderFullView";
import { useHtmlRenderMessageSend } from "./htmlRenderMessages";
import { useHtmlRenderZoom } from "./HtmlRenderZoom";
import { htmlRenderZoomKey } from "./htmlRenderZoomStore";
import { useHtmlRenderSource } from "./useHtmlRenderSource";

/**
 * The expanded dialog's body: the page at full size with its zoom, source and
 * download. Its own module, loaded the first time a page opens full size, so
 * the chat route carries only the inline frame.
 */
export function HtmlRenderDialogPopup(props: {
  readonly request: HtmlRenderOpenRequest;
  readonly onClose: () => void;
}) {
  const { target, origin } = props.request;
  const { title } = target.htmlRender;
  // A page already shown inline comes from memory.
  const source = useHtmlRenderSource(target);
  const [showSource, setShowSource] = useState(false);
  const onSendMessage = useHtmlRenderMessageSend({
    environmentId: target.environmentId,
    threadId: target.threadId,
    title,
    enabled: target.canSendMessages === true,
  });
  const zoom = useHtmlRenderZoom(
    htmlRenderZoomKey({
      environmentId: target.environmentId,
      threadId: target.threadId,
      messageId: target.messageId,
      attachmentId: target.attachment.id,
    }),
  );
  return (
    <DialogPopup
      className="h-[85dvh] max-w-5xl overflow-hidden"
      onKeyDown={zoom.onKeyDown}
      bottomStickOnMobile={false}
      morph={origin ? { origin } : "auto"}
    >
      <DialogHeader className="shrink-0 flex-row items-center gap-2 border-b py-3 pr-14 pl-5 max-sm:pb-3">
        <DialogTitle className="min-w-0 flex-1 truncate text-base" title={title}>
          {title}
        </DialogTitle>
        <DialogDescription className="sr-only">
          A page the agent published, running in a sandbox.
        </DialogDescription>
        <HtmlRenderViewActions
          html={source.html}
          title={title}
          showSource={showSource}
          onShowSourceChange={setShowSource}
          zoom={zoom}
        />
      </DialogHeader>
      {/* A gutter, so the page's content never meets the dialog's edge. */}
      <HtmlRenderFullView
        source={source}
        title={title}
        sizeBytes={target.attachment.sizeBytes}
        showSource={showSource}
        onEscape={props.onClose}
        onSendMessage={onSendMessage}
        zoom={zoom}
        className="rounded-b-[calc(min(var(--radius-2xl),1.25rem)-1px)] px-4 pt-4 sm:px-6"
      />
    </DialogPopup>
  );
}
