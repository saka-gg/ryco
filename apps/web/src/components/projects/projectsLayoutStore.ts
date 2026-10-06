import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

/**
 * Habits for the projects page. The checkout itself lives in the URL; this only
 * remembers which one to open when a link names none, and transient page state.
 */
const PROJECTS_LAYOUT_STORAGE_KEY = "ryco:projects-layout:v1";

const PersistedLayout = Schema.Struct({
  lastCheckoutKey: Schema.NullOr(Schema.String),
});
type PersistedLayout = typeof PersistedLayout.Type;

function restoreLayout(): PersistedLayout {
  const fallback: PersistedLayout = { lastCheckoutKey: null };
  try {
    return getLocalStorageItem(PROJECTS_LAYOUT_STORAGE_KEY, PersistedLayout) ?? fallback;
  } catch {
    return fallback;
  }
}

interface ProjectsLayoutState extends PersistedLayout {
  /** Drawer state below the docking breakpoint; never persisted. */
  readonly drawerOpen: boolean;
  /** What had focus when the drawer opened, so closing can return there. */
  readonly drawerOpener: HTMLElement | null;
  /** `/` asked for the filter while no list was mounted. */
  readonly filterFocusRequested: boolean;
  setLastCheckoutKey: (key: string | null) => void;
  setDrawerOpen: (open: boolean) => void;
  requestFilterFocus: () => void;
  consumeFilterFocus: () => boolean;
}

export const useProjectsLayoutStore = create<ProjectsLayoutState>()((set, get) => ({
  ...restoreLayout(),
  drawerOpen: false,
  drawerOpener: null,
  filterFocusRequested: false,
  setLastCheckoutKey: (lastCheckoutKey) => {
    if (get().lastCheckoutKey === lastCheckoutKey) return;
    set({ lastCheckoutKey });
    try {
      setLocalStorageItem(PROJECTS_LAYOUT_STORAGE_KEY, { lastCheckoutKey }, PersistedLayout);
    } catch {
      // Best-effort: a full or unavailable storage keeps it in memory.
    }
  },
  setDrawerOpen: (drawerOpen) => {
    if (get().drawerOpen === drawerOpen) return;
    const active = typeof document === "undefined" ? null : document.activeElement;
    set(
      drawerOpen
        ? { drawerOpen, drawerOpener: active instanceof HTMLElement ? active : null }
        : { drawerOpen },
    );
  },
  requestFilterFocus: () => set({ filterFocusRequested: true }),
  consumeFilterFocus: () => {
    if (!get().filterFocusRequested) return false;
    set({ filterFocusRequested: false });
    return true;
  },
}));
