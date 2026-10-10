import { RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { StatusBoardLayout } from "./overview/overviewLayouts";
import { isOverviewEmpty, OverviewBadge, OverviewEmptyState } from "./overview/overviewSections";
import type { OverviewLayoutProps, OverviewPanelMode } from "./overview/overviewTypes";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

export type {
  OverviewChangedFile,
  OverviewChanges,
  OverviewFileStatus,
  OverviewPanelItem,
  OverviewPullRequestCheckRun,
  OverviewPullRequestState,
} from "./overview/overviewTypes";

export interface PlanSidebarProps extends OverviewLayoutProps {
  preview?: ReactNode;
  mode?: OverviewPanelMode;
  /**
   * Renders a visible close affordance in the panel header. Passed for
   * overlay presentations (the floating desktop overlay had no close button
   * and could trap the user); inline and sheet presentations keep their
   * existing dismissal paths.
   */
  onClose?: (() => void) | undefined;
}

function HeaderTrailing({ layoutProps }: { layoutProps: OverviewLayoutProps }) {
  const showConflict = Boolean(layoutProps.pullRequest?.hasMergeConflicts);
  const showRefresh = Boolean(layoutProps.onRefreshPullRequest);
  if (!showConflict && !showRefresh) return null;

  // A lingering source-control fetch error is surfaced loudly once (via toast);
  // afterwards this quiet dot on the refresh control is the only persistent cue
  // that the panel data may be stale and a retry is worthwhile.
  const hasSourceControlError = Boolean(layoutProps.pullRequest?.checksError);

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {showConflict ? (
        <OverviewBadge tone="error">
          <TriangleAlertIcon /> conflict
        </OverviewBadge>
      ) : null}
      {showRefresh ? (
        <div className="relative shrink-0">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={layoutProps.onRefreshPullRequest}
            disabled={layoutProps.isRefreshingPullRequest}
            aria-label={
              hasSourceControlError
                ? "Retry loading source control (last refresh failed)"
                : "Refresh source control"
            }
          >
            <RotateCwIcon
              className={cn("size-3.5", layoutProps.isRefreshingPullRequest && "animate-spin")}
            />
          </Button>
          {hasSourceControlError && !layoutProps.isRefreshingPullRequest ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning ring-2 ring-card"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const PlanSidebar = memo(function PlanSidebar({
  mode = "sidebar",
  onClose,
  preview,
  ...layoutProps
}: PlanSidebarProps) {
  const empty = isOverviewEmpty(layoutProps);
  const closeButton = onClose ? (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onClick={onClose}
      aria-label="Close overview"
    >
      <XIcon className="size-3.5" />
    </Button>
  ) : null;

  const body = empty ? <OverviewEmptyState /> : <StatusBoardLayout {...layoutProps} />;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        mode === "sidebar" &&
          "my-3 mr-3 w-[340px] shrink-0 self-start overflow-hidden rounded-lg border border-border/70 bg-card/90 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-card/75",
        mode === "sheet" &&
          "h-full w-full bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75",
        // Floating mode overlaps the transcript — it joins the shared overlay
        // material instead of its old ad-hoc bg-card/backdrop-blur recipe.
        mode === "floating" &&
          "selection-glass-surface pointer-events-auto max-h-[min(72vh,42rem)] w-[min(360px,calc(100vw_-_1.5rem))] rounded-lg border",
      )}
      style={mode === "sidebar" ? { maxHeight: "calc(100% - 1.5rem)" } : undefined}
      data-slot="overview-panel"
    >
      {!empty && layoutProps.branchControl ? (
        <div
          className="flex min-h-9 min-w-0 shrink-0 items-center justify-between gap-1 border-b border-border/60 pr-2"
          data-slot="overview-branch-header"
        >
          <div className="flex min-w-0 flex-1 items-center" data-slot="overview-branch-control">
            {layoutProps.branchControl}
          </div>
          {closeButton ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <HeaderTrailing layoutProps={layoutProps} />
              {closeButton}
            </div>
          ) : (
            <HeaderTrailing layoutProps={layoutProps} />
          )}
        </div>
      ) : closeButton ? (
        // The close affordance must exist even when the panel has no header
        // content (empty state): an overlay without it can trap the user.
        <div className="flex shrink-0 items-center justify-end border-b border-border/60 px-2 py-1.5">
          {closeButton}
        </div>
      ) : null}

      {mode === "sidebar" ? (
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          data-slot="scroll-area-viewport"
        >
          {body}
          {preview}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1" scrollbarGutter>
          {body}
          {preview}
        </ScrollArea>
      )}

      {!empty && layoutProps.sourceControlActions ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-card/50 px-3 py-2.5">
          <div className="flex min-w-0 flex-1">{layoutProps.sourceControlActions}</div>
        </div>
      ) : null}
    </div>
  );
});

export default PlanSidebar;
