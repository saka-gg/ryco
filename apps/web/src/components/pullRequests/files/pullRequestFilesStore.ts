import { create } from "zustand";

import { usePullRequestsLayoutStore } from "../pullRequestsLayoutStore";

/**
 * Files-tab UI state the bar and the tab share: the tree overlay (narrow
 * readers; the docked tree's visibility is the persisted `treeHidden`), the
 * commit-scope menu, and the review popover (opened with `R` from any tab).
 * Memory-only, and reset whenever the selected pull request changes.
 */
interface PullRequestFilesUiState {
  readonly treeOverlayOpen: boolean;
  readonly commitMenuOpen: boolean;
  readonly reviewOpen: boolean;
  setTreeOverlayOpen: (open: boolean) => void;
  setCommitMenuOpen: (open: boolean) => void;
  setReviewOpen: (open: boolean) => void;
  reset: () => void;
}

const INITIAL = { treeOverlayOpen: false, commitMenuOpen: false, reviewOpen: false } as const;

export const usePullRequestFilesUiStore = create<PullRequestFilesUiState>()((set) => ({
  ...INITIAL,
  setTreeOverlayOpen: (treeOverlayOpen) => set({ treeOverlayOpen }),
  setCommitMenuOpen: (commitMenuOpen) => set({ commitMenuOpen }),
  setReviewOpen: (reviewOpen) => set({ reviewOpen }),
  reset: () => set(INITIAL),
}));

/** Whether the file tree is on screen for the current layout. */
export function useFileTreeShown(treeDocked: boolean): boolean {
  const treeHidden = usePullRequestsLayoutStore((state) => state.treeHidden);
  const overlayOpen = usePullRequestFilesUiStore((state) => state.treeOverlayOpen);
  return treeDocked ? !treeHidden : overlayOpen;
}

/** `F` and the bar's tree toggle: the docked tree hides (persisted), the overlay opens. */
export function toggleFileTree(treeDocked: boolean): void {
  if (treeDocked) {
    usePullRequestsLayoutStore.getState().toggleTreeHidden();
    return;
  }
  const files = usePullRequestFilesUiStore.getState();
  files.setTreeOverlayOpen(!files.treeOverlayOpen);
}
