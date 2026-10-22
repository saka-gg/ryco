import { create } from "zustand";

import {
  addProjectDialogAvailable,
  openAddProject as openAddProjectDialog,
  type OpenAddProjectOptions,
} from "./components/projectNodes/projectNodesDialogStore";

type CommandPaletteOpenIntent =
  | { kind: "add-project" | "split-thread"; requestId: number }
  /** Opens with `query` already typed, e.g. the sidebar field's "Search everywhere". */
  | { kind: "search"; query: string; requestId: number };

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  /**
   * Every "Add project" entry point: opens `AddProjectDialog` where it is
   * available (`addProjectDialogAvailable`), else the palette's add-project
   * views (the frozen phone tier, and every tier until the dialog is on).
   */
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
  openAddProject: () => {
    if (addProjectDialogAvailable()) {
      openAddProjectDialog();
      return;
    }
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    }));
  },
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

/**
 * "Add project" from an entry point that knows more than the palette asks, e.g.
 * onboarding's node: the dialog starts there where it is available; the
 * palette's views (the phone tier) start at their own first step.
 */
export function openAddProjectWith(options: OpenAddProjectOptions): void {
  if (addProjectDialogAvailable()) {
    openAddProjectDialog(options);
    return;
  }
  useCommandPaletteStore.getState().openAddProject();
}
