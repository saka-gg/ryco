import { useCallback, useSyncExternalStore } from "react";

import { PREFERS_REDUCED_MOTION_QUERY } from "../lib/perf/motion";
import {
  APPEARANCE_PREFERENCES_CHANGE_EVENT,
  APPEARANCE_PREFERENCES_STORAGE_KEY,
  getAppearancePreferences,
  getEffectiveAppearancePreferences,
  isReducedMotionEffective,
  isSurfaceTransparencyReducedBySystem,
  type AppearancePreferenceKey,
} from "../themes/appearancePreferences";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_PREFERENCES_STORAGE_KEY) onChange();
  };
  window.addEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * Reactively read a single appearance preference. Updates whenever the
 * preference changes in this tab (via {@link APPEARANCE_PREFERENCES_CHANGE_EVENT})
 * or another tab (via the `storage` event). Returns the resolved string value,
 * which falls back to the default when no override is stored.
 *
 * With `{ effective: true }` the value is the selection that actually drives the
 * document variables: `surfaceTransparency` then carries the phone tier's
 * unstored default instead of the desktop one. It is republished through the
 * same change event, so the same subscription covers it.
 */
export function useAppearancePreference(
  key: AppearancePreferenceKey,
  options?: { readonly effective?: boolean },
): string {
  const effective = options?.effective ?? false;
  const getSnapshot = useCallback(
    () => (effective ? getEffectiveAppearancePreferences() : getAppearancePreferences())[key],
    [effective, key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether the OS is currently forcing translucent surfaces opaque. This never
 * changes the selected value — it is a presentation override enforced in CSS —
 * so a settings control must report it alongside the selection rather than
 * displaying the forced step as though it had been chosen.
 */
export function useSurfaceTransparencyReducedBySystem(): boolean {
  return useSyncExternalStore(
    subscribe,
    isSurfaceTransparencyReducedBySystem,
    isSurfaceTransparencyReducedBySystem,
  );
}

/**
 * Subscribes to both inputs of {@link isReducedMotionEffective}: the in-app
 * Motion preference and the OS `prefers-reduced-motion` query. The query is
 * watched directly rather than through the environment sync's republished
 * change event, so a consumer stays correct wherever that sync is not wired.
 */
export function subscribeToReducedMotionEffective(onChange: () => void): () => void {
  const unsubscribePreferences = subscribe(onChange);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return unsubscribePreferences;
  }
  const mediaQueryList = window.matchMedia(PREFERS_REDUCED_MOTION_QUERY);
  mediaQueryList.addEventListener("change", onChange);
  return () => {
    unsubscribePreferences();
    mediaQueryList.removeEventListener("change", onChange);
  };
}

/**
 * Reactive {@link isReducedMotionEffective}: whether motion is reduced by the
 * in-app Motion preference or by the OS setting. For components whose motion
 * runs outside CSS (Web Animations, JS timers) or that mark a subtree reduced.
 */
export function useReducedMotionEffective(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotionEffective,
    isReducedMotionEffective,
    isReducedMotionEffective,
  );
}
