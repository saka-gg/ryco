import { createContext, useContext } from "react";

import type {
  PullRequestRepositoryOption,
  PullRequestRepositoryRequest,
} from "./pullRequestRepositories.logic";
import type {
  PullRequestsDiffSide,
  PullRequestsSearch,
  PullRequestsTab,
} from "./pullRequestsSearch";
import type { PullRequestsModel } from "./usePullRequestsModel";

/**
 * The integration contract for every area of the pull requests page (list,
 * reader bar, conversation, facts, files, checks, commits). Areas read data
 * and navigate exclusively through this context, so the URL stays the single
 * source of truth for what is selected and revealed.
 */

export interface PullRequestsNavigateOptions {
  /** Push a history entry (clicks, pastes, links). Keyboard moves replace. */
  readonly push?: boolean;
}

export type PullRequestSelectionMotion =
  /** Directional settle: J/K, list click. `direction` follows list order. */
  | { readonly kind: "settle"; readonly direction: -1 | 0 | 1; readonly token: number }
  /**
   * Stack layer push: `[` `]`, stack rows, spine rows. +1 = up the stack.
   * `from` is the layer being left, so the new bar can roll its title from it.
   */
  | {
      readonly kind: "push";
      readonly direction: -1 | 1;
      readonly token: number;
      readonly from?: { readonly number: number; readonly title: string } | undefined;
    }
  | { readonly kind: "none"; readonly token: number };

export interface PullRequestsNavigation {
  readonly search: PullRequestsSearch;
  readonly tab: PullRequestsTab;
  /** Merge a patch into the URL state (replace by default). */
  setSearch(patch: Partial<PullRequestsSearch>, options?: PullRequestsNavigateOptions): void;
  /**
   * Select a change request (or clear with `undefined`). PR-scoped params are
   * dropped; list params survive. `via` picks the reader motion.
   */
  selectPullRequest(
    pr: number | undefined,
    options?: PullRequestsNavigateOptions & {
      readonly tab?: PullRequestsTab;
      readonly via?: "list" | "stack" | "link";
    },
  ): void;
  /** Move to the next/previous visible list row (J/K / ⇧J/⇧K). */
  stepPullRequest(offset: 1 | -1): void;
  /** Move down (-1) or up (+1) the current stack, if any. */
  stepStackLayer(offset: 1 | -1): void;
  setTab(tab: PullRequestsTab): void;
  /** Reveal a review thread: in Files when it maps onto the diff, else in Conversation. */
  revealThread(threadId: string): void;
  /** Reveal a line of the whole change request's diff (any commit scope is cleared). */
  revealFile(path: string, line?: number, side?: PullRequestsDiffSide): void;
  revealJob(jobId: string): void;
  /** Scope Files to one commit (`undefined` = whole change request). */
  scopeToCommit(sha: string | undefined): void;
  selectRepository(option: PullRequestRepositoryOption): void;
}

export interface PullRequestsLayout {
  /** Page content width (excludes the app sidebar). */
  readonly pageWidth: number;
  /** The list is docked beside the reader (page ≥ 900 and not on Files). */
  readonly listDocked: boolean;
  /** The docked list is currently shown (not hidden with `\`). */
  readonly listVisible: boolean;
  /** Nothing is selected on a narrow page: the list is the whole page. */
  readonly listFillsPage: boolean;
  /** Width of the docked list when visible. */
  readonly listWidth: number;
  /** Reader width after the docked list. */
  readonly readerWidth: number;
  /** Conversation facts render as a right rail (reader ≥ 800) instead of a band. */
  readonly railDocked: boolean;
  /** Files tree docks beside the diff (reader ≥ 720) instead of overlaying. */
  readonly treeDocked: boolean;
  /** Bar folds Files tools into a menu and drops tab counts (reader < 640). */
  readonly barCompact: boolean;
  /**
   * Which region's top bar owns the window's top-left corner (and so carries
   * the collapsed-sidebar inset and the leading drag area).
   */
  readonly leadingRegion: "list" | "reader";
  /** Open the list: toggles the docked list, or opens the drawer when undocked. */
  toggleList(): void;
  openDrawer(): void;
  closeDrawer(): void;
  readonly drawerOpen: boolean;
}

/**
 * Why there is (or is not) a repository to read. A repository named in the URL
 * that is not listed yet is "waiting" (its environment is still syncing; after
 * a grace period `stalled` offers other repositories), or "unavailable" when
 * it cannot appear. The page never substitutes another repository for it.
 */
export type PullRequestsRepositoryStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "waiting";
      readonly requested: PullRequestRepositoryRequest;
      /** Human label for the requested environment, when known. */
      readonly environmentLabel: string | null;
      readonly stalled: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly requested: PullRequestRepositoryRequest;
      readonly environmentLabel: string | null;
      readonly reason: "offline" | "missing";
    };

export interface PullRequestsPageContextValue {
  readonly repository: PullRequestRepositoryOption | null;
  readonly repositoryStatus: PullRequestsRepositoryStatus;
  readonly repositories: ReadonlyArray<PullRequestRepositoryOption>;
  readonly model: PullRequestsModel;
  readonly nav: PullRequestsNavigation;
  readonly layout: PullRequestsLayout;
  /** Motion for the most recent selection change (read by the reader transition). */
  readonly selectionMotion: PullRequestSelectionMotion;
  /** `pullRequestReaderKey(repository.key, pr)` for the selected PR, else null. */
  readonly readerKey: string | null;
}

export const PullRequestsPageContext = createContext<PullRequestsPageContextValue | null>(null);

export function usePullRequestsPage(): PullRequestsPageContextValue {
  const value = useContext(PullRequestsPageContext);
  if (value === null) {
    throw new Error("usePullRequestsPage must be used inside the pull requests page.");
  }
  return value;
}

/** The selected change request; throws when nothing is selected (reader-only areas). */
export function usePullRequestSelection() {
  const { model } = usePullRequestsPage();
  if (model.selection === null) {
    throw new Error("usePullRequestSelection requires a selected pull request.");
  }
  return model.selection;
}
