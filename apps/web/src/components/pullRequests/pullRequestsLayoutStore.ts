import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import type { PullRequestsTab } from "./pullRequestsSearch";

/**
 * Layout preferences for the pull requests page. These are user habits, not
 * links, so they persist locally instead of living in the URL.
 */
export const PULL_REQUESTS_LIST_MIN_WIDTH = 264;
export const PULL_REQUESTS_LIST_MAX_WIDTH = 440;
export const PULL_REQUESTS_LIST_DEFAULT_WIDTH = 304;
/** The docked list column's width; `ListResizeHandle` drives it live while dragging. */
export const PULL_REQUESTS_LIST_WIDTH_VAR = "--pr-list-width";

const PULL_REQUESTS_LAYOUT_STORAGE_KEY = "ryco:pull-requests-layout:v1";

const PersistedLayout = Schema.Struct({
  listWidth: Schema.Number,
  listHidden: Schema.Boolean,
  treeHidden: Schema.Boolean,
  foldedGroups: Schema.Array(Schema.String),
  lastRepositoryKey: Schema.NullOr(Schema.String),
});
type PersistedLayout = typeof PersistedLayout.Type;

export function clampPullRequestsListWidth(width: number): number {
  if (!Number.isFinite(width)) return PULL_REQUESTS_LIST_DEFAULT_WIDTH;
  return Math.round(
    Math.min(PULL_REQUESTS_LIST_MAX_WIDTH, Math.max(PULL_REQUESTS_LIST_MIN_WIDTH, width)),
  );
}

function restoreLayout(): PersistedLayout {
  const fallback: PersistedLayout = {
    listWidth: PULL_REQUESTS_LIST_DEFAULT_WIDTH,
    listHidden: false,
    treeHidden: false,
    foldedGroups: [],
    lastRepositoryKey: null,
  };
  try {
    const stored = getLocalStorageItem(PULL_REQUESTS_LAYOUT_STORAGE_KEY, PersistedLayout);
    return stored
      ? { ...stored, listWidth: clampPullRequestsListWidth(stored.listWidth) }
      : fallback;
  } catch {
    return fallback;
  }
}

/** List width writes coalesce (keyboard steps); every other preference persists at once. */
const LIST_WIDTH_PERSIST_DELAY_MS = 250;

interface PullRequestsLayoutState extends PersistedLayout {
  /** Drawer state below the docking breakpoint; never persisted. */
  readonly drawerOpen: boolean;
  /**
   * What had focus when the drawer opened. Closing returns there, or — when a
   * selection replaced it — to the new reader (see the drawer's `finalFocus`).
   */
  readonly drawerOpener: HTMLElement | null;
  /** The keyboard shortcuts dialog (`?`, the bar menu); page-level, never persisted. */
  readonly shortcutsOpen: boolean;
  /**
   * `/` asked for the search field while no list was mounted: the list pane
   * that mounts next (docked or drawer) focuses it and clears the request.
   */
  readonly searchFocusRequested: boolean;
  setListWidth: (width: number) => void;
  setListHidden: (hidden: boolean) => void;
  toggleListHidden: () => void;
  setTreeHidden: (hidden: boolean) => void;
  toggleTreeHidden: () => void;
  toggleGroupFolded: (groupKey: string) => void;
  setLastRepositoryKey: (key: string | null) => void;
  setDrawerOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  requestSearchFocus: () => void;
  /** True once per request: the caller should focus the search field. */
  consumeSearchFocus: () => boolean;
}

export const usePullRequestsLayoutStore = create<PullRequestsLayoutState>()((set, get) => {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const { listWidth, listHidden, treeHidden, foldedGroups, lastRepositoryKey } = get();
    try {
      setLocalStorageItem(
        PULL_REQUESTS_LAYOUT_STORAGE_KEY,
        { listWidth, listHidden, treeHidden, foldedGroups, lastRepositoryKey },
        PersistedLayout,
      );
    } catch {
      // Preferences are best-effort; a full or unavailable storage keeps them in memory.
    }
  };
  const update = (patch: Partial<PullRequestsLayoutState>) => {
    set(patch);
    persist();
  };
  return {
    ...restoreLayout(),
    drawerOpen: false,
    drawerOpener: null,
    shortcutsOpen: false,
    searchFocusRequested: false,
    setListWidth: (width) => {
      const listWidth = clampPullRequestsListWidth(width);
      if (get().listWidth === listWidth) return;
      set({ listWidth });
      if (persistTimer !== null) clearTimeout(persistTimer);
      persistTimer = setTimeout(persist, LIST_WIDTH_PERSIST_DELAY_MS);
    },
    setListHidden: (listHidden) => update({ listHidden }),
    toggleListHidden: () => update({ listHidden: !get().listHidden }),
    setTreeHidden: (treeHidden) => update({ treeHidden }),
    toggleTreeHidden: () => update({ treeHidden: !get().treeHidden }),
    toggleGroupFolded: (groupKey) => {
      const folded = new Set(get().foldedGroups);
      if (folded.has(groupKey)) folded.delete(groupKey);
      else folded.add(groupKey);
      update({ foldedGroups: [...folded].toSorted() });
    },
    setLastRepositoryKey: (lastRepositoryKey) => {
      if (get().lastRepositoryKey === lastRepositoryKey) return;
      update({ lastRepositoryKey });
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
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    requestSearchFocus: () => set({ searchFocusRequested: true }),
    consumeSearchFocus: () => {
      if (!get().searchFocusRequested) return false;
      set({ searchFocusRequested: false });
      return true;
    },
  };
});

/**
 * Per-pull-request reader memory: which tabs were visited (they stay mounted
 * behind the active one), scroll offsets per tab, and expanded check jobs.
 * Memory-only — it describes this session's reading, not a preference.
 */
export function pullRequestReaderKey(repositoryKey: string, pr: number): string {
  return `${repositoryKey}\0${pr}`;
}

interface PullRequestReaderState {
  readonly visitedTabs: Readonly<Record<string, ReadonlyArray<PullRequestsTab>>>;
  readonly scrollTop: Readonly<Record<string, number>>;
  readonly expandedJobs: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Conversation masthead scrolled out of view, so the bar shows the title. */
  readonly mastheadHidden: Readonly<Record<string, boolean>>;
  setMastheadHidden: (readerKey: string, hidden: boolean) => void;
  /** Bumped by "Edit title" (bar menu, `E`); the masthead enters edit mode when it changes. */
  readonly titleEditRequest: Readonly<Record<string, number>>;
  requestTitleEdit: (readerKey: string) => void;
  markTabVisited: (readerKey: string, tab: PullRequestsTab) => void;
  setScrollTop: (readerKey: string, tab: PullRequestsTab, top: number) => void;
  setJobExpanded: (readerKey: string, jobId: string, expanded: boolean) => void;
}

const MAX_REMEMBERED_READERS = 24;

function trimRecord<T>(record: Readonly<Record<string, T>>, keep: string): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= MAX_REMEMBERED_READERS) return { ...record };
  const next: Record<string, T> = {};
  for (const key of keys.slice(keys.length - MAX_REMEMBERED_READERS + 1)) {
    next[key] = record[key] as T;
  }
  next[keep] = record[keep] as T;
  return next;
}

export const usePullRequestReaderStore = create<PullRequestReaderState>()((set) => ({
  visitedTabs: {},
  scrollTop: {},
  expandedJobs: {},
  mastheadHidden: {},
  titleEditRequest: {},
  requestTitleEdit: (readerKey) =>
    set((state) => ({
      titleEditRequest: {
        ...state.titleEditRequest,
        [readerKey]: (state.titleEditRequest[readerKey] ?? 0) + 1,
      },
    })),
  setMastheadHidden: (readerKey, hidden) =>
    set((state) =>
      (state.mastheadHidden[readerKey] ?? false) === hidden
        ? state
        : {
            mastheadHidden: trimRecord({ ...state.mastheadHidden, [readerKey]: hidden }, readerKey),
          },
    ),
  markTabVisited: (readerKey, tab) =>
    set((state) => {
      const visited = state.visitedTabs[readerKey] ?? [];
      if (visited.includes(tab)) return state;
      return {
        visitedTabs: trimRecord(
          { ...state.visitedTabs, [readerKey]: [...visited, tab] },
          readerKey,
        ),
      };
    }),
  setScrollTop: (readerKey, tab, top) =>
    set((state) => ({ scrollTop: { ...state.scrollTop, [`${readerKey}\0${tab}`]: top } })),
  setJobExpanded: (readerKey, jobId, expanded) =>
    set((state) => {
      const current = state.expandedJobs[readerKey] ?? [];
      const has = current.includes(jobId);
      if (has === expanded) return state;
      const next = expanded ? [...current, jobId] : current.filter((id) => id !== jobId);
      return { expandedJobs: trimRecord({ ...state.expandedJobs, [readerKey]: next }, readerKey) };
    }),
}));
