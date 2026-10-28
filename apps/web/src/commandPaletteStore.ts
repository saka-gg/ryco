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
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: () => void;
  /** Opens straight into the thread picker for a new split pane. */
  openSplitThread: () => void;
  /** Opens straight into the snooze times for the open thread. */
  openSnoozeThread: () => void;
  openSearch: (query: string) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  readCurrentThreadLifecycle: null,
  tasksAvailable: false,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: () =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openSplitThread: () =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "split-thread",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openSnoozeThread: () =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "snooze-thread",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openSearch: (query) =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "search",
        query,
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));
