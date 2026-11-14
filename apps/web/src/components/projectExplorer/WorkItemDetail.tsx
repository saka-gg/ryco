import type {
  ChangeRequest,
  EnvironmentId,
  ProjectId,
  VcsRef,
  WorkItemComment,
  WorkItemDetail as WorkItemDetailModel,
  WorkItemEditableFieldId,
  WorkItemEditableFieldMetadata,
  WorkItemEditableFieldOption,
  WorkItemPriority,
  WorkItemUpdateFields,
} from "@ryco/contracts";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { DateTime, Option } from "effect";
import { useQuery } from "~/rpc/queryClient";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HistoryIcon,
  MessageSquareIcon,
  MinusIcon,
  PencilIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { readEnvironmentApi } from "~/environmentApi";
import { cn } from "~/lib/utils";
import {
  findLinkedWorkItemBranches,
  findLinkedWorkItemWorktrees,
  type LinkedWorkItemWorktree,
} from "~/lib/workItemLocalLinks";
import { searchChangeRequestsQueryOptions } from "~/lib/sourceControlContextRpc";
import { errorMessage } from "~/lib/errorMessage";
import {
  useAddWorkItemCommentMutation,
  useEditWorkItemCommentMutation,
  useImproveWorkItemDescriptionMutation,
  useTransitionWorkItemMutation,
  useUpdateWorkItemMutation,
  useWorkItemDetail,
} from "~/rpc/useWorkItems";
import { selectSidebarWorktreesForProjectRef, useStore } from "~/store";
import { AtlassianJiraIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { CommentComposer, CommentItem, type CommentQuoteInsertion } from "./CommentThread";
import { buildCommentQuoteMarkdown } from "./CommentThread.logic";
import { LabelChip } from "./LabelChip";
import { PrCheckStatusBadge } from "./PrCheckStatusBadge";
import { getPrCheckStatusFromChangeRequest } from "./prCheckStatus";
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
import { changeRequestStateKind, StateBadge, type StateBadgeKind } from "./StateBadge";
import {
  filterWorkItemActivityEntries,
  isWorkItemTransitionActivity,
  workItemActivityCounts,
  type WorkItemActivityFilter,
  type WorkItemActivityCounts,
} from "./WorkItemDetail.logic";

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const NONE_VALUE = "__none__";

interface WorkItemDetailProps {
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  cwd: string | null;
  workItemKey: string;
  onBack: () => void;
  onSelectLinkedChangeRequest?: ((number: number) => void) | undefined;
}

export function WorkItemDetail(props: WorkItemDetailProps) {
  const [editingComment, setEditingComment] = useState<WorkItemComment | null>(null);
  const [quoteInsertion, setQuoteInsertion] = useState<CommentQuoteInsertion | null>(null);
  const [descriptionDialogOpen, setDescriptionDialogOpen] = useState(false);

  const detailQuery = useWorkItemDetail({
    environmentId: props.environmentId,
    projectId: props.projectId,
    key: props.workItemKey,
    fullContent: true,
  });
  const mutationScope = {
    environmentId: props.environmentId,
    projectId: props.projectId,
    key: props.workItemKey,
  };
  const linkedPrQuery = useQuery(
    searchChangeRequestsQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      query: props.workItemKey,
      limit: 8,
      enabled: props.cwd !== null,
    }),
  );
  const localBranchQuery = useQuery({
    queryKey: [
      "workItems",
      "localBranches",
      props.environmentId,
      props.cwd ?? null,
      props.workItemKey,
    ] as const,
    environmentId: props.environmentId,
    queryFn: async () => {
      const api = props.environmentId ? readEnvironmentApi(props.environmentId) : null;
      if (!api || !props.cwd) return [];
      const result = await api.vcs.listRefs({
        cwd: props.cwd,
        query: props.workItemKey,
        limit: 100,
      });
      return result.refs;
    },
    enabled: props.environmentId !== null && props.cwd !== null,
    staleTime: 30_000,
  });
  const projectWorktrees = useStore(
    useShallow((state) =>
      props.environmentId && props.projectId
        ? selectSidebarWorktreesForProjectRef(
            state,
            scopeProjectRef(props.environmentId, props.projectId),
          )
        : [],
    ),
  );

  const updateMutation = useUpdateWorkItemMutation(mutationScope, {
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update Jira work item",
          description: errorMessage(error, "The Jira update was not saved."),
        }),
      );
    },
  });
  const addCommentMutation = useAddWorkItemCommentMutation(mutationScope, {
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add Jira comment",
          description: errorMessage(error, "The comment was not posted."),
        }),
      );
    },
  });
  const editCommentMutation = useEditWorkItemCommentMutation(mutationScope, {
    onEditCommentSuccess: () => setEditingComment(null),
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not edit Jira comment",
          description: errorMessage(error, "The comment edit was not saved."),
        }),
      );
    },
  });
  const transitionMutation = useTransitionWorkItemMutation(mutationScope, {
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not transition Jira work item",
          description: errorMessage(error, "The work item transition was not applied."),
        }),
      );
    },
  });
  const improveDescriptionMutation = useImproveWorkItemDescriptionMutation({
    environmentId: props.environmentId,
    cwd: props.cwd,
    currentTitle: detailQuery.data?.title,
  });

  const detail = detailQuery.data;
  const linkedChangeRequests = useMemo(
    () =>
      mergeLinkedChangeRequests(
        detail?.linkedChangeRequests ?? [],
        linkedPrQuery.data ?? [],
        props.workItemKey,
      ),
    [detail?.linkedChangeRequests, linkedPrQuery.data, props.workItemKey],
  );
  const linkedBranches = useMemo(
    () =>
      findLinkedWorkItemBranches({
        key: props.workItemKey,
        refs: localBranchQuery.data ?? [],
      }),
    [localBranchQuery.data, props.workItemKey],
  );
  const linkedWorktrees = useMemo(
    () =>
      findLinkedWorkItemWorktrees({
        key: props.workItemKey,
        worktrees: projectWorktrees,
      }),
    [projectWorktrees, props.workItemKey],
  );

  const queueQuoteInsertion = (comment: {
    readonly author: string;
    readonly body: string;
    readonly createdAt: DateTime.Utc;
    readonly contextLabel: string;
  }) => {
    setQuoteInsertion({
      id: Date.now(),
      markdown: buildCommentQuoteMarkdown(comment),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SourceControlDetailToolbar
        onBack={props.onBack}
        githubUrl={detail?.url}
        githubLabel="Open in Jira"
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {detailQuery.isLoading ? (
          <SourceControlDetailLoadingState label="Jira work item" />
        ) : detailQuery.isError ? (
          <SourceControlDetailErrorState
            message={errorMessage(detailQuery.error, "Failed to load Jira work item.")}
          />
        ) : detail ? (
          <SourceControlDetailLayout
            sidebar={
              <WorkItemSidebar
                detail={detail}
                linkedChangeRequests={linkedChangeRequests}
                linkedChangeRequestsLoading={linkedPrQuery.isLoading}
                linkedBranches={linkedBranches}
                linkedBranchesLoading={localBranchQuery.isLoading}
                linkedWorktrees={linkedWorktrees}
                mutationPending={updateMutation.isPending}
                onUpdate={(fields) => updateMutation.mutate(fields)}
                onSelectLinkedChangeRequest={props.onSelectLinkedChangeRequest}
              />
            }
          >
            <WorkItemConversation
              detail={detail}
              canImproveDescription={
                props.cwd !== null && editableField(detail, "description") !== null
              }
              addCommentPending={addCommentMutation.isPending}
              transitionPending={transitionMutation.isPending}
              onAddComment={(body) => addCommentMutation.mutateAsync(body)}
              onEditComment={(comment) => setEditingComment(comment)}
              onImproveDescription={() => setDescriptionDialogOpen(true)}
              onQuote={queueQuoteInsertion}
              onTransition={(transitionId) => transitionMutation.mutate(transitionId)}
              quoteInsertion={quoteInsertion}
              onQuoteInsertionHandled={(id) => {
                if (quoteInsertion?.id === id) setQuoteInsertion(null);
              }}
            />
          </SourceControlDetailLayout>
        ) : null}
      </div>

      {editingComment ? (
        <EditCommentDialog
          comment={editingComment}
          pending={editCommentMutation.isPending}
          onOpenChange={(open) => {
            if (!open && !editCommentMutation.isPending) setEditingComment(null);
          }}
          onSave={(body) => {
            if (!editingComment.id) return;
            editCommentMutation.mutate({ commentId: editingComment.id, body });
          }}
        />
      ) : null}

      {detail ? (
        <ImproveDescriptionDialog
          open={descriptionDialogOpen}
          detail={detail}
          generatePending={improveDescriptionMutation.isPending}
          savePending={updateMutation.isPending}
          generateError={improveDescriptionMutation.error}
          onOpenChange={setDescriptionDialogOpen}
          onGenerate={(input) => improveDescriptionMutation.mutateAsync(input)}
          onSave={(description) => {
            updateMutation.mutate(
              { description },
              {
                onSuccess: () => setDescriptionDialogOpen(false),
              },
            );
          }}
        />
      ) : null}
    </div>
  );
}

type WorkItemLinkedChangeRequest = Pick<
  ChangeRequest,
  "checkRollup" | "headSha" | "isDraft" | "number" | "provider" | "state" | "title" | "url"
>;

function mergeLinkedChangeRequests(
  contractLinks: WorkItemDetailModel["linkedChangeRequests"],
  searchedLinks: ReadonlyArray<ChangeRequest>,
  workItemKey: string,
): ReadonlyArray<WorkItemLinkedChangeRequest> {
  const key = workItemKey.toLowerCase();
  const merged = new Map<number, WorkItemLinkedChangeRequest>();
  for (const link of contractLinks) {
    merged.set(link.number, {
      provider: link.provider,
      number: link.number,
      title: link.title,
      url: link.url,
      state: link.state,
    });
  }
  for (const link of searchedLinks) {
    const haystack = `${link.title} ${link.headRefName} ${link.baseRefName}`.toLowerCase();
    if (!haystack.includes(key) && contractLinks.length > 0) continue;
    merged.set(link.number, {
      provider: link.provider,
      number: link.number,
      title: link.title,
      url: link.url,
      state: link.state,
      ...(typeof link.isDraft === "boolean" ? { isDraft: link.isDraft } : {}),
      ...(link.headSha ? { headSha: link.headSha } : {}),
      ...(link.checkRollup ? { checkRollup: link.checkRollup } : {}),
    });
  }
  return Array.from(merged.values()).toSorted((a, b) => b.number - a.number);
}

function WorkItemConversation(props: {
  readonly detail: WorkItemDetailModel;
  readonly canImproveDescription: boolean;
  readonly addCommentPending: boolean;
  readonly transitionPending: boolean;
  readonly quoteInsertion: CommentQuoteInsertion | null;
  readonly onAddComment: (body: string) => Promise<unknown>;
  readonly onEditComment: (comment: WorkItemComment) => void;
  readonly onImproveDescription: () => void;
  readonly onQuote: (comment: {
    readonly author: string;
    readonly body: string;
    readonly createdAt: DateTime.Utc;
    readonly contextLabel: string;
  }) => void;
  readonly onQuoteInsertionHandled: (id: number) => void;
  readonly onTransition: (transitionId: string) => void;
}) {
  const { detail } = props;
  const [activityFilter, setActivityFilter] = useState<WorkItemActivityFilter>("comments");
  const activityCounts = useMemo(
    () => workItemActivityCounts({ comments: detail.comments, activity: detail.activity }),
    [detail.activity, detail.comments],
  );
  const visibleActivityEntries = useMemo(
    () => filterWorkItemActivityEntries({ activity: detail.activity, filter: activityFilter }),
    [activityFilter, detail.activity],
  );
  const showComments = activityFilter === "comments" || activityFilter === "all";
  const showStatusNotice = activityFilter === "transitions" || activityFilter === "all";
  const opCreatedAt =
    detail.createdAt && Option.isSome(detail.createdAt)
      ? detail.createdAt.value
      : detail.updatedAt && Option.isSome(detail.updatedAt)
        ? detail.updatedAt.value
        : DateTime.fromDateUnsafe(new Date());

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-border/60 border-b bg-background/70 px-5 py-4 lg:px-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-muted-foreground text-xs">{detail.key}</span>
              {detail.issueType ? (
                <span className="rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-muted-foreground text-xs">
                  {detail.issueType}
                </span>
              ) : null}
              <StateBadge kind={workItemStateBadgeKind(detail.state)} />
            </div>
            <h2 className="max-w-4xl font-heading font-semibold text-xl leading-tight">
              {detail.title}
            </h2>
            {detail.labels && detail.labels.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.labels.map((label) => (
                  <LabelChip key={label} label={label} />
                ))}
              </div>
            ) : null}
          </div>
          {props.canImproveDescription ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              onClick={props.onImproveDescription}
            >
              <SparklesIcon className="size-3.5" />
              Improve description with AI
            </Button>
          ) : null}
        </div>
        {detail.transitions.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-border/50 border-t pt-3">
            <span className="mr-1 text-muted-foreground text-xs">Move status</span>
            {detail.transitions.map((transition) => (
              <Button
                key={transition.id}
                type="button"
                size="sm"
                variant="outline"
                className="h-7"
                disabled={props.transitionPending}
                onClick={() => props.onTransition(transition.id)}
              >
                {props.transitionPending ? <Spinner className="size-3" /> : null}
                {transition.name}
              </Button>
            ))}
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/8 px-4 py-5 sm:px-5 lg:px-6">
        <div className="mx-auto w-full max-w-[980px]">
          <SourceControlTimeline>
            <SourceControlTimelineEntry tone="body" icon={<FileTextIcon className="size-4" />}>
              <CommentItem
                author={detail.reporter ?? "Jira"}
                body={detail.description}
                createdAt={opCreatedAt}
                isOriginalPost
                itemKind="body"
                onQuote={() =>
                  props.onQuote({
                    author: detail.reporter ?? "Jira",
                    body: detail.description,
                    createdAt: opCreatedAt,
                    contextLabel: "Jira description",
                  })
                }
              />
            </SourceControlTimelineEntry>
          </SourceControlTimeline>

          <div className="mt-5 mb-4 flex flex-wrap items-center justify-between gap-3 border-border/60 border-y py-3">
            <div className="min-w-0">
              <h3 className="font-medium text-foreground text-sm">Activity</h3>
              <p className="text-muted-foreground text-xs">
                {activityFilterDescription(activityFilter)}
              </p>
            </div>
            <ActivityFilterTabs
              value={activityFilter}
              counts={activityCounts}
              onChange={setActivityFilter}
            />
          </div>

          <SourceControlTimeline>
            {showStatusNotice ? (
              <SourceControlTimelineEntry tone="system" icon={<CircleDotIcon className="size-4" />}>
                <SourceControlTimelineNotice
                  tone="system"
                  title="Current Jira status"
                  description={
                    formatOptionDate(detail.updatedAt)
                      ? `Updated ${formatOptionDate(detail.updatedAt)}`
                      : undefined
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StateBadge kind={workItemStateBadgeKind(detail.state)} />
                    {detail.assignee ? (
                      <span className="text-muted-foreground text-xs">
                        Assigned to {detail.assignee}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">Unassigned</span>
                    )}
                  </div>
                </SourceControlTimelineNotice>
              </SourceControlTimelineEntry>
            ) : null}

            {visibleActivityEntries.map((entry) => (
              <SourceControlTimelineEntry
                key={entry.id}
                tone="system"
                icon={<HistoryIcon className="size-4" />}
              >
                <SourceControlTimelineNotice
                  tone="system"
                  title={activityEntryTitle(entry)}
                  description={formatDateTime(entry.createdAt)}
                >
                  <ul className="grid gap-1 text-xs">
                    {entry.items.map((item) => (
                      <li
                        key={`${entry.id}-${item.field}-${item.from ?? ""}-${item.to ?? ""}`}
                        className="text-muted-foreground"
                      >
                        <span className="font-medium text-foreground/80">{item.field}</span>
                        {": "}
                        {item.from ?? "None"} {"->"} {item.to ?? "None"}
                      </li>
                    ))}
                  </ul>
                </SourceControlTimelineNotice>
              </SourceControlTimelineEntry>
            ))}

            {activityFilter !== "comments" && visibleActivityEntries.length === 0 ? (
              <SourceControlTimelineEntry tone="system" icon={<HistoryIcon className="size-4" />}>
                <SourceControlTimelineNotice
                  tone="system"
                  title={emptyActivityTitle(activityFilter)}
                  description="Jira did not return matching changelog entries for this issue."
                />
              </SourceControlTimelineEntry>
            ) : null}

            {showComments && detail.comments.length === 0 ? (
              <SourceControlTimelineEntry
                tone="comment"
                icon={<MessageSquareIcon className="size-4" />}
              >
                <SourceControlTimelineNotice
                  tone="system"
                  title="No comments yet"
                  description="Add the first Jira comment below."
                />
              </SourceControlTimelineEntry>
            ) : null}

            {showComments
              ? detail.comments.map((comment) => (
                  <SourceControlTimelineEntry
                    key={
                      comment.id ??
                      `${comment.author}-${DateTime.toDate(comment.createdAt).toISOString()}`
                    }
                    tone="comment"
                    icon={<MessageSquareIcon className="size-4" />}
                  >
                    <CommentItem
                      author={comment.author}
                      body={comment.body}
                      createdAt={comment.createdAt}
                      reactions={comment.reactions}
                      itemKind="comment"
                      eyebrow={
                        comment.updatedAt
                          ? `Edited ${formatDateTime(comment.updatedAt)}`
                          : "Comment"
                      }
                      onQuote={() =>
                        props.onQuote({
                          author: comment.author,
                          body: comment.body,
                          createdAt: comment.createdAt,
                          contextLabel: "Jira comment",
                        })
                      }
                      actions={
                        comment.editable && comment.id ? (
                          <button
                            type="button"
                            onClick={() => props.onEditComment(comment)}
                            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Edit Jira comment"
                            title="Edit comment"
                          >
                            <PencilIcon className="size-3.5" />
                          </button>
                        ) : null
                      }
                    />
                  </SourceControlTimelineEntry>
                ))
              : null}

            {showComments ? (
              <SourceControlTimelineEntry
                tone="composer"
                icon={<MessageSquareIcon className="size-4" />}
              >
                <CommentComposer
                  placeholder="Add a Jira comment"
                  submitLabel="Comment"
                  disabled={props.addCommentPending}
                  quoteInsertion={props.quoteInsertion}
                  onQuoteInsertionHandled={props.onQuoteInsertionHandled}
                  onSubmit={({ body }) => props.onAddComment(body).then(() => undefined)}
                />
              </SourceControlTimelineEntry>
            ) : null}
          </SourceControlTimeline>
        </div>
      </div>
    </div>
  );
}

function ActivityFilterTabs(props: {
  readonly value: WorkItemActivityFilter;
  readonly counts: WorkItemActivityCounts;
  readonly onChange: (value: WorkItemActivityFilter) => void;
}) {
  const options: ReadonlyArray<{
    readonly id: WorkItemActivityFilter;
    readonly label: string;
    readonly count: number;
  }> = [
    { id: "comments", label: "Comments", count: props.counts.comments },
    { id: "history", label: "History", count: props.counts.history },
    { id: "transitions", label: "Transitions", count: props.counts.transitions },
    { id: "all", label: "All", count: props.counts.all },
  ];
  return (
    <div
      role="tablist"
      aria-label="Jira activity filter"
      className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border/60 bg-muted/35 p-0.5"
    >
      {options.map((option) => {
        const active = props.value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(option.id)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-xs transition-colors",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{option.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{option.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function activityFilterDescription(filter: WorkItemActivityFilter): string {
  switch (filter) {
    case "comments":
      return "Comments only";
    case "history":
      return "Field changes without status moves";
    case "transitions":
      return "Status and resolution changes";
    case "all":
      return "Comments and Jira changelog";
  }
}

function activityEntryTitle(entry: WorkItemDetailModel["activity"][number]): string {
  const actor = entry.author ?? "Jira";
  return isWorkItemTransitionActivity(entry) ? `${actor} moved the issue` : `${actor} updated Jira`;
}

function emptyActivityTitle(filter: WorkItemActivityFilter): string {
  switch (filter) {
    case "history":
      return "No field history";
    case "transitions":
      return "No transition history";
    case "all":
      return "No Jira activity";
    case "comments":
      return "No comments yet";
  }
}

function WorkItemSidebar(props: {
  readonly detail: WorkItemDetailModel;
  readonly linkedChangeRequests: ReadonlyArray<WorkItemLinkedChangeRequest>;
  readonly linkedChangeRequestsLoading: boolean;
  readonly linkedBranches: ReadonlyArray<VcsRef>;
  readonly linkedBranchesLoading: boolean;
  readonly linkedWorktrees: ReadonlyArray<LinkedWorkItemWorktree>;
  readonly mutationPending: boolean;
  readonly onUpdate: (fields: WorkItemUpdateFields) => void;
  readonly onSelectLinkedChangeRequest?: ((number: number) => void) | undefined;
}) {
  const { detail } = props;
  const assigneeField = editableField(detail, "assignee");
  const priorityField = editableField(detail, "priority");
  const parentField = editableField(detail, "parent");
  const dueDateField = editableField(detail, "dueDate");
  const startDateField = editableField(detail, "startDate");
  const reporterField = editableField(detail, "reporter");
  const parentValue = detail.parentKey ?? detail.epicKey ?? null;

  return (
    <aside className="border-border/60 border-t bg-muted/12 px-4 py-4 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
      <div className="space-y-5 text-xs">
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="font-medium text-foreground text-sm">Details</h3>
            {props.mutationPending ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Spinner className="size-3" />
                Saving
              </span>
            ) : null}
          </div>
          <div className="overflow-hidden rounded-lg border border-border/60 bg-background/45">
            {priorityField ? (
              <EditableOptionDetailRow
                label="Priority"
                field={priorityField}
                currentLabel={detail.priority ?? "None"}
                selectedValue={detail.priorityDetail?.id}
                disabled={props.mutationPending}
                valueForOption={(option) => option.id ?? option.name}
                renderCurrentValue={() => (
                  <PriorityDisplay priority={detail.priorityDetail ?? detail.priority} />
                )}
                renderOptionPrefix={(option) => <PriorityDisplay priority={option} compact />}
                onChange={(value) => props.onUpdate({ priorityId: value })}
                onClear={() => props.onUpdate({ priorityId: null })}
              />
            ) : (
              <DetailRow
                label="Priority"
                value={<PriorityDisplay priority={detail.priorityDetail ?? detail.priority} />}
              />
            )}
            {assigneeField ? (
              <EditableOptionDetailRow
                label="Assignee"
                field={assigneeField}
                currentLabel={detail.assignee ?? "Unassigned"}
                disabled={props.mutationPending}
                valueForOption={(option) => option.accountId ?? option.id ?? option.name}
                renderCurrentValue={() => detail.assignee ?? "Unassigned"}
                onChange={(value) => props.onUpdate({ assigneeAccountId: value })}
                onClear={() => props.onUpdate({ assigneeAccountId: null })}
              />
            ) : (
              <DetailRow label="Assignee" value={detail.assignee ?? "Unassigned"} />
            )}
            {reporterField ? (
              <EditableOptionDetailRow
                label="Reporter"
                field={reporterField}
                currentLabel={detail.reporter ?? "Unknown"}
                disabled={props.mutationPending}
                valueForOption={(option) => option.accountId ?? option.id ?? option.name}
                onChange={(value) => props.onUpdate({ reporterAccountId: value })}
                onClear={() => props.onUpdate({ reporterAccountId: null })}
              />
            ) : (
              <DetailRow label="Reporter" value={detail.reporter ?? "Unknown"} />
            )}
            {parentField ? (
              parentField.options && parentField.options.length > 0 ? (
                <EditableOptionDetailRow
                  label="Parent"
                  field={parentField}
                  currentLabel={parentValue ?? "None"}
                  selectedValue={parentValue ?? undefined}
                  disabled={props.mutationPending}
                  valueForOption={(option) => option.key ?? option.id ?? option.name}
                  onChange={(value) => props.onUpdate({ parentKey: value })}
                  onClear={() => props.onUpdate({ parentKey: null })}
                />
              ) : (
                <EditableTextDetailRow
                  label="Parent"
                  value={parentValue ?? ""}
                  placeholder="PROJ-123"
                  emptyLabel="None"
                  disabled={props.mutationPending}
                  onSave={(value) => props.onUpdate({ parentKey: value.trim() || null })}
                />
              )
            ) : (
              <DetailRow label="Parent" value={parentValue ?? "None"} />
            )}
            {dueDateField ? (
              <EditableTextDetailRow
                label="Due date"
                type="date"
                value={detail.dueDate ?? ""}
                emptyLabel="None"
                disabled={props.mutationPending}
                onSave={(value) => props.onUpdate({ dueDate: value.trim() || null })}
              />
            ) : (
              <DetailRow label="Due date" value={detail.dueDate ?? "None"} />
            )}
            {startDateField ? (
              <EditableTextDetailRow
                label="Start date"
                type="date"
                value={detail.startDate ?? ""}
                emptyLabel="None"
                disabled={props.mutationPending}
                onSave={(value) => props.onUpdate({ startDate: value.trim() || null })}
              />
            ) : (
              <DetailRow label="Start date" value={detail.startDate ?? "None"} />
            )}
            {detail.createdAt && Option.isSome(detail.createdAt) ? (
              <DetailRow
                label="Created"
                value={dateFmt.format(DateTime.toDate(detail.createdAt.value))}
              />
            ) : null}
            {detail.updatedAt && Option.isSome(detail.updatedAt) ? (
              <DetailRow
                label="Updated"
                value={dateFmt.format(DateTime.toDate(detail.updatedAt.value))}
              />
            ) : null}
          </div>
        </section>

        <LinkedLocalWorkItemSection
          branches={props.linkedBranches}
          branchesLoading={props.linkedBranchesLoading}
          worktrees={props.linkedWorktrees}
        />
        <LinkedPullRequestsSection
          loading={props.linkedChangeRequestsLoading}
          items={props.linkedChangeRequests}
          onSelect={props.onSelectLinkedChangeRequest}
        />
      </div>
    </aside>
  );
}

function DetailRow(props: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="grid min-h-9 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 border-border/55 border-b px-3 py-2 last:border-b-0">
      <div className="text-muted-foreground">{props.label}</div>
      <div className="min-w-0 truncate text-right font-medium text-foreground">{props.value}</div>
    </div>
  );
}

function EditableOptionDetailRow(props: {
  readonly label: string;
  readonly field: WorkItemEditableFieldMetadata;
  readonly currentLabel: string;
  readonly selectedValue?: string | undefined;
  readonly disabled: boolean;
  readonly valueForOption: (option: WorkItemEditableFieldOption) => string;
  readonly renderCurrentValue?: (() => ReactNode) | undefined;
  readonly renderOptionPrefix?: ((option: WorkItemEditableFieldOption) => ReactNode) | undefined;
  readonly onChange: (value: string) => void;
  readonly onClear: () => void;
}) {
  const options = props.field.options ?? [];
  if (options.length === 0) {
    return <DetailRow label={props.label} value={props.currentLabel} />;
  }
  const selectedValue =
    props.selectedValue ??
    selectedEditableOptionValue({
      options,
      currentLabel: props.currentLabel,
      valueForOption: props.valueForOption,
    });
  return (
    <div className="grid min-h-9 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 border-border/55 border-b px-3 py-1.5 last:border-b-0">
      <div className="text-muted-foreground">{props.label}</div>
      <Select
        value={selectedValue ?? ""}
        onValueChange={(value) => {
          if (typeof value !== "string") return;
          if (value === NONE_VALUE) props.onClear();
          else props.onChange(value);
        }}
      >
        <SelectTrigger
          size="xs"
          variant="ghost"
          disabled={props.disabled}
          className="h-7 w-full justify-end text-right"
        >
          {props.renderCurrentValue ? (
            <span className="flex min-w-0 flex-1 justify-end truncate text-foreground">
              {props.renderCurrentValue()}
            </span>
          ) : (
            <SelectValue placeholder={props.currentLabel} />
          )}
        </SelectTrigger>
        <SelectPopup align="end">
          <SelectItem value={NONE_VALUE}>None</SelectItem>
          {options.map((option) => {
            const value = props.valueForOption(option);
            return (
              <SelectItem key={`${props.field.id}:${value}`} value={value}>
                <span className="inline-flex min-w-0 items-center gap-2">
                  {props.renderOptionPrefix?.(option)}
                  <span className="truncate">{option.displayName ?? option.name}</span>
                </span>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
    </div>
  );
}

function EditableTextDetailRow(props: {
  readonly label: string;
  readonly value: string;
  readonly type?: "text" | "date" | undefined;
  readonly placeholder?: string | undefined;
  readonly emptyLabel: string;
  readonly disabled: boolean;
  readonly onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  const dirty = draft !== props.value;
  return (
    <div className="grid min-h-9 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 border-border/55 border-b px-3 py-1.5 last:border-b-0">
      <div className="text-muted-foreground">{props.label}</div>
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        <Input
          type={props.type ?? "text"}
          size="sm"
          value={draft}
          disabled={props.disabled}
          placeholder={props.value.length > 0 ? props.placeholder : props.emptyLabel}
          className="max-w-36"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        {dirty ? (
          <Button
            type="button"
            size="sm"
            className="h-8 px-2"
            disabled={props.disabled}
            onClick={() => props.onSave(draft)}
          >
            Save
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function selectedEditableOptionValue(input: {
  readonly options: ReadonlyArray<WorkItemEditableFieldOption>;
  readonly currentLabel: string;
  readonly valueForOption: (option: WorkItemEditableFieldOption) => string;
}): string | undefined {
  const currentLabel = normalizeOptionLabel(input.currentLabel);
  const option = input.options.find((candidate) => {
    const labels = [
      candidate.displayName,
      candidate.name,
      candidate.key,
      candidate.id,
      candidate.accountId,
    ];
    return labels.some((label) => normalizeOptionLabel(label) === currentLabel);
  });
  return option ? input.valueForOption(option) : undefined;
}

function normalizeOptionLabel(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function LinkedLocalWorkItemSection(props: {
  readonly branches: ReadonlyArray<VcsRef>;
  readonly branchesLoading: boolean;
  readonly worktrees: ReadonlyArray<LinkedWorkItemWorktree>;
}) {
  const hasLinks = props.branches.length > 0 || props.worktrees.length > 0;
  return (
    <section>
      <div className="mb-2 text-muted-foreground">Local links</div>
      {props.branchesLoading && !hasLinks ? (
        <span className="text-muted-foreground/70 text-xs italic">Checking...</span>
      ) : hasLinks ? (
        <div className="grid gap-2">
          {props.branches.length > 0 ? (
            <div className="grid gap-1">
              {props.branches.map((branch) => (
                <span
                  key={branch.name}
                  className="flex min-w-0 items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
                  title={branch.worktreePath ?? branch.name}
                >
                  <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-[11px]">{branch.name}</span>
                </span>
              ))}
            </div>
          ) : null}
          {props.worktrees.length > 0 ? (
            <div className="grid gap-1">
              {props.worktrees.map((worktree) => (
                <span
                  key={worktree.id}
                  className="flex min-w-0 items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
                  title={worktree.worktreePath ?? worktree.branch}
                >
                  <AtlassianJiraIcon className="size-3 shrink-0" />
                  <span className="min-w-0 truncate font-mono text-[11px]">{worktree.branch}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="text-muted-foreground/70 text-xs italic">None found</span>
      )}
    </section>
  );
}

function LinkedPullRequestsSection(props: {
  readonly loading: boolean;
  readonly items: ReadonlyArray<WorkItemLinkedChangeRequest>;
  readonly onSelect?: ((number: number) => void) | undefined;
}) {
  return (
    <section>
      <div className="mb-2 text-muted-foreground">Linked PRs</div>
      {props.loading ? (
        <span className="text-muted-foreground/70 text-xs italic">Searching...</span>
      ) : props.items.length > 0 ? (
        <ul className="space-y-1.5">
          {props.items.map((pr) => {
            const checkStatus = getPrCheckStatusFromChangeRequest(pr);
            return (
              <li key={pr.number}>
                <div className="flex min-w-0 items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5">
                  <GitPullRequestIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => props.onSelect?.(pr.number)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-foreground text-xs">
                      #{pr.number} {pr.title}
                    </span>
                    <span className="mt-1 flex items-center gap-1 text-[10px]">
                      <StateBadge
                        kind={changeRequestStateKind(pr.state, pr.isDraft)}
                        className="h-4 px-1.5 text-[10px]"
                      />
                      <PrCheckStatusBadge view={checkStatus} mode="compact" />
                    </span>
                  </button>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 text-muted-foreground hover:text-foreground"
                    title="Open pull request"
                  >
                    <ExternalLinkIcon className="size-3" />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="text-muted-foreground/70 text-xs italic">None found</span>
      )}
    </section>
  );
}

function EditCommentDialog(props: {
  readonly comment: WorkItemComment;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (body: string) => void;
}) {
  const [body, setBody] = useState(props.comment.body);
  useEffect(() => {
    setBody(props.comment.body);
  }, [props.comment.body]);
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full max-w-xl p-0">
        <DialogHeader className="border-border/60 border-b px-5 py-3">
          <DialogTitle className="text-base">Edit Jira comment</DialogTitle>
          <DialogDescription className="text-xs">
            Review changes before saving them to Jira.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="px-5 py-4">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            className="min-h-40 text-sm"
          />
        </DialogPanel>
        <DialogFooter className="border-border/60 border-t px-5 py-3">
          <Button
            variant="outline"
            disabled={props.pending}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={props.pending || body.trim().length === 0}
            onClick={() => props.onSave(body)}
          >
            {props.pending ? <Spinner className="size-3.5" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ImproveDescriptionDialog(props: {
  readonly open: boolean;
  readonly detail: WorkItemDetailModel;
  readonly generatePending: boolean;
  readonly savePending: boolean;
  readonly generateError: unknown;
  readonly onOpenChange: (open: boolean) => void;
  readonly onGenerate: (input: {
    readonly rough: string;
    readonly instructions: string;
  }) => Promise<{ readonly body?: string | undefined }>;
  readonly onSave: (description: string) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [draft, setDraft] = useState(props.detail.description);
  useEffect(() => {
    if (props.open) setDraft(props.detail.description);
  }, [props.detail.description, props.open]);
  const generate = async () => {
    const result = await props.onGenerate({
      rough: props.detail.description,
      instructions,
    });
    if (result.body !== undefined) setDraft(result.body);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="flex max-h-[82vh] w-full max-w-2xl flex-col p-0">
        <DialogHeader className="border-border/60 border-b px-5 py-3">
          <DialogTitle className="text-base">Improve Jira description with AI</DialogTitle>
          <DialogDescription className="text-xs">
            Generate a draft, review it, then save it to Jira.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <Input
            value={instructions}
            onChange={(event) => setInstructions(event.currentTarget.value)}
            placeholder='Optional guidance, e.g. "make acceptance criteria explicit"'
            className="h-8 text-xs"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.generatePending || props.savePending}
              onClick={() => void generate()}
            >
              {props.generatePending ? (
                <Spinner className="size-3.5" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              Generate draft
            </Button>
          </div>
          {props.generateError ? (
            <p className="text-destructive text-xs">
              {errorMessage(props.generateError, "AI draft generation failed.")}
            </p>
          ) : null}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            className="min-h-72 text-sm"
          />
        </DialogPanel>
        <DialogFooter className="border-border/60 border-t px-5 py-3">
          <Button
            variant="outline"
            disabled={props.generatePending || props.savePending}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={props.generatePending || props.savePending}
            onClick={() => props.onSave(draft)}
          >
            {props.savePending ? <Spinner className="size-3.5" /> : null}
            Save to Jira
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function editableField(
  detail: WorkItemDetailModel,
  id: WorkItemEditableFieldId,
): WorkItemEditableFieldMetadata | null {
  return detail.editableFields.find((field) => field.id === id) ?? null;
}

function PriorityDisplay(props: {
  readonly priority: WorkItemPriority | WorkItemEditableFieldOption | string | undefined;
  readonly compact?: boolean | undefined;
}) {
  const priority =
    typeof props.priority === "string"
      ? { name: props.priority }
      : props.priority && "name" in props.priority
        ? props.priority
        : undefined;
  if (!priority) return <span>None</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <PriorityIcon priority={priority} />
      {props.compact ? null : <span className="truncate">{priority.name}</span>}
    </span>
  );
}

function PriorityIcon(props: { readonly priority: Pick<WorkItemPriority, "iconUrl" | "name"> }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (props.priority.iconUrl && !imageFailed) {
    return (
      <img
        src={props.priority.iconUrl}
        alt=""
        className="size-3.5 shrink-0"
        loading="lazy"
        decoding="async"
        onError={() => setImageFailed(true)}
      />
    );
  }
  const normalized = props.priority.name.toLowerCase();
  if (normalized.includes("highest") || normalized.includes("blocker")) {
    return <ChevronsUpIcon className="size-3.5 shrink-0 text-rose-500" />;
  }
  if (
    normalized.includes("high") ||
    normalized.includes("major") ||
    normalized.includes("critical")
  ) {
    return <ArrowUpIcon className="size-3.5 shrink-0 text-orange-500" />;
  }
  if (normalized.includes("low") || normalized.includes("minor")) {
    return <ArrowDownIcon className="size-3.5 shrink-0 text-sky-500" />;
  }
  if (normalized.includes("lowest") || normalized.includes("trivial")) {
    return <ChevronsDownIcon className="size-3.5 shrink-0 text-slate-500" />;
  }
  return <MinusIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function workItemStateBadgeKind(state: WorkItemDetailModel["state"]): StateBadgeKind {
  if (state === "done" || state === "closed") return "issue-closed";
  if (state === "unknown") return "issue-unknown";
  return "issue-open";
}

function formatOptionDate(value: Option.Option<DateTime.Utc>): string | null {
  return Option.isSome(value) ? dateFmt.format(DateTime.toDate(value.value)) : null;
}

function formatDateTime(value: DateTime.Utc): string {
  return dateTimeFmt.format(DateTime.toDate(value));
}
