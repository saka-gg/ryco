import type {
  SourceControlAddCommentReactionInput,
  EnvironmentId,
  SourceControlAddChangeRequestCommentInput,
  SourceControlAddIssueCommentInput,
  SourceControlChangeRequestDetail,
  SourceControlCommentReaction,
  SourceControlCommentReactionContent,
  SourceControlIssueComment,
  SourceControlIssueDetail,
} from "@ryco/contracts";
import { queryOptions, useMutation, useQueryClient } from "~/rpc/queryClient";
import { requireEnvironmentConnection } from "~/environments/runtime";

type SourceControlWorkflowRerunPayload =
  | { readonly target: "failed-jobs" }
  | { readonly target: "job"; readonly jobId: string };

type CommentReactionDetail = SourceControlIssueDetail | SourceControlChangeRequestDetail;

function toggleReactionList(
  reactions: ReadonlyArray<SourceControlCommentReaction> | undefined,
  content: SourceControlCommentReactionContent,
): ReadonlyArray<SourceControlCommentReaction> | undefined {
  const existing = reactions?.find((reaction) => reaction.content === content);
  const others = reactions?.filter((reaction) => reaction.content !== content) ?? [];
  if (!existing) {
    return [...others, { content, count: 1, viewerHasReacted: true }];
  }
  const viewerHasReacted = existing.viewerHasReacted === true;
  const nextCount = viewerHasReacted ? Math.max(0, existing.count - 1) : existing.count + 1;
  if (nextCount <= 0) return others.length > 0 ? others : undefined;
  return [...others, { ...existing, count: nextCount, viewerHasReacted: !viewerHasReacted }];
}

function toggleCommentReactionInDetail<TDetail extends CommentReactionDetail>(
  detail: TDetail | undefined,
  input: Pick<SourceControlAddCommentReactionInput, "commentId" | "content">,
): TDetail | undefined {
  if (!detail) return detail;
  let changed = false;
  const comments = detail.comments.map((comment): SourceControlIssueComment => {
    if (comment.id !== input.commentId) return comment;
    changed = true;
    const reactions = toggleReactionList(comment.reactions, input.content);
    if (reactions) return { ...comment, reactions };
    const { reactions: _reactions, ...rest } = comment;
    return rest;
  });
  return changed ? ({ ...detail, comments } as TDetail) : detail;
}

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

export function useRerunWorkflowMutation(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  runId: string;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SourceControlWorkflowRerunPayload) => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("Workflow reruns are unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.rerunWorkflow({
        cwd: input.cwd,
        runId: input.runId,
        ...payload,
      });
    },
    onSuccess: (result) => {
      qc.invalidateQueries({
        queryKey: sourceControlContextQueryKeys.workflows(input.environmentId, input.cwd),
      });
      qc.invalidateQueries({
        queryKey: sourceControlContextQueryKeys.changeRequests(input.environmentId, input.cwd),
      });
      qc.invalidateQueries({
        queryKey: sourceControlContextQueryKeys.workflowRunJobs(
          input.environmentId,
          input.cwd,
          result.runId,
        ),
      });
    },
  });
}

export function useAddIssueCommentMutation(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      payload: Pick<SourceControlAddIssueCommentInput, "body" | "clientMutationId">,
    ) => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("Issue comments are unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.addIssueComment({
        cwd: input.cwd,
        reference: input.reference,
        body: payload.body,
        ...(payload.clientMutationId !== undefined
          ? { clientMutationId: payload.clientMutationId }
          : {}),
      });
    },
    onSuccess: (result) => {
      qc.setQueryData(
        sourceControlContextQueryKeys.issueDetail(
          input.environmentId,
          input.cwd,
          input.reference,
          true,
        ),
        result.detail,
      );
      qc.invalidateQueries({
        queryKey: sourceControlContextQueryKeys.all,
      });
    },
  });
}

export function useAddIssueCommentReactionMutation(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string;
}) {
  const qc = useQueryClient();
  const detailKey = sourceControlContextQueryKeys.issueDetail(
    input.environmentId,
    input.cwd,
    input.reference,
    true,
  );
  return useMutation({
    mutationFn: async (
      payload: Pick<SourceControlAddCommentReactionInput, "commentId" | "content">,
    ) => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("Comment reactions are unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.addIssueCommentReaction({
        cwd: input.cwd,
        reference: input.reference,
        commentId: payload.commentId,
        content: payload.content,
      });
    },
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: detailKey });
      const previous = qc.getQueryData<SourceControlIssueDetail>(detailKey);
      qc.setQueryData<SourceControlIssueDetail>(detailKey, (current) =>
        toggleCommentReactionInDetail(current, payload),
      );
      return { previous };
    },
    onError: (_error, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(detailKey, context.previous);
      }
    },
    onSuccess: (result) => {
      qc.setQueryData(detailKey, result.detail);
      qc.invalidateQueries({
        queryKey: sourceControlContextQueryKeys.all,
      });
    },
  });
}

export function useAddChangeRequestCommentMutation(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      payload: Pick<SourceControlAddChangeRequestCommentInput, "body" | "clientMutationId">,
    ) => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("Pull request comments are unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.addChangeRequestComment({
        cwd: input.cwd,
        reference: input.reference,
        body: payload.body,
        ...(payload.clientMutationId !== undefined
          ? { clientMutationId: payload.clientMutationId }
          : {}),
      });
    },
    onSuccess: (result) => {
      qc.setQueryData(
        sourceControlContextQueryKeys.changeRequestDetail(
          input.environmentId,
          input.cwd,
          input.reference,
          true,
        ),
        result.detail,
      );
      qc.invalidateQueries({
        queryKey: sourceControlContextQueryKeys.all,
      });
    },
  });
}

export function useAddChangeRequestCommentReactionMutation(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string;
}) {
  const qc = useQueryClient();
  const detailKey = sourceControlContextQueryKeys.changeRequestDetail(
    input.environmentId,
    input.cwd,
    input.reference,
    true,
  );
  return useMutation({
    mutationFn: async (
      payload: Pick<SourceControlAddCommentReactionInput, "commentId" | "content">,
    ) => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("Comment reactions are unavailable.");
      }
      const client = requireEnvironmentConnection(input.environmentId).client;
      return client.sourceControl.addChangeRequestCommentReaction({
        cwd: input.cwd,
        reference: input.reference,
        commentId: payload.commentId,
        content: payload.content,
      });
    },
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: detailKey });
      const previous = qc.getQueryData<SourceControlChangeRequestDetail>(detailKey);
      qc.setQueryData<SourceControlChangeRequestDetail>(detailKey, (current) =>
        toggleCommentReactionInDetail(current, payload),
      );
      return { previous };
    },
    onError: (_error, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(detailKey, context.previous);
      }
    },
    onSuccess: (result) => {
      qc.setQueryData(detailKey, result.detail);
      qc.invalidateQueries({
        queryKey: sourceControlContextQueryKeys.all,
      });
    },
  });
}
