import type {
  ChangeRequest,
  EnvironmentId,
  SourceControlChangeRequestDetail,
  SourceControlWorkflowRunListResult,
} from "@ryco/contracts";
import { useCallback } from "react";

import { useSettings } from "~/hooks/useSettings";
import {
  useSourceControlChangeRequestDetail,
  useSourceControlChangeRequestList,
  useSourceControlWorkflowRunJobsBatch,
  useSourceControlWorkflowRuns,
  type SourceControlQueryState,
  type SourceControlWorkflowRunJobsBatchResult,
} from "./useSourceControl";
import { resolveSourceControlRefreshDelay } from "./sourceControlRefreshPolicy";

export type OverviewQueryState<TData> = SourceControlQueryState<TData>;
export type OverviewWorkflowRunJobsResult = SourceControlWorkflowRunJobsBatchResult;

export const OVERVIEW_CHANGE_REQUEST_LIST_LIMIT = 50;
export const OVERVIEW_WORKFLOW_RUNS_LIMIT = 20;

/**
 * Overview adapters deliberately reuse the canonical source-control bindings.
 * Opening Overview and Project Explorer for the same key therefore joins one
 * in-flight request, one cache entry, and one lifecycle-aware poll timer.
 */
export function useOverviewChangeRequestList(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  enabled: boolean;
}): OverviewQueryState<ReadonlyArray<ChangeRequest>> {
  return useSourceControlChangeRequestList({
    ...input,
    state: "open",
    limit: OVERVIEW_CHANGE_REQUEST_LIST_LIMIT,
  });
}

export function useOverviewPullRequestDetail(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string | null;
  enabled: boolean;
}): OverviewQueryState<SourceControlChangeRequestDetail> {
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const resolveIntervalMs = useCallback(
    (data: SourceControlChangeRequestDetail | null) =>
      resolveSourceControlRefreshDelay({
        mode: refreshMode,
        phase: data?.state === "open" ? "active" : "settled",
      }),
    [refreshMode],
  );
  return useSourceControlChangeRequestDetail(input, resolveIntervalMs);
}

export function useOverviewWorkflowRuns(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  pullRequestNumber: number | null;
  branch: string | null;
  commitSha: string | null;
  enabled: boolean;
  resolveIntervalMs: (data: SourceControlWorkflowRunListResult | null) => number | false;
}): OverviewQueryState<SourceControlWorkflowRunListResult> {
  return useSourceControlWorkflowRuns(
    {
      environmentId: input.environmentId,
      cwd: input.cwd,
      pullRequestNumber: input.pullRequestNumber,
      branch: input.pullRequestNumber === null ? input.branch : null,
      commitSha: input.commitSha,
      limit: OVERVIEW_WORKFLOW_RUNS_LIMIT,
      enabled: input.enabled && (input.pullRequestNumber !== null || input.branch !== null),
    },
    input.resolveIntervalMs,
  );
}

/**
 * The overview follows one active run; any other run's jobs still poll while
 * they show unfinished work (see `useSourceControlWorkflowRunJobsBatch`).
 */
export function useOverviewWorkflowRunJobs(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  runIds: ReadonlyArray<string>;
  activeRunId: string | null;
  enabled: boolean;
}): OverviewWorkflowRunJobsResult {
  return useSourceControlWorkflowRunJobsBatch({
    environmentId: input.environmentId,
    cwd: input.cwd,
    runIds: input.runIds,
    incompleteRunIds: input.activeRunId === null ? [] : [input.activeRunId],
    enabled: input.enabled,
  });
}
