import {
  EMPTY_REVIEW_DRAFT,
  selectReviewDraft,
} from "@ryco/client-runtime/state/pull-request-review";
import { useEffect } from "react";

import { usePullRequestReviewDraftStore } from "../../../pullRequestReviewDraftStore";
import { RollingText, useTravelDirection } from "../../chat/RollingText";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { KeyHint } from "../primitives";
import { usePullRequestSelection } from "../PullRequestsPageContext";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";
import { pendingReviewCount } from "./pullRequestFiles.logic";
import { usePullRequestFilesUiStore } from "./pullRequestFilesStore";
import { ReviewSubmitPopover } from "./ReviewSubmitPopover";

/**
 * The bar's Review button: the single home of the pending review. Its badge
 * counts comments waiting to be sent (drafts here plus any in a review started
 * on the host) and rolls when that number changes. Opens the submit popover;
 * `R` opens it from any tab.
 */
export function ReviewButton() {
  const selection = usePullRequestSelection();
  const draftKey = selection.draftKey;
  const headSha = selection.headSha;
  const draft = usePullRequestReviewDraftStore((state) =>
    draftKey ? selectReviewDraft(state, draftKey) : EMPTY_REVIEW_DRAFT,
  );
  const markHead = usePullRequestReviewDraftStore((state) => state.markHead);
  const open = usePullRequestFilesUiStore((state) => state.reviewOpen);
  const setOpen = usePullRequestFilesUiStore((state) => state.setReviewOpen);
  const count = pendingReviewCount(draft.comments, selection.activity.data?.pendingReview);
  const direction = useTravelDirection(count);

  // Drafts remember the head they were written on; record where the PR is now.
  useEffect(() => {
    if (draftKey && headSha) markHead(draftKey, headSha);
  }, [draftKey, headSha, markHead]);
  // A new reader (another pull request) starts with the popover closed.
  useEffect(() => () => usePullRequestFilesUiStore.getState().setReviewOpen(false), []);

  usePullRequestsShortcut("r", () => {
    if (!draftKey) return false;
    setOpen(true);
  });

  if (!draftKey) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={count > 0 ? `Review, ${count} pending` : "Review"}
                  className="gap-1.5"
                />
              }
            >
              Review
              {count > 0 ? (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] leading-none font-medium text-background tabular-nums">
                  <RollingText text={String(count)} direction={direction} align="center" />
                </span>
              ) : null}
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom" sideOffset={4}>
          <span className="inline-flex items-center gap-1.5">
            Finish your review
            <KeyHint>R</KeyHint>
          </span>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" sideOffset={6} className="p-0" viewportClassName="p-0">
        <ReviewSubmitPopover draftKey={draftKey} draft={draft} onClose={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}
