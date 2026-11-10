import {
  htmlRenderFileName,
  stripHtmlRenderBootstrap,
  HTML_RENDER_SOURCE_PREVIEW_MAX_CHARS,
} from "@ryco/shared/htmlRender";
import { htmlRenderZoomFrameStyle } from "@ryco/shared/htmlRenderZoom";
import { CodeIcon, DownloadIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { HtmlRenderDocument } from "./HtmlRenderDocument";
import type { HtmlRenderPageMessageSender } from "./htmlRenderMessages";
import { HtmlRenderSourceStatus } from "./HtmlRenderView";
import { HtmlRenderZoomControls, type HtmlRenderZoom } from "./HtmlRenderZoom";
import type { HtmlRenderSource } from "./useHtmlRenderSource";

/**
 * A render at full size, shared by the expanded dialog and the workspace
 * panel's page tab: the page with its zoom, its source, and a download. Kept
 * apart from the inline frame's pieces (`HtmlRenderView`) so the chat route
 * loads it only when a page is opened full size.
 */

const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/**
 * Saves the page under its title. The bytes go out as an inert download; a
 * blob URL carries the app's origin, so it is never navigated to.
 */
export function downloadHtmlRender(html: string, title: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = htmlRenderFileName(title);
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // A desktop save dialog reads the bytes only once the reader picks a place.
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

/** The zoom controls, Source toggle and Download button of a render shown at full size. */
export function HtmlRenderViewActions(props: {
  readonly html: string | undefined;
  readonly title: string;
  readonly showSource: boolean;
  readonly onShowSourceChange: (showSource: boolean) => void;
  readonly zoom?: HtmlRenderZoom | undefined;
}) {
  const { html, title } = props;
  return (
    <>
      {props.zoom ? (
        <HtmlRenderZoomControls
          zoom={props.zoom}
          disabled={html === undefined || props.showSource}
        />
      ) : null}
      <Toggle
        variant="outline"
        size="sm"
        pressed={props.showSource}
        disabled={html === undefined}
        onPressedChange={(pressed) => props.onShowSourceChange(Boolean(pressed))}
      >
        <CodeIcon className="size-3.5" />
        Source
      </Toggle>
      <Button
        variant="outline"
        size="sm"
        disabled={html === undefined}
        onClick={() => {
          if (html !== undefined) downloadHtmlRender(html, title);
        }}
      >
        <DownloadIcon className="size-3.5" />
        Download
      </Button>
    </>
  );
}

function HtmlRenderSourceView(props: { readonly html: string }) {
  // The agent's own markup, without the theme bootstrap Ryco injected.
  const html = useMemo(() => stripHtmlRenderBootstrap(props.html), [props.html]);
  // The source of a page with inlined images can run to megabytes; its head
  // is what a reader wants to see, and the download has the rest.
  const truncated = html.length > HTML_RENDER_SOURCE_PREVIEW_MAX_CHARS;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {truncated && (
        <p role="status" className="shrink-0 border-b px-6 py-2 text-xs text-muted-foreground">
          Showing the start of the source. Download the page for all of it.
        </p>
      )}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-6 font-mono text-xs">
        {truncated ? html.slice(0, HTML_RENDER_SOURCE_PREVIEW_MAX_CHARS) : html}
      </pre>
    </div>
  );
}

/**
 * A render at full size: the page filling the space on the thread's
 * background (which its `--background` matches), or its source. The page
 * stays mounted under the source, so toggling keeps its state.
 */
export function HtmlRenderFullView(props: {
  readonly source: HtmlRenderSource;
  readonly title: string;
  readonly sizeBytes: number;
  readonly showSource: boolean;
  /** The reader pressed Escape inside the page (its keys never reach the app). */
  readonly onEscape?: (() => void) | undefined;
  /** Where the page's `ryco.send` goes; absent where it may not send. */
  readonly onSendMessage?: HtmlRenderPageMessageSender | undefined;
  /** The page area: its gutter and corners. */
  readonly className?: string;
  /** The page zooms (see `useHtmlRenderZoom`); fixed at 100% without it. */
  readonly zoom?: HtmlRenderZoom | undefined;
}) {
  const { source, title, zoom } = props;
  const html = source.html;
  // Read apart: the box callback goes to `ref`, the rest is rendered.
  const zoomLevel = zoom?.zoom ?? 1;
  const attachZoomBox = zoom?.attachBox;
  const pageClassName = cn(
    "flex min-h-0 flex-1 flex-col overflow-hidden bg-background",
    props.className,
  );
  if (html === undefined) {
    return (
      <div className={pageClassName}>
        <HtmlRenderSourceStatus source={source} title={title} sizeBytes={props.sizeBytes} />
      </div>
    );
  }
  return (
    <>
      {props.showSource && <HtmlRenderSourceView html={html} />}
      <div
        // Where a send confirmation returns focus: the page's container, not the page.
        tabIndex={-1}
        className={cn(pageClassName, "outline-none", props.showSource && "hidden")}
      >
        {zoom ? (
          // The frame is laid out at the box's size over the zoom and scaled
          // back up to fill it, as browser zoom does.
          <div
            ref={attachZoomBox}
            data-html-render-zoom={zoomLevel}
            className="relative min-h-0 w-full flex-1 overflow-hidden"
          >
            <HtmlRenderDocument
              html={html}
              title={title}
              className="absolute top-0 left-0"
              frameStyle={htmlRenderZoomFrameStyle(zoomLevel)}
              {...(props.onEscape ? { onEscape: props.onEscape } : {})}
              onSendMessage={props.onSendMessage}
              onZoomRequest={zoom.onZoomRequest}
              onContentWidth={zoom.onContentWidth}
            />
          </div>
        ) : (
          <HtmlRenderDocument
            html={html}
            title={title}
            className="min-h-0 w-full flex-1"
            {...(props.onEscape ? { onEscape: props.onEscape } : {})}
            onSendMessage={props.onSendMessage}
          />
        )}
      </div>
    </>
  );
}
