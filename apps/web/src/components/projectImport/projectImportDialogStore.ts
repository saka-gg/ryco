// Opens the app's one "Import from Codex or Claude Code" dialog from any
// entry point (command palette, empty sidebar banner, first-run setup,
// Settings). The dialog (`ProjectImportDialog.tsx`) loads lazily on first
// open; entry points import only this module.

import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

export interface ProjectImportDialogState {
  readonly open: boolean;
  /** Bumps on every open, so each open starts from a fresh import. */
  readonly token: number;
  /** The node whose history is imported; null for the one Settings would show. */
  readonly environmentId: EnvironmentId | null;
}

/** App-wide state of the one project import dialog; `ProjectImportDialog` is its only host. */
export const useProjectImportDialogStore = create<ProjectImportDialogState>()(() => ({
  open: false,
  token: 0,
  environmentId: null,
}));

/** Starts loading the dialog's code ahead of a likely open. */
export function preloadProjectImportDialog(): void {
  void import("./ProjectImportDialog");
}

export function openProjectImportDialog(
  input: { readonly environmentId?: EnvironmentId | null } = {},
): void {
  useProjectImportDialogStore.setState((state) => ({
    open: true,
    token: state.token + 1,
    environmentId: input.environmentId ?? null,
  }));
}

export function closeProjectImportDialog(): void {
  if (!useProjectImportDialogStore.getState().open) return;
  useProjectImportDialogStore.setState({ open: false });
}
