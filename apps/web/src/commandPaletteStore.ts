import { create } from "zustand";

type CommandPaletteOpenIntent =
  | { kind: "add-project" | "split-thread"; requestId: number }
  /** Opens with `query` already typed, e.g. the sidebar field's "Search everywhere". */
  | { kind: "search"; query: string; requestId: number };

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: () => void;
  /** Opens straight into the thread picker for a new split pane. */
  openSplitThread: () => void;
  openSearch: (query: string) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
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
