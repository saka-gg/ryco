import type { DesktopBridge } from "@ryco/contracts";

import { isWindowsPlatform } from "../lib/utils";

const BADGE_SIZE = 64;
const BADGE_COLOR = "#e5484d";
/** The page's icons, `icon` and `shortcut icon`, but not `apple-touch-icon`. */
const ICON_LINKS = 'link[rel~="icon"]';

/** Up to nine, then "9+". */
export function threadBadgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/**
 * The count in white on a red disk, as a 64px PNG data URL: in the corner of
 * `base` (the favicon) when given, filling the image otherwise (the Windows
 * taskbar overlay). Null where no canvas can draw it.
 */
export function drawThreadBadge(count: number, base: CanvasImageSource | null): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = BADGE_SIZE;
    canvas.height = BADGE_SIZE;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    const label = threadBadgeLabel(count);
    const radius = base === null ? 28 : 22;
    const center = base === null ? BADGE_SIZE / 2 : BADGE_SIZE - radius;
    if (base !== null) context.drawImage(base, 0, 0, BADGE_SIZE, BADGE_SIZE);
    context.fillStyle = BADGE_COLOR;
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "white";
    context.font = `600 ${Math.round(radius * (label.length > 1 ? 1.05 : 1.4))}px "Segoe UI", system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, center, center + radius * 0.07);
    return canvas.toDataURL("image/png");
  } catch {
    // A cross-origin favicon taints the canvas.
    return null;
  }
}

/** What the favicon badge reads from the page; tests replace it. */
export interface FaviconBadgeHost {
  readonly document: Pick<Document, "head" | "createElement">;
  /** Runs `apply` once the page has loaded: index.html adds its icons on load. */
  readonly whenLoaded: (apply: () => void) => void;
  readonly loadImage: (href: string) => Promise<CanvasImageSource | null>;
  readonly draw: (count: number, base: CanvasImageSource | null) => string | null;
}

function browserFaviconBadgeHost(): FaviconBadgeHost {
  return {
    document,
    whenLoaded: (apply) => {
      if (document.readyState === "complete") apply();
      else window.addEventListener("load", apply, { once: true });
    },
    loadImage: async (href) => {
      const image = new Image();
      image.src = href;
      try {
        await image.decode();
        return image;
      } catch {
        return null;
      }
    },
    draw: drawThreadBadge,
  };
}

/**
 * The count drawn over the favicon. While it shows, the page's own icon links
 * leave the head (a browser may keep showing any of them) and one badge link
 * stands in; at 0 they come back.
 */
export function createFaviconBadge(host: FaviconBadgeHost = browserFaviconBadgeHost()): {
  readonly set: (count: number) => void;
} {
  const { head } = host.document;
  let icons: ReadonlyArray<Element> = [];
  let badge: HTMLLinkElement | null = null;
  let base: Promise<CanvasImageSource | null> | null = null;
  // Only the latest count draws; a base image still loading may finish late.
  let generation = 0;

  const loadBase = () => {
    const icon =
      head.querySelector<HTMLLinkElement>(`${ICON_LINKS}[type="image/png"]`) ??
      head.querySelector<HTMLLinkElement>(ICON_LINKS);
    return icon === null ? Promise.resolve(null) : host.loadImage(icon.href);
  };
  const show = (href: string) => {
    if (badge === null) {
      icons = Array.from(head.querySelectorAll(ICON_LINKS));
      for (const icon of icons) icon.remove();
      badge = host.document.createElement("link");
      badge.rel = "icon";
      badge.type = "image/png";
      badge.setAttribute("data-ryco-badge", "");
      head.append(badge);
    }
    badge.href = href;
  };
  const restore = () => {
    if (badge === null) return;
    badge.remove();
    badge = null;
    head.append(...icons);
    icons = [];
  };

  return {
    set: (count) => {
      const current = (generation += 1);
      if (count <= 0) {
        restore();
        return;
      }
      host.whenLoaded(() => {
        base ??= loadBase();
        void base.then((image) => {
          if (current !== generation) return;
          const href = host.draw(count, image);
          if (href !== null) show(href);
        });
      });
    },
  };
}

/**
 * Shows how many threads alerted while Ryco was in the background, 0 clears
 * it: on the dock or taskbar in the desktop app, and on the favicon and the
 * installed web app's icon in a browser.
 */
export function createThreadAlertBadge(
  desktopBridge: Pick<DesktopBridge, "setNotificationBadge"> | undefined,
): (count: number) => void {
  const setNotificationBadge = desktopBridge?.setNotificationBadge;
  if (setNotificationBadge) {
    const overlay = isWindowsPlatform(navigator.platform);
    return (count) => {
      setNotificationBadge({
        count,
        image: overlay && count > 0 ? drawThreadBadge(count, null) : null,
      }).catch(() => undefined);
    };
  }
  const favicon = createFaviconBadge();
  return (count) => {
    favicon.set(count);
    if (typeof navigator.setAppBadge !== "function") return;
    (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => undefined);
  };
}
