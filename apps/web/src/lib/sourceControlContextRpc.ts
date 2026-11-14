import type { EnvironmentId } from "@ryco/contracts";
import { queryOptions } from "~/rpc/queryClient";
import { requireEnvironmentConnection } from "~/environments/runtime";

export const sourceControlContextQueryKeys = {
  all: ["sourceControl"] as const,
  changeRequests: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["sourceControl", "changeRequests", environmentId ?? null, cwd] as const,
  issueList: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    state: "open" | "closed" | "all",
    limit?: number,
  ) =>
    ["sourceControl", "issues", environmentId ?? null, cwd, "list", state, limit ?? null] as const,
  issueDetail: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    reference: string,
    fullContent: boolean = false,
  ) =>
    [
      "sourceControl",
      "issues",
      environmentId ?? null,
      cwd,
      "detail",
      reference,
      fullContent ? "full" : "truncated",
    ] as const,
  issueSearch: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    query: string,
    limit?: number,
  ) =>
    [
      "sourceControl",
      "issues",
      environmentId ?? null,
      cwd,
      "search",
      query,
      limit ?? null,
    ] as const,
  changeRequestList: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    state: "open" | "closed" | "merged" | "all",
    limit?: number,
  ) =>
    [
      "sourceControl",
      "changeRequests",
      environmentId ?? null,
      cwd,
      "list",
      state,
      limit ?? null,
    ] as const,
  changeRequestDetail: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    reference: string,
    fullContent: boolean = false,
  ) =>
    [
      "sourceControl",
      "changeRequests",
      environmentId ?? null,
      cwd,
      "detail",
      reference,
      fullContent ? "full" : "truncated",
    ] as const,
  changeRequestDiff: (environmentId: EnvironmentId | null, cwd: string | null, reference: string) =>
    ["sourceControl", "changeRequests", environmentId ?? null, cwd, "diff", reference] as const,
  changeRequestSearch: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    query: string,
    limit?: number,
  ) =>
    [
      "sourceControl",
      "changeRequests",
      environmentId ?? null,
      cwd,
      "search",
      query,
      limit ?? null,
    ] as const,
  workflowRuns: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    pullRequestNumber?: number | null,
    commitSha?: string | null,
    limit?: number,
  ) =>
    [
      "sourceControl",
      "workflows",
      environmentId ?? null,
      cwd,
      "runs",
      pullRequestNumber ?? null,
      commitSha ?? null,
      limit ?? null,
    ] as const,
  workflows: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["sourceControl", "workflows", environmentId ?? null, cwd] as const,
  workflowRunJobs: (environmentId: EnvironmentId | null, cwd: string | null, runId: string) =>
    ["sourceControl", "workflows", environmentId ?? null, cwd, "jobs", runId] as const,
  workflowJobLog: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    runId: string,
    jobId: string,
  ) => ["sourceControl", "workflows", environmentId ?? null, cwd, "logs", runId, jobId] as const,
};

export function issueDetailQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string | null;
  fullContent?: boolean;
  enabled?: boolean;
}) {
  const fullContent = input.fullContent ?? false;
  return queryOptions({
    queryKey: sourceControlContextQueryKeys.issueDetail(
      input.environmentId,
      input.cwd,
      input.reference ?? "",
      fullContent,
    ),
    environmentId: input.environmentId,
    queryFn: async () => {
      if (!input.cwd || !input.environmentId || !input.reference) {
        throw new Error("Issue detail is unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.getIssue({
        cwd: input.cwd,
        reference: input.reference,
        ...(fullContent ? { fullContent: true } : {}),
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.reference !== null,
    staleTime: 300_000,
  });
}

export function searchChangeRequestsQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  limit?: number;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: sourceControlContextQueryKeys.changeRequestSearch(
      input.environmentId,
      input.cwd,
      input.query,
      input.limit,
    ),
    environmentId: input.environmentId,
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Change request search is unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.searchChangeRequests({
        cwd: input.cwd,
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.query.length > 0,
    staleTime: 30_000,
  });
}

export function changeRequestDetailQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string | null;
  fullContent?: boolean;
  enabled?: boolean;
}) {
  const fullContent = input.fullContent ?? false;
  return queryOptions({
    queryKey: sourceControlContextQueryKeys.changeRequestDetail(
      input.environmentId,
      input.cwd,
      input.reference ?? "",
      fullContent,
    ),
    environmentId: input.environmentId,
    queryFn: async () => {
      if (!input.cwd || !input.environmentId || !input.reference) {
        throw new Error("Change request detail is unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.getChangeRequestDetail({
        cwd: input.cwd,
        reference: input.reference,
        ...(fullContent ? { fullContent: true } : {}),
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.reference !== null,
    staleTime: 300_000,
  });
}
