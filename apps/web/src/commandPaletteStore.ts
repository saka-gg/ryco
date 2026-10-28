import type { ThreadLifecycleAction } from "@ryco/client-runtime/state/threads";
import { create } from "zustand";

type CommandPaletteOpenIntent =
  | { kind: "add-project" | "split-thread" | "snooze-thread"; requestId: number }
  /** Opens with `query` already typed, e.g. the sidebar field's "Search everywhere". */
  | { kind: "search"; query: string; requestId: number };

/** A time the open thread can be snoozed until. */
export interface ThreadSnoozeOption {
  readonly id: string;
  readonly label: string;
  readonly snoozedUntil: string;
  /** When it wakes, as the Inbox shows it. */
  readonly timeLabel: string;
}

/**
 * Settle, snooze, archive and mark unread for the open thread, as its Inbox row
 * decides them at the moment they are read.
 */
export interface CurrentThreadLifecycle {
  readonly title: string;
  readonly settled: boolean;
  readonly snoozed: boolean;
  /**
   * A settle, snooze or archive from a shortcut or the palette awaits the node.
   * Until it answers the thread reads as before, so like the Inbox row these
   * three send nothing: sent again, the action would drop the first one's Undo.
   */
  readonly pending: boolean;
  /** Why each action cannot run now, worded as the Inbox words it; null while it can. */
  readonly disabledReasons: Readonly<Record<ThreadLifecycleAction, string | null>>;
  /** Snooze times from now on. */
  readonly snoozeOptions: () => ReadonlyArray<ThreadSnoozeOption>;
  /** Settles the thread, or moves it back to Active with false. */
  readonly setSettled: (settled: boolean) => void;
  /** Snoozes the thread until `snoozedUntil`, or wakes it with null. */
  readonly snooze: (snoozedUntil: string | null) => void;
  /** Archives the thread, asking first when "Archive confirmation" is on. */
  readonly archive: () => void;
  readonly markUnread: () => void;
}

/**
 * A search of the routed thread's workspace the palette shows in place of its
 * commands: files by name (quick open) or their contents (find in files).
 */
export type WorkspaceSearchMode = "files" | "content";

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  /**
   * Set by the sidebar while it is mounted. Null without an open thread, and
   * read when needed, so a snooze that just ran out never reads as snoozed.
   */
  readCurrentThreadLifecycle: (() => CurrentThreadLifecycle | null) | null;
  /** Set by the sidebar while it offers the Tasks page. */
  tasksAvailable: boolean;
  /** The workspace search shown, or null for the command list (and while closed). */
  workspaceSearchMode: WorkspaceSearchMode | null;
  setOpen: (open: boolean) => void;
  /** Opens or closes the palette; from a workspace search it shows the command list. */
  toggleOpen: () => void;
  openAddProject: () => void;
  /** Opens straight into the thread picker for a new split pane. */
  openSplitThread: () => void;
  /** Opens straight into the snooze times for the open thread. */
  openSnoozeThread: () => void;
  openSearch: (query: string) => void;
  /** Opens the palette on a workspace search; closes it when that search is shown. */
  openWorkspaceSearch: (mode: WorkspaceSearchMode) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  readCurrentThreadLifecycle: null,
  tasksAvailable: false,
  workspaceSearchMode: null,
  setOpen: (open) =>
    set({ open, ...(open ? {} : { openIntent: null, workspaceSearchMode: null }) }),
  toggleOpen: () =>
    set((state) => {
      if (state.open && state.workspaceSearchMode !== null) return { workspaceSearchMode: null };
      return { open: !state.open, ...(state.open ? { openIntent: null } : {}) };
    }),
  openAddProject: () =>
    set((state) => ({
      open: true,
      workspaceSearchMode: null,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openSplitThread: () =>
    set((state) => ({
      open: true,
      workspaceSearchMode: null,
      openIntent: {
        kind: "split-thread",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openSnoozeThread: () =>
    set((state) => ({
      open: true,
      workspaceSearchMode: null,
      openIntent: {
        kind: "snooze-thread",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openSearch: (query) =>
    set((state) => ({
      open: true,
      workspaceSearchMode: null,
      openIntent: {
        kind: "search",
        query,
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openWorkspaceSearch: (mode) =>
    set((state) =>
      state.open && state.workspaceSearchMode === mode
        ? { open: false, openIntent: null, workspaceSearchMode: null }
        : { open: true, openIntent: null, workspaceSearchMode: mode },
    ),
  clearOpenIntent: () => set({ openIntent: null }),
}));
