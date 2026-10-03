import type { SourceControlWorkflowStep } from "@ryco/contracts";
import type { ChangeRequestCheckState } from "@ryco/client-runtime/state/pull-request-review";
import { DateTime, Option } from "effect";
import { ExternalLinkIcon, MoreHorizontalIcon, RotateCwIcon, SparklesIcon } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";

import { openExternalLink } from "../../../lib/openExternalLink";
import { cn } from "../../../lib/utils";
import {
  retrySourceControlWorkflowJobLog,
  useRerunWorkflowMutation,
  useSourceControlWorkflowJobLog,
} from "../../../rpc/useSourceControl";
import { InboxMotionContext, useInboxClock } from "../../inboxSidebar/useInboxListMotion";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Skeleton } from "../../ui/skeleton";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CheckStateGlyph } from "../primitives";
import { useChecksTab } from "./checksContext";
import {
  CHECK_STATE_LABEL,
  checkStateOverall,
  checksJobMemoryKey,
  formatWorkflowDuration,
  isCompletedStatus,
  workflowItemState,
  type ChecksJobEntry,
  type ChecksWorkflowEntry,
} from "./checksModel";
import { checksRerunStartedTitle, describeChecksRerunFailure } from "./checksRerun";
import {
  Disclosure,
  DisclosureChevron,
  ROW_HOVER_REVEAL_CLASS,
  ROW_ICON_BUTTON_CLASS,
  RequiredTag,
  landingFlashClass,
} from "./checksUi";
import { JobLogBlock } from "./JobLogBlock";
import { jobLogAllLines, jobLogStepLines, jobLogTailText, splitJobLog } from "./jobLog";

/**
 * GitHub Actions on the head commit, nested workflow → job → step → log.
 * Workflow headers are plain lines; jobs are hairline-separated rows that
 * expand to their steps, and a failing job opens on its own with the failing
 * step's log at its tail. Row actions (re-run, open, fix with agent) stay
 * out of the way until the row is hovered or focused.
 */

/** Data key the tab uses to find a job row for deep links. */
export const CHECKS_JOB_ROW_ATTRIBUTE = "data-checks-job";

const ROW_TRAILING_CLASS = "relative flex shrink-0 items-center gap-1";
const DURATION_CLASS = "w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums";

function isFailedState(state: ChangeRequestCheckState): boolean {
  return state === "failure" || state === "cancelled";
}

function StateGlyph(props: {
  readonly state: ChangeRequestCheckState;
  readonly className?: string | undefined;
}) {
  const overall = checkStateOverall(props.state);
  // Keyed by the state shown, so a change remounts it and the new mark pops.
  return (
    <CheckStateGlyph
      key={overall}
      overall={overall}
      label={CHECK_STATE_LABEL[props.state]}
      className={props.className}
    />
  );
}

function rerunFailureToast(error: unknown) {
  const failure = describeChecksRerunFailure(error);
  toastManager.add(
    stackedThreadToast({ type: "error", title: failure.title, description: failure.description }),
  );
}

// ── Workflow ─────────────────────────────────────────────────────────

export const WorkflowSection = memo(function WorkflowSection(props: {
  readonly workflow: ChecksWorkflowEntry;
  readonly rerunnable: boolean;
}) {
  const { workflow } = props;
  const tab = useChecksTab();
  const run = workflow.run;
  const rerun = useRerunWorkflowMutation({
    environmentId: tab.environmentId,
    cwd: tab.cwd,
    runId: run?.runId ?? "",
  });
  const { mutateAsync } = rerun;

  // Jobs a re-run was requested for read as queued until the host reports
  // the new attempt, so the glyph never flickers back to failed meanwhile.
  const [requested, setRequested] = useState<ReadonlyMap<string, number | null>>(() => new Map());
  useEffect(() => {
    if (requested.size === 0) return;
    const timer = window.setTimeout(() => setRequested(new Map()), 45_000);
    return () => window.clearTimeout(timer);
  }, [requested]);
  const markRequested = useCallback(
    (jobs: ReadonlyArray<ChecksJobEntry>, on: boolean) =>
      setRequested((current) => {
        const next = new Map(current);
        for (const job of jobs) {
          if (on) next.set(job.key, job.startedAtMs);
          else next.delete(job.key);
        }
        return next;
      }),
    [],
  );
  const isRequested = (job: ChecksJobEntry) =>
    requested.has(job.key) &&
    isFailedState(job.state) &&
    requested.get(job.key) === job.startedAtMs;

  const failedJobs = useMemo(
    () => workflow.jobs.filter((job) => isFailedState(job.state)),
    [workflow.jobs],
  );
  const rerunFailed = useCallback(async () => {
    markRequested(failedJobs, true);
    try {
      return await mutateAsync({ target: "failed-jobs" });
    } catch (error) {
      markRequested(failedJobs, false);
      throw error;
    }
  }, [failedJobs, markRequested, mutateAsync]);

  const { registerRunRerun } = tab;
  const runId = run?.runId ?? null;
  useEffect(() => {
    if (runId === null || !props.rerunnable) return;
    return registerRunRerun(runId, rerunFailed);
  }, [props.rerunnable, registerRunRerun, rerunFailed, runId]);

  const rerunJob = useCallback(
    async (job: ChecksJobEntry) => {
      if (!job.job) return;
      markRequested([job], true);
      try {
        await mutateAsync({ target: "job", jobId: job.job.jobId });
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: checksRerunStartedTitle({ jobName: job.name }),
            timeout: 2400,
          }),
        );
      } catch (error) {
        markRequested([job], false);
        rerunFailureToast(error);
      }
    },
    [markRequested, mutateAsync],
  );

  const runFinished = run !== null && isCompletedStatus(run.status);
  const duration =
    workflow.group === "running" ? null : formatWorkflowDuration(workflow.durationMs);

  return (
    <section
      data-inbox-row-key={`workflow:${workflow.key}`}
      aria-label={workflow.name}
      className="relative pt-5 first:pt-1"
    >
      <div className="group/row flex h-9 items-center gap-2 pr-1 pl-1">
        <StateGlyph state={workflow.state} />
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
          {workflow.name}
        </h3>
        {workflow.group === "running" && run ? (
          <RunningFor startedAtMs={epochMillisOrNull(run.startedAt)} />
        ) : duration ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{duration}</span>
        ) : null}
        <span className="flex-1" />
        {run ? (
          <RowMenu label={`${workflow.name} actions`}>
            {props.rerunnable && tab.canRerun ? (
              <MenuItem
                onClick={() =>
                  void rerunFailed().then(
                    () =>
                      toastManager.add(
                        stackedThreadToast({
                          type: "success",
                          title: checksRerunStartedTitle({ failedJobs: failedJobs.length }),
                          timeout: 2400,
                        }),
                      ),
                    rerunFailureToast,
                  )
                }
              >
                <RotateCwIcon aria-hidden />
                Re-run failed jobs
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => openExternalLink(run.url, "Couldn't open the workflow run")}>
              <ExternalLinkIcon aria-hidden />
              Open on {tab.providerName}
            </MenuItem>
          </RowMenu>
        ) : null}
      </div>
      <ul className="border-t border-border/60">
        {workflow.jobs.length === 0 && tab.jobsLoading ? (
          <JobRowsSkeleton count={3} />
        ) : (
          workflow.jobs.map((job) => (
            <JobRow
              key={job.key}
              workflow={workflow}
              job={job}
              requested={isRequested(job)}
              canRerun={tab.canRerun && runFinished && job.job !== null && !isRequested(job)}
              onRerun={rerunJob}
            />
          ))
        )}
      </ul>
    </section>
  );
});

function epochMillisOrNull(value: Option.Option<DateTime.Utc>): number | null {
  return Option.match(value, { onNone: () => null, onSome: DateTime.toEpochMillis });
}

function RunningFor(props: { readonly startedAtMs: number | null }) {
  const now = useInboxClock();
  const elapsed = props.startedAtMs === null ? null : Math.max(0, now - props.startedAtMs);
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {elapsed === null ? "Running" : formatWorkflowDuration(elapsed)}
    </span>
  );
}

function RowMenu(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            className={cn(ROW_ICON_BUTTON_CLASS, ROW_HOVER_REVEAL_CLASS)}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </button>
        }
      />
      <MenuPopup align="end" className="min-w-48">
        {props.children}
      </MenuPopup>
    </Menu>
  );
}

// ── Job ──────────────────────────────────────────────────────────────

const JobRow = memo(function JobRow(props: {
  readonly workflow: ChecksWorkflowEntry;
  readonly job: ChecksJobEntry;
  readonly requested: boolean;
  readonly canRerun: boolean;
  readonly onRerun: (job: ChecksJobEntry) => void;
}) {
  const { workflow, job } = props;
  const tab = useChecksTab();
  const regionId = useId();
  const memoryKey = checksJobMemoryKey(workflow, job);
  // An Actions run means steps (and logs) exist or are on their way.
  const expandable = workflow.run !== null;
  const expanded = expandable && tab.isExpanded(workflow, job);
  // A requested re-run spins at once and reads "Queued" until the host catches up.
  const glyphState: ChangeRequestCheckState = props.requested ? "running" : job.state;
  const durationState: ChangeRequestCheckState = props.requested ? "pending" : job.state;
  const actionsJob = job.job;
  const completed = actionsJob !== null && isCompletedStatus(actionsJob.status);
  const failing = job.state === "failure" && !props.requested;

  // Steps: the failing one opens on its own; the reader's toggles override.
  const [stepOverrides, setStepOverrides] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const failingStepNumber = failing ? (job.failingStep?.number ?? null) : null;
  const isStepOpen = (step: SourceControlWorkflowStep) =>
    stepOverrides.get(step.number) ?? step.number === failingStepNumber;
  const anyStepOpen = expanded && (actionsJob?.steps.some((step) => isStepOpen(step)) ?? false);

  // A failing job's log loads even while collapsed: "Fix with agent" quotes it.
  const logInput = {
    environmentId: tab.environmentId,
    cwd: tab.cwd,
    runId: job.runId,
    jobId: actionsJob?.jobId ?? null,
    enabled: tab.logsAvailable && completed && (anyStepOpen || failing),
  };
  const logQuery = useSourceControlWorkflowJobLog(logInput);
  const sections = useMemo(
    () => (logQuery.data ? splitJobLog(logQuery.data.log) : null),
    [logQuery.data],
  );

  const fixWithAgent = () => {
    const step = job.failingStep;
    const lines =
      sections && step
        ? jobLogStepLines(sections, step, { failing: true, steps: actionsJob?.steps })
        : null;
    const context = lines ? jobLogTailText(lines, 80) : "";
    void tab.handoff.start({
      kind: "fix-check",
      prompt: [
        `The check "${workflow.name} / ${job.name}" fails on pull request #${tab.pullRequestNumber}.`,
        step ? `The failing step is "${step.name}".` : null,
        "Find the cause, fix it on this branch, and run the check locally to confirm.",
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
      ...(context ? { context: `Log tail:\n\`\`\`\n${context}\n\`\`\`` } : {}),
    });
  };

  const toggle = () => tab.setExpanded(workflow, job, !expanded);
  const label = (
    <>
      <StateGlyph state={glyphState} />
      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{job.name}</span>
    </>
  );

  return (
    <li
      data-inbox-row-key={`job:${memoryKey}`}
      {...{ [CHECKS_JOB_ROW_ATTRIBUTE]: memoryKey }}
      className="scroll-mt-12 border-b border-border/60"
    >
      <div
        className={cn(
          "group/row relative flex h-10 items-center gap-2 rounded-md pr-1 pl-1 transition-colors duration-(--app-motion-duration-chip) hover:bg-foreground/[0.025]",
          landingFlashClass(tab.flash, memoryKey),
        )}
      >
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left outline-hidden before:absolute before:inset-0 before:rounded-md focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
          >
            <DisclosureChevron open={expanded} />
            {label}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span aria-hidden className="size-3 shrink-0" />
            {label}
          </div>
        )}
        <div className={ROW_TRAILING_CLASS}>
          {failing && tab.actionable && tab.handoff.available ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={fixWithAgent}
                    className={cn(
                      "text-muted-foreground hover:text-foreground",
                      ROW_HOVER_REVEAL_CLASS,
                    )}
                  >
                    <SparklesIcon className="size-3" />
                    Fix with agent
                  </Button>
                }
              />
              <TooltipPopup side="top" sideOffset={4}>
                Start an agent on the branch with this log
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {job.required ? <RequiredTag /> : null}
          <JobDuration job={job} state={durationState} />
          {job.url || (actionsJob && tab.canRerun) ? (
            <RowMenu label={`${job.name} actions`}>
              {tab.canRerun && actionsJob ? (
                <MenuItem disabled={!props.canRerun} onClick={() => props.onRerun(job)}>
                  <RotateCwIcon aria-hidden />
                  Re-run job
                </MenuItem>
              ) : null}
              {job.url ? (
                <MenuItem onClick={() => openExternalLink(job.url!, "Couldn't open the job")}>
                  <ExternalLinkIcon aria-hidden />
                  Open on {tab.providerName}
                </MenuItem>
              ) : null}
            </RowMenu>
          ) : (
            <span aria-hidden className="size-6" />
          )}
        </div>
      </div>
      {expandable ? (
        <Disclosure open={expanded} id={regionId}>
          {/* Steps paint still: only job rows pop when their state changes. */}
          <InboxMotionContext.Provider value={null}>
            {actionsJob ? (
              <ol className="pb-2 pl-6" aria-label={`${job.name} steps`}>
                {actionsJob.steps.map((step) => (
                  <StepRow
                    key={step.number}
                    step={step}
                    hasLog={completed && tab.logsAvailable}
                    open={isStepOpen(step)}
                    onToggle={(open) =>
                      setStepOverrides((current) => new Map(current).set(step.number, open))
                    }
                    log={
                      <StepLog
                        step={step}
                        steps={actionsJob.steps}
                        failing={step.number === failingStepNumber}
                        query={logQuery}
                        onRetry={() => retrySourceControlWorkflowJobLog(logInput)}
                        sections={sections}
                        url={job.url}
                      />
                    }
                  />
                ))}
              </ol>
            ) : (
              <ol className="pb-2 pl-6" aria-busy>
                <StepRowsSkeleton count={4} />
              </ol>
            )}
          </InboxMotionContext.Provider>
        </Disclosure>
      ) : null}
    </li>
  );
});

function JobDuration(props: {
  readonly job: ChecksJobEntry;
  readonly state: ChangeRequestCheckState;
}) {
  const { job, state } = props;
  if (state === "running" && job.startedAtMs !== null) {
    return (
      <span className={DURATION_CLASS}>
        <RunningFor startedAtMs={job.startedAtMs} />
      </span>
    );
  }
  const text =
    state === "pending" || state === "running" || state === "unknown" || state === "skipped"
      ? CHECK_STATE_LABEL[state]
      : formatWorkflowDuration(job.durationMs);
  return <span className={DURATION_CLASS}>{text}</span>;
}

// ── Step ─────────────────────────────────────────────────────────────

function StepRow(props: {
  readonly step: SourceControlWorkflowStep;
  readonly hasLog: boolean;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly log: React.ReactNode;
}) {
  const { step } = props;
  const regionId = useId();
  const state = workflowItemState(step);
  const hasLog = props.hasLog && state !== "skipped";
  const open = hasLog && props.open;
  const failed = isFailedState(state);
  const duration =
    state === "running"
      ? CHECK_STATE_LABEL.running
      : state === "pending"
        ? ""
        : formatWorkflowDuration(Option.getOrNull(step.durationMs));
  const label = (
    <>
      <StateGlyph state={state} className="size-3" />
      <span className="w-4 shrink-0 text-right text-[11px] text-muted-foreground/70 tabular-nums">
        {step.number}
      </span>
      <span
        className={cn(
          "min-w-0 truncate",
          failed ? "text-foreground" : "text-muted-foreground group-hover/step:text-foreground",
        )}
      >
        {step.name}
      </span>
    </>
  );
  return (
    <li>
      <div className="group/step relative flex h-7 items-center gap-2 rounded-md pr-1 text-xs transition-colors duration-(--app-motion-duration-chip)">
        {hasLog ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={() => props.onToggle(!open)}
            className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left outline-hidden before:absolute before:inset-0 before:rounded-md hover:before:bg-foreground/[0.025] focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
          >
            <DisclosureChevron open={open} />
            {label}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span aria-hidden className="size-3 shrink-0" />
            {label}
          </div>
        )}
        <span className={cn(DURATION_CLASS, "text-[11px]")}>{duration}</span>
        <span aria-hidden className="size-6 shrink-0" />
      </div>
      {hasLog ? (
        <Disclosure open={open} id={regionId}>
          <div className="pt-1 pr-8 pb-2 pl-5">{props.log}</div>
        </Disclosure>
      ) : null}
    </li>
  );
}

function StepLog(props: {
  readonly step: SourceControlWorkflowStep;
  readonly steps: ReadonlyArray<SourceControlWorkflowStep>;
  readonly failing: boolean;
  readonly query: ReturnType<typeof useSourceControlWorkflowJobLog>;
  /** Re-reads this job's log only. */
  readonly onRetry: () => void;
  readonly sections: ReturnType<typeof splitJobLog> | null;
  readonly url: string | null;
}) {
  const tab = useChecksTab();
  const { query, sections } = props;
  const lines = useMemo(
    () =>
      sections
        ? jobLogStepLines(sections, props.step, { failing: props.failing, steps: props.steps })
        : null,
    [props.failing, props.step, props.steps, sections],
  );
  const allLines = useMemo(() => (sections ? jobLogAllLines(sections) : []), [sections]);

  if (query.error && !query.data) {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        Couldn't load the log.
        <button
          type="button"
          onClick={props.onRetry}
          className="rounded-[4px] font-medium text-foreground/80 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
        {props.url ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={() => openExternalLink(props.url!, "Couldn't open the job")}
              className="rounded-[4px] font-medium text-foreground/80 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open on {tab.providerName}
            </button>
          </>
        ) : null}
      </p>
    );
  }
  if (!sections) {
    return (
      <div
        aria-busy
        aria-label="Loading log"
        className="space-y-2 rounded-md border border-border/70 px-3 py-3"
      >
        <Skeleton className="h-2.5 w-2/5" />
        <Skeleton className="h-2.5 w-3/5" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
    );
  }
  if (lines === null || lines.length === 0) {
    return <p className="text-xs text-muted-foreground">No output for this step.</p>;
  }
  return (
    <JobLogBlock
      lines={lines}
      allLines={allLines}
      truncated={query.data?.truncated ?? false}
      resolvePath={tab.resolvePath}
      onRevealFile={tab.revealFile}
    />
  );
}

// ── Skeletons (same geometry as the rows) ────────────────────────────

const SKELETON_WIDTHS = ["w-28", "w-20", "w-36", "w-24", "w-32"];

export function JobRowsSkeleton(props: { readonly count: number }) {
  return Array.from({ length: props.count }, (_, index) => (
    <li
      key={index}
      aria-hidden
      className="flex h-10 items-center gap-2 border-b border-border/60 pr-1 pl-1"
    >
      <span className="size-3 shrink-0" />
      <Skeleton className="size-3.5 shrink-0 rounded-full" />
      <Skeleton className={cn("h-3", SKELETON_WIDTHS[index % SKELETON_WIDTHS.length])} />
      <span className="flex-1" />
      <Skeleton className="mr-8 h-2.5 w-9" />
    </li>
  ));
}

function StepRowsSkeleton(props: { readonly count: number }) {
  return Array.from({ length: props.count }, (_, index) => (
    <li key={index} aria-hidden className="flex h-7 items-center gap-2 pr-1">
      <span className="size-3 shrink-0" />
      <Skeleton className="size-3 shrink-0 rounded-full" />
      <Skeleton className={cn("h-2.5", SKELETON_WIDTHS[(index + 2) % SKELETON_WIDTHS.length])} />
    </li>
  ));
}
