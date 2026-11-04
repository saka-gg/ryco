// Opens the app's one "Import from Codex or Claude Code" dialog from any
// entry point (command palette, empty sidebar banner, first-run setup,
// Settings). The dialog (`SessionImportDialog.tsx`) loads lazily on first
// open; entry points import only this module.

import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

export interface SessionImportDialogState {
  readonly open: boolean;
  /** Bumps on every open, so each open starts from a fresh import. */
  readonly token: number;
  /** The node whose history is imported; null for the one Settings would show. */
  readonly environmentId: EnvironmentId | null;
}

/** App-wide state of the one project import dialog; `SessionImportDialog` is its only host. */
export const useSessionImportDialogStore = create<SessionImportDialogState>()(() => ({
  open: false,
  token: 0,
  environmentId: null,
}));

/** Starts loading the dialog's code ahead of a likely open. */
export function preloadSessionImportDialog(): void {
  void import("./SessionImportDialog");
}

export function openSessionImportDialog(
  input: { readonly environmentId?: EnvironmentId | null } = {},
): void {
  useSessionImportDialogStore.setState((state) => ({
    open: true,
    token: state.token + 1,
    environmentId: input.environmentId ?? null,
  }));
}

export function closeSessionImportDialog(): void {
  if (!useSessionImportDialogStore.getState().open) return;
  useSessionImportDialogStore.setState({ open: false });
}
