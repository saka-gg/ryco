import type {
  ChangeRequestReviewThread,
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import type { ChangeRequestNextAction } from "@ryco/client-runtime/state/pull-request-review";
import { useMemo } from "react";

import { preferredUpdateBranchMethod } from "@ryco/shared/sourceControl";

import { usePullRequestAgentHandoff } from "../agentHandoff";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import {
  deriveMergeStatusLines,
  deriveMergeVerdict,
  deriveNextActionButton,
  deriveNextActionMenu,
  hostSupportsCommand,
  resolveMergeMethod,
  type MergeStatusLine,
  type MergeVerdict,
  type NextActionButtonSpec,
  type NextActionMenuModel,
} from "./mergeFacts.logic";
import { usePullRequestRailStore } from "./railStore";

const EMPTY_THREADS: ReadonlyArray<ChangeRequestReviewThread> = [];

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

  const capabilities = model.capabilities;
  return useMemo<MergeModel | null>(() => {
    // Without readiness facts from the host there is no verdict or next step to state.
    if (!detail || !nextAction || !capabilities.mergeReadiness) return null;
    const input = { detail, viewer, checks: selection.checks, nextAction, threads };
    const method = resolveMergeMethod(detail, preferredMethod, capabilities.merge.methods);
    const derived = deriveNextActionButton({
      ...input,
      method,
      updateBranchMethod: preferredUpdateBranchMethod(capabilities),
    });
    // A step the host cannot take is not offered; navigation always is.
    const button = derived && hostSupportsCommand(derived.command, capabilities) ? derived : null;
    const menu = deriveNextActionMenu({
      ...input,
      button,
      method,
      capabilities,
      agentsAvailable: handoff.available,
    });
    return {
      detail,
      viewer,
      nextAction,
      verdict: deriveMergeVerdict(input),
      lines: deriveMergeStatusLines(input, { checkRollup: capabilities.checkRollup }),
      button,
      menu,
      method,
      setMethod: (next) => setMergeMethod(repositoryKey, next),
      deleteBranch:
        capabilities.merge.deleteBranch &&
        (deleteBranchChoice ?? menu.deleteBranchDefault ?? false),
      setDeleteBranch: (value) => {
        if (readerKey) setDeleteBranchChoice(readerKey, value);
      },
    };
  }, [
    capabilities,
    deleteBranchChoice,
    detail,
    handoff.available,
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
