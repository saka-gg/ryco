import type { ElementType, ReactNode } from "react";
import {
  BotIcon,
  CircleCheckIcon,
  FilesIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  ServerIcon,
  RotateCwIcon,
} from "lucide-react";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  WORKSPACE_SHORTCUT_CLASS_NAME,
  WORKSPACE_SHORTCUT_LABEL_CLASS_NAME,
} from "../chat/workspaceShortcutStyles";
import type { OverviewLayoutProps } from "./overviewTypes";
import {
  ChangesContent,
  ChecksContent,
  getOverviewSummary,
  pickEnvironmentItem,
  PlanExplanation,
  PlanSteps,
  ProposedPlanDisclosure,
  PullRequestContent,
  SubagentRows,
} from "./overviewSections";

function RailSection({
  label,
  value,
  Icon,
  iconClassName,
  children,
}: {
  label: string;
  value?: string | undefined;
  Icon: ElementType;
  iconClassName?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger className={WORKSPACE_SHORTCUT_CLASS_NAME} aria-label={label}>
        <Icon aria-hidden="true" className={iconClassName} />
        <span className={WORKSPACE_SHORTCUT_LABEL_CLASS_NAME}>
          <span className="truncate">{value ?? label}</span>
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="left"
        align="start"
        sideOffset={12}
        surface="glass"
        className="w-80 max-w-[calc(100vw-4.5rem)]"
        aria-label={label}
      >
        <h2 className="mb-3 text-xs font-medium">{label}</h2>
        <div className="text-xs text-muted-foreground">{children}</div>
      </PopoverPopup>
    </Popover>
  );
}

/** The overview's existing content, split into individually addressable icons. */
export function OverviewRailSections({ overview }: { overview: OverviewLayoutProps }) {
  const summary = getOverviewSummary(overview);
  const environment = pickEnvironmentItem(overview.overviewItems);
  const planVisible = Boolean(overview.activePlan || overview.activeProposedPlan?.planMarkdown);
  return (
    <>
      {overview.branchControl}
      <RailSection
        label="Changes"
        Icon={FilesIcon}
        value={
          summary.hasDiff
            ? `${summary.fileCount} files · +${summary.additions} −${summary.deletions}`
            : "No changes"
        }
      >
        <ChangesContent
          changes={overview.changes}
          overviewItems={overview.overviewItems}
          onOpenReview={overview.onOpenReview}
          pullRequestNumber={overview.pullRequest?.number}
        />
      </RailSection>
      {overview.sourceControlActions ? (
        <RailSection label="Git actions" Icon={GitCommitHorizontalIcon}>
          {overview.sourceControlActions}
        </RailSection>
      ) : null}
      {overview.pullRequest ? (
        <RailSection
          label="Checks"
          Icon={CircleCheckIcon}
          iconClassName={
            summary.checksFailed > 0
              ? "text-destructive"
              : summary.checksRunning > 0
                ? "text-primary"
                : summary.checksTotal > 0 && summary.checksPassed === summary.checksTotal
                  ? "text-success"
                  : ""
          }
          value={
            summary.checksTotal
              ? `Checks · ${summary.checksPassed}/${summary.checksTotal} passed`
              : "Checks"
          }
        >
          <ChecksContent pullRequest={overview.pullRequest} />
          {overview.onRefreshPullRequest ? (
            <button
              type="button"
              className="mt-3 flex items-center gap-2 text-xs"
              onClick={overview.onRefreshPullRequest}
              disabled={overview.isRefreshingPullRequest}
            >
              <RotateCwIcon className="size-3.5" />
              {overview.isRefreshingPullRequest ? "Refreshing…" : "Refresh checks"}
            </button>
          ) : null}
        </RailSection>
      ) : null}
      {overview.pullRequest?.number != null ? (
        <RailSection
          label="Pull request"
          Icon={GitPullRequestIcon}
          value={`#${overview.pullRequest.number} · ${overview.pullRequest.isDraft ? "Draft" : (overview.pullRequest.state ?? "Pull request")}`}
        >
          <PullRequestContent
            pullRequest={overview.pullRequest}
            showTitle
            showChecks={false}
            showReviews
          />
          {overview.pullRequest.url ? (
            <a
              href={overview.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block text-primary"
            >
              Open pull request ↗
            </a>
          ) : null}
        </RailSection>
      ) : null}
      {planVisible ? (
        <RailSection
          label="Plan"
          Icon={ListChecksIcon}
          value={
            summary.planTotal ? `Plan · ${summary.planDone}/${summary.planTotal}` : "Proposed plan"
          }
        >
          <PlanExplanation activePlan={overview.activePlan} />
          <PlanSteps activePlan={overview.activePlan} />
          <ProposedPlanDisclosure
            activeProposedPlan={overview.activeProposedPlan}
            environmentId={overview.environmentId}
            markdownCwd={overview.markdownCwd}
            workspaceRoot={overview.workspaceRoot}
          />
        </RailSection>
      ) : null}
      {(overview.subagents?.length ?? 0) > 0 ? (
        <RailSection
          label="Agents"
          Icon={BotIcon}
          value={`Agents · ${summary.agentsRunning} running`}
        >
          <SubagentRows subagents={overview.subagents} onOpenSubagent={overview.onOpenSubagent} />
        </RailSection>
      ) : null}
      {environment ? (
        <RailSection label="Environment" Icon={ServerIcon} value={environment.value}>
          <p>{environment.value}</p>
          {environment.detail ? <p className="mt-1">{environment.detail}</p> : null}
        </RailSection>
      ) : null}
    </>
  );
}
