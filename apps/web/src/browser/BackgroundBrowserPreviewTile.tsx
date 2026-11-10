import { useEffect, useRef, useState } from "react";
import { GlobeIcon } from "lucide-react";
import { createVisibilityAwarePoller } from "~/lib/visibilityPolling";
import { webAppLifecycle } from "~/platform/appLifecycle";
import type { ProjectBrowserTab } from "@ryco/contracts";

type ProjectBrowserApi = NonNullable<NonNullable<Window["desktopBridge"]>["browser"]>;

/** How often the thumbnail follows a changing page. */
const PREVIEW_CAPTURE_MS = 2_000;
/** The slowest it follows a still page. */
const PREVIEW_IDLE_CAPTURE_MS = 10_000;
/** Identical captures in a row before the thumbnail starts slowing down. */
const PREVIEW_STILL_CAPTURES = 3;

/** 2 s while the page changes; after a few identical captures 4 s, 8 s, then 10 s. */
function previewCaptureDelayMs(unchanged: number): number {
  if (unchanged < PREVIEW_STILL_CAPTURES) return PREVIEW_CAPTURE_MS;
  return Math.min(
    PREVIEW_IDLE_CAPTURE_MS,
    PREVIEW_CAPTURE_MS * 2 ** (unchanged - PREVIEW_STILL_CAPTURES + 1),
  );
}

/**
 * The thumbnail of a project's background browser, loaded only once one runs
 * (`BackgroundBrowserPreview` decides). A view-only thumbnail: never mounts a
 * native page or changes browser focus.
 */
export function BackgroundBrowserPreviewTile({
  selected,
  api,
  onOpen,
}: {
  readonly selected: ProjectBrowserTab;
  readonly api: ProjectBrowserApi;
  readonly onOpen: () => void;
}) {
  const container = useRef<HTMLButtonElement>(null);
  const wake = useRef<(() => void) | null>(null);
  const [frame, setFrame] = useState<{ tab: string; src: string } | null>(null);
  const tab = selected.id;
  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let visible = false;
    let lastSrc: string | null = null;
    let unchanged = 0;
    // Captures only while the tile is on screen and the window is shown; a still page (the
    // desktop returns the same URL for unchanged pixels) is captured less and less often.
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      runImmediately: false,
      resolveDelayMs: () => (visible ? previewCaptureDelayMs(unchanged) : false),
      run: async () => {
        if (disposed || !visible || !webAppLifecycle.isForeground()) return;
        try {
          const src = await api.capture(tab);
          if (disposed) return;
          if (src === lastSrc) {
            unchanged += 1;
            return;
          }
          lastSrc = src;
          unchanged = 0;
          setFrame({ tab, src });
        } catch {
          if (disposed) return;
          lastSrc = null;
          unchanged = 0;
          setFrame(null);
        }
      },
    });
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) void poller.refresh();
    });
    observer.observe(container.current);
    wake.current = () => {
      unchanged = 0;
      void poller.refresh();
    };
    return () => {
      disposed = true;
      wake.current = null;
      observer.disconnect();
      poller.stop();
    };
  }, [api, tab]);
  return (
    <button
      ref={container}
      type="button"
      aria-label="Open browser in workspace"
      onClick={onOpen}
      onPointerEnter={() => wake.current?.()}
      className="mx-3 my-3 block w-[calc(100%-1.5rem)] overflow-hidden rounded-lg border text-left hover:bg-accent/40"
    >
      <span className="flex items-center gap-2 px-3 py-2 text-xs">
        <GlobeIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{selected.title || selected.url}</span>
        <span className="text-muted-foreground">Browser</span>
      </span>
      {frame && frame.tab === tab ? (
        <img src={frame.src} alt="Browser preview" className="max-h-44 w-full object-contain" />
      ) : (
        <span className="block px-3 pb-3 text-xs text-muted-foreground">
          Running in the workspace
        </span>
      )}
    </button>
  );
}
