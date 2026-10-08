import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scrollRowIntoView, useLandingFlash } from "../../../hooks/useLandingFlash";
import { useSettings } from "../../../hooks/useSettings";
import { resolveSourceControlRefreshDelay } from "../../../rpc/sourceControlRefreshPolicy";
import {
  invalidateSourceControlWorkflowRuns,
  useSourceControlWorkflowRunJobsBatch,
  useSourceControlWorkflowRuns,
} from "../../../rpc/useSourceControl";
import { InboxMotionContext, useInboxListMotion } from "../../inboxSidebar/useInboxListMotion";
import { Skeleton } from "../../ui/skeleton";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { usePullRequestAgentHandoff } from "../agentHandoff";
import { CheckStateGlyph } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { usePullRequestReaderStore } from "../pullRequestsLayoutStore";
import { ChecksSummaryLine } from "./ChecksSummaryLine";
import { ChecksTabContext, type ChecksRunRerun, type ChecksTabContextValue } from "./checksContext";
import {
  buildPullRequestChecksModel,
  checksJobExpansionWrites,
  checksJobMemoryKey,
  isChecksJobExpanded,
  isCompletedStatus,
  isHeadWorkflowRun,
  resolveChecksJobParam,
  type ChecksJobEntry,
  type ChecksWorkflowEntry,
} from "./checksModel";
import { checksRerunStartedTitle, describeChecksRerunFailure } from "./checksRerun";
import { useTabScrollMemory } from "./checksUi";
import { createJobLogPathResolver } from "./jobLog";
import { StatusContextList } from "./StatusContextList";
import { CHECKS_JOB_ROW_ATTRIBUTE, JobRowsSkeleton, WorkflowSection } from "./WorkflowRunList";

/**
 * The Checks tab: one summary line, then every check on the head commit —
 * Actions workflows (job → step → log) in attention → running → completed →
 * skipped order, and other statuses as links. Content first: no title (the
 * bar names the tab), hairline rows, and quiet errors. Polls while anything
 * runs, on the house refresh cadence.
 */

const EMPTY_MEMORY: ReadonlyArray<string> = [];
const RUN_LIST_LIMIT = 20;

function isFailedJob(job: ChecksJobEntry): boolean {
  return job.state === "failure" || job.state === "cancelled";
}

export function ChecksTab() {
  const { model, nav, readerKey, jobRevealToken } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const { environmentId, cwd } = model;
  const { capabilities } = model;
  // Workflow runs (job → step → log) where the host serves them; the rollup alone otherwise.
  const actionsSupported = capabilities.workflowRuns;
  const providerName = model.provider?.name ?? "the web";
  const prState = selection.detail.data?.state ?? selection.summary?.state ?? null;
  const actionable = actionsSupported && prState === "open";
  const canRerun = actionable && capabilities.rerunWorkflows;
  const logsAvailable = actionsSupported && capabilities.workflowJobLogs;
  const headSha = selection.headSha;
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);

  // ── Reads ──
  const liveRef = useRef(false);
  const runsQuery = useSourceControlWorkflowRuns(
    {
      environmentId,
      cwd,
      pullRequestNumber: selection.number,
      limit: RUN_LIST_LIMIT,
      enabled: actionsSupported,
    },
    (data) =>
      resolveSourceControlRefreshDelay({
        mode: refreshMode,
        phase:
          liveRef.current || (data?.runs.some((run) => !isCompletedStatus(run.status)) ?? false)
            ? "active"
            : "settled",
      }),
  );
  const runs = actionsSupported ? (runsQuery.data?.runs ?? null) : null;
  const headRuns = (runs ?? []).filter((run) => isHeadWorkflowRun(run, headSha));
  const headRunSignature = headRuns.map((run) => run.runId).join(",");
  const headRunIds = useMemo(
    () => (headRunSignature ? headRunSignature.split(",") : []),
    [headRunSignature],
  );
  // Every unfinished head run is followed, not only the first one.
  const incompleteRunSignature = headRuns
    .filter((run) => !isCompletedStatus(run.status))
    .map((run) => run.runId)
    .join(",");
  const incompleteRunIds = useMemo(
    () => (incompleteRunSignature ? incompleteRunSignature.split(",") : []),
    [incompleteRunSignature],
  );
  const jobsBatch = useSourceControlWorkflowRunJobsBatch({
    environmentId,
    cwd,
    runIds: headRunIds,
    incompleteRunIds,
    enabled: actionsSupported && headRunIds.length > 0,
  });

  const checks = useMemo(
    () =>
      buildPullRequestChecksModel({
        rollup: selection.checks,
        runs,
        jobsByRunId: jobsBatch.jobsByRunId,
        headSha,
      }),
    [headSha, jobsBatch.jobsByRunId, runs, selection.checks],
  );
  useEffect(() => {
    liveRef.current = checks.live;
  }, [checks.live]);

  // ── Expansion memory (per pull request, survives tab and PR switches) ──
  const memory = usePullRequestReaderStore((state) =>
    readerKey ? (state.expandedJobs[readerKey] ?? EMPTY_MEMORY) : EMPTY_MEMORY,
  );
  const setJobExpanded = usePullRequestReaderStore((state) => state.setJobExpanded);
  const isExpanded = useCallback(
    (workflow: ChecksWorkflowEntry, job: ChecksJobEntry) =>
      isChecksJobExpanded(memory, checksJobMemoryKey(workflow, job), job.state === "failure"),
    [memory],
  );
  const setExpanded = useCallback(
    (workflow: ChecksWorkflowEntry, job: ChecksJobEntry, expanded: boolean) => {
      if (readerKey === null) return;
      const key = checksJobMemoryKey(workflow, job);
      for (const write of checksJobExpansionWrites(key, expanded, job.state === "failure")) {
        setJobExpanded(readerKey, write.id, write.expanded);
      }
    },
    [readerKey, setJobExpanded],
  );

  // ── Re-run failed (every finished run with failed jobs) ──
  const rerunsRef = useRef(new Map<string, ChecksRunRerun>());
  const registerRunRerun = useCallback((runId: string, rerun: ChecksRunRerun) => {
    rerunsRef.current.set(runId, rerun);
    return () => {
      if (rerunsRef.current.get(runId) === rerun) rerunsRef.current.delete(runId);
    };
  }, []);
  const [rerunPending, setRerunPending] = useState(false);
  const rerunJobCount = checks.workflows
    .filter((workflow) => workflow.run && checks.rerunnableRunIds.includes(workflow.run.runId))
    .reduce((sum, workflow) => sum + workflow.jobs.filter(isFailedJob).length, 0);
  const rerunFailed = async () => {
    const reruns = checks.rerunnableRunIds.flatMap((runId) => {
      const rerun = rerunsRef.current.get(runId);
      return rerun ? [rerun] : [];
    });
    if (reruns.length === 0) return;
    setRerunPending(true);
    const results = await Promise.allSettled(reruns.map((rerun) => rerun()));
    setRerunPending(false);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      const described = describeChecksRerunFailure(failure.reason);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: described.title,
          description: described.description,
        }),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: checksRerunStartedTitle({ failedJobs: rerunJobCount }),
        timeout: 2400,
      }),
    );
  };

  // ── Context for rows ──
  const handoff = usePullRequestAgentHandoff();
  const files = selection.detail.data?.files;
  const resolvePath = useMemo(
    () => createJobLogPathResolver(files?.map((file) => file.path) ?? []),
    [files],
  );
  const revealFile = useCallback((path: string, line: number) => nav.revealFile(path, line), [nav]);
  const { flash, trigger: triggerFlash } = useLandingFlash();
  const context = useMemo<ChecksTabContextValue>(
    () => ({
      environmentId,
      cwd,
      pullRequestNumber: selection.number,
      providerName,
      actionable,
      canRerun,
      logsAvailable,
      jobsLoading: jobsBatch.isLoading,
      handoff,
      resolvePath,
      revealFile,
      isExpanded,
      setExpanded,
      flash,
      registerRunRerun,
    }),
    [
      actionable,
      canRerun,
      cwd,
      environmentId,
      flash,
      handoff,
      isExpanded,
      jobsBatch.isLoading,
      logsAvailable,
      providerName,
      registerRunRerun,
      resolvePath,
      revealFile,
      selection.number,
      setExpanded,
    ],
  );

  // ── Layout state ──
  const hasRows = checks.sections.length > 0;
  const loading =
    !hasRows &&
    ((selection.detail.isLoading && selection.detail.data === null) ||
      (actionsSupported && runsQuery.isLoading && runsQuery.data === null));
  const { ref: scrollRef, onScroll } = useTabScrollMemory("checks", hasRows);

  // ── `job` deep link: open the job, bring it into view, flash it once ──
  // A repeat reveal of the same job bumps `jobRevealToken`, so it lands again.
  const jobParam = nav.search.job ?? null;
  const target = useMemo(() => resolveChecksJobParam(checks, jobParam), [checks, jobParam]);
  const targetKey = target ? `${target.workflowKey}/${target.jobKey}` : null;
  const revealKey = jobParam === null ? null : `${jobParam}#${jobRevealToken ?? 0}`;
  const handledRevealRef = useRef<string | null>(null);
  useEffect(() => {
    if (revealKey === null) {
      handledRevealRef.current = null;
      return;
    }
    if (target === null || targetKey === null || handledRevealRef.current === revealKey) return;
    const workflow = checks.workflows.find((candidate) => candidate.key === target.workflowKey);
    const job = workflow?.jobs.find((candidate) => candidate.key === target.jobKey);
    if (workflow && job && !isExpanded(workflow, job)) setExpanded(workflow, job, true);
    const frame = window.requestAnimationFrame(() => {
      handledRevealRef.current = revealKey;
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[${CHECKS_JOB_ROW_ATTRIBUTE}="${CSS.escape(targetKey)}"]`,
      );
      if (!row) return;
      scrollRowIntoView(row);
      triggerFlash(targetKey);
    });
    return () => window.cancelAnimationFrame(frame);
    // Runs once per reveal; later model updates must not re-scroll.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, targetKey]);

  // ── Motion: rows glide when the order changes, glyphs pop when state does ──
  const orderSignature = checks.sections
    .map((section) =>
      section.kind === "workflow"
        ? `${section.key}:${section.workflow.jobs.map((job) => job.key).join(",")}`
        : `statuses:${section.statuses.map((status) => status.key).join(",")}`,
    )
    .join("|");
  const motion = useInboxListMotion({ enabled: true, orderSignature });

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto w-full max-w-[56rem] px-5 pt-1 pb-20">
        {loading ? (
          <ChecksSkeleton />
        ) : !hasRows ? (
          <ChecksEmpty
            error={selection.detail.error !== null && selection.detail.data === null}
            unsupportedHost={
              capabilities.checkRollup || capabilities.workflowRuns ? null : providerName
            }
          />
        ) : (
          <ChecksTabContext.Provider value={context}>
            <InboxMotionContext.Provider value={motion.gateRef}>
              <ChecksSummaryLine
                counts={checks.counts}
                onRerunFailed={
                  canRerun && checks.rerunnableRunIds.length > 0 ? () => void rerunFailed() : null
                }
                rerunPending={rerunPending}
                rerunJobCount={rerunJobCount}
              />
              <div ref={motion.listRef} className="relative">
                {checks.sections.map((section) =>
                  section.kind === "workflow" ? (
                    <WorkflowSection
                      key={section.key}
                      workflow={section.workflow}
                      rerunnable={
                        section.workflow.run !== null &&
                        checks.rerunnableRunIds.includes(section.workflow.run.runId)
                      }
                    />
                  ) : (
                    <StatusContextList
                      key={section.key}
                      statuses={section.statuses}
                      title={checks.workflows.length > 0 ? "Other checks" : null}
                    />
                  ),
                )}
              </div>
              {actionsSupported && runsQuery.error && runsQuery.data === null ? (
                <p className="flex flex-wrap items-center gap-x-1.5 pt-4 pl-1 text-xs text-muted-foreground">
                  Couldn't load workflow runs, so steps and logs are missing.
                  <button
                    type="button"
                    onClick={() => invalidateSourceControlWorkflowRuns({ environmentId, cwd })}
                    className="rounded-[4px] font-medium text-foreground/80 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Retry
                  </button>
                </p>
              ) : null}
            </InboxMotionContext.Provider>
          </ChecksTabContext.Provider>
        )}
      </div>
    </div>
  );
}

function ChecksSkeleton() {
  return (
    <div aria-busy aria-label="Loading checks">
      <div className="flex h-12 items-center gap-3 pr-1 pl-1">
        <Skeleton className="h-3 w-44" />
      </div>
      <div className="pt-1">
        <div className="flex h-9 items-center gap-2 pr-1 pl-1">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-2.5 w-10" />
        </div>
        <ul className="border-t border-border/60">
          <JobRowsSkeleton count={5} />
        </ul>
      </div>
    </div>
  );
}

function ChecksEmpty(props: {
  readonly error: boolean;
  /** The host's name when its provider reports no checks at all (not "no checks ran"). */
  readonly unsupportedHost: string | null;
}) {
  return (
    <div className="flex min-h-12 items-center gap-2.5 pr-1 pl-1 text-[13px] text-muted-foreground">
      <CheckStateGlyph overall="none" />
      {props.unsupportedHost !== null
        ? `Ryco can't read checks from ${props.unsupportedHost} yet.`
        : props.error
          ? "Couldn't load checks for this pull request."
          : "No checks have reported on the latest commit."}
    </div>
  );
}
