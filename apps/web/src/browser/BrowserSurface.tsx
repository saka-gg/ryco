import { useEffect, useRef, useState } from "react";
import type { ProjectBrowserTab } from "@ryco/contracts";

/** DOM owns layout; the main process owns guest content and attachment identity. */
export function BrowserSurface({ tab, width }: { tab: ProjectBrowserTab; width: number | null }) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const api = window.desktopBridge?.browser;
  const floating = tab.presentation === "window";
  useEffect(() => {
    if (!api || !slot.current || floating) return;
    const owner = crypto.randomUUID();
    let frame = 0,
      stopped = false,
      previous = "",
      settlingUntil = 0;
    const sync = () => {
      frame = 0;
      if (stopped || !slot.current) return;
      const rect = slot.current.getBoundingClientRect();
      // Native guests sit above DOM. Hide for other app portals, not the preview's own popup.
      const obstructed = [
        ...document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], [data-slot="popover-popup"], [role="menu"]',
        ),
      ].some((element) => !element.contains(slot.current));
      const visible =
        !obstructed &&
        document.visibilityState === "visible" &&
        rect.width >= 1 &&
        rect.height >= 1 &&
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight &&
        !slot.current.closest('[inert], [aria-hidden="true"]');
      const input = {
        owner,
        tab: visible ? tab.id : null,
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.max(1, Math.min(rect.width, innerWidth - rect.left)),
        height: Math.max(1, Math.min(rect.height, innerHeight - rect.top)),
      };
      const key = JSON.stringify(input);
      if (key !== previous) {
        previous = key;
        void api.surface(input).catch((reason) => {
          if (!stopped)
            setError(reason instanceof Error ? reason.message : "Browser surface unavailable.");
        });
      }
      if (performance.now() < settlingUntil) frame = requestAnimationFrame(sync);
    };
    const schedule = () => {
      if (!frame && !stopped) frame = requestAnimationFrame(sync);
    };
    const settle = () => {
      settlingUntil = performance.now() + 500;
      schedule();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(slot.current);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["inert", "aria-hidden", "data-state"],
    });
    window.addEventListener("resize", settle);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("transitionrun", settle, true);
    settle();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", settle);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("transitionrun", settle, true);
      void api.surface({ owner, tab: null, x: 0, y: 0, width: 1, height: 1 }).catch(() => {});
    };
  }, [api, tab.id, floating]);
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-muted/30">
      <div
        ref={slot}
        className="relative min-h-0 bg-white"
        style={{ width: width ?? "100%", maxWidth: "100%", height: "100%" }}
      >
        {api ? (
          error ? (
            <p role="alert" className="p-4 text-sm text-destructive">
              {error}
            </p>
          ) : null
        ) : (
          <iframe
            key={tab.id + tab.url}
            title={tab.title || "Browser preview"}
            src={tab.url}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            className="size-full border-0"
          />
        )}
      </div>
    </div>
  );
}
