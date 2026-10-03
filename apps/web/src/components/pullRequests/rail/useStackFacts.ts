import type { SourceControlChangeRequestStack } from "@ryco/contracts";
import { useCallback, useMemo } from "react";

import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { assessStack, stackPositionLabel, type StackAssessment } from "./stackFacts.logic";

export interface StackFacts {
  readonly stack: SourceControlChangeRequestStack;
  readonly assessment: StackAssessment;
  /** "3 of 4". */
  readonly position: string;
  /** Host could not load every layer: show "Stack details unavailable", offer no merge-through. */
  readonly incomplete: boolean;
  readonly canMergeThrough: boolean;
  readonly currentNumber: number;
  /** Push to a layer (stack motion). */
  selectLayer(number: number): void;
}

/** The selected pull request's GitHub-native stack, or null when it has none. */
export function useStackFacts(): StackFacts | null {
  const { nav, model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const stack = detail?.stack ?? null;
  const viewer = selection.activity.data?.viewer ?? null;
  const incomplete = detail?.stackMetadataIncomplete === true;
  const currentNumber = selection.number;
  const selectLayer = useCallback(
    (number: number) => {
      if (number === currentNumber) return;
      nav.selectPullRequest(number, { via: "stack", push: true });
    },
    [currentNumber, nav],
  );
  return useMemo(() => {
    if (!stack || stack.entries.length < 2) return null;
    return {
      stack,
      assessment: assessStack(stack),
      position: stackPositionLabel(stack),
      incomplete,
      canMergeThrough: model.supportsReview && !incomplete && (viewer?.canMerge ?? true),
      currentNumber,
      selectLayer,
    };
  }, [currentNumber, incomplete, model.supportsReview, selectLayer, stack, viewer?.canMerge]);
}
