import { create } from "zustand";

/**
 * The sidebar header folds into one toolbar row while a sidebar list is
 * scrolled, and unfolds at the top. Both lists report their scroll here; the
 * header only renders `folded`.
 */

/** Scrolling past this folds the header; an unfold by hand lasts until the list moves this far. */
export const SIDEBAR_FOLD_THRESHOLD_PX = 24;
/** At or above this the list counts as at the top. */
const AT_TOP_PX = 2;
export const SIDEBAR_FOLDED_HEADER_HEIGHT_PX = 36;

/** Field row (30px + 6px gap), one 28px row per destination, then 6px before the list. */
export function sidebarRestHeaderHeight(destinationCount: number): number {
  return 36 + destinationCount * 28 + 6;
}

export interface SidebarFoldState {
  readonly folded: boolean;
  /** scrollTop when the header was unfolded by hand while scrolled. */
  readonly anchor: number | null;
}

export interface SidebarFoldMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** Height the list gains when the header folds. */
  readonly foldGain: number;
  /** The field is focused or its menu is open: never fold under the user. */
  readonly busy: boolean;
}

export function nextSidebarFoldState(
  state: SidebarFoldState,
  metrics: SidebarFoldMetrics,
): SidebarFoldState {
  if (metrics.scrollTop <= AT_TOP_PX) return { folded: false, anchor: null };
  if (metrics.busy) return state;
  if (state.anchor !== null) {
    return Math.abs(metrics.scrollTop - state.anchor) > SIDEBAR_FOLD_THRESHOLD_PX
      ? { folded: true, anchor: null }
      : state;
  }
  // Fold only if the list still scrolls once it gains the header's height;
  // otherwise folding resets scrollTop to 0 and the header bounces back open.
  const canFold =
    metrics.scrollHeight - metrics.clientHeight - metrics.foldGain > SIDEBAR_FOLD_THRESHOLD_PX;
  if (!state.folded && !canFold) return state;
  return { folded: metrics.scrollTop > SIDEBAR_FOLD_THRESHOLD_PX, anchor: null };
}

interface SidebarFoldStore extends SidebarFoldState {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly foldGain: number;
  /** The list that scrolled last, so an unfold by hand can anchor to it. */
  readonly viewport: HTMLElement | null;
  readonly handleListScroll: (viewport: HTMLElement) => void;
  /** Unfold while scrolled, e.g. to use the field; folds again after another threshold. */
  readonly unfold: () => void;
  /** Back to the unfolded header, e.g. when the sidebar switches lists. */
  readonly reset: () => void;
  readonly setBusy: (busy: boolean) => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setFoldGain: (foldGain: number) => void;
}

export const useSidebarFoldStore = create<SidebarFoldStore>((set, get) => ({
  folded: false,
  anchor: null,
  enabled: true,
  busy: false,
  foldGain: 0,
  viewport: null,
  handleListScroll: (viewport) => {
    const state = get();
    if (!state.enabled) return;
    const next = nextSidebarFoldState(state, {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      foldGain: state.foldGain,
      busy: state.busy,
    });
    if (
      next.folded !== state.folded ||
      next.anchor !== state.anchor ||
      viewport !== state.viewport
    ) {
      set({ ...next, viewport });
    }
  },
  unfold: () => {
    const { folded, viewport } = get();
    if (!folded) return;
    set({ folded: false, anchor: viewport?.scrollTop ?? null });
  },
  reset: () => set({ folded: false, anchor: null, viewport: null }),
  setBusy: (busy) => {
    if (get().busy !== busy) set({ busy });
  },
  setEnabled: (enabled) => {
    if (get().enabled === enabled) return;
    set(enabled ? { enabled } : { enabled, folded: false, anchor: null });
  },
  setFoldGain: (foldGain) => {
    if (get().foldGain !== foldGain) set({ foldGain });
  },
}));

/** For a sidebar list's scroll viewport. */
export function handleSidebarListScroll(viewport: HTMLElement): void {
  useSidebarFoldStore.getState().handleListScroll(viewport);
}
