import { useSyncExternalStore } from "react";

import {
  ACTIVE_THEME_STORAGE_KEY,
  CUSTOM_THEMES_STORAGE_KEY,
  DEFAULT_THEME_ID,
  applyThemeToDocument,
  findTheme,
  getActiveThemeId,
  setActiveThemeId,
  subscribeThemeRegistry,
} from "../themes/registry";
import {
  APPEARANCE_PREFERENCES_STORAGE_KEY,
  applyAppearancePreferencesToDocument,
} from "../themes/appearancePreferences";

type Theme = "light" | "dark" | "system";
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
  activeThemeId: string;
};

const STORAGE_KEY = "ryco:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  systemDark: false,
  activeThemeId: DEFAULT_THEME_ID,
};
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: Theme | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function hasThemeStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark() {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

function getStored(): Theme {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.theme;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return DEFAULT_THEME_SNAPSHOT.theme;
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

let transitionGuardFrame: number | null = null;

/**
 * Suppresses transitions while the theme swaps. Root class changes restyle the
 * whole document (587 KiB sheet), so instead of forcing a synchronous reflow
 * between adding and removing the guard, the next frame's style pass sees the
 * guard and the new theme together and the guard lifts one frame later. The
 * browser chrome colour is read in that first frame too, instead of forcing
 * its own recalc now.
 */
function startThemeTransitionGuard(root: HTMLElement) {
  root.classList.add("no-transitions");
  if (transitionGuardFrame !== null) cancelAnimationFrame(transitionGuardFrame);
  transitionGuardFrame = requestAnimationFrame(() => {
    syncBrowserChromeTheme();
    transitionGuardFrame = requestAnimationFrame(() => {
      transitionGuardFrame = null;
      root.classList.remove("no-transitions");
    });
  });
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const root = document.documentElement;
  if (suppressTransitions) startThemeTransitionGuard(root);
  const isDark = theme === "dark" || (theme === "system" && getSystemDark());
  root.classList.toggle("dark", isDark);
  applyThemeToDocument(findTheme(getActiveThemeId()));
  applyAppearancePreferencesToDocument();
  if (!suppressTransitions) syncBrowserChromeTheme();
  syncDesktopTheme(theme);
}

function syncDesktopTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// ---------------------------------------------------------------------------
// One theme controller per document
//
// The theme is applied exactly once per real change: on module load, by the
// setters below, and by a single system color-scheme / cross-tab storage
// listener. `useTheme` is read-only: it never applies the theme and never
// installs listeners of its own, so the per-message ChatMarkdown consumers
// cost a subscription, not a style rewrite plus a forced style recalc each.
// ---------------------------------------------------------------------------

let appliedTheme: Theme | null = null;

function applyThemeChange(theme: Theme, suppressTransitions = false) {
  appliedTheme = theme;
  applyTheme(theme, suppressTransitions);
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && hasThemeStorage()) {
  applyThemeChange(getStored());
}

function readSnapshot(): ThemeSnapshot {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;
  const activeThemeId = getActiveThemeId();

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.activeThemeId === activeThemeId
  ) {
    return lastSnapshot;
  }

  return { theme, systemDark, activeThemeId };
}

/**
 * Cached snapshot, invalidated by `emitChange` (setters and the shared
 * listeners) instead of re-reading storage and media queries on every render.
 */
let snapshotStale = true;

function getSnapshot(): ThemeSnapshot {
  if (snapshotStale || lastSnapshot === null) {
    lastSnapshot = readSnapshot();
    // Without listeners nothing invalidates the cache; read through.
    snapshotStale = listeners.length === 0;
  }
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function handleSystemColorSchemeChange() {
  if (getStored() === "system") applyThemeChange("system", true);
  invalidateAndEmit();
}

function handleThemeStorage(event: StorageEvent) {
  if (
    event.key === STORAGE_KEY ||
    event.key === ACTIVE_THEME_STORAGE_KEY ||
    event.key === CUSTOM_THEMES_STORAGE_KEY ||
    event.key === APPEARANCE_PREFERENCES_STORAGE_KEY
  ) {
    applyThemeChange(getStored(), true);
    invalidateAndEmit();
  }
}

let detachDocumentListeners: (() => void) | null = null;

/**
 * Installed by the first consumer and kept for the document's lifetime: the
 * controller owns the applied theme even while no component reads it (pages
 * without a themed consumer), so a system color-scheme flip or another tab's
 * theme write is never missed. One listener set, however many consumers.
 */
function attachDocumentListeners() {
  if (detachDocumentListeners !== null || typeof window === "undefined") return;
  const mq = window.matchMedia(MEDIA_QUERY);
  mq.addEventListener("change", handleSystemColorSchemeChange);
  window.addEventListener("storage", handleThemeStorage);
  // Same-tab registry writes (theme editor) change the snapshot without a
  // storage event; they apply the theme themselves.
  const unsubscribeRegistry = subscribeThemeRegistry(invalidateAndEmit);
  detachDocumentListeners = () => {
    mq.removeEventListener("change", handleSystemColorSchemeChange);
    window.removeEventListener("storage", handleThemeStorage);
    unsubscribeRegistry();
  };
  // Changes between the module-load apply and the first consumer.
  const stored = getStored();
  const expectedDark = stored === "dark" || (stored === "system" && getSystemDark());
  if (
    appliedTheme !== stored ||
    document.documentElement.classList.contains("dark") !== expectedDark
  ) {
    applyThemeChange(stored);
  }
}

function invalidateAndEmit() {
  snapshotStale = true;
  emitChange();
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);
  snapshotStale = true;
  attachDocumentListeners();

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    // Without consumers nothing reads the cached snapshot; read through.
    if (listeners.length === 0) snapshotStale = true;
  };
}

function setTheme(next: Theme) {
  if (!hasThemeStorage()) return;
  localStorage.setItem(STORAGE_KEY, next);
  applyThemeChange(next, true);
  invalidateAndEmit();
}

function setActiveTheme(id: string) {
  if (!hasThemeStorage()) return;
  setActiveThemeId(id);
  applyThemeChange(getStored(), true);
  invalidateAndEmit();
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;
  const activeThemeId = snapshot.activeThemeId;

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (snapshot.systemDark ? "dark" : "light") : theme;

  return { theme, setTheme, resolvedTheme, activeThemeId, setActiveTheme } as const;
}

export function __resetThemeControllerForTests(): void {
  if (transitionGuardFrame !== null) cancelAnimationFrame(transitionGuardFrame);
  transitionGuardFrame = null;
  detachDocumentListeners?.();
  detachDocumentListeners = null;
  listeners = [];
  lastSnapshot = null;
  snapshotStale = true;
  appliedTheme = null;
  lastDesktopTheme = null;
}
