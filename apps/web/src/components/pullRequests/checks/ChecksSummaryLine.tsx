import { RotateCwIcon } from "lucide-react";
import { Fragment, memo } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { checksSummarySegments, type ChecksCounts, type ChecksSummarySegment } from "./checksModel";
import { RollingCount } from "./checksUi";

/**
 * The tab's one line of totals — "1 failing · 8 passed · 1 running · 4
 * required" — over exactly the rows listed below it (the last only where the
 * host marks required checks), plus a ghost "Re-run failed" when a
 * finished run has failed jobs. No title: the bar already says "Checks".
 */

const TONE_CLASS: Record<ChecksSummarySegment["tone"], string> = {
  destructive: "text-destructive-foreground",
  warning: "text-warning-foreground",
  muted: "text-muted-foreground",
};

export const ChecksSummaryLine = memo(function ChecksSummaryLine(props: {
  readonly counts: ChecksCounts;
  /** Null hides the action (nothing to re-run, or the PR is closed). */
  readonly onRerunFailed: (() => void) | null;
  readonly rerunPending: boolean;
  readonly rerunJobCount: number;
}) {
  const segments = checksSummarySegments(props.counts);
  return (
    <div className="flex min-h-12 items-center gap-3 pr-1 pl-1">
      <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-[13px]">
        {segments.map((segment, index) => (
          <Fragment key={segment.key}>
            {index === 0 ? null : (
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
            )}
            <span className={cn("whitespace-nowrap", TONE_CLASS[segment.tone])}>
              <span
                className={cn(
                  "font-medium",
                  segment.tone === "muted" ? "text-foreground" : undefined,
                )}
              >
                <RollingCount value={segment.count} />
              </span>{" "}
              {segment.label}
            </span>
          </Fragment>
        ))}
      </p>
      {props.onRerunFailed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                onClick={props.onRerunFailed}
                disabled={props.rerunPending}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <RotateCwIcon
                  aria-hidden
                  className={cn("size-3", props.rerunPending && "inbox-glyph-spin")}
                />
                Re-run failed
              </Button>
            }
          />
          <TooltipPopup side="bottom" sideOffset={4}>
            {props.rerunJobCount === 1
              ? "Re-run the failed job"
              : `Re-run the ${props.rerunJobCount} failed jobs`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});
