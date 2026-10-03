import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { create } from "zustand";

/** The checkout a change request is opened from. */
export interface CreatePullRequestTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** Shown under the dialog title, so the palette's pick is visible. */
  readonly repositoryName: string;
}

/** A palette request: the checkout, plus the project the new request opens in afterwards. */
export interface CreatePullRequestRequest extends CreatePullRequestTarget {
  readonly projectId: ProjectId;
}

interface CreatePullRequestDialogState {
  readonly open: boolean;
  /** Kept after closing so the dialog can play its exit with the same form. */
  readonly request: CreatePullRequestRequest | null;
  openFor(request: CreatePullRequestRequest): void;
  setOpen(open: boolean): void;
}

/**
 * The palette's "New pull request…" opens the dialog wherever the user is
 * (the page's own list button keeps a local dialog). Mounted by
 * `CreatePullRequestDialogHost`.
 */
export const useCreatePullRequestDialogStore = create<CreatePullRequestDialogState>()((set) => ({
  open: false,
  request: null,
  openFor: (request) => set({ open: true, request }),
  setOpen: (open) => set({ open }),
}));
