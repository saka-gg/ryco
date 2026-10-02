import type { SourceControlChangeRequestStackSummary } from "@ryco/contracts";
import { ArrowUpRightIcon, GitForkIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { openExternalLink } from "../../lib/openExternalLink";
import { cn } from "../../lib/utils";
import type { CheckRollupSummary } from "../projectExplorer/prCheckStatus";
import { resolveStateBadgeVariant } from "../sourceControl/stateBadgeVariants";
import type { InboxPullRequest } from "./inboxPullRequests";
import { InboxHint } from "./InboxRowHint";

function openPullRequest(event: MouseEvent, url: string) {
  // Chips live inside the row's open-thread button; the link wins.
  event.preventDefault();
  event.stopPropagation();
  openExternalLink(url, "Unable to open pull request link");
}

function PullRequestHint(props: {
  readonly pr: InboxPullRequest;
  readonly label: string;
  readonly providerName: string;
  readonly checks: CheckRollupSummary | null;
}) {
  return (
    <span className="flex max-w-64 flex-col gap-0.5 py-0.5">
      <span className="font-medium">{props.label}</span>
      {props.pr.title ? (
        <span className="truncate text-muted-foreground">{props.pr.title}</span>
      ) : null}
      {props.checks ? (
        <span className={cn("text-[11px]", props.checks.view.iconClassName)}>
          {props.checks.view.label}
          {props.checks.active > 0 ? ` · ${props.checks.passed}/${props.checks.total}` : ""}
        </span>
      ) : null}
      {props.pr.url ? (
        <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground/80">
          Open on {props.providerName}
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </span>
      ) : null}
    </span>
  );
}

/**
 * `inline` is the row's second line: only the thread's own change request,
 * colored text without a box, plus its stack position; hovering names it and
 * clicking opens it. `badges` lists the whole stack for the hover card.
 */
export function InboxPullRequestBadges(props: {
  readonly requests: readonly InboxPullRequest[];
  readonly stack: SourceControlChangeRequestStackSummary | null;
  readonly shortName: string;
  readonly providerName?: string | undefined;
  readonly variant?: "inline" | "badges";
  readonly currentNumber?: number | null;
  /** Checks of the thread's own change request, named in its hint. */
  readonly currentChecks?: CheckRollupSummary | null;
}) {
  if (props.requests.length === 0) return null;
  const inline = props.variant === "inline";
  const providerName = props.providerName ?? "the web";
  const shown = inline
    ? props.requests.filter(
        (pr) => pr.number === (props.currentNumber ?? props.requests[0]!.number),
      )
    : props.requests;
  const stack = props.stack;
  const stackLabel = stack
    ? `Stack #${stack.number}, pull request ${stack.position} of ${stack.size}`
    : null;
  return (
    <span
      className={
        inline ? "flex shrink-0 items-center gap-1" : "flex min-w-0 flex-wrap items-center gap-1"
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
        const url = pr.url;
        if (inline) {
          return (
            <InboxHint
              key={pr.number}
              aria-label={label}
              label={
                <PullRequestHint
                  checks={props.currentChecks ?? null}
                  label={label}
                  pr={pr}
                  providerName={providerName}
                />
              }
              className={cn(
                "inline-flex shrink-0 items-center gap-0.5 rounded-sm text-[11px] font-medium tabular-nums",
                variant.textClassName,
                url && "cursor-pointer underline-offset-2 hover:underline",
              )}
              {...(url
                ? { role: "link", onClick: (event: MouseEvent) => openPullRequest(event, url) }
                : {})}
            >
              <Icon aria-hidden className="size-[11px]" />
              <span>#{pr.number}</span>
            </InboxHint>
          );
        }
        const badgeClassName = `inline-flex shrink-0 items-center gap-1 rounded border px-1 py-0.5 text-[10px] leading-3 ${variant.compactClassName}`;
        return url ? (
          <a
            key={pr.number}
            aria-label={label}
            className={cn(badgeClassName, "transition-[filter] hover:brightness-125")}
            href={url}
            onClick={(event) => openPullRequest(event, url)}
          >
            <Icon aria-hidden className="size-3" />
            <span>#{pr.number}</span>
          </a>
        ) : (
          <span key={pr.number} aria-label={label} className={badgeClassName}>
            <Icon aria-hidden className="size-3" />
            <span>#{pr.number}</span>
          </span>
        );
      })}
      {stack && stackLabel ? (
        inline ? (
          <InboxHint
            aria-label={stackLabel}
            label={`Stack #${stack.number} · ${props.shortName} ${stack.position} of ${stack.size}`}
            className="inline-flex items-center gap-0.5 text-[10.5px] tabular-nums text-muted-foreground"
          >
            <GitForkIcon aria-hidden className="size-3" />
            {`${stack.position}/${stack.size}`}
          </InboxHint>
        ) : (
          // Inside the hover card a hint would close the card it sits in.
          <span
            aria-label={stackLabel}
            className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground"
          >
            <GitForkIcon aria-hidden className="size-3" />
            {`Stack ${stack.position}/${stack.size}`}
          </span>
        )
      ) : null}
    </span>
  );
}
