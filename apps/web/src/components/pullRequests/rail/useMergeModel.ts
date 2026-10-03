import type {
  ChangeRequestReviewThread,
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import type { ChangeRequestNextAction } from "@ryco/client-runtime/state/pull-request-review";
import { useMemo } from "react";

import { usePullRequestAgentHandoff } from "../agentHandoff";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import {
  deriveMergeStatusLines,
  deriveMergeVerdict,
  deriveNextActionButton,
  deriveNextActionMenu,
  isNavigationCommand,
  resolveMergeMethod,
  type MergeStatusLine,
  type MergeVerdict,
  type NextActionButtonSpec,
  type NextActionMenuModel,
} from "./mergeFacts.logic";
import { usePullRequestRailStore } from "./railStore";

const EMPTY_THREADS: ReadonlyArray<ChangeRequestReviewThread> = [];
const EMPTY_MENU: NextActionMenuModel = { methods: null, deleteBranchDefault: null, items: [] };

export interface MergeModel {
  readonly detail: SourceControlChangeRequestDetail;
  readonly viewer: ChangeRequestViewerCapabilities | null;
  readonly nextAction: ChangeRequestNextAction;
  readonly verdict: MergeVerdict;
  readonly lines: ReadonlyArray<MergeStatusLine>;
  readonly button: NextActionButtonSpec | null;
  readonly menu: NextActionMenuModel;
  readonly method: SourceControlChangeRequestMergeMethod;
  setMethod(method: SourceControlChangeRequestMergeMethod): void;
  /** "Delete branch after merge": the user's choice, else the repository setting. */
  readonly deleteBranch: boolean;
  setDeleteBranch(value: boolean): void;
  /** The host implements lifecycle mutations (GitHub). */
  readonly supportsMutations: boolean;
}

/**
 * Everything the merge section, the bar's next-action button and its menu
 * read, derived once per render from the selection. Null until the detail
 * (and so the next action) has loaded.
 */
export function useMergeModel(): MergeModel | null {
  const { model, readerKey, repository } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const handoff = usePullRequestAgentHandoff();
  const detail = selection.detail.data;
  const nextAction = selection.nextAction;
  const viewer = selection.activity.data?.viewer ?? null;
  const threads = selection.activity.data?.reviewThreads ?? EMPTY_THREADS;
  const repositoryKey = repository?.repositoryKey ?? "";
  const preferredMethod = usePullRequestRailStore(
    (state) => state.mergeMethod[repositoryKey] ?? null,
  );
  const deleteBranchChoice = usePullRequestRailStore((state) =>
    readerKey ? state.deleteBranch[readerKey] : undefined,
  );
  const setMergeMethod = usePullRequestRailStore((state) => state.setMergeMethod);
  const setDeleteBranchChoice = usePullRequestRailStore((state) => state.setDeleteBranch);

  return useMemo<MergeModel | null>(() => {
    if (!detail || !nextAction) return null;
    const input = { detail, viewer, checks: selection.checks, nextAction, threads };
    const method = resolveMergeMethod(detail, preferredMethod);
    const derived = deriveNextActionButton({ ...input, method });
    // Hosts without lifecycle mutations keep only the steps that navigate.
    const button =
      derived && (model.supportsReview || isNavigationCommand(derived.command)) ? derived : null;
    const menu = model.supportsReview
      ? deriveNextActionMenu({
          ...input,
          button,
          method,
          supportsMutations: model.supportsReview,
          agentsAvailable: handoff.available,
        })
      : EMPTY_MENU;
    return {
      detail,
      viewer,
      nextAction,
      verdict: deriveMergeVerdict(input),
      lines: deriveMergeStatusLines(input),
      button,
      menu,
      method,
      setMethod: (next) => setMergeMethod(repositoryKey, next),
      deleteBranch: deleteBranchChoice ?? menu.deleteBranchDefault ?? false,
      setDeleteBranch: (value) => {
        if (readerKey) setDeleteBranchChoice(readerKey, value);
      },
      supportsMutations: model.supportsReview,
    };
  }, [
    deleteBranchChoice,
    detail,
    handoff.available,
    model.supportsReview,
    nextAction,
    preferredMethod,
    readerKey,
    repositoryKey,
    selection.checks,
    setDeleteBranchChoice,
    setMergeMethod,
    threads,
    viewer,
  ]);
}
