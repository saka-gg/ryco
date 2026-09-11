import { DeviceIcon } from "./DeviceIcon";
import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { VcsStatusResult } from "@ryco/contracts";
import { TerminalIcon, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useGitStatus } from "../lib/gitStatusState";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveChangeRequestStateBadgeVariant } from "./sourceControl/stateBadgeVariants";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
  Icon: LucideIcon;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);
  const variant = resolveChangeRequestStateBadgeVariant(pr.state);
  return {
    label: `${presentation.shortName} ${pr.state}`,
    colorClass: variant.textClassName,
    tooltip: `#${pr.number} ${presentation.shortName} ${pr.state}: ${pr.title}`,
    url: pr.url,
    Icon: variant.Icon,
  };
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
  };
}

export function ThreadStatusLabel({
  status,
  compact = false,
  alwaysShowLabel = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
  /**
   * Render the text label at every width. Phone surfaces set this so status
   * is always conveyed as text plus indicator, never the dot alone.
   */
  alwaysShowLabel?: boolean;
}) {
  const dotSizeClass = compact ? "size-[9px]" : "size-1.5";
  const statusDot = status.pulse ? (
    <span className={`status-activity-signal ${dotSizeClass}`}>
      <span className={`size-full rounded-full ${status.dotClass}`} />
    </span>
  ) : (
    <span className={`${dotSizeClass} rounded-full ${status.dotClass}`} />
  );

  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        {statusDot}
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
    >
      {statusDot}
      <span className={alwaysShowLabel ? undefined : "hidden md:inline"}>{status.label}</span>
    </span>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({
  thread,
  alwaysShowStatusLabel = false,
}: {
  thread: SidebarThreadSummary;
  alwaysShowStatusLabel?: boolean;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const PrStatusIcon = prStatus?.Icon;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!prStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus && PrStatusIcon ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <PrStatusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? (
        <ThreadStatusLabel status={threadStatus} alwaysShowLabel={alwaysShowStatusLabel} />
      ) : null}
    </span>
  );
}

/**
 * Plain-text change-request detail for phone action sheets. Desktop exposes
 * the PR number, state, and title only in a hover tooltip; phone surfaces
 * include this line in the thread's kebab sheet so the detail stays
 * reachable by touch. Renders nothing when the thread has no change request.
 */
export function ThreadStatusDetailLine({ thread }: { thread: SidebarThreadSummary }) {
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);

  if (!prStatus) {
    return null;
  }
  const PrStatusIcon = prStatus.Icon;

  return (
    <p
      data-thread-status-detail="true"
      className="flex items-start gap-1.5 px-2 pb-2 text-xs text-muted-foreground"
    >
      <PrStatusIcon className={`mt-0.5 size-3 shrink-0 ${prStatus.colorClass}`} />
      <span className="min-w-0 flex-1 wrap-break-word">{prStatus.tooltip}</span>
    </p>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <span
          role="img"
          aria-label={terminalStatus.label}
          title={terminalStatus.label}
          className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
        >
          <TerminalIcon className="size-3" />
        </span>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <DeviceIcon
              environmentId={thread.environmentId}
              label={threadEnvironmentLabel ?? "Remote"}
              className="size-3 text-muted-foreground/60"
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
