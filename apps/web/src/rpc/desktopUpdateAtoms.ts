import { useAtomValue } from "@effect/atom-react";
import type { DesktopUpdateState } from "@ryco/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "@ryco/client-runtime/rpc";

/**
 * Writable atom mirroring the desktop updater state. Replaces the previous
 * React Query cache: the renderer subscribes to `desktopBridge.onUpdateState`
 * push events and writes imperative action results back through `setDesktopUpdateState`.
 */
export const desktopUpdateStateAtom = Atom.make<DesktopUpdateState | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop-update-state"),
);

export function getDesktopUpdateState(): DesktopUpdateState | null {
  return appAtomRegistry.get(desktopUpdateStateAtom);
}

export function setDesktopUpdateState(state: DesktopUpdateState | null): void {
  appAtomRegistry.set(desktopUpdateStateAtom, state);
}

/** Notifies on every write to {@link desktopUpdateStateAtom}; returns the unsubscribe. */
export function subscribeDesktopUpdateState(listener: () => void): () => void {
  return appAtomRegistry.subscribe(desktopUpdateStateAtom, () => listener());
}

/**
 * Keeps {@link desktopUpdateStateAtom} current outside React: fetches a fresh
 * snapshot now and mirrors every updater push until the returned stop runs.
 * A no-op outside the desktop app.
 */
export function followDesktopUpdateState(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge) return () => undefined;

  let cancelled = false;
  if (typeof bridge.getUpdateState === "function") {
    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (!cancelled) {
          setDesktopUpdateState(nextState);
        }
      })
      .catch(() => undefined);
  }

  const unsubscribe =
    typeof bridge.onUpdateState === "function"
      ? bridge.onUpdateState((nextState) => {
          setDesktopUpdateState(nextState);
        })
      : undefined;

  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/**
 * Subscribes to desktop updater push events and returns the latest state.
 * Re-fetches a fresh snapshot on every mount (previous `refetchOnMount: "always"`
 * semantics) so Settings never reuses stale desktop update state.
 */
export function useDesktopUpdateState(): DesktopUpdateState | null {
  const state = useAtomValue(desktopUpdateStateAtom);

  useEffect(() => followDesktopUpdateState(), []);

  return state;
}
