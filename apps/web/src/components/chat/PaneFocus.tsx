import type { ScopedThreadRef } from "@ryco/contracts";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type DependencyList,
  type EffectCallback,
} from "react";

/** Shared input boundary for chat, selection and voice surfaces (including portals).
 * Outside a split the ordinary thread view remains the input owner. This is presentation
 * ownership only; it must never grant RPC or mutation authority.
 */
export const PaneFocusContext = createContext(true);
/** Null outside the pane shell. Additive scope for composer actions. */
export const PaneThreadContext = createContext<ScopedThreadRef | null>(null);
export function usePaneThreadRef() {
  return useContext(PaneThreadContext);
}
export function usePaneFocus(): boolean {
  return useContext(PaneFocusContext);
}

/** Deferred focus callbacks must check the current owner, not their scheduling render. */
export function usePaneFocusRef() {
  const focused = usePaneFocus();
  const ref = useRef(focused);
  useLayoutEffect(() => {
    ref.current = focused;
    return () => {
      ref.current = false;
    };
  }, [focused]);
  return ref;
}

/** Installs interaction effects only for the current pane; also cleans up on focus loss.
 * Context propagates through React portals, so overlays use the same owner.
 */
export function usePaneEffect(effect: EffectCallback, dependencies: DependencyList): void {
  const focused = usePaneFocus();
  // This effect wrapper deliberately forwards its caller's dependency list,
  // adding focus as a cleanup boundary just as useEffect adds mount/unmount.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => (focused ? effect() : undefined), [focused, ...dependencies]);
}

export type PaneCloseGuard = () => boolean | Promise<boolean>;
export const PaneCloseGuardContext = createContext<((guard: PaneCloseGuard) => () => void) | null>(
  null,
);
/** Presentation drafts can veto unmount. Registration is local, including inactive panes. */
export function usePaneCloseGuard(guard: PaneCloseGuard): void {
  const register = useContext(PaneCloseGuardContext);
  const latest = useRef(guard);
  useLayoutEffect(() => {
    latest.current = guard;
  });
  useLayoutEffect(() => register?.(() => latest.current()), [register]);
}
