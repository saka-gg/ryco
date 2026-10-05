import { cn } from "~/lib/utils";

import { changeRequestStateKind, StateBadge } from "../projectExplorer/StateBadge";
import {
  AvatarStack,
  ChangesContent,
  ChecksContent,
  CheckDots,
  DiffStat,
  getOverviewSummary,
  MiniProgress,
  OverviewBadge,
  planPercent,
  PlanExplanation,
  PlanSteps,
  pickChangesItem,
  ProposedPlanDisclosure,
  PullRequestContent,
  SECTION_ICON,
  SectionLane,
  SubagentRows,
} from "./overviewSections";
import type { OverviewLayoutProps } from "./overviewTypes";

/** Check if either the active plan or proposed plan has content to display. */
function isPlanActive(props: OverviewLayoutProps): boolean {
  return Boolean(
    (props.activePlan && (props.activePlan.steps.length > 0 || props.activePlan.explanation)) ||
    props.activeProposedPlan?.planMarkdown,
  );
}

/** Format a count and word pair with proper pluralization. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function StatusBoardLayout(props: OverviewLayoutProps) {
  const summary = getOverviewSummary(props);
  const changesItem = pickChangesItem(props.overviewItems);
  const subagents = props.subagents ?? [];
  const activeStep =
    props.activePlan?.steps.find((step) => step.status === "inProgress")?.step ??
    props.activePlan?.explanation ??
    undefined;
  const agentNames = subagents
    .slice(0, 2)
    .map((subagent) => subagent.name)
    .join(", ");
  const changesFileLabel =
    summary.fileCount > 0 ? plural(summary.fileCount, "file") : changesItem?.value;

  return (
    <div>
      {summary.fileCount > 0 || Boolean(changesItem) ? (
        <SectionLane
          icon={SECTION_ICON.changes}
          title="Changes"
          summary={
            <>
              {changesFileLabel ? (
                <span
                  className={cn(
                    "font-mono text-[10px] text-muted-foreground tabular-nums",
                    summary.hasDiff && "border-r border-border pr-1.5",
                  )}
                >
                  {changesFileLabel}
                </span>
              ) : null}
              {summary.hasDiff ? (
                <DiffStat
                  additions={summary.additions}
                  deletions={summary.deletions}
                  className="text-[10px]"
                />
              ) : null}
            </>
          }
        >
          <ChangesContent
            changes={props.changes}
            overviewItems={props.overviewItems}
            onOpenReview={props.onOpenReview}
            pullRequestNumber={props.pullRequest?.number}
          />
        </SectionLane>
      ) : null}

      {props.pullRequest ? (
        <SectionLane
          icon={SECTION_ICON.checks}
          title="Checks"
          subtitle={
            props.pullRequest.number != null
              ? `CI on PR #${props.pullRequest.number}`
              : summary.refName
                ? `CI on ${summary.refName}`
                : "CI"
          }
          summary={
            <>
              <CheckDots runs={props.pullRequest.latestRuns} />
              {summary.checksTotal > 0 ? (
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {summary.checksPassed}/{summary.checksTotal}
                </span>
              ) : null}
            </>
          }
        >
          <ChecksContent pullRequest={props.pullRequest} />
        </SectionLane>
      ) : null}

      {isPlanActive(props) ? (
        <SectionLane
          icon={SECTION_ICON.plan}
          title="Plan"
          subtitle={activeStep}
          summary={
            summary.planTotal > 0 ? (
              <>
                <MiniProgress value={planPercent(summary)} />
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {summary.planDone}/{summary.planTotal}
                </span>
              </>
            ) : undefined
          }
        >
          <PlanExplanation activePlan={props.activePlan} />
          <PlanSteps activePlan={props.activePlan} />
          <ProposedPlanDisclosure
            activeProposedPlan={props.activeProposedPlan}
            environmentId={props.environmentId}
            markdownCwd={props.markdownCwd}
            workspaceRoot={props.workspaceRoot}
          />
        </SectionLane>
      ) : null}

      {subagents.length > 0 ? (
        <SectionLane
          icon={SECTION_ICON.agents}
          title="Subagents"
          subtitle={agentNames ? `${agentNames}${subagents.length > 2 ? "…" : ""}` : undefined}
          summary={
            <>
              <AvatarStack subagents={subagents} />
              <span className="text-[11px] text-muted-foreground">
                {summary.agentsRunning > 0
                  ? `${summary.agentsRunning} running`
                  : `${summary.agentsTotal} total`}
              </span>
            </>
          }
        >
          <SubagentRows subagents={props.subagents} onOpenSubagent={props.onOpenSubagent} />
        </SectionLane>
      ) : null}

      {props.pullRequest && props.pullRequest.number != null ? (
        <SectionLane
          icon={SECTION_ICON.pr}
          title={`Pull Request #${props.pullRequest.number}`}
          subtitle={props.pullRequest.title}
          summary={
            <>
              {props.pullRequest.state ? (
                <StateBadge
                  kind={changeRequestStateKind(props.pullRequest.state, props.pullRequest.isDraft)}
                />
              ) : null}
              {props.pullRequest.hasMergeConflicts ? (
                <OverviewBadge tone="error">conflict</OverviewBadge>
              ) : null}
            </>
          }
          externalLink={
            props.pullRequest.url
              ? {
                  href: props.pullRequest.url,
                  ariaLabel: props.onOpenPullRequestInApp
                    ? `Review pull request #${props.pullRequest.number} (⌘-click opens it in a new tab)`
                    : `Open pull request #${props.pullRequest.number} in a new tab`,
                  onOpenInApp: props.onOpenPullRequestInApp,
                }
              : undefined
          }
        >
          <PullRequestContent
            pullRequest={props.pullRequest}
            showTitle={false}
            showChecks={false}
            showReviews
          />
        </SectionLane>
      ) : null}
    </div>
  );
}
