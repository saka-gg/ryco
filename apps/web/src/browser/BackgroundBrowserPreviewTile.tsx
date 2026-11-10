import { useEffect, useRef, useState } from "react";
import { GlobeIcon } from "lucide-react";
import type { BrowserProject } from "./BrowserPanel";
import { projectBrowserKey, useProjectBrowserTabs } from "./browserState";

/** A view-only thumbnail: never mounts a native page or changes browser focus. */
export function BackgroundBrowserPreview({
  environmentId,
  cwd,
  onOpen,
}: BrowserProject & { onOpen: () => void }) {
  const { selected, api } = useProjectBrowserTabs(projectBrowserKey(environmentId, cwd));
  const container = useRef<HTMLButtonElement>(null);
  const [frame, setFrame] = useState<{ tab: string; src: string } | null>(null);
  const tab = selected?.id;
  useEffect(() => {
    if (!api || !tab || !container.current) return;
    let disposed = false;
    let visible = false;
    let pending = false;
    const capture = async () => {
      if (disposed || pending || !visible || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const src = await api.capture(tab);
        if (!disposed) setFrame({ tab, src });
      } catch {
        if (!disposed) setFrame(null);
      } finally {
        pending = false;
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) void capture();
    });
    observer.observe(container.current);
    const update = () => void capture();
    document.addEventListener("visibilitychange", update);
    const timer = window.setInterval(update, 2000);
    return () => {
      disposed = true;
      observer.disconnect();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [api, tab]);
  if (!api || !selected) return null;
  return (
    <button
      ref={container}
      type="button"
      aria-label="Open browser in workspace"
      onClick={onOpen}
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
