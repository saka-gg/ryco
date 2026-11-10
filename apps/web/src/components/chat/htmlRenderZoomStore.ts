import { clampHtmlRenderZoom } from "@ryco/shared/htmlRenderZoom";
import { useCallback, useState, useSyncExternalStore } from "react";

/**
 * How far the reader zoomed each agent page this session: a level, or "fit
 * the page's width". The expanded view and the page tab of one page share it,
 * and it lasts until the app reloads. Memory only, keyed by the page's
 * environment, thread, message and attachment.
 */
export type HtmlRenderZoomSetting =
  | { readonly mode: "zoom"; readonly zoom: number }
  | { readonly mode: "fit" };

export const DEFAULT_HTML_RENDER_ZOOM: HtmlRenderZoomSetting = { mode: "zoom", zoom: 1 };

// Pages zoomed this session; the oldest go first past this many.
const MAX_REMEMBERED = 200;
const settings = new Map<string, HtmlRenderZoomSetting>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readHtmlRenderZoomSetting(key: string | null): HtmlRenderZoomSetting {
  return (key === null ? undefined : settings.get(key)) ?? DEFAULT_HTML_RENDER_ZOOM;
}

export function writeHtmlRenderZoomSetting(key: string, setting: HtmlRenderZoomSetting): void {
  const next: HtmlRenderZoomSetting =
    setting.mode === "fit" ? setting : { mode: "zoom", zoom: clampHtmlRenderZoom(setting.zoom) };
  const current = settings.get(key);
  if (
    current !== undefined &&
    current.mode === next.mode &&
    (next.mode === "fit" || (current.mode === "zoom" && current.zoom === next.zoom))
  ) {
    return;
  }
  settings.delete(key);
  if (!(next.mode === "zoom" && next.zoom === 1)) {
    settings.set(key, next);
    if (settings.size > MAX_REMEMBERED) {
      const oldest = settings.keys().next().value;
      if (oldest !== undefined) settings.delete(oldest);
    }
  }
  emit();
}

/** The key a page's zoom is remembered under. */
export function htmlRenderZoomKey(input: {
  readonly environmentId: string | undefined | null;
  readonly threadId: string | undefined | null;
  readonly messageId: string | undefined | null;
  readonly attachmentId: string;
}): string | null {
  const { environmentId, threadId, messageId, attachmentId } = input;
  return environmentId && threadId && messageId
    ? `${environmentId}:${threadId}:${messageId}:${attachmentId}`
    : null;
}

export function useHtmlRenderZoomSetting(
  key: string | null,
): readonly [HtmlRenderZoomSetting, (setting: HtmlRenderZoomSetting) => void] {
  const remembered = useSyncExternalStore(
    subscribe,
    () => readHtmlRenderZoomSetting(key),
    () => DEFAULT_HTML_RENDER_ZOOM,
  );
  // A page with no key (not on a known thread message) still zooms, for as
  // long as it is shown: its level is its own state, never remembered.
  const [own, setOwn] = useState<HtmlRenderZoomSetting>(DEFAULT_HTML_RENDER_ZOOM);
  const write = useCallback(
    (next: HtmlRenderZoomSetting) => {
      if (key === null) {
        setOwn(next.mode === "fit" ? next : { mode: "zoom", zoom: clampHtmlRenderZoom(next.zoom) });
        return;
      }
      writeHtmlRenderZoomSetting(key, next);
    },
    [key],
  );
  return [key === null ? own : remembered, write] as const;
}

export function __resetHtmlRenderZoomForTests(): void {
  settings.clear();
  emit();
}
