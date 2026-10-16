import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  buildAgentControlProposalCardModel,
  completionReturnPresentation,
  EMPTY_AGENT_CONTROL_QUEUE_STATE,
  findCompletionReturnForChild,
  selectAgentControlThreadActivity,
  selectCompletionReturnsByChildThreadId,
  useAgentControlStore,
  type AgentControlStatusTone,
  type AgentControlThreadActivity,
} from "@ryco/client-runtime/state/agentControl";
import {
  isArchivedThreadStub,
  threadForkReplyExcerpt,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ServerConfig, ThreadId } from "@ryco/contracts";
import type {
  AgentControlCompletionReturn,
  AgentControlProposal,
} from "@ryco/contracts/agent-control";
import { useRouter } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentServerConfigSelector } from "../../hooks/useChatsAvailability";
import { cn } from "../../lib/utils";
import { selectDelegatedChildThreadsForThreadRef, useStore, type AppState } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedClockLabel } from "../../timestampFormat";
import { useAgentControlSyncEnvironmentIds } from "../agent-control/agentControlSyncGate";
import { AgentControlProposalCard } from "../agent-control/AgentControlProposalCard";
import { useAgentControlDecisions } from "../agent-control/useAgentControlDecisions";
import { useAutomationProposalSync } from "../automations/data/useAutomationProposalSync";
import { resolveInboxGlyph } from "../inboxSidebar/inboxRowPresentation";
import { modelDisplayName } from "../inboxSidebar/inboxSidebarModel";
import { InboxStatusGlyph } from "../inboxSidebar/InboxStatusGlyph";
import { useInboxClock } from "../inboxSidebar/useInboxListMotion";
import { DelegationDockChildPeek } from "./DelegationDockChildPeek";
import {
  buildDelegationDockChildren,
  buildDelegationDockLog,
  formatDelegationDockAge,
  summarizeDelegationDock,
  type DelegationDockChild,
  type DelegationDockTone,
} from "./delegationDock.logic";

export interface DelegationDockProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Whether the dock renders anything; the composer tightens its prompt under a header. */
  readonly onPresenceChange?: ((present: boolean) => void) | undefined;
}

const TASK_MAX_CHARS = 280;
const NO_CHILDREN: ReadonlyArray<SidebarThreadSummary> = [];
const selectProviders = (config: ServerConfig | null) => config?.providers ?? null;

const threadHref = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

const STATE_TEXT_TONE: Record<DelegationDockTone, string> = {
  working: "text-(--delegation-dock-working-text)",
  attention: "font-medium text-warning-foreground",
  done: "text-muted-foreground",
  danger: "text-destructive-foreground",
  muted: "text-muted-foreground",
};

const BAR_TONE: Record<DelegationDockTone, string> = {
  working: "delegation-dock-shimmer",
  attention: "bg-warning",
  done: "bg-success",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/35",
};

const PILL_TONE: Record<AgentControlStatusTone, string> = {
  pending: "border-warning/40 text-warning-foreground",
  info: "border-(--delegation-dock-working)/40 text-(--delegation-dock-working-text)",
  success: "border-success/40 bg-success/10 text-success-foreground",
  danger: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
  muted: "border-border text-muted-foreground",
};

const LOG_DOT: Record<AgentControlStatusTone, string> = {
  pending: "before:bg-warning",
  info: "before:bg-(--delegation-dock-working)",
  success: "before:bg-success",
  danger: "before:bg-destructive",
  muted: "before:bg-muted-foreground/50",
};

const DOCK_BUTTON = "rounded-[7px] px-2.5 py-[3px] text-[11.5px] whitespace-nowrap";
const GHOST_BUTTON = `${DOCK_BUTTON} text-muted-foreground hover:bg-foreground/9 hover:text-foreground disabled:opacity-50`;
const PRIMARY_BUTTON = `${DOCK_BUTTON} bg-primary text-primary-foreground disabled:opacity-50`;
const ROW_FOCUS =
  "outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function RunningClock(props: { readonly since: string }) {
  const now = useInboxClock();
  return <>{formatElapsedClockLabel(props.since, now)}</>;
}

function DelegationIcon() {
  return (
    <svg
      aria-hidden
      className="size-3.5 shrink-0 text-muted-foreground"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="8" r="1.6" />
      <path d="M4 5.1v5.8M4 8h3.5a3 3 0 0 0 3-1.4" />
    </svg>
  );
}

function DelegatedFromIcon() {
  return (
    <svg
      aria-hidden
      className="size-[13px] shrink-0"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.5 10.5V6.5a2 2 0 0 0-2-2H3.5M5.5 2.5l-2 2 2 2" />
    </svg>
  );
}

function ChildStateText(props: { readonly child: DelegationDockChild }) {
  const { child } = props;
  return (
    <span
      className={cn("text-[11.5px] whitespace-nowrap tabular-nums", STATE_TEXT_TONE[child.tone])}
    >
      {child.label}
      {child.runningSince ? (
        <>
          {" · "}
          <RunningClock since={child.runningSince} />
        </>
      ) : child.state === "idle" && child.finishedAt ? (
        ` · ${formatDelegationDockAge(child.finishedAt)}`
      ) : null}
    </span>
  );
}

/**
 * The thread's delegation, docked at the top of the composer: one line with
 * its delegated threads' state, opening into those threads, its pending Agent
 * Control approvals and its Agent Control log. A delegated thread sees where it
 * came from. Off the frozen phone tier (ChatView never mounts it there).
 */
export function DelegationDock(props: DelegationDockProps) {
  const { environmentId, threadId, onPresenceChange } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const childRows = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) => selectDelegatedChildThreadsForThreadRef(state, threadRef),
        [threadRef],
      ),
    ),
  );
  const children = useMemo(() => {
    const full = childRows.filter(
      (thread): thread is SidebarThreadSummary => !isArchivedThreadStub(thread),
    );
    return full.length > 0 ? full : NO_CHILDREN;
  }, [childRows]);
  const lineage = useStore(
    (state) =>
      state.environmentStateById[environmentId]?.threadShellById[threadId]?.lineage ?? null,
  );
  const syncEnvironmentIds = useMemo(() => [environmentId], [environmentId]);
  useAutomationProposalSync(useAgentControlSyncEnvironmentIds(syncEnvironmentIds));
  const queueState =
    useAgentControlStore((state) => state.queueByEnvironmentId[environmentId]) ??
    EMPTY_AGENT_CONTROL_QUEUE_STATE;
  const selection = useMemo(
    () => selectAgentControlThreadActivity(queueState, threadId, lineage),
    [queueState, threadId, lineage],
  );
  const ownReturn = useMemo(
    () => findCompletionReturnForChild(queueState, threadId),
    [queueState, threadId],
  );

  // Most threads have nothing here: they stop before subscribing to titles.
  const present =
    selection.delegatedFromThreadId !== null ||
    selection.managerThreadId !== null ||
    children.length > 0 ||
    selection.activity.length > 0 ||
    selection.pending.length > 0;
  useLayoutEffect(() => {
    onPresenceChange?.(present);
  }, [onPresenceChange, present]);
  useLayoutEffect(() => () => onPresenceChange?.(false), [onPresenceChange]);
  if (!present) return null;
  return (
    <DelegationDockContent
      environmentId={environmentId}
      threadId={threadId}
      childThreads={children}
      selection={selection}
      ownReturn={ownReturn}
    />
  );
}

/** A user decision the server has carried out (not a stale or failed one). */
function decisionApplied(proposal: AgentControlProposal, decision: "accept" | "reject"): boolean {
  return decision === "reject"
    ? proposal.status === "rejected"
    : proposal.status !== "rejected" &&
        proposal.status !== "expired" &&
        proposal.status !== "cancelled";
}

function DelegationDockContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly childThreads: ReadonlyArray<SidebarThreadSummary>;
  readonly selection: AgentControlThreadActivity;
  readonly ownReturn: AgentControlCompletionReturn | null;
}) {
  const { environmentId, threadId, childThreads, selection, ownReturn } = props;
  const router = useRouter({ warn: false });
  const threadShells = useStore(
    (state) => state.environmentStateById[environmentId]?.threadShellById,
  );
  const getThreadTitle = useMemo(() => (id: ThreadId) => threadShells?.[id]?.title, [threadShells]);
  const decisions = useAgentControlDecisions(environmentId);
  const providers = useEnvironmentServerConfigSelector(environmentId, selectProviders);

  const dockChildren = useMemo(
    () =>
      buildDelegationDockChildren(
        childThreads,
        selectCompletionReturnsByChildThreadId(
          [...selection.pending, ...selection.activity],
          threadId,
        ),
      ),
    [childThreads, selection, threadId],
  );
  const summary = useMemo(() => summarizeDelegationDock(dockChildren), [dockChildren]);
  const log = useMemo(
    () => buildDelegationDockLog(selection.activity, getThreadTitle),
    [selection.activity, getThreadTitle],
  );

  const parentThreadId = selection.delegatedFromThreadId;
  const managerThreadId = selection.managerThreadId;
  const parentRef = useMemo(
    () => (parentThreadId === null ? null : scopeThreadRef(environmentId, parentThreadId)),
    [environmentId, parentThreadId],
  );
  const siblingCount = useStore((state) =>
    parentRef === null
      ? 0
      : Math.max(0, selectDelegatedChildThreadsForThreadRef(state, parentRef).length - 1),
  );
  const taskText = useStore((state) => {
    if (parentThreadId === null) return null;
    const environmentState = state.environmentStateById[environmentId];
    const messages = environmentState?.messageByThreadId[threadId];
    if (ownReturn !== null) return messages?.[ownReturn.initialMessageId]?.text ?? null;
    // Without a return naming the task message, only a window that starts at
    // the thread's beginning knows its first prompt.
    if (environmentState?.threadHistoryByThreadId?.[threadId]?.messages.hasMoreBefore !== false) {
      return null;
    }
    for (const id of environmentState.messageIdsByThreadId[threadId] ?? []) {
      const message = messages?.[id];
      if (message?.role === "user") return message.text;
    }
    return null;
  });

  const [expanded, setExpanded] = useState(false);
  const [selectedChildId, setSelectedChildId] = useState<ThreadId | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [openLogProposalId, setOpenLogProposalId] = useState<string | null>(null);
  const [detailsProposalId, setDetailsProposalId] = useState<string | null>(null);
  const [originOpen, setOriginOpen] = useState(false);
  const [decided, setDecided] = useState<Readonly<Record<string, "accept" | "reject">>>({});

  const hasOrigin = parentThreadId !== null || managerThreadId !== null;
  const hasHeader = dockChildren.length > 0 || log.length > 0;
  const decidedLines = selection.activity.filter((proposal) => {
    const decision = decided[proposal.proposalId];
    return decision !== undefined && decisionApplied(proposal, decision);
  });

  const openThread = (id: ThreadId) => {
    if (!router) return;
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, id)),
    });
  };
  const titleOf = (id: ThreadId) => getThreadTitle(id) || `thread ${id.slice(0, 8)}…`;
  const decide = (proposal: AgentControlProposal, decision: "accept" | "reject") => {
    setDecided((current) => ({ ...current, [proposal.proposalId]: decision }));
    decisions.decide(proposal.proposalId, decision);
  };

  const summaryParts: ReactNode[] = [];
  if (summary.working > 0) {
    summaryParts.push(
      <span key="working" className="text-(--delegation-dock-working-text)">
        {summary.working} working
      </span>,
    );
  }
  if (summary.needsYou > 0) {
    summaryParts.push(
      <span key="needs" className="text-warning-foreground">
        {summary.needsYou} needs you
      </span>,
    );
  }
  if (summary.failed > 0) {
    summaryParts.push(
      <span key="failed" className="text-destructive-foreground">
        {summary.failed} failed
      </span>,
    );
  }
  if (summary.returning > 0) {
    summaryParts.push(
      <span key="returned">
        {summary.returned} of {summary.returning} returned
      </span>,
    );
  }
  const latestLog = log[0];

  const logList = (
    <div className="delegation-dock-rise pt-1 pr-3 pb-2 pl-[30px] text-[11.5px] text-muted-foreground">
      {log.map((row) => {
        const open = openLogProposalId === row.proposal.proposalId;
        return (
          <div key={row.proposal.proposalId}>
            <button
              type="button"
              aria-expanded={open}
              className={cn(
                "relative flex w-full gap-2 rounded-sm py-0.5 text-left before:absolute before:top-[7px] before:-left-3.5 before:size-1.5 before:rounded-full hover:text-foreground",
                LOG_DOT[row.tone],
                ROW_FOCUS,
              )}
              onClick={() => setOpenLogProposalId(open ? null : row.proposal.proposalId)}
            >
              <span className="min-w-0">
                <b className="font-medium text-foreground">{row.action}</b> · {row.target}
                {row.status ? ` · ${row.status}` : null}
              </span>
              <time className="ml-auto whitespace-nowrap" dateTime={row.at}>
                {formatDelegationDockAge(row.at)}
              </time>
            </button>
            {open ? (
              <div className="delegation-dock-rise pt-1.5">
                <AgentControlProposalCard
                  model={buildAgentControlProposalCardModel(row.proposal, getThreadTitle)}
                  environmentId={environmentId}
                  getThreadTitle={getThreadTitle}
                  isSubmitting={false}
                  decisionError={null}
                  disabledReason={null}
                  onAccept={() => {}}
                  onReject={() => {}}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      className="delegation-dock overflow-hidden rounded-t-[max(0px,calc(var(--radius-3xl)-3px))] border-b border-border/65 bg-muted/20 text-xs"
      data-chat-composer-collapsed-controls="true"
      data-testid="delegation-dock"
    >
      {hasOrigin ? (
        <>
          <button
            type="button"
            aria-expanded={originOpen}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:bg-foreground/6",
              ROW_FOCUS,
            )}
            onClick={() => setOriginOpen((open) => !open)}
          >
            <DelegatedFromIcon />
            {parentThreadId !== null ? (
              <>
                <span className="shrink-0 whitespace-nowrap">Delegated from</span>
                <b className="min-w-0 truncate font-medium text-foreground">
                  {titleOf(parentThreadId)}
                </b>
              </>
            ) : null}
            {parentThreadId !== null && managerThreadId !== null ? (
              <span aria-hidden className="shrink-0">
                ·
              </span>
            ) : null}
            {managerThreadId !== null ? (
              <>
                <span className="shrink-0 whitespace-nowrap">Managed by</span>
                <b className="min-w-0 truncate font-medium text-foreground">
                  {titleOf(managerThreadId)}
                </b>
              </>
            ) : null}
            {ownReturn !== null ? (
              <span className="shrink-0 whitespace-nowrap">
                {completionReturnPresentation(ownReturn.status).pending
                  ? "· result returns when you finish"
                  : `· ${completionReturnPresentation(ownReturn.status).label.toLowerCase()}`}
              </span>
            ) : null}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "ml-auto size-3 shrink-0 text-muted-foreground transition-transform duration-(--app-motion-duration-pop)",
                originOpen && "rotate-180",
              )}
            />
          </button>
          {originOpen ? (
            <div className="delegation-dock-rise pt-0.5 pr-3 pb-2.5 pl-[33px] text-muted-foreground">
              {taskText ? (
                <>
                  <div className="mb-0.5 text-[10.5px] tracking-[0.06em] uppercase">Task</div>
                  <p className="mb-2 text-foreground">
                    {threadForkReplyExcerpt(taskText, TASK_MAX_CHARS)}
                  </p>
                </>
              ) : null}
              {parentThreadId !== null ? (
                <a
                  className="text-(--chat-link) hover:underline"
                  href={threadHref(environmentId, parentThreadId)}
                  onClick={(event) => {
                    event.preventDefault();
                    openThread(parentThreadId);
                  }}
                >
                  Open {titleOf(parentThreadId)} ↗
                </a>
              ) : null}
              {siblingCount > 0 ? (
                <span>
                  {" · "}
                  {siblingCount} sibling {siblingCount === 1 ? "thread" : "threads"}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {hasHeader ? (
        <button
          type="button"
          aria-expanded={expanded}
          className={cn(
            "flex w-full items-center gap-[9px] px-3 py-2 text-left not-first:border-t not-first:border-border/65 hover:bg-foreground/6",
            ROW_FOCUS,
          )}
          onClick={() => setExpanded((open) => !open)}
        >
          <DelegationIcon />
          {dockChildren.length > 0 ? (
            <>
              <span className="font-semibold whitespace-nowrap text-foreground">
                {dockChildren.length} delegated
              </span>
              <span aria-hidden className="inline-flex gap-0.5">
                {dockChildren.map((child) => (
                  <i
                    key={child.thread.id}
                    className={cn("block h-1 w-3.5 rounded-[2px]", BAR_TONE[child.tone])}
                  />
                ))}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                {summaryParts.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]))}
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold whitespace-nowrap text-foreground">
                Agent Control · {log.length}
              </span>
              {latestLog ? (
                <span className="min-w-0 truncate text-muted-foreground">
                  {latestLog.action} · {latestLog.target}
                </span>
              ) : null}
            </>
          )}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "ml-auto size-3 shrink-0 text-muted-foreground transition-transform duration-(--app-motion-duration-pop)",
              expanded && "rotate-180",
            )}
          />
        </button>
      ) : null}

      {selection.pending.map((proposal) => {
        const model = buildAgentControlProposalCardModel(proposal, getThreadTitle);
        const danger = model.isDestructive || model.warningLabel !== null;
        const submitting = decisions.submittingIds.includes(proposal.proposalId);
        const error = decisions.decisionErrorsById[proposal.proposalId] ?? null;
        const detailsOpen = detailsProposalId === proposal.proposalId;
        const disabled = submitting || decisions.disabledReason !== null;
        return (
          <div key={proposal.proposalId} data-testid="delegation-dock-approval">
            <div
              className={cn(
                "delegation-dock-rise-slow flex items-center gap-2 px-3 py-[7px] not-first:border-t",
                danger
                  ? "border-destructive/22 bg-destructive/8"
                  : "border-warning/22 bg-warning/8",
              )}
            >
              <InboxStatusGlyph kind={danger ? "error" : "needs-input"} />
              <span className="min-w-0 flex-1 truncate">
                <b className="font-bold">{model.actionLabel}</b> · {model.targetLabel}
              </span>
              <span
                className={cn(
                  "text-[11px] whitespace-nowrap",
                  danger ? "text-destructive-foreground" : "text-muted-foreground",
                )}
              >
                {model.isDestructive
                  ? "Destructive"
                  : model.warningLabel
                    ? "High risk"
                    : "Agent Control"}
              </span>
              <button
                type="button"
                aria-expanded={detailsOpen}
                className={cn(GHOST_BUTTON, ROW_FOCUS)}
                onClick={() => setDetailsProposalId(detailsOpen ? null : proposal.proposalId)}
              >
                Details
              </button>
              <button
                type="button"
                className={cn(GHOST_BUTTON, ROW_FOCUS)}
                disabled={disabled}
                title={decisions.disabledReason ?? undefined}
                onClick={() => decide(proposal, "reject")}
              >
                Reject
              </button>
              <button
                type="button"
                className={cn(PRIMARY_BUTTON, ROW_FOCUS)}
                disabled={disabled}
                title={decisions.disabledReason ?? undefined}
                onClick={() => decide(proposal, "accept")}
              >
                Approve
              </button>
            </div>
            {error !== null ? (
              <p role="alert" className="px-3 pb-1.5 text-[11.5px] text-destructive-foreground">
                {error}
              </p>
            ) : null}
            {detailsOpen ? (
              <div className="delegation-dock-rise px-3 pt-2">
                <AgentControlProposalCard
                  model={model}
                  environmentId={environmentId}
                  getThreadTitle={getThreadTitle}
                  isSubmitting={submitting}
                  decisionError={null}
                  disabledReason={decisions.disabledReason}
                  onAccept={() => decide(proposal, "accept")}
                  onReject={() => decide(proposal, "reject")}
                  showDecisions={false}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      {decidedLines.map((proposal) => {
        const model = buildAgentControlProposalCardModel(proposal, getThreadTitle);
        const approved = decided[proposal.proposalId] === "accept";
        return (
          <div
            key={proposal.proposalId}
            className="delegation-dock-rise-slow flex items-center gap-2 px-3 py-1.5 text-muted-foreground not-first:border-t not-first:border-border/65"
          >
            {approved ? (
              <InboxStatusGlyph kind="completed" />
            ) : (
              <span
                aria-hidden
                className="inline-flex size-3.5 shrink-0 items-center justify-center"
              >
                ✕
              </span>
            )}
            <span className="min-w-0 truncate">
              You {approved ? "approved" : "rejected"} {model.actionLabel} · {model.targetLabel}
            </span>
            <span className="ml-auto whitespace-nowrap">
              {formatDelegationDockAge(proposal.decidedAt ?? proposal.updatedAt)}
            </span>
          </div>
        );
      })}

      {expanded && dockChildren.length > 0 ? (
        <>
          <div className="delegation-dock-rise px-1.5 pt-0.5 pb-1.5">
            {dockChildren.map((child) => {
              const open = selectedChildId === child.thread.id;
              const glyph =
                child.state === "idle" && child.finishedAt
                  ? "completed"
                  : resolveInboxGlyph(child, false);
              return (
                <div key={child.thread.id}>
                  <button
                    type="button"
                    aria-expanded={open}
                    className={cn(
                      "group/dock-row grid w-full grid-cols-[18px_minmax(0,1fr)_auto_auto_14px] items-center gap-2 rounded-lg p-1.5 text-left text-[13px] hover:bg-foreground/6 aria-expanded:bg-foreground/9",
                      ROW_FOCUS,
                    )}
                    onClick={() => setSelectedChildId(open ? null : child.thread.id)}
                  >
                    <InboxStatusGlyph key={glyph} kind={glyph} label={child.label} />
                    <span className="min-w-0 truncate text-foreground">{child.thread.title}</span>
                    <ChildStateText child={child} />
                    {child.result ? (
                      <span
                        className={cn(
                          "rounded-full border px-[7px] py-px text-[10.5px] whitespace-nowrap",
                          PILL_TONE[child.result.tone],
                        )}
                        title={child.result.detail}
                      >
                        {child.result.label}
                      </span>
                    ) : (
                      <span />
                    )}
                    <span
                      aria-hidden
                      className="text-xs text-muted-foreground opacity-0 transition-opacity duration-[calc(var(--app-motion-duration-pop)*0.75)] group-hover/dock-row:opacity-100 group-aria-expanded/dock-row:opacity-100"
                    >
                      ↗
                    </span>
                  </button>
                  {open ? (
                    <DelegationDockChildPeek
                      environmentId={environmentId}
                      child={child}
                      modelLabel={
                        modelDisplayName(child.thread.modelSelection, providers) ??
                        child.thread.modelSelection?.model ??
                        null
                      }
                      threadHref={threadHref(environmentId, child.thread.id)}
                      onOpenThread={() => openThread(child.thread.id)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          {latestLog ? (
            <>
              <button
                type="button"
                aria-expanded={logOpen}
                className={cn(
                  "flex w-full items-center gap-1.5 border-t border-border/65 px-3 py-1.5 text-left text-[11.5px] text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
                  ROW_FOCUS,
                )}
                onClick={() => setLogOpen((open) => !open)}
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 transition-transform duration-(--app-motion-duration-pop)",
                    logOpen && "rotate-90",
                  )}
                />
                Agent Control activity · {log.length}
                <span className="ml-auto whitespace-nowrap">
                  {formatDelegationDockAge(latestLog.at)}
                </span>
              </button>
              {logOpen ? logList : null}
            </>
          ) : null}
        </>
      ) : null}
      {expanded && dockChildren.length === 0 && log.length > 0 ? logList : null}
    </div>
  );
}
