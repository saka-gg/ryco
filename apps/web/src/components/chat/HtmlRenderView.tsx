import {
  htmlRenderFileName,
  stripHtmlRenderBootstrap,
  HTML_RENDER_SOURCE_PREVIEW_MAX_CHARS,
} from "@ryco/shared/htmlRender";
import { CodeIcon, DownloadIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Toggle } from "../ui/toggle";
import { formatAttachmentBytes } from "./attachmentPreview";
import { HtmlRenderDocument } from "./HtmlRenderDocument";
import type { HtmlRenderSource } from "./useHtmlRenderSource";

/**
 * The pieces every surface that shows an agent's HTML render shares: the
 * inline frame, the full-size dialog and the workspace panel's page tab.
 */

const DOWNLOAD_URL_LIFETIME_MS = 60_000;
// A quick load paints nothing but the page; only a slow one shows a faint skeleton.
const LOADING_INDICATOR_DELAY_MS = 150;

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

function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => setElapsed(true), delayMs);
    return () => {
      window.clearTimeout(timeout);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}

/**
 * What a render's box holds until its page is in: nothing for a quick load,
 * a faint skeleton for a slow one, a retry after a failure, or a load button
 * for a page above the auto-load cap.
 */
export function HtmlRenderSourceStatus(props: {
  readonly source: HtmlRenderSource;
  readonly title: string;
  readonly sizeBytes: number;
  readonly className?: string;
}) {
  const { source, title } = props;
  const showLoading = useDelayedFlag(source.loading, LOADING_INDICATOR_DELAY_MS);
  const boxClassName = cn(
    "flex size-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground",
    props.className,
  );
  if (source.failed) {
    return (
      <div role="status" className={boxClassName}>
        <span>Unable to load {title}</span>
        <Button variant="outline" size="xs" onClick={source.retry}>
          Retry
        </Button>
      </div>
    );
  }
  if (source.deferred) {
    return (
      <div className={boxClassName}>
        <span>
          {title} · {formatAttachmentBytes(props.sizeBytes)}
        </span>
        <Button variant="outline" size="xs" onClick={source.retry}>
          Load page
        </Button>
      </div>
    );
  }
  return showLoading ? (
    <Skeleton className={cn("size-full rounded-lg opacity-50", props.className)} />
  ) : null;
}

/** The Source toggle and Download button of a render shown at full size. */
export function HtmlRenderViewActions(props: {
  readonly html: string | undefined;
  readonly title: string;
  readonly showSource: boolean;
  readonly onShowSourceChange: (showSource: boolean) => void;
}) {
  const { html, title } = props;
  return (
    <>
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
  /** The page area: its gutter and corners. */
  readonly className?: string;
}) {
  const { source, title } = props;
  const html = source.html;
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
      <div className={cn(pageClassName, props.showSource && "hidden")}>
        <HtmlRenderDocument
          html={html}
          title={title}
          className="min-h-0 w-full flex-1"
          {...(props.onEscape ? { onEscape: props.onEscape } : {})}
        />
      </div>
    </>
  );
}
