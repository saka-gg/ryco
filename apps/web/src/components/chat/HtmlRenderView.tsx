import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { cn } from "~/lib/utils";
import { useEffect, useState } from "react";

import { formatAttachmentBytes } from "./attachmentPreview";
import type { HtmlRenderSource } from "./useHtmlRenderSource";

/**
 * What the inline frame shows while its page is not in yet. The full-size
 * pieces (dialog, page tab) live in `HtmlRenderFullView`.
 */

// A quick load paints nothing but the page; only a slow one shows a faint skeleton.
const LOADING_INDICATOR_DELAY_MS = 150;

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
