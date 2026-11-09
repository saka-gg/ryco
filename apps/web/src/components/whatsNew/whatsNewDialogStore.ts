// Opens the app's one What's new dialog: from Settings → About, the command
// palette, or on its own the first time the app starts after an update. The
// dialog (`WhatsNewDialog.tsx`) and the release notes load lazily on first
// open; entry points import only this module.

import { create } from "zustand";

export interface WhatsNewDialogState {
  readonly open: boolean;
  /**
   * After an update: the version the person last saw notes for, so the dialog
   * lists only the releases since. Null lists every release up to this one.
   */
  readonly sinceVersion: string | null;
}

/** App-wide state of the one What's new dialog; `WhatsNewDialog` is its only host. */
export const useWhatsNewDialogStore = create<WhatsNewDialogState>()(() => ({
  open: false,
  sinceVersion: null,
}));

/** Starts loading the dialog's code ahead of a likely open. */
export function preloadWhatsNewDialog(): void {
  void import("./WhatsNewDialog");
}

export function openWhatsNewDialog(input: { readonly sinceVersion?: string | null } = {}): void {
  useWhatsNewDialogStore.setState({ open: true, sinceVersion: input.sinceVersion ?? null });
}

export function closeWhatsNewDialog(): void {
  if (!useWhatsNewDialogStore.getState().open) return;
  useWhatsNewDialogStore.setState({ open: false });
}
