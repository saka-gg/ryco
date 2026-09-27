import type { SourceControlChangeRequestStackSummary } from "@ryco/contracts";
import { GitForkIcon } from "lucide-react";
import { resolveStateBadgeVariant } from "../sourceControl/stateBadgeVariants";
import type { InboxPullRequest } from "./inboxPullRequests";

export function InboxPullRequestBadges(props: {
  readonly requests: readonly InboxPullRequest[];
  readonly stack: SourceControlChangeRequestStackSummary | null;
  readonly shortName: string;
}) {
  if (props.requests.length === 0) return null;
  return (
    <span
      className="flex w-full min-w-0 flex-wrap items-center gap-1"
      data-testid="inbox-pr-badges"
    >
      {props.stack ? (
        <span
          aria-label={`Stack #${props.stack.number}, pull request ${props.stack.position} of ${props.stack.size}`}
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
        >
          <GitForkIcon aria-hidden className="size-3" />
          Stack {props.stack.position}/{props.stack.size}
        </span>
      ) : null}
      {props.requests.map((pr) => {
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
            title={label}
            className={`inline-flex shrink-0 items-center gap-1 rounded border px-1 py-0.5 text-[10px] leading-3 ${variant.compactClassName}`}
          >
            <Icon aria-hidden className="size-3" />
            <span>#{pr.number}</span>
          </span>
        );
      })}
    </span>
  );
}
