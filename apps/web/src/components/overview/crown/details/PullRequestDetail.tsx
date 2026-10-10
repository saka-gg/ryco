import { ExternalLinkIcon, GitPullRequestIcon, LayersIcon } from "lucide-react";

import { handleInAppLinkClick } from "~/pullRequestsRoute";

import { changeRequestStateKind, StateBadge } from "../../../projectExplorer/StateBadge";
import { Button } from "../../../ui/button";
import { OtherPullRequestRows, reviewsLabel } from "../../overviewSections";
import type { OverviewPullRequestState } from "../../overviewTypes";
import {
  CROWN_PILL_BUTTON_CLASS,
  CrownDetailActions,
  CrownDetailEmpty,
  CrownDetailHeading,
  CrownKeyValueRow,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";

function MergeValue({ pullRequest }: { pullRequest: OverviewPullRequestState }) {
  if (pullRequest.hasMergeConflicts || pullRequest.mergeability === "conflicting") {
    return <span className="text-destructive-foreground">Conflicts</span>;
  }
  if (pullRequest.mergeability === "mergeable") {
    return <span className="text-success-foreground">No conflicts</span>;
  }
  return <span className="text-muted-foreground">Unknown</span>;
}

/**
 * "Open in Ryco" opens the pull request in the workspace panel. With a host URL
 * it is a real link, so ⌘/Ctrl- or middle-click still opens the host page
 * (the same rule as the classic panel's lane link).
 */
function OpenPullRequestAction({
  pullRequest,
  onOpenInApp,
}: {
  pullRequest: OverviewPullRequestState;
  onOpenInApp: (() => void) | undefined;
}) {
  const { url } = pullRequest;
  if (url) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={CROWN_PILL_BUTTON_CLASS}
        title={onOpenInApp ? "⌘-click opens it in a new tab" : undefined}
        render={
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => handleInAppLinkClick(event, onOpenInApp)}
          />
        }
      >
        {onOpenInApp ? (
          <>
            <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
            Open in Ryco
          </>
        ) : (
          <>
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            Open pull request
          </>
        )}
      </Button>
    );
  }
  if (!onOpenInApp) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className={CROWN_PILL_BUTTON_CLASS}
      onClick={() => onOpenInApp()}
    >
      <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
      Open in Ryco
    </Button>
  );
}

/** `≋ 2/3`: where the pull request sits in its host stack. */
function StackMarker({ stack }: { stack: NonNullable<OverviewPullRequestState["stack"]> }) {
  return (
    <span
      title={`Stack #${stack.number}`}
      className="inline-flex items-center gap-0.5 font-mono text-[11px] text-muted-foreground tabular-nums"
    >
      <LayersIcon aria-hidden className="size-3" />
      <span aria-hidden>
        {stack.position}/{stack.size}
      </span>
      <span className="sr-only">
        Stack #{stack.number}, pull request {stack.position} of {stack.size}
      </span>
    </span>
  );
}

export function PullRequestDetail({ layout, variant }: CrownDetailViewProps) {
  const pullRequest = layout.pullRequest;
  if (!pullRequest || pullRequest.number == null) {
    return (
      <>
        <CrownDetailHeading section="pr" variant={variant} />
        <CrownDetailEmpty>No pull request for this branch yet</CrownDetailEmpty>
      </>
    );
  }
  // Sized like the lab's `.badge` (18px, 10.5px semibold); it inherits the meta slot's mono face.
  const stateBadge = pullRequest.state ? (
    <StateBadge
      kind={changeRequestStateKind(pullRequest.state, pullRequest.isDraft)}
      className="h-[18px] px-1.5 py-0 text-[10.5px] font-semibold"
    />
  ) : null;
  const stackMarker = pullRequest.stack ? <StackMarker stack={pullRequest.stack} /> : null;
  const reviews = reviewsLabel(pullRequest.reviewsApproved, pullRequest.reviewsRequested);
  const openShownInApp = layout.onOpenPullRequestInApp
    ? () => layout.onOpenPullRequestInApp?.()
    : undefined;
  const action = <OpenPullRequestAction pullRequest={pullRequest} onOpenInApp={openShownInApp} />;
  return (
    <>
      <CrownDetailHeading
        section="pr"
        variant={variant}
        title={`PR #${pullRequest.number}`}
        meta={
          stackMarker ? (
            <span className="inline-flex items-center gap-1.5">
              {stackMarker}
              {stateBadge}
            </span>
          ) : (
            stateBadge
          )
        }
      />
      <div className="mx-1 mb-1.5 flex min-w-0 items-start gap-2">
        {/* The card has no heading, so it carries the number and state here. */}
        {variant === "card" ? (
          <span className="shrink-0 font-mono text-[11px] leading-[18px] font-medium text-muted-foreground">
            #{pullRequest.number}
          </span>
        ) : null}
        {pullRequest.title ? (
          <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] font-medium break-words">
            {pullRequest.title}
          </span>
        ) : null}
        {variant === "card" ? stackMarker : null}
        {variant === "card" ? stateBadge : null}
      </div>
      {reviews ? <CrownKeyValueRow label="Reviews">{reviews}</CrownKeyValueRow> : null}
      {typeof pullRequest.commentsCount === "number" ? (
        <CrownKeyValueRow label="Comments" className="tabular-nums">
          {pullRequest.commentsCount}
        </CrownKeyValueRow>
      ) : null}
      <CrownKeyValueRow label="Merge">
        <MergeValue pullRequest={pullRequest} />
      </CrownKeyValueRow>
      {layout.otherPullRequests && layout.otherPullRequests.length > 0 ? (
        // The rows carry the classic lane's inset; line their text up with the rows above.
        <div className="-mx-2">
          <OtherPullRequestRows
            links={layout.otherPullRequests}
            onOpenInApp={layout.onOpenPullRequestInApp}
          />
        </div>
      ) : null}
      {pullRequest.url || layout.onOpenPullRequestInApp ? (
        <CrownDetailActions>{action}</CrownDetailActions>
      ) : null}
    </>
  );
}
