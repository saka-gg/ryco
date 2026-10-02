import type { SourceControlChangeRequestStackSummary } from "@ryco/contracts";
import { GitForkIcon } from "lucide-react";
import { resolveStateBadgeVariant } from "../sourceControl/stateBadgeVariants";
import type { InboxPullRequest } from "./inboxPullRequests";

/**
 * `inline` is the row's second line: only the thread's own change request,
 * colored text without a box, plus its stack position. `badges` lists the
 * whole stack for the hover card.
 */
export function InboxPullRequestBadges(props: {
  readonly requests: readonly InboxPullRequest[];
  readonly stack: SourceControlChangeRequestStackSummary | null;
  readonly shortName: string;
  readonly variant?: "inline" | "badges";
  readonly currentNumber?: number | null;
}) {
  if (props.requests.length === 0) return null;
  const inline = props.variant === "inline";
  const shown = inline
    ? props.requests.filter(
        (pr) => pr.number === (props.currentNumber ?? props.requests[0]!.number),
      )
    : props.requests;
  return (
    <span
      className={
        inline
          ? "flex shrink-0 items-center gap-1"
          : "flex w-full min-w-0 flex-wrap items-center gap-1"
      }
      data-testid="inbox-pr-badges"
    >
      {shown.map((pr) => {
        const variant = resolveStateBadgeVariant({
          kind: "pr",
          state: pr.state,
          isDraft: pr.isDraft,
        });
        const label = `${props.shortName} #${pr.number} · ${variant.label ?? "Unknown"}`;
        const Icon = variant.Icon;
        return (
          <span
            key={pr.number}
            aria-label={label}
            className={
              inline
                ? `inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium tabular-nums ${variant.textClassName}`
                : `inline-flex shrink-0 items-center gap-1 rounded border px-1 py-0.5 text-[10px] leading-3 ${variant.compactClassName}`
            }
          >
            <Icon aria-hidden className={inline ? "size-[11px]" : "size-3"} />
            <span>#{pr.number}</span>
          </span>
        );
      })}
      {props.stack ? (
        <span
          aria-label={`Stack #${props.stack.number}, pull request ${props.stack.position} of ${props.stack.size}`}
          className={`inline-flex items-center gap-0.5 tabular-nums text-muted-foreground ${inline ? "text-[10.5px]" : "text-[10px]"}`}
        >
          <GitForkIcon aria-hidden className="size-3" />
          {inline
            ? `${props.stack.position}/${props.stack.size}`
            : `Stack ${props.stack.position}/${props.stack.size}`}
        </span>
      ) : null}
    </span>
  );
}
