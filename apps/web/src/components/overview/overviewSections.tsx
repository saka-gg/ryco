import { prefersExternalPullRequestLink } from "../../pullRequestsRoute";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  LoaderIcon,
  MessageSquareIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import {
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import type { ActivePlanState } from "../../session-logic";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { SubagentAvatar } from "../sidebar/SubagentAvatar";
import { changeRequestStateKind, StateBadge } from "../projectExplorer/StateBadge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

import type {
  OverviewChangedFile,
  OverviewLayoutProps,
  OverviewPanelItem,
  OverviewPullRequestCheckRun,
} from "./overviewTypes";

/* ================================================================== *
 * Helpers + derived summary
 * ================================================================== */

export interface OverviewSummary {
  additions: number;
  deletions: number;
  hasDiff: boolean;
  fileCount: number;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checksRunning: number;
  planTotal: number;
  planDone: number;
  agentsTotal: number;
  agentsRunning: number;
  refName: string | null;
  aheadCount: number;
  behindCount: number;
}

/** Compute aggregated metrics (diff, checks, plan progress, agent status) from layout props for rendering badges and summaries. */
export function getOverviewSummary(props: OverviewLayoutProps): OverviewSummary {
  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  let hasDiff = false;
  if (props.changes) {
    additions = props.changes.insertions;
    deletions = props.changes.deletions;
    fileCount = props.changes.files.length;
    hasDiff = fileCount > 0 || additions > 0 || deletions > 0;
  } else {
    for (const item of props.overviewItems ?? []) {
      if (typeof item.additions === "number") {
        additions += item.additions;
        hasDiff = true;
      }
      if (typeof item.deletions === "number") {
        deletions += item.deletions;
        hasDiff = true;
      }
    }
  }
  const runs = props.pullRequest?.latestRuns ?? [];
  let checksPassed = 0;
  let checksFailed = 0;
  let checksRunning = 0;
  for (const run of runs) {
    if (run.tone === "success") checksPassed += 1;
    else if (run.tone === "failure" || run.tone === "error") checksFailed += 1;
    else if (run.tone === "running") checksRunning += 1;
  }
  const steps = props.activePlan?.steps ?? [];
  const agents = props.subagents ?? [];
  // Progress numerator counts steps that have been *reached* — completed plus the
  // currently in-progress step — to mirror the lab's "N of M" / percentage (e.g.
  // 2 done + 1 active of 5 = 3/5 = 60%). The per-step markers still key off the
  // raw status, so only completed steps render a check.
  const planReached = steps.filter(
    (step) => step.status === "completed" || step.status === "inProgress",
  ).length;
  return {
    additions,
    deletions,
    hasDiff,
    fileCount,
    checksTotal: runs.length,
    checksPassed,
    checksFailed,
    checksRunning,
    planTotal: steps.length,
    planDone: planReached,
    agentsTotal: agents.length,
    agentsRunning: agents.filter((agent) => agent.status === "running").length,
    refName: props.changes?.refName ?? null,
    aheadCount: props.changes?.aheadCount ?? 0,
    behindCount: props.changes?.behindCount ?? 0,
  };
}

/** Check if the panel has no meaningful content to display. */
export function isOverviewEmpty(props: OverviewLayoutProps): boolean {
  return (
    !props.activePlan &&
    !props.activeProposedPlan?.planMarkdown &&
    (props.subagents?.length ?? 0) === 0 &&
    (props.overviewItems?.length ?? 0) === 0 &&
    (props.changes?.files.length ?? 0) === 0 &&
    !props.pullRequest &&
    !props.sourceControlActions &&
    !props.branchControl
  );
}

/** Extract the changes item from the overview items array. */
export function pickChangesItem(
  overviewItems: ReadonlyArray<OverviewPanelItem> | undefined,
): OverviewPanelItem | undefined {
  return overviewItems?.find((item) => item.icon === "changes");
}

/** Calculate plan completion percentage (0–100). */
export function planPercent(summary: OverviewSummary): number {
  if (summary.planTotal === 0) return 0;
  return Math.round((summary.planDone / summary.planTotal) * 100);
}

/** Check if the pull request has any review data (approved or requested). */
export function hasReviews(pullRequest: { reviewsApproved?: number; reviewsRequested?: number }) {
  return (
    typeof pullRequest.reviewsApproved === "number" ||
    typeof pullRequest.reviewsRequested === "number"
  );
}

/* ================================================================== *
 * Primitives
 * ================================================================== */

type BadgeTone = "success" | "warning" | "error" | "info" | "neutral" | "primary";

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  success: "bg-success/11 text-success-foreground",
  warning: "bg-warning/12 text-warning-foreground",
  error: "bg-destructive/11 text-destructive-foreground",
  info: "bg-info/11 text-info-foreground",
  neutral: "bg-secondary text-muted-foreground",
  primary: "bg-primary/12 text-primary dark:text-info-foreground",
};

export function OverviewBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[19px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] leading-none font-medium [&_svg]:size-[11px]",
        BADGE_TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-[12px] font-semibold tabular-nums",
        className,
      )}
    >
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">&minus;{deletions}</span>
    </span>
  );
}

/** The `.spark` stacked add/del bar. */
export function SparkBar({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cn("flex h-1.5 overflow-hidden rounded-[3px] bg-muted", className)}>
      <span className="h-full bg-success" style={{ flexGrow: additions || 0 }} />
      <span className="h-full bg-destructive" style={{ flexGrow: deletions || 0 }} />
    </span>
  );
}

export function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null;
  return (
    <span className="flex items-center gap-1 font-mono text-[11px] font-semibold text-muted-foreground tabular-nums">
      {ahead > 0 ? (
        <span className="flex items-center gap-0.5">
          <ArrowUpIcon className="size-[11px]" />
          {ahead}
        </span>
      ) : null}
      {behind > 0 ? (
        <span className="flex items-center gap-0.5">
          <ArrowDownIcon className="size-[11px]" />
          {behind}
        </span>
      ) : null}
    </span>
  );
}

const CHECK_DOT_TONE: Record<string, string> = {
  success: "bg-success",
  failure: "bg-destructive",
  error: "bg-destructive",
  running: "bg-sky-400 animate-status-pulse",
  pending: "bg-warning/55",
};

/** The `.dots5` mini visualization for the checks lane. */
export function CheckDots({ runs }: { runs: ReadonlyArray<OverviewPullRequestCheckRun> }) {
  if (runs.length === 0) return null;
  return (
    <span className="flex items-center gap-[3px]">
      {runs.map((run) => (
        <span
          key={run.id}
          className={cn(
            "size-[7px] rounded-full bg-[color:var(--border-strong)]",
            CHECK_DOT_TONE[run.tone],
          )}
        />
      ))}
    </span>
  );
}

/** The `.prog` mini progress bar. */
export function MiniProgress({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-[5px] w-[54px] overflow-hidden rounded-[3px] bg-muted",
        className,
      )}
    >
      <span
        className="block h-full rounded-[3px] bg-primary"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </span>
  );
}

/** The `.avstack` overlapping initials avatars for the subagents lane. */
export function AvatarStack({ subagents }: { subagents: ReadonlyArray<ThreadSubagentView> }) {
  if (subagents.length === 0) return null;
  return (
    <span className="flex items-center">
      {subagents.slice(0, 3).map((subagent, index) => (
        <span
          key={subagent.key}
          className={cn(
            "grid size-5 place-items-center rounded-full border-2 border-card bg-secondary/60",
            index > 0 && "-ml-[7px]",
          )}
        >
          <SubagentAvatar name={subagent.avatarKey ?? subagent.key} className="size-3" />
        </span>
      ))}
    </span>
  );
}

/** A running status dot (`.dot.running`). */
function StatusDot({ className, title }: { className?: string; title?: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", className)} title={title} />;
}

export function SectionMiniLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
    </p>
  );
}

export function KeyValueRow({
  label,
  value,
  monoValue = true,
}: {
  label: ReactNode;
  value: ReactNode;
  monoValue?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 text-[12.5px]">
      <span className="flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
        {label}
      </span>
      <span className={cn("text-[12px] font-medium tabular-nums", monoValue && "font-mono")}>
        {value}
      </span>
    </div>
  );
}

export function ConflictBanner({ detail }: { detail?: string | undefined }) {
  return (
    <div className="flex gap-2 rounded-[10px] border border-destructive/24 bg-destructive/[0.09] px-[11px] py-[9px] text-[12.5px] text-destructive-foreground">
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
      <span>
        <span className="font-semibold">Merge conflict</span>
        {detail ? ` · ${detail}` : " — rebase onto the base branch to resolve before merge."}
      </span>
    </div>
  );
}

/** A status-board `.lane` with the lab's 4-column header grid. */
export function SectionLane({
  icon,
  title,
  subtitle,
  summary,
  externalLink,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  summary?: ReactNode;
  externalLink?:
    | {
        href: string;
        ariaLabel: string;
        /** When set, a plain click stays in the app and ⌘/Ctrl-click opens `href`. */
        onOpenInApp?: (() => void) | undefined;
      }
    | undefined;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const expandable = children !== undefined && children !== null && children !== false;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = expandable && uncontrolledOpen;
  const headerClassName = cn(
    "relative grid min-h-10 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-[7px] py-1 pl-2.5 text-left",
    expandable && "transition-colors hover:bg-accent",
    externalLink ? "pr-14" : expandable ? "pr-8" : "pr-2.5",
  );
  const headerContent = (
    <>
      <span
        className={cn(
          "grid size-5 place-items-center rounded-md bg-secondary text-muted-foreground transition-colors [&_svg]:size-3",
          open && "bg-primary/12 text-primary dark:text-info-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11.5px] leading-[14px] font-semibold">{title}</span>
        {subtitle ? (
          <span className="mt-px block truncate text-[10px] leading-3 text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      {summary ? (
        <span className="flex shrink-0 items-center justify-self-end gap-1.5">{summary}</span>
      ) : null}
      {expandable ? (
        <ChevronRightIcon
          className={cn(
            "absolute top-1/2 right-2.5 size-3 -translate-y-1/2 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      ) : null}
    </>
  );
  return (
    <div className="border-b border-border last:border-b-0">
      <div
        className="relative min-h-10"
        data-slot="overview-section-lane-header"
        data-expandable={expandable ? "true" : "false"}
      >
        {expandable ? (
          <button
            type="button"
            onClick={() => setUncontrolledOpen((value) => !value)}
            aria-expanded={open}
            className={headerClassName}
          >
            {headerContent}
          </button>
        ) : (
          <div className={headerClassName}>{headerContent}</div>
        )}
        {externalLink ? (
          <a
            href={externalLink.href}
            target="_blank"
            rel="noreferrer"
            aria-label={externalLink.ariaLabel}
            title={externalLink.ariaLabel}
            onClick={(event) => {
              const openInApp = externalLink.onOpenInApp;
              if (!openInApp || prefersExternalPullRequestLink(event)) return;
              event.preventDefault();
              openInApp();
            }}
            className="absolute top-1/2 right-7 z-10 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : null}
      </div>
      {open ? <div className="pb-1.5">{children}</div> : null}
    </div>
  );
}

/* ================================================================== *
 * Changes
 * ================================================================== */

interface ChangesBucket {
  key: string;
  label: string;
  detail?: string;
  files: ReadonlyArray<OverviewChangedFile>;
}

function ChangeBucketRow({
  label,
  detail,
  files,
  onOpen,
}: {
  label: string;
  detail?: string | undefined;
  files: ReadonlyArray<OverviewChangedFile>;
  onOpen?: (() => void) | undefined;
}) {
  const insertions = files.reduce((total, file) => total + file.insertions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="font-medium text-foreground/90">{label}</span>
        {detail ? (
          <span className="truncate text-[11px] text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2.5">
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <DiffStat additions={insertions} deletions={deletions} className="text-[11px]" />
      </span>
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-accent"
      >
        {content}
      </button>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-[12.5px]">{content}</div>
  );
}

type ChangesProps = Pick<OverviewLayoutProps, "changes" | "overviewItems" | "onOpenReview"> & {
  pullRequestNumber?: number | undefined;
};

export function ChangesContent({
  changes,
  overviewItems,
  onOpenReview,
  pullRequestNumber,
}: ChangesProps) {
  const changesItem = pickChangesItem(overviewItems);
  const files = changes?.files ?? [];

  if (files.length > 0) {
    // Summarize into local vs committed buckets (individual files live in the
    // Diff panel, which a click opens). "committed" files with an open PR are
    // labeled with the PR number.
    const committed = files.filter((file) => file.category === "committed");
    const local = files.filter((file) => file.category !== "committed");
    const buckets: ChangesBucket[] = [];
    if (committed.length > 0) {
      buckets.push({
        key: "committed",
        label: "Committed",
        ...(pullRequestNumber ? { detail: `· PR #${pullRequestNumber}` } : {}),
        files: committed,
      });
    }
    if (local.length > 0) {
      buckets.push({ key: "local", label: "Uncommitted", files: local });
    }
    return (
      <div>
        {buckets.map((bucket) => (
          <ChangeBucketRow
            key={bucket.key}
            label={bucket.label}
            detail={bucket.detail}
            files={bucket.files}
            onOpen={onOpenReview}
          />
        ))}
      </div>
    );
  }
  if (changesItem) {
    return (
      <button
        type="button"
        onClick={onOpenReview}
        disabled={!onOpenReview}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-accent disabled:hover:bg-transparent"
      >
        <span className="truncate text-foreground/85">{changesItem.value}</span>
        {changesItem.detail ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{changesItem.detail}</span>
        ) : null}
      </button>
    );
  }
  return <p className="px-3 py-1.5 text-[12px] text-muted-foreground">No file changes.</p>;
}

/* ================================================================== *
 * Plan
 * ================================================================== */

function PlanStepMarker({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <span className="flex size-[17px] shrink-0 items-center justify-center rounded-full bg-success text-white">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-[17px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-primary">
        <span className="size-[7px] animate-status-pulse rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span className="size-[17px] shrink-0 rounded-full border-[1.5px] border-[color:var(--border-strong)]" />
  );
}

export function PlanExplanation({ activePlan }: { activePlan: ActivePlanState | null }) {
  if (!activePlan?.explanation) return null;
  return (
    <p className="px-3 pt-1 pb-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
      {activePlan.explanation}
    </p>
  );
}

export function PlanSteps({ activePlan }: { activePlan: ActivePlanState | null }) {
  if (!activePlan || activePlan.steps.length === 0) return null;
  return (
    <div>
      {activePlan.steps.map((step) => (
        <div
          key={`${step.status}:${step.step}`}
          className="flex items-start gap-2.5 px-3 py-[7px] text-[13px]"
        >
          <span className="mt-px">
            <PlanStepMarker status={step.status} />
          </span>
          <span
            className={cn(
              "leading-snug",
              step.status === "inProgress" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {step.step}
          </span>
        </div>
      ))}
    </div>
  );
}

type ProposedPlanProps = Pick<
  OverviewLayoutProps,
  "activeProposedPlan" | "environmentId" | "markdownCwd" | "workspaceRoot"
>;

export function ProposedPlanDisclosure({
  activeProposedPlan,
  environmentId,
  markdownCwd,
  workspaceRoot,
}: ProposedPlanProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [environmentId, planMarkdown, workspaceRoot]);

  if (!planMarkdown) return null;

  return (
    <div className="space-y-2 px-3 pt-1 pb-1">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setProposedPlanExpanded((value) => !value)}
        >
          {proposedPlanExpanded ? (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[10px] font-semibold tracking-widest text-muted-foreground uppercase group-hover:text-foreground/70">
            {planTitle ?? "Full plan"}
          </span>
        </button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="shrink-0 text-muted-foreground hover:text-foreground/70"
                aria-label="Plan actions"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem
              onClick={handleSaveToWorkspace}
              disabled={!workspaceRoot || isSavingToWorkspace}
            >
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {proposedPlanExpanded ? (
        <div className="rounded-lg border border-border bg-background/50 p-3">
          <ChatMarkdown text={displayedPlanMarkdown ?? ""} cwd={markdownCwd} isStreaming={false} />
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * Subagents
 * ================================================================== */

function subagentStatusLabel(status: ThreadSubagentView["status"]): string {
  if (status === "running") return "Working";
  if (status === "failed") return "Needs review";
  if (status === "finished") return "Finished";
  if (status === "interrupted") return "Stopped";
  return "Idle";
}

const SUBAGENT_DOT_TONE: Record<ThreadSubagentView["status"], string> = {
  running:
    "bg-sky-400 animate-status-pulse shadow-[0_0_0_3px_color-mix(in_srgb,var(--sky)_22%,transparent)]",
  finished: "bg-success",
  failed: "bg-destructive",
  interrupted: "bg-muted-foreground/60",
  idle: "bg-muted-foreground/40",
};

type SubagentProps = Pick<OverviewLayoutProps, "subagents" | "onOpenSubagent">;

export function SubagentRows({ subagents = [], onOpenSubagent }: SubagentProps) {
  if (subagents.length === 0) return null;
  return (
    <div>
      {subagents.map((subagent) => {
        const meta = subagent.model ?? subagent.tool ?? subagent.role ?? null;
        const timestamp = subagent.updatedAt || subagent.startedAt;
        return (
          <button
            key={subagent.key}
            type="button"
            className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent"
            onClick={() => onOpenSubagent?.(subagent)}
            aria-label={`${subagent.name} — ${subagentStatusLabel(subagent.status)}`}
            title={subagent.detail ?? undefined}
          >
            <span className="grid size-[26px] shrink-0 place-items-center rounded-lg border border-border bg-secondary/40">
              <SubagentAvatar name={subagent.avatarKey ?? subagent.key} className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{subagent.name}</span>
                <StatusDot
                  className={SUBAGENT_DOT_TONE[subagent.status]}
                  title={subagentStatusLabel(subagent.status)}
                />
              </span>
              {meta ? (
                <span className="block truncate text-[11.5px] text-muted-foreground">{meta}</span>
              ) : null}
            </span>
            {timestamp ? (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                {formatRelativeTimeLabel(timestamp)}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ================================================================== *
 * Pull request + checks
 * ================================================================== */

function checkToneIcon(tone: OverviewPullRequestCheckRun["tone"]): ReactNode {
  if (tone === "success") return <CheckIcon className="size-3.5 text-success-foreground" />;
  if (tone === "failure" || tone === "error")
    return <XIcon className="size-3.5 text-destructive-foreground" />;
  if (tone === "running")
    return <LoaderIcon className="size-3.5 animate-spin text-info-foreground" />;
  if (tone === "pending") return <ClockIcon className="size-3.5 text-muted-foreground" />;
  return <span className="size-3 rounded-full border border-muted-foreground/35" />;
}

function CheckRow({ run }: { run: OverviewPullRequestCheckRun }) {
  const content = (
    <>
      <span className="grid w-4 shrink-0 place-items-center">{checkToneIcon(run.tone)}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{run.name}</span>
      {run.detail ? (
        <span className="shrink-0 text-[11.5px] text-muted-foreground">{run.detail}</span>
      ) : null}
    </>
  );
  if (run.url) {
    return (
      <a
        href={run.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 items-center gap-2.5 px-3 py-1.5 text-[12.5px] transition-colors hover:bg-accent"
      >
        {content}
      </a>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-3 py-1.5 text-[12.5px]">{content}</div>
  );
}

export function ChecksContent({
  pullRequest,
}: {
  pullRequest: NonNullable<OverviewLayoutProps["pullRequest"]>;
}) {
  // Terminal errors need an actionable, persistent message; transient ones
  // (timeout / network blip) get a quiet muted line — the loud notice is a
  // one-time toast, and the refresh control carries the retry affordance.
  const error = pullRequest.checksError;
  return (
    <div>
      {error ? (
        <p
          className={cn(
            "px-3 py-1.5 text-[11.5px]",
            error.kind === "terminal" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {error.message}
        </p>
      ) : null}
      {pullRequest.latestRuns.map((run) => (
        <CheckRow key={run.id} run={run} />
      ))}
      {pullRequest.latestRuns.length === 0 && !error ? (
        <p className="px-3 py-1.5 text-[12px] text-muted-foreground">No checks reported.</p>
      ) : null}
    </div>
  );
}

function reviewsLabel(approved?: number, requested?: number): string | null {
  const parts: string[] = [];
  if (typeof approved === "number") parts.push(`${approved} approved`);
  if (typeof requested === "number") parts.push(`${requested} requested`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function ReviewsRow({
  pullRequest,
}: {
  pullRequest: NonNullable<OverviewLayoutProps["pullRequest"]>;
}) {
  const label = reviewsLabel(pullRequest.reviewsApproved, pullRequest.reviewsRequested);
  if (!label) return null;
  return (
    <KeyValueRow
      label={
        <>
          <MessageSquareIcon /> Reviews
        </>
      }
      value={label}
      monoValue={false}
    />
  );
}

export function PullRequestContent({
  pullRequest,
  showTitle = true,
  showChecks = true,
  showReviews = true,
}: {
  pullRequest: NonNullable<OverviewLayoutProps["pullRequest"]>;
  showTitle?: boolean;
  showChecks?: boolean;
  showReviews?: boolean;
}) {
  return (
    <div>
      {showTitle || pullRequest.hasMergeConflicts ? (
        <div className="space-y-2 px-3 pt-0.5 pb-[9px]">
          {showTitle ? (
            <p className="truncate text-[11.5px] text-muted-foreground">{pullRequest.title}</p>
          ) : null}
          {pullRequest.hasMergeConflicts ? <ConflictBanner /> : null}
        </div>
      ) : null}

      {showChecks ? <ChecksContent pullRequest={pullRequest} /> : null}
      {showReviews ? <ReviewsRow pullRequest={pullRequest} /> : null}
    </div>
  );
}

/** Inline `#3204 open` heading used by single-section layouts that need it. */
export function PullRequestHeading({
  pullRequest,
}: {
  pullRequest: NonNullable<OverviewLayoutProps["pullRequest"]>;
}) {
  return (
    <span className="flex items-center gap-2 text-[13px] font-semibold">
      <GitPullRequestIcon className="size-3.5 text-muted-foreground" />#{pullRequest.number}
      {pullRequest.state ? (
        <StateBadge kind={changeRequestStateKind(pullRequest.state, pullRequest.isDraft)} />
      ) : null}
    </span>
  );
}

/* ================================================================== *
 * Empty state + shared icons
 * ================================================================== */

export function OverviewEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-3 py-12 text-center">
      <p className="text-[13px] text-muted-foreground/40">No active plan yet.</p>
      <p className="mt-1 text-[11px] text-muted-foreground/30">
        Plans and subagents will appear here as the thread runs.
      </p>
    </div>
  );
}

export const SECTION_ICON = {
  changes: <GitCommitHorizontalIcon />,
  plan: <SparklesIcon />,
  agents: <BotIcon />,
  pr: <GitPullRequestIcon />,
  checks: <GitPullRequestIcon />,
} as const;
