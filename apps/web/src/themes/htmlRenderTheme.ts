import {
  HTML_RENDER_DEFAULT_FONTS,
  defaultHtmlRenderTheme,
  htmlRenderTheme,
  type HtmlRenderTheme,
} from "@ryco/shared/htmlRender";
import {
  RYCO_DEFAULT_RADIUS,
  THEME_COLOR_TOKENS,
  defaultThemeColors,
  type ThemeAppearance,
  type ThemeColorToken,
} from "@ryco/shared/themePalettes";
import { useSyncExternalStore } from "react";

import {
  APPEARANCE_PREFERENCES_CHANGE_EVENT,
  APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID,
} from "./appearancePreferences";
import { THEME_STYLE_ELEMENT_ID } from "./registry";

/**
 * The app's live theme as handed to agent HTML renders. Ryco's tokens are CSS
 * expressions (`var()`, `color-mix()`, oklch Tailwind colors) layered by the
 * active theme and appearance `<style>` elements, so the only faithful source
 * is the computed style of `<html>`. Every color is flattened to plain sRGB
 * `rgb()`/`rgba()`, which the shared theme can mix and a page can hand to a
 * canvas.
 */

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_STYLE_IDS: ReadonlySet<string> = new Set([
  THEME_STYLE_ELEMENT_ID,
  APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID,
]);
const SERVER_THEME = defaultHtmlRenderTheme("dark");

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function formatRgba({ r, g, b, a }: Rgba): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  const alpha = Math.round(Math.min(1, Math.max(0, a)) * 1000) / 1000;
  return alpha >= 1
    ? `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`
    : `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${alpha})`;
}

const readNumber = (value: string | undefined) =>
  value === undefined || value === "" || !/^-?[\d.]+(?:e-?\d+)?$/i.test(value)
    ? undefined
    : Number(value);

// Exact parses of the sRGB serializations browsers compute, so translucent
// tokens keep their precise alpha instead of a canvas's 8-bit, premultiplied one.
function parseComputedSrgb(value: string): Rgba | undefined {
  const legacy = /^rgba?\(([^)]*)\)$/i.exec(value)?.[1];
  if (legacy !== undefined) {
    const parts = legacy
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(readNumber);
    if (parts.length < 3 || parts.length > 4 || parts.some((part) => part === undefined)) {
      return undefined;
    }
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/i.exec(value)?.[1];
  if (srgb === undefined) return undefined;
  const [channels = "", alpha] = srgb.split("/").map((part) => part.trim());
  const parts = channels
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part === "none" ? 0 : readNumber(part)));
  const a = alpha === undefined ? 1 : alpha === "none" ? 0 : readNumber(alpha);
  if (parts.length !== 3 || parts.some((part) => part === undefined) || a === undefined) {
    return undefined;
  }
  return { r: parts[0]! * 255, g: parts[1]! * 255, b: parts[2]! * 255, a };
}

let canvasContext: CanvasRenderingContext2D | null | undefined;

// Any other syntax (oklch, lab, display-p3) is drawn into one sRGB pixel.
function rasterizeColor(color: string): Rgba | undefined {
  if (canvasContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  const context = canvasContext;
  if (!context) return undefined;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = "rgba(0, 0, 0, 0)";
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

/** A computed CSS color as plain sRGB `rgb()`/`rgba()`, or undefined when it cannot be read. */
export function normalizeHtmlRenderColor(color: string): string | undefined {
  const value = color.trim();
  if (value === "") return undefined;
  const parsed = parseComputedSrgb(value) ?? rasterizeColor(value);
  return parsed === undefined ? undefined : formatRgba(parsed);
}

/** Reads the theme from the document as it is painted right now. */
export function readHtmlRenderTheme(): HtmlRenderTheme {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return SERVER_THEME;
  }
  const root = document.documentElement;
  const appearance: ThemeAppearance = root.classList.contains("dark") ? "dark" : "light";
  const rootStyle = getComputedStyle(root);
  const fallback = defaultThemeColors(appearance);
  // One hidden probe per token under <html>, appended together so the browser
  // resolves them in a single style pass.
  const probes = document.createElement("div");
  probes.hidden = true;
  const colorProbes = THEME_COLOR_TOKENS.map((token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(--${token})`;
    probes.append(probe);
    return probe;
  });
  // The app's radius is rem-based; the page's rem is its own 14px base, so the
  // radius travels as resolved pixels.
  const radiusProbe = document.createElement("span");
  radiusProbe.style.borderTopLeftRadius = "var(--radius)";
  probes.append(radiusProbe);
  root.append(probes);
  try {
    const colors = {} as Record<ThemeColorToken, string>;
    THEME_COLOR_TOKENS.forEach((token, index) => {
      colors[token] =
        rootStyle.getPropertyValue(`--${token}`).trim() === ""
          ? fallback[token]
          : (normalizeHtmlRenderColor(getComputedStyle(colorProbes[index]!).color) ??
            fallback[token]);
    });
    const radius =
      rootStyle.getPropertyValue("--radius").trim() === ""
        ? RYCO_DEFAULT_RADIUS
        : getComputedStyle(radiusProbe).borderTopLeftRadius || RYCO_DEFAULT_RADIUS;
    return htmlRenderTheme(colors, appearance, {
      fonts: {
        sans:
          rootStyle.getPropertyValue("--font-family-sans").trim() || HTML_RENDER_DEFAULT_FONTS.sans,
        mono:
          rootStyle.getPropertyValue("--font-family-mono").trim() || HTML_RENDER_DEFAULT_FONTS.mono,
      },
      radius,
    });
  } finally {
    probes.remove();
  }
}

const listeners = new Set<() => void>();
let current: HtmlRenderTheme | null = null;
let currentKey = "";
let scheduledFrame: number | null = null;
let stopWatching: (() => void) | null = null;

// `useTheme()` re-applies the theme on every mount and the transition guard
// flips a class per change, so most mutations change nothing; only a different
// theme replaces the snapshot.
function refresh(): boolean {
  const next = readHtmlRenderTheme();
  const key = JSON.stringify(next);
  if (current !== null && key === currentKey) return false;
  current = next;
  currentKey = key;
  return true;
}

function scheduleRefresh() {
  if (scheduledFrame !== null) return;
  scheduledFrame = requestAnimationFrame(() => {
    scheduledFrame = null;
    if (!refresh()) return;
    for (const listener of listeners) listener();
  });
}

const isThemeStyle = (node: Node | null) => node instanceof Element && THEME_STYLE_IDS.has(node.id);

function touchesThemeStyle(record: MutationRecord): boolean {
  return (
    isThemeStyle(record.target) ||
    isThemeStyle(record.target.parentNode) ||
    [...record.addedNodes, ...record.removedNodes].some(isThemeStyle)
  );
}

function watchDocument(): () => void {
  const root = document.documentElement;
  // Light/dark lives on <html>'s class.
  const classObserver = new MutationObserver(scheduleRefresh);
  classObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
  // Themes, live editor drafts and the custom primary only rewrite these two
  // style elements; nothing else announces them.
  const styleObserver = new MutationObserver((records) => {
    if (records.some(touchesThemeStyle)) scheduleRefresh();
  });
  styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  window.addEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, scheduleRefresh);
  const media =
    typeof window.matchMedia === "function" ? window.matchMedia(DARK_MEDIA_QUERY) : null;
  media?.addEventListener("change", scheduleRefresh);
  return () => {
    classObserver.disconnect();
    styleObserver.disconnect();
    window.removeEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, scheduleRefresh);
    media?.removeEventListener("change", scheduleRefresh);
    if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
    scheduledFrame = null;
  };
}

/** Subscribes to theme changes; the document is watched only while someone listens. */
export function subscribeHtmlRenderTheme(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  listeners.add(listener);
  if (listeners.size === 1) {
    stopWatching = watchDocument();
    // Catch up on anything that changed while nobody was watching.
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopWatching?.();
    stopWatching = null;
  };
}

/** The current theme; the same object until the theme actually changes. */
export function getHtmlRenderThemeSnapshot(): HtmlRenderTheme {
  // Unwatched, the cached value may be stale, so read the document again.
  if (current === null || listeners.size === 0) refresh();
  return current ?? SERVER_THEME;
}

function getServerSnapshot(): HtmlRenderTheme {
  return SERVER_THEME;
}

/** The app's active theme, fonts and radius for an HTML render. Stable until one changes. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
  return useSyncExternalStore(
    subscribeHtmlRenderTheme,
    getHtmlRenderThemeSnapshot,
    getServerSnapshot,
  );
}
