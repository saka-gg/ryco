import type { ThreadLocalServer } from "@ryco/contracts";
import type {
  NodeBrowserCapability,
  NodeBrowserInputEvent,
  NodeBrowserTab,
} from "@ryco/contracts/node-browser";

/**
 * The phone's view of the node's browser and of the servers a thread
 * started, without React. Tabs run in Chrome on the node (so `localhost` is
 * the node's), the phone shows a still of the page refreshed while it looks,
 * and taps, scrolls and typing go back as input events.
 */

/** How often the shown still refreshes while the screen is in front. */
export const PREVIEW_STILL_INTERVAL_MS = 700;
/** The still's longest side the phone asks for, in device pixels. */
export const PREVIEW_STILL_MAX_WIDTH = 1170;
export const PREVIEW_STILL_MAX_HEIGHT = 1200;
export const PREVIEW_STILL_QUALITY = 60;
/** The node's smallest tab viewport (its `resize` minimum). */
const MIN_VIEWPORT = { width: 320, height: 240 } as const;

/**
 * The tab's CSS viewport for a preview area of this size: the area itself, so
 * a responsive page lays out for a phone. Null until the area is measured.
 */
export function previewViewport(
  areaWidth: number,
  areaHeight: number,
): { readonly width: number; readonly height: number } | null {
  if (areaWidth < 1 || areaHeight < 1) return null;
  return {
    width: Math.max(MIN_VIEWPORT.width, Math.round(areaWidth)),
    height: Math.max(MIN_VIEWPORT.height, Math.round(areaHeight)),
  };
}

export function nodeBrowserUnavailableMessage(capability: NodeBrowserCapability | null): string {
  if (!capability) return "This machine has no browser for previews. Update Ryco on it.";
  switch (capability.reason) {
    case "installing":
      return "Ryco is installing the browser on this machine. Try again in a minute.";
    case "crashed":
      return "The machine's browser stopped several times in a row. Ryco tries again in a few minutes.";
    case "sandbox-blocked":
      return "This machine gives Chrome no usable sandbox, so it cannot run preview tabs.";
    default:
      return "Previews are not available on this machine.";
  }
}

/** The project's tabs, newest last, as the desktop's tab strip lists them. */
export function tabsInScope(
  tabs: ReadonlyArray<NodeBrowserTab>,
  scope: string,
): ReadonlyArray<NodeBrowserTab> {
  return tabs.filter((tab) => tab.scope === scope);
}

/** A tab already showing `url` (ignoring a trailing slash), to reuse instead of opening another. */
export function tabForUrl(tabs: ReadonlyArray<NodeBrowserTab>, url: string): NodeBrowserTab | null {
  const strip = (value: string) => value.replace(/\/+$/u, "");
  return tabs.find((tab) => strip(tab.url) === strip(url)) ?? null;
}

export function tabLabel(tab: Pick<NodeBrowserTab, "title" | "url">): string {
  const title = tab.title.trim();
  if (title.length > 0) return title;
  try {
    const url = new URL(tab.url);
    return url.host || tab.url;
  } catch {
    return tab.url || "New tab";
  }
}

export interface ShownImage {
  /** The still's size in CSS pixels of the page. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** The size the still is drawn at on the phone. */
  readonly viewWidth: number;
  readonly viewHeight: number;
}

/** A point on the drawn still in page CSS pixels, clamped into the page. */
export function pagePoint(
  image: ShownImage,
  viewX: number,
  viewY: number,
): { readonly x: number; readonly y: number } {
  const scaleX = image.cssWidth / Math.max(1, image.viewWidth);
  const scaleY = image.cssHeight / Math.max(1, image.viewHeight);
  return {
    x: Math.round(Math.min(image.cssWidth - 1, Math.max(0, viewX * scaleX))),
    y: Math.round(Math.min(image.cssHeight - 1, Math.max(0, viewY * scaleY))),
  };
}

/** A left click: move, press and release at one point. */
export function clickEvents(point: {
  readonly x: number;
  readonly y: number;
}): NodeBrowserInputEvent[] {
  const base = { x: point.x, y: point.y, modifiers: 0 } as const;
  return [
    { type: "mouse", action: "move", button: "none", buttons: 0, clickCount: 0, ...base },
    { type: "mouse", action: "down", button: "left", buttons: 1, clickCount: 1, ...base },
    { type: "mouse", action: "up", button: "left", buttons: 0, clickCount: 1, ...base },
  ];
}

/**
 * A finger drag as a wheel scroll: dragging up scrolls the page down, by the
 * distance dragged in page pixels.
 */
export function scrollEvent(
  image: ShownImage,
  at: { readonly x: number; readonly y: number },
  dragX: number,
  dragY: number,
): NodeBrowserInputEvent | null {
  const point = pagePoint(image, at.x, at.y);
  // `|| 0`: no drag is 0, not -0.
  const deltaX = Math.round((-dragX * image.cssWidth) / Math.max(1, image.viewWidth)) || 0;
  const deltaY = Math.round((-dragY * image.cssHeight) / Math.max(1, image.viewHeight)) || 0;
  if (deltaX === 0 && deltaY === 0) return null;
  return {
    type: "wheel",
    x: point.x,
    y: point.y,
    deltaX: Math.max(-10_000, Math.min(10_000, deltaX)),
    deltaY: Math.max(-10_000, Math.min(10_000, deltaY)),
    modifiers: 0,
  };
}

/** Typed text, then Enter when asked: what the phone's "Type" field sends. */
export function typingEvents(text: string, pressEnter: boolean): NodeBrowserInputEvent[] {
  const events: NodeBrowserInputEvent[] = [];
  if (text.length > 0) events.push({ type: "text", text });
  if (pressEnter) {
    const enter = { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 } as const;
    events.push({ type: "key", action: "down", ...enter }, { type: "key", action: "up", ...enter });
  }
  return events;
}

export interface ServerRow {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly url: string;
}

/** The thread's servers as rows: the page title when it has one, else the process and port. */
export function serverRows(servers: ReadonlyArray<ThreadLocalServer>): ServerRow[] {
  return servers
    .toSorted((left, right) => left.port - right.port)
    .map((server) => ({
      key: `${server.pid}:${server.startTimeMs}:${server.port}`,
      title: server.pageTitle ?? server.processName ?? `Port ${server.port}`,
      detail: [server.url, server.processName].filter(Boolean).join(" · "),
      url: server.url,
    }));
}

/**
 * The size to give a shared tab back when the phone stops showing it: the one
 * it had before, unless it had none or the phone's own size is that size.
 */
export function viewportToRestore(
  before: { readonly width: number; readonly height: number } | null,
  own: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } | null {
  if (!before) return null;
  if (before.width === own.width && before.height === own.height) return null;
  return { width: before.width, height: before.height };
}
