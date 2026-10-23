import { create } from "zustand";

type CommandPaletteOpenIntent =
  | { kind: "add-project" | "split-thread"; requestId: number }
  /** Opens with `query` already typed, e.g. the sidebar field's "Search everywhere". */
  | { kind: "search"; query: string; requestId: number };

/** A search of the routed thread's workspace the palette shows in place of its commands. */
export type WorkspaceSearchMode = "files";

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  /** The workspace search shown, or null for the command list (and while closed). */
  workspaceSearchMode: WorkspaceSearchMode | null;
  setOpen: (open: boolean) => void;
  /** Opens or closes the palette; from a workspace search it shows the command list. */
  toggleOpen: () => void;
  openAddProject: () => void;
  /** Opens straight into the thread picker for a new split pane. */
  openSplitThread: () => void;
  openSearch: (query: string) => void;
  /** Opens the palette on a workspace search; closes it when that search is shown. */
  openWorkspaceSearch: (mode: WorkspaceSearchMode) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
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
