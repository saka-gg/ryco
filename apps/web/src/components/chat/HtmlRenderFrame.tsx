import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  type HtmlRenderMetadata,
} from "@ryco/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";

import { usePresentationTier } from "~/hooks/usePresentationTier";
import { LRUCache } from "~/lib/lruCache";
import { cn } from "~/lib/utils";
import type { ChatFileAttachment } from "../../types";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useHtmlRenderOpener } from "./HtmlRenderDialog";
import { HtmlRenderDocument } from "./HtmlRenderDocument";
import { HtmlRenderSourceStatus } from "./HtmlRenderView";
import { useHtmlRenderSource } from "./useHtmlRenderSource";

// The height a page last reported at a width, so a row that scrolls back into
// view reserves the page's own height instead of the server's estimate.
const reportedHeights = new LRUCache<{ readonly width: number; readonly height: number }>(
  256,
  Number.POSITIVE_INFINITY,
);

/**
 * An agent's HTML render inline in the thread: the page itself on the thread's
 * own background, at the server's measured height for this width until the
 * page reports its own. Loading, deferral and failure hold the same box, so
 * nothing below it moves.
 */
export const HtmlRenderFrame = memo(function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | undefined;
  readonly messageId: MessageId | undefined;
  readonly attachment: ChatFileAttachment;
  readonly htmlRender: HtmlRenderMetadata;
}) {
  const { attachment, htmlRender } = props;
  const { title } = htmlRender;
  const heightKey = `${props.environmentId}:${props.messageId}:${attachment.id}`;
  // The box measures its own width before first paint, so the reserved height
  // is already the one for this width.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [report, setReport] = useState<{ readonly height?: number; readonly count: number }>({
    count: 0,
  });
  const onContentHeight = useCallback(
    (height: number) => {
      setReport((current) => ({ height, count: current.count + 1 }));
      if (boxRef.current) {
        reportedHeights.set(heightKey, { width: boxRef.current.clientWidth, height }, 1);
      }
    },
    [heightKey],
  );
  const remembered = reportedHeights.get(heightKey);
  const contentHeight =
    report.height ??
    (remembered !== null && Math.round(remembered.width) === Math.round(width)
      ? remembered.height
      : undefined);
  const height = htmlRenderFrameHeight(htmlRender, width, contentHeight);

  const source = useHtmlRenderSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    messageId: props.messageId,
    attachment,
  });
  const [pointerInside, setPointerInside] = useState(false);
  // The frozen phone tier gets no expand affordance; where the turn replied,
  // the reply's page card still opens the page full size.
  const canExpand = usePresentationTier() !== "phone";
  const { open, dialog } = useHtmlRenderOpener();
  const html = source.html;

  return (
    <div
      ref={boxRef}
      data-html-render-frame=""
      aria-busy={source.loading || undefined}
      className={cn(
        "group/html-render relative w-full",
        // The page's first report snaps the box to its height; later changes
        // (the page growing, the column resizing) ease to the new height.
        report.count > 1 &&
          "overflow-hidden transition-[height] duration-(--app-motion-duration-stack) ease-(--app-motion-ease)",
      )}
      style={{ height }}
    >
      {html !== undefined ? (
        <>
          <HtmlRenderDocument
            html={html}
            title={title}
            className="block size-full"
            onContentHeight={onContentHeight}
            onPointerInside={setPointerInside}
          />
          {canExpand && (
            <div
              className={cn(
                "absolute end-2 top-2 opacity-0 transition-opacity duration-(--app-motion-duration-chip) focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100",
                pointerInside && "opacity-100",
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Open full size"
                      size="icon-xs"
                      variant="ghost"
                      // A plate of its own, so it reads over any page.
                      className="border-border bg-background/85 text-foreground/75 shadow-sm/10 backdrop-blur-sm hover:bg-background hover:text-foreground"
                      onClick={() =>
                        open({
                          target: {
                            environmentId: props.environmentId,
                            threadId: props.threadId,
                            messageId: props.messageId,
                            attachment,
                            htmlRender,
                          },
                          origin: () => boxRef.current,
                        })
                      }
                    />
                  }
                >
                  <Maximize2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="left">Open full size</TooltipPopup>
              </Tooltip>
            </div>
          )}
        </>
      ) : (
        <HtmlRenderSourceStatus source={source} title={title} sizeBytes={attachment.sizeBytes} />
      )}
      {dialog}
    </div>
  );
});
