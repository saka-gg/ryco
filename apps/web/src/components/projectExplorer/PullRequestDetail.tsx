import type {
  EnvironmentId,
  SourceControlCommentReactionContent,
  SourceControlChangeRequestCommit,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Clock3Icon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitCommitIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  SendIcon,
} from "lucide-react";
import {
  useAddChangeRequestCommentMutation,
  useAddChangeRequestCommentReactionMutation,
  useMergeChangeRequestMutation,
  useSourceControlChangeRequestDetail,
  useSourceControlWorkflowRuns,
} from "~/rpc/useSourceControl";
import { errorMessage } from "~/lib/errorMessage";
import { cn } from "~/lib/utils";
import { useSettings } from "~/hooks/useSettings";
import { resolveSourceControlRefreshDelay } from "~/rpc/sourceControlRefreshPolicy";
import { ContextPickerTabs } from "../chat/ContextPickerTabs";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { CommentComposer, CommentItem, type CommentQuoteInsertion } from "./CommentThread";
import { buildCommentQuoteMarkdown, deriveOriginalPostAuthorRole } from "./CommentThread.logic";
import { PrCheckStatusBadge } from "./PrCheckStatusBadge";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import {
  SourceControlDetailErrorState,
  SourceControlDetailLayout,
  SourceControlDetailLoadingState,
  SourceControlDetailToolbar,
} from "./SourceControlDetailLayout";
import {
  SourceControlTimeline,
  SourceControlTimelineEntry,
  SourceControlTimelineNotice,
} from "./SourceControlTimeline";
import { changeRequestStateKind, StateBadge } from "./StateBadge";
import {
  getPrCheckStatusForQuery,
  getPrCheckStatusFromChangeRequest,
  getPrCheckStatusFromWorkflowRuns,
  shouldRefreshPrCheckStatus,
} from "./prCheckStatus";
import { PullRequestFilesTab } from "./PullRequestFilesTab";
import { usePrCheckPassNotifications } from "./usePrCheckPassNotifications";
import {
  assessPullRequestStack,
  pullRequestMergeBlocker,
  pullRequestMergeConfirmation,
  pullRequestMergeSuccessMessage,
} from "./pullRequestStack.logic";
import { WorktreeItemSidebar } from "./WorktreeItemSidebar";
import { WorkflowRunsSection } from "./WorkflowRunsSection";

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const compactDateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const numberFmt = new Intl.NumberFormat(undefined);
const MAX_TIMELINE_COMMIT_ROWS = 12;

type PullRequestTab = "conversation" | "checks" | "commits" | "files";

interface PullRequestDetailProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  pullRequestNumber: number;
  onBack: () => void;
  onSelectLinkedIssue: (issueNumber: number) => void;
  onSelectLinkedWorkItem?: ((workItemKey: string) => void) | undefined;
  onSelectPullRequest?: ((number: number) => void) | undefined;
  onAttach?: ((mode: "local" | "worktree") => Promise<void> | void) | undefined;
  attachInProgress?: "local" | "worktree" | null;
}

export function PullRequestDetail(props: PullRequestDetailProps) {
  const reference = String(props.pullRequestNumber);
  const sourceControlRefreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const resolveDetailIntervalMs = useCallback(
    (data: SourceControlChangeRequestDetail | null): number | false =>
      resolveSourceControlRefreshDelay({
        mode: sourceControlRefreshMode,
        phase: data?.state === "open" ? "active" : "settled",
      }),
    [sourceControlRefreshMode],
  );
  const detailQuery = useSourceControlChangeRequestDetail(
    {
      environmentId: props.environmentId,
      cwd: props.cwd,
      reference,
      fullContent: true,
    },
    resolveDetailIntervalMs,
  );
  const addCommentMutation = useAddChangeRequestCommentMutation({
    environmentId: props.environmentId,
    cwd: props.cwd,
    reference,
  });
  const addReactionMutation = useAddChangeRequestCommentReactionMutation({
    environmentId: props.environmentId,
    cwd: props.cwd,
    reference,
  });
  const mergeMutation = useMergeChangeRequestMutation({
    environmentId: props.environmentId,
    cwd: props.cwd,
    reference,
  });

  const detail = detailQuery.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SourceControlDetailToolbar onBack={props.onBack} githubUrl={detail?.url} />

      <div className="min-h-0 flex-1 overflow-hidden">
        {detailQuery.isLoading ? (
          <SourceControlDetailLoadingState label="pull request" />
        ) : detailQuery.error ? (
          <SourceControlDetailErrorState
            message={errorMessage(detailQuery.error, "Failed to load pull request.")}
          />
        ) : detail ? (
          <PullRequestDetailBody
            detail={detail}
            environmentId={props.environmentId}
            cwd={props.cwd}
            onSelectLinkedIssue={props.onSelectLinkedIssue}
            onSelectLinkedWorkItem={props.onSelectLinkedWorkItem}
            onSelectPullRequest={props.onSelectPullRequest}
            mergePending={mergeMutation.isPending}
            onMerge={(mergeMethod) => mergeMutation.mutateAsync({ mergeMethod })}
            onSubmitComment={
              detail.provider === "github" && props.environmentId !== null && props.cwd !== null
                ? (input) => addCommentMutation.mutateAsync(input).then(() => undefined)
                : undefined
            }
            onAddCommentReaction={
              detail.provider === "github" && props.environmentId !== null && props.cwd !== null
                ? (input) => addReactionMutation.mutateAsync(input).then(() => undefined)
                : undefined
            }
          />
        ) : null}
      </div>

      {props.onAttach ? (
        <footer className="flex items-center justify-end gap-2 border-border/60 border-t bg-muted/30 px-4 py-3">
          <span className="mr-auto text-muted-foreground text-xs">
            Check out this pull request in a chat thread
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!detail || props.attachInProgress !== null}
            onClick={() => props.onAttach?.("local")}
          >
            {props.attachInProgress === "local" ? "Preparing local…" : "Attach (Local)"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!detail || props.attachInProgress !== null}
            onClick={() => props.onAttach?.("worktree")}
          >
            {props.attachInProgress === "worktree" ? "Preparing worktree…" : "Attach (Worktree)"}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}

function PullRequestDetailBody(props: {
  detail: SourceControlChangeRequestDetail;
  environmentId: EnvironmentId | null;
  cwd: string | null;
  onSelectLinkedIssue: (issueNumber: number) => void;
  onSelectLinkedWorkItem?: ((workItemKey: string) => void) | undefined;
  onSelectPullRequest?: ((number: number) => void) | undefined;
  mergePending: boolean;
  onMerge: (
    mergeMethod: SourceControlChangeRequestMergeMethod,
  ) => Promise<{ readonly outcome: "merged" | "enqueued" }>;
  onSubmitComment?:
    | ((input: { readonly body: string; readonly clientMutationId: string }) => Promise<void>)
    | undefined;
  onAddCommentReaction?:
    | ((input: {
        readonly commentId: string;
        readonly content: SourceControlCommentReactionContent;
      }) => Promise<void>)
    | undefined;
}) {
  const { detail, onMerge } = props;
  const [activeTab, setActiveTab] = useState<PullRequestTab>("conversation");
  const [quoteInsertion, setQuoteInsertion] = useState<CommentQuoteInsertion | null>(null);
  const nextQuoteInsertionIdRef = useRef(0);
  const queueQuoteInsertion = useCallback(
    (input: Parameters<typeof buildCommentQuoteMarkdown>[0]) => {
      nextQuoteInsertionIdRef.current += 1;
      setQuoteInsertion({
        id: nextQuoteInsertionIdRef.current,
        markdown: buildCommentQuoteMarkdown(input),
      });
    },
    [],
  );
  const handleQuoteInsertionHandled = useCallback((id: number) => {
    setQuoteInsertion((current) => (current?.id === id ? null : current));
  }, []);

  const opCreatedAt =
    detail.updatedAt && Option.isSome(detail.updatedAt)
      ? detail.updatedAt.value
      : DateTime.fromDateUnsafe(new Date());
  const opAuthorRole = deriveOriginalPostAuthorRole(detail);

  const conversationCount = detail.comments.length + 1;
  const commitCount = detail.commits?.length ?? 0;
  const fileCount = detail.changedFiles ?? detail.files?.length ?? 0;
  const additions = detail.additions ?? 0;
  const deletions = detail.deletions ?? 0;
  const updatedLabel =
    detail.updatedAt && Option.isSome(detail.updatedAt)
      ? dateFmt.format(DateTime.toDate(detail.updatedAt.value))
      : null;
  const reviewersCount = detail.reviewers?.length ?? 0;
  const checkStatus = getPrCheckStatusFromChangeRequest(detail);
  const onSubmitComment = props.onSubmitComment;
  const canComment = onSubmitComment !== undefined;
  const onAddCommentReaction = props.onAddCommentReaction;
  const [mergeConfirmationOpen, setMergeConfirmationOpen] = useState(false);
  const availableMergeMethods = useMemo(
    () =>
      (["merge", "squash", "rebase"] as const).filter(
        (method) => detail.mergeCapabilities?.[method] === true,
      ),
    [detail.mergeCapabilities],
  );
  const [mergeMethod, setMergeMethod] = useState<SourceControlChangeRequestMergeMethod>("merge");
  const selectedMergeMethod = availableMergeMethods.includes(mergeMethod)
    ? mergeMethod
    : (availableMergeMethods[0] ?? mergeMethod);
  const githubStack = detail.provider === "github" ? detail.stack : undefined;
  const stackAssessment = githubStack ? assessPullRequestStack(githubStack) : null;
  const mergeBlocker = pullRequestMergeBlocker(detail, stackAssessment);
  const showMergeControls =
    detail.provider === "github" && detail.state === "open" && availableMergeMethods.length > 0;
  const mergeConfirmation = pullRequestMergeConfirmation({
    selectedNumber: detail.number,
    mergeMethod: selectedMergeMethod,
    stack: githubStack ?? null,
  });
  const confirmMerge = useCallback(async () => {
    if (mergeBlocker !== null || availableMergeMethods.length === 0) return;
    try {
      const result = await onMerge(selectedMergeMethod);
      const message = pullRequestMergeSuccessMessage({
        outcome: result.outcome,
        isStack: githubStack !== undefined,
      });
      toastManager.add({ type: "success", ...message });
      setMergeConfirmationOpen(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: githubStack ? "Could not merge stack" : "Could not merge pull request",
        description: errorMessage(error, "GitHub rejected the merge request."),
      });
    }
  }, [availableMergeMethods.length, githubStack, mergeBlocker, onMerge, selectedMergeMethod]);

  usePrCheckPassNotifications([
    {
      environmentId: props.environmentId,
      cwd: props.cwd,
      provider: detail.provider,
      number: detail.number,
      title: detail.title,
      url: detail.url,
      status: checkStatus,
    },
  ]);

  return (
    <SourceControlDetailLayout
      sidebar={
        <WorktreeItemSidebar
          assignees={detail.assignees}
          labels={detail.labels}
          reviewers={detail.reviewers ?? []}
          linkedIssueNumbers={detail.linkedIssueNumbers ?? []}
          linkedWorkItemKeys={detail.linkedWorkItemKeys ?? []}
          onSelectLinkedIssue={props.onSelectLinkedIssue}
          onSelectLinkedWorkItem={props.onSelectLinkedWorkItem}
        />
      }
    >
      <div className="flex min-h-0 flex-col lg:h-full">
        {detail.provider === "github" && detail.stackMetadataIncomplete === true ? (
          <div
            role="status"
            className="border-amber-500/30 border-b bg-amber-500/8 px-5 py-2 text-amber-700 text-xs dark:text-amber-300 lg:px-6"
          >
            Stack details could not be loaded. Refresh before attempting to merge this pull request.
          </div>
        ) : null}
        <header className="border-border/60 border-b bg-background/50 px-5 py-4 lg:px-6">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-balance font-heading font-semibold text-xl leading-tight lg:text-2xl">
                {detail.title}{" "}
                <span className="font-normal text-muted-foreground">#{detail.number}</span>
              </h2>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                {detail.author ? <span>Opened by {detail.author}</span> : <span>Opened</span>}
                {updatedLabel ? <span>Updated {updatedLabel}</span> : null}
                <span className="inline-flex min-w-0 items-center gap-1">
                  <GitBranchIcon className="size-3 shrink-0" />
                  <span className="truncate font-mono">
                    {detail.headRefName} → {detail.baseRefName}
                  </span>
                </span>
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {githubStack ? (
                <PullRequestStackPopover
                  stack={githubStack}
                  currentNumber={detail.number}
                  onSelectPullRequest={props.onSelectPullRequest}
                />
              ) : null}
              <DiffStatsBadge additions={additions} deletions={deletions} />
              <PrCheckStatusBadge
                view={checkStatus}
                mode="compact"
                onClick={() => setActiveTab("checks")}
                title={
                  checkStatus.kind === "failed"
                    ? "Open failed check details"
                    : "Open pull request checks"
                }
              />
              <StateBadge kind={changeRequestStateKind(detail.state, detail.isDraft)} />
              {showMergeControls ? (
                <div className="flex items-center">
                  <Select
                    value={selectedMergeMethod}
                    onValueChange={(value) => {
                      if (value === "merge" || value === "squash" || value === "rebase") {
                        setMergeMethod(value);
                      }
                    }}
                    disabled={props.mergePending}
                  >
                    <SelectTrigger size="sm" className="rounded-r-none" aria-label="Merge method">
                      <SelectValue>{mergeMethodLabel(selectedMergeMethod)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {availableMergeMethods.map((method) => (
                        <SelectItem key={method} value={method}>
                          {mergeMethodLabel(method)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    className="rounded-l-none border-l-0"
                    disabled={mergeBlocker !== null || props.mergePending}
                    title={mergeBlocker ?? undefined}
                    onClick={() => setMergeConfirmationOpen(true)}
                  >
                    {props.mergePending ? <Spinner className="size-3.5" /> : null}
                    {githubStack ? "Merge stack" : "Merge"}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <ContextPickerTabs
          tabs={[
            { id: "conversation", label: "Conversation", count: conversationCount },
            { id: "checks", label: "Checks" },
            { id: "commits", label: "Commits", count: commitCount },
            { id: "files", label: "Files changed", count: fileCount },
          ]}
          activeId={activeTab}
          onSelect={(id) => setActiveTab(id as PullRequestTab)}
        />

        <div
          className={cn(
            "min-h-0 bg-muted/8 lg:flex-1",
            activeTab === "checks"
              ? "overflow-hidden"
              : "overflow-visible px-4 py-5 sm:px-5 lg:overflow-y-auto lg:px-6",
          )}
        >
          {activeTab === "conversation" ? (
            <div className="mx-auto w-full max-w-[980px]">
              <SourceControlTimeline>
                <SourceControlTimelineEntry tone="body" icon={<FileTextIcon className="size-4" />}>
                  <CommentItem
                    author={opAuthorRole.author}
                    body={detail.body}
                    createdAt={opCreatedAt}
                    authorRole={opAuthorRole.role}
                    isOriginalPost
                    itemKind="body"
                    onQuote={
                      canComment
                        ? () =>
                            queueQuoteInsertion({
                              author: opAuthorRole.author,
                              body: detail.body,
                              createdAt: opCreatedAt,
                              contextLabel: "pull request description",
                            })
                        : undefined
                    }
                  />
                </SourceControlTimelineEntry>
                <SourceControlTimelineEntry
                  tone="workflow"
                  icon={<GitBranchIcon className="size-4" />}
                >
                  <SourceControlTimelineNotice
                    tone="workflow"
                    title="Workflow overview"
                    description={`${commitCount} commits · ${fileCount} files changed`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StateBadge kind={changeRequestStateKind(detail.state, detail.isDraft)} />
                      <DiffStatsBadge additions={additions} deletions={deletions} />
                      <PrCheckStatusBadge
                        view={checkStatus}
                        mode="compact"
                        onClick={() => setActiveTab("checks")}
                        title="Open pull request checks"
                      />
                      <span className="rounded-md border border-border/60 bg-background/70 px-2 py-0.5 text-muted-foreground text-xs">
                        {reviewersCount === 1 ? "1 reviewer" : `${reviewersCount} reviewers`}
                      </span>
                    </div>
                  </SourceControlTimelineNotice>
                </SourceControlTimelineEntry>
                {detail.commits && detail.commits.length > 0 ? (
                  <SourceControlTimelineEntry
                    tone="commit"
                    icon={<GitCommitIcon className="size-4" />}
                  >
                    <PullRequestTimelineCommits
                      commits={detail.commits}
                      provider={detail.provider}
                      environmentId={props.environmentId}
                      cwd={props.cwd}
                      pullRequestUrl={detail.url}
                      onOpenCommits={() => setActiveTab("commits")}
                    />
                  </SourceControlTimelineEntry>
                ) : null}
                {detail.comments.map((comment) => {
                  const commentId = comment.id;
                  return (
                    <SourceControlTimelineEntry
                      key={`${comment.author}-${comment.createdAt}-${comment.body}`}
                      tone={comment.reviewState ? "review" : "comment"}
                      icon={<MessageSquareIcon className="size-4" />}
                    >
                      <CommentItem
                        author={comment.author}
                        body={comment.body}
                        createdAt={comment.createdAt}
                        authorAssociation={comment.authorAssociation}
                        authorRole={comment.authorRole}
                        reviewState={comment.reviewState}
                        reactions={comment.reactions}
                        itemKind={comment.reviewState ? "review" : "comment"}
                        eyebrow={comment.reviewState ? "Review comment" : "Comment"}
                        onAddReaction={
                          onAddCommentReaction && commentId
                            ? (content) => onAddCommentReaction({ commentId, content })
                            : undefined
                        }
                        onQuote={
                          canComment
                            ? () =>
                                queueQuoteInsertion({
                                  author: comment.author,
                                  body: comment.body,
                                  createdAt: comment.createdAt,
                                  contextLabel: "PR conversation",
                                })
                            : undefined
                        }
                      />
                    </SourceControlTimelineEntry>
                  );
                })}
                {onSubmitComment ? (
                  <SourceControlTimelineEntry
                    tone="composer"
                    icon={<SendIcon className="size-4" />}
                  >
                    <CommentComposer
                      placeholder="Write a conversation comment"
                      submitLabel="Comment"
                      onSubmit={onSubmitComment}
                      quoteInsertion={quoteInsertion}
                      onQuoteInsertionHandled={handleQuoteInsertionHandled}
                      className="border-emerald-500/25 bg-emerald-500/5"
                    />
                  </SourceControlTimelineEntry>
                ) : null}
              </SourceControlTimeline>
            </div>
          ) : activeTab === "checks" ? (
            <WorkflowRunsSection
              environmentId={props.environmentId}
              cwd={props.cwd}
              pullRequestNumber={detail.number}
              title="Checks"
              description="GitHub Actions workflow runs for this pull request head commit."
            />
          ) : activeTab === "commits" ? (
            <div className="mx-auto w-full max-w-[1100px]">
              <CommitsTab commits={detail.commits ?? []} pullRequestUrl={detail.url} />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[1180px]">
              <PullRequestFilesTab
                key={`${props.environmentId}:${props.cwd}:${detail.number}`}
                files={detail.files ?? []}
                headSha={detail.headSha ?? null}
                environmentId={props.environmentId}
                cwd={props.cwd}
                reference={String(detail.number)}
                active={activeTab === "files"}
              />
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={mergeConfirmationOpen}
        onOpenChange={(open) => {
          if (!props.mergePending) setMergeConfirmationOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{mergeConfirmation.title}</AlertDialogTitle>
            <AlertDialogDescription>{mergeConfirmation.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={props.mergePending}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={
                props.mergePending || mergeBlocker !== null || availableMergeMethods.length === 0
              }
              onClick={() => void confirmMerge()}
            >
              {props.mergePending ? <Spinner className="size-4" /> : null}
              {githubStack ? "Merge stack" : "Merge pull request"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SourceControlDetailLayout>
  );
}

function mergeMethodLabel(method: SourceControlChangeRequestMergeMethod): string {
  switch (method) {
    case "merge":
      return "Merge commit";
    case "squash":
      return "Squash and merge";
    case "rebase":
      return "Rebase and merge";
  }
}

function DiffStatsBadge({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      className="mt-1 inline-flex shrink-0 items-baseline gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-[11px] tabular-nums"
      aria-label={`Diff: ${additions} additions, ${deletions} deletions`}
    >
      <span className="text-emerald-600 dark:text-emerald-400">+{numberFmt.format(additions)}</span>
      <span className="text-rose-600 dark:text-rose-400">−{numberFmt.format(deletions)}</span>
    </span>
  );
}

function formatCommitDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return compactDateTimeFmt.format(date);
}

function PullRequestTimelineCommits(props: {
  commits: ReadonlyArray<SourceControlChangeRequestCommit>;
  provider: SourceControlChangeRequestDetail["provider"];
  environmentId: EnvironmentId | null;
  cwd: string | null;
  pullRequestUrl: string;
  onOpenCommits: () => void;
}) {
  const commits =
    props.commits.length > MAX_TIMELINE_COMMIT_ROWS
      ? props.commits.slice(-MAX_TIMELINE_COMMIT_ROWS)
      : props.commits;
  const hiddenCount = props.commits.length - commits.length;
  const commitLabel = props.commits.length === 1 ? "1 commit" : `${props.commits.length} commits`;

  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-background/55 text-sm">
      <header className="flex flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-foreground/90 text-sm">Commits</h3>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {hiddenCount > 0
              ? `Latest ${commits.length} of ${commitLabel}`
              : `${commitLabel} in this pull request`}
          </p>
        </div>
        {hiddenCount > 0 ? (
          <Button type="button" size="sm" variant="ghost" onClick={props.onOpenCommits}>
            View all
          </Button>
        ) : null}
      </header>
      <ol className="divide-y divide-border/50">
        {commits.map((commit) => (
          <PullRequestTimelineCommitRow
            key={commit.oid}
            commit={commit}
            provider={props.provider}
            environmentId={props.environmentId}
            cwd={props.cwd}
            pullRequestUrl={props.pullRequestUrl}
          />
        ))}
      </ol>
    </section>
  );
}

function PullRequestTimelineCommitRow(props: {
  commit: SourceControlChangeRequestCommit;
  provider: SourceControlChangeRequestDetail["provider"];
  environmentId: EnvironmentId | null;
  cwd: string | null;
  pullRequestUrl: string;
}) {
  const sourceControlRefreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const runsQuery = useSourceControlWorkflowRuns(
    {
      environmentId: props.environmentId,
      cwd: props.cwd,
      commitSha: props.commit.oid,
      limit: 20,
      enabled: props.provider === "github",
    },
    (data) => {
      const status = data
        ? getPrCheckStatusFromWorkflowRuns({
            runs: data.runs,
            headSha: props.commit.oid,
          })
        : null;
      return resolveSourceControlRefreshDelay({
        mode: sourceControlRefreshMode,
        phase: status && shouldRefreshPrCheckStatus(status) ? "active" : "settled",
      });
    },
  );
  const status = getPrCheckStatusForQuery({
    isLoading: runsQuery.isLoading,
    error: runsQuery.error,
    status: runsQuery.data
      ? getPrCheckStatusFromWorkflowRuns({
          runs: runsQuery.data.runs,
          headSha: props.commit.oid,
        })
      : null,
  });
  const runCount = runsQuery.data?.runs.length ?? null;
  const committedAt = formatCommitDate(props.commit.committedDate);

  return (
    <li className="flex min-w-0 items-start gap-3 bg-muted/10 px-3 py-2.5 text-xs">
      <code className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {props.commit.shortOid}
      </code>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
            {props.commit.messageHeadline || "No commit message"}
          </span>
          <PrCheckStatusBadge view={status} mode="compact" />
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-[11px]">
          {props.commit.author ? <span>{props.commit.author}</span> : null}
          {committedAt ? (
            <span className="inline-flex items-center gap-1">
              <Clock3Icon className="size-3" />
              {committedAt}
            </span>
          ) : null}
          {runCount !== null ? <span>{runCount === 1 ? "1 run" : `${runCount} runs`}</span> : null}
        </div>
      </div>
      <a
        href={`${props.pullRequestUrl}/changes/${props.commit.oid}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
        aria-label={`Open commit ${props.commit.shortOid}`}
        title={`Open commit ${props.commit.shortOid}`}
      >
        <ExternalLinkIcon className="size-3.5" />
      </a>
    </li>
  );
}

function CommitsTab({
  commits,
  pullRequestUrl,
}: {
  commits: ReadonlyArray<SourceControlChangeRequestCommit>;
  pullRequestUrl: string;
}) {
  if (commits.length === 0) {
    return <EmptyTabState message="No commits to show." />;
  }
  return (
    <ol className="overflow-hidden rounded-lg border border-border/60 divide-y divide-border/60">
      {commits.map((commit) => (
        <li key={commit.oid} className="flex items-center gap-3 bg-muted/12 px-3 py-2 text-xs">
          <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {commit.shortOid}
          </code>
          <span className="min-w-0 flex-1 truncate text-foreground/90">
            {commit.messageHeadline}
          </span>
          {commit.author ? (
            <span className="shrink-0 text-muted-foreground">{commit.author}</span>
          ) : null}
          <a
            href={`${pullRequestUrl}/changes/${commit.oid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
            aria-label={`Open commit ${commit.shortOid} on GitHub`}
            title={`Open commit ${commit.shortOid} on GitHub`}
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </li>
      ))}
    </ol>
  );
}

function EmptyTabState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground/70 text-sm">
      <MessagesSquareIcon className="size-6 opacity-40" />
      {message}
    </div>
  );
}
