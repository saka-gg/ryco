import { DeviceIcon } from "../DeviceIcon";
import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";
import type { useThreadMenuActions } from "../sidebar/hooks/useThreadMenuActions";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuPopup,
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "../ui/menu";
import { InboxContextHandoffPreview } from "./InboxContextHandoffPreview";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import {
  CheckIcon,
  ClockIcon,
  MoreHorizontalIcon,
  PinIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  InfoIcon,
  SearchIcon,
  Undo2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Input } from "../ui/input";
import { SidebarContent } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildInboxSidebarModel,
  describeInboxFocus,
  type InboxSidebarEnvironment,
  type InboxSidebarRow,
  type InboxSidebarStatusFilter,
} from "./inboxSidebarModel";

type InboxThreadActions = Pick<
  ReturnType<typeof useThreadMenuActions>,
  "listThreadMenuActions" | "performThreadMenuAction"
>;

export interface InboxSidebarProps {
  readonly threadActions?: InboxThreadActions | undefined;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly environments: ReadonlyArray<InboxSidebarEnvironment>;
  readonly deliveryUnknownThreadKeys: ReadonlySet<string>;
  readonly localQueuedThreadKeys: ReadonlySet<string>;
  readonly activeThreadKey: string | null;
  readonly aiFocusEnabled: boolean;
  readonly autoSettleAfterDays: SidebarAutoSettleAfterDays;
  readonly pinnedThreadKeys: ReadonlySet<string>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}

const STATUS_FILTERS: ReadonlyArray<{
  readonly value: InboxSidebarStatusFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All status" },
  { value: "focus", label: "Focus" },
  { value: "active", label: "Active now" },
  { value: "needs-input", label: "Needs input" },
  { value: "recent", label: "Recent" },
  { value: "snoozed", label: "Snoozed" },
  { value: "settled", label: "Settled" },
];

function statusTone(state: InboxSidebarRow["state"]): string {
  switch (state) {
    case "needs-input":
      return "text-warning-foreground";
    case "delivery-unknown":
    case "error":
      return "text-destructive";
    case "working":
      return "text-success-foreground";
    case "connecting":
    case "reconnecting":
      return "text-info-foreground";
    case "offline":
    case "idle":
      return "text-muted-foreground";
  }
}

function InboxThreadRow(props: {
  readonly threadActions?: InboxThreadActions | undefined;
  readonly row: InboxSidebarRow;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onSetSettlement: (row: InboxSidebarRow, settled: boolean) => Promise<boolean>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const ProviderIcon = props.row.providerDriver
    ? (PROVIDER_ICON_BY_PROVIDER[props.row.providerDriver] ?? null)
    : null;
  const WorkspaceIcon = props.row.isWorktree ? GitForkIcon : GitBranchIcon;
  const locationLabel = props.row.isWorktree ? "Worktree" : "Original directory";
  const projectIcon = props.row.project ? (
    <ProjectFavicon
      key={`${props.row.environmentId}:${props.row.project.id}:${props.row.project.customAvatarContentHash ?? ""}`}
      environmentId={props.row.environmentId}
      cwd={props.row.project.cwd}
      projectId={props.row.project.id}
      customAvatarContentHash={props.row.project.customAvatarContentHash ?? null}
      className="size-4 shrink-0"
    />
  ) : (
    <FolderIcon aria-hidden className="size-4 shrink-0 opacity-60" />
  );
  const actionLabel = props.row.settled ? "Move to Active" : "Settle";
  const actionEnabled = props.row.settlementActionEnabled && !pending;
  const actionTitle = actionEnabled
    ? actionLabel
    : (props.row.settlementDisabledReason ?? "Settlement is temporarily unavailable.");
  const timestamp = props.row.settled
    ? (props.row.effectiveSettlementTimestamp ?? props.row.updatedAt)
    : props.row.updatedAt;
  const showPopupStatus = props.row.state !== "idle";
  const focusExplanation = props.row.focus ? describeInboxFocus(props.row.focus) : null;
  const handleSettlement = async () => {
    if (!actionEnabled) return;
    setPending(true);
    try {
      await props.onSetSettlement(props.row, !props.row.settled);
    } finally {
      setPending(false);
    }
  };
  const snoozePresets = useMemo(
    () => (menuOpen ? resolveSnoozePresets(new Date()) : []),
    [menuOpen],
  );
  const handleSnooze = async (snoozedUntil: string | null) => {
    if (pending || !(snoozedUntil ? props.row.canSnooze : props.row.canUnsnooze)) return;
    setPending(true);
    try {
      const api = readEnvironmentApi(props.row.environmentId);
      if (!api) throw new Error("The owning machine is not connected.");
      await api.orchestration.dispatchCommand(
        snoozedUntil
          ? {
              type: "thread.snooze",
              commandId: newCommandId(),
              threadId: props.row.threadId,
              snoozedUntil,
            }
          : { type: "thread.unsnooze", commandId: newCommandId(), threadId: props.row.threadId },
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update snooze",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setPending(false);
    }
  };
  const menuItems = (
    <>
      {props.threadActions?.listThreadMenuActions(props.row.key).map((item) => (
        <MenuItem
          key={item.id}
          variant={item.destructive ? "destructive" : "default"}
          disabled={!props.row.mutationEnabled && ["rename", "archive", "close"].includes(item.id)}
          onClick={() =>
            void props.threadActions?.performThreadMenuAction(
              scopeThreadRef(props.row.environmentId, props.row.threadId),
              item.id,
            )
          }
        >
          {item.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      {props.row.snoozedUntil ? (
        <MenuItem
          disabled={!props.row.canUnsnooze || pending}
          onClick={() => void handleSnooze(null)}
        >
          Unsnooze
        </MenuItem>
      ) : (
        <MenuSub>
          <MenuSubTrigger disabled={!props.row.canSnooze || pending}>Snooze</MenuSubTrigger>
          <MenuSubPopup>
            {snoozePresets.map((preset) => (
              <MenuItem key={preset.id} onClick={() => void handleSnooze(preset.snoozedUntil)}>
                {preset.label}
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  {new Date(preset.snoozedUntil).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      )}
      <MenuItem disabled={!actionEnabled} onClick={() => void handleSettlement()}>
        {actionLabel}
      </MenuItem>
    </>
  );
  const pr = props.row.pullRequest;
  const PrIcon =
    pr?.state === "merged"
      ? GitMergeIcon
      : pr?.state === "closed"
        ? GitPullRequestClosedIcon
        : pr?.isDraft
          ? GitPullRequestDraftIcon
          : GitPullRequestIcon;
  const prLabel = pr
    ? `PR #${pr.number} · ${pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : pr.isDraft ? "Draft" : pr.state === "open" ? "Open" : "Unknown"}`
    : null;
  const prBadge = prLabel ? (
    <span
      aria-label={prLabel}
      title={prLabel}
      className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${pr?.state === "merged" ? "text-violet-500" : pr?.state === "closed" ? "text-destructive" : pr?.state === "open" && !pr.isDraft ? "text-success-foreground" : "text-muted-foreground"}`}
    >
      <PrIcon aria-hidden className="size-3" />
      <span>#{pr?.number}</span>
    </span>
  ) : null;
  const navigationButton = (
    <button
      type="button"
      aria-current={props.active ? "page" : undefined}
      className={`group/row relative flex w-full min-w-0 overflow-hidden rounded-lg border border-transparent text-left outline-hidden ring-ring transition-[background-color,border-color,box-shadow,translate,scale] duration-200 ease-out hover:-translate-y-px hover:border-sidebar-border/60 hover:bg-sidebar-accent hover:shadow-sm/5 focus-visible:ring-2 active:translate-y-0 active:scale-[0.995] motion-reduce:translate-none motion-reduce:scale-100 motion-reduce:transition-colors aria-[current=page]:border-sidebar-border/60 aria-[current=page]:bg-sidebar-accent aria-[current=page]:shadow-xs/5 ${props.row.settled ? "items-center gap-2 px-2.5 py-2 pr-18 text-muted-foreground" : "flex-col gap-1 px-2.5 py-2"}`}
      data-testid="inbox-thread-row"
      onClick={props.onOpen}
    >
      {props.row.settled ? (
        <>
          {projectIcon}
          {props.row.pinned ? (
            <PinIcon aria-label="Pinned thread" className="size-3 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{props.row.title}</span>
          {prBadge}
          {ProviderIcon ? <ProviderIcon className="size-3.5 shrink-0 opacity-65" /> : null}
          <span className="shrink-0 tabular-nums text-[10px] opacity-60 transition-opacity group-hover/inbox-row:opacity-0 group-focus-within/inbox-row:opacity-0">
            {formatRelativeTimeLabel(timestamp)}
          </span>
        </>
      ) : (
        <>
          <div className="flex w-full min-w-0 items-center gap-2 text-[10px] leading-4 text-muted-foreground/70">
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {projectIcon}
              <span className="flex min-w-0 items-center overflow-hidden whitespace-nowrap">
                <span className="truncate text-xs font-medium text-sidebar-foreground/85">
                  {props.row.projectLabel}
                </span>
                <span aria-hidden className="shrink-0 px-1 text-muted-foreground/40">
                  ·
                </span>
                <DeviceIcon
                  environmentId={props.row.environmentId}
                  label={props.row.machineLabel}
                  className="mr-1 size-3 shrink-0"
                />
                <span className="truncate">{props.row.machineLabel}</span>
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground/60 transition-opacity group-hover/inbox-row:opacity-0 group-focus-within/inbox-row:opacity-0">
              {formatRelativeTimeLabel(timestamp)}
            </span>
          </div>
          <div className="flex w-full min-w-0 items-center gap-1.5">
            {props.row.pinned ? (
              <PinIcon
                aria-label="Pinned thread"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4.5 text-sidebar-foreground transition-[translate] duration-200 group-hover/row:translate-x-0.5 motion-reduce:translate-none">
              {props.row.title}
            </span>
          </div>
          <div className="flex w-full min-w-0 items-center gap-1.5 text-[10px] leading-4">
            <span
              className={`inline-flex shrink-0 items-center gap-1 font-medium ${statusTone(props.row.state)}`}
            >
              <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />
              {props.row.snoozedUntil ? (
                <>
                  <ClockIcon aria-hidden className="size-3" />
                  {`Until ${new Date(props.row.snoozedUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`}
                </>
              ) : (
                props.row.statusLabel
              )}
            </span>
            <span aria-hidden className="h-3 w-px shrink-0 bg-sidebar-border/60" />
            <span
              title={locationLabel}
              aria-label={`${locationLabel}: ${props.row.workspaceLabel}`}
              className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground/70"
            >
              <WorkspaceIcon aria-hidden className="size-3 shrink-0 opacity-70" />
              <span className="truncate">{props.row.workspaceLabel}</span>
            </span>
            {prBadge}
            {props.row.trustLabel ? (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                {props.row.trustLabel}
              </span>
            ) : null}
            {props.row.roleLabel ? (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                {props.row.roleLabel}
              </span>
            ) : null}
            <span
              aria-label={
                props.row.providerLabel ? `${props.row.providerLabel} provider` : "Provider"
              }
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-[color,scale] duration-200 group-hover/row:scale-110 group-hover/row:text-sidebar-foreground/85 motion-reduce:scale-100"
              title={props.row.providerLabel ?? "Provider"}
            >
              {ProviderIcon ? (
                <ProviderIcon className="size-3.5" />
              ) : (
                <span className="size-1.5 rounded-full bg-current" />
              )}
            </span>
          </div>
        </>
      )}
    </button>
  );

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        render={<div />}
        className={`group/inbox-row relative [content-visibility:auto] ${props.row.settled ? "[contain-intrinsic-block-size:auto_2rem]" : "[contain-intrinsic-block-size:auto_4.75rem]"}`}
        data-testid="inbox-thread-row-shell"
      >
        <Tooltip open={menuOpen ? false : previewOpen} onOpenChange={setPreviewOpen}>
          <TooltipTrigger closeDelay={80} delay={140} render={navigationButton} />
          <TooltipPopup align="start" className="w-80 p-2.5" side="right" sideOffset={8}>
            <div className="space-y-1.5 text-left">
              <div className="flex min-w-0 items-center gap-3">
                <p
                  className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-popover-foreground"
                  data-testid="inbox-preview-title"
                >
                  {props.row.title}
                </p>
                <span
                  className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] leading-5 tabular-nums ${showPopupStatus ? statusTone(props.row.state) : "text-muted-foreground"}`}
                  data-testid="inbox-preview-status"
                >
                  {showPopupStatus ? (
                    <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />
                  ) : null}
                  {showPopupStatus ? props.row.statusLabel : formatRelativeTimeLabel(timestamp)}
                </span>
              </div>
              <div className="space-y-1 text-[11px] leading-4 text-muted-foreground">
                <div className="flex items-center gap-2">
                  {projectIcon}
                  <span className="truncate">{props.row.projectLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  <DeviceIcon
                    environmentId={props.row.environmentId}
                    label={props.row.machineLabel}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{props.row.machineLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  <WorkspaceIcon
                    aria-label={locationLabel}
                    role="img"
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">
                    {props.row.branchLabel ?? props.row.workspaceLabel}
                  </span>
                </div>
                {props.row.providerLabel ? (
                  <div className="flex items-center gap-2">
                    {ProviderIcon ? (
                      <ProviderIcon className="size-3.5 shrink-0" />
                    ) : (
                      <span aria-hidden className="size-2 rounded-full bg-current" />
                    )}
                    <span className="truncate">
                      {props.row.modelLabel
                        ? `${props.row.providerLabel} · ${props.row.modelLabel}`
                        : props.row.providerLabel}
                    </span>
                  </div>
                ) : null}
                {props.row.changeRequestLabel ? (
                  <div className="flex items-center gap-2">
                    <GitPullRequestIcon aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {props.row.changeRequestStateLabel
                        ? `${props.row.changeRequestLabel} · ${props.row.changeRequestStateLabel}`
                        : props.row.changeRequestLabel}
                    </span>
                  </div>
                ) : null}
                {previewOpen && props.row.modelSelection ? (
                  <InboxContextHandoffPreview
                    key={`${props.row.key}:${props.row.modelSelection.instanceId}:${props.row.modelSelection.model}:${props.row.updatedAt}`}
                    environmentId={props.row.environmentId}
                    threadId={props.row.threadId}
                    selection={props.row.modelSelection}
                  />
                ) : null}
                {focusExplanation ? (
                  <div className="mt-1 border-t border-border/60 pt-1.5">
                    <div className="flex items-start gap-2 text-popover-foreground/85">
                      <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span className="whitespace-normal">
                        <span className="font-medium">Why focused? {focusExplanation.title}.</span>{" "}
                        {focusExplanation.detail}
                      </span>
                    </div>
                    {focusExplanation.aiGenerated && props.row.focus?.ranking ? (
                      <div className="ml-5 mt-1 whitespace-normal text-[10px] text-muted-foreground/75">
                        {props.row.rankingModelLabel ? `${props.row.rankingModelLabel} · ` : ""}
                        ranked {formatRelativeTimeLabel(props.row.focus.ranking.rankedAt)}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </TooltipPopup>
        </Tooltip>
        <button
          aria-disabled={!actionEnabled}
          aria-label={`${actionLabel} ${props.row.title}`}
          className="absolute right-9 top-1.5 z-10 inline-flex h-6 items-center gap-1 rounded-md bg-sidebar-accent/95 px-1.5 text-[10px] font-medium text-sidebar-foreground opacity-0 shadow-xs transition-[opacity,translate] duration-150 translate-x-1 group-hover/inbox-row:translate-x-0 group-hover/inbox-row:opacity-100 group-focus-within/inbox-row:translate-x-0 group-focus-within/inbox-row:opacity-100 focus-visible:translate-x-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground motion-reduce:translate-x-0 motion-reduce:transition-opacity"
          onClick={() => void handleSettlement()}
          title={actionTitle}
          type="button"
        >
          {pending ? (
            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
          ) : props.row.settled ? (
            <Undo2Icon aria-hidden className="size-3" />
          ) : (
            <CheckIcon aria-hidden className="size-3" />
          )}
          <span>{actionLabel}</span>
        </button>
        <Menu onOpenChange={setMenuOpen}>
          <MenuTrigger
            aria-label={`Thread actions for ${props.row.title}`}
            className="absolute right-2 top-1.5 z-10 flex size-6 items-center justify-center rounded-md bg-sidebar-accent text-muted-foreground opacity-0 group-hover/inbox-row:opacity-100 group-focus-within/inbox-row:opacity-100 data-popup-open:opacity-100 focus-visible:opacity-100"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start">{menuItems}</MenuPopup>
        </Menu>
      </ContextMenuTrigger>
      <ContextMenuPopup>{menuItems}</ContextMenuPopup>
    </ContextMenu>
  );
}

export function InboxSidebar(props: InboxSidebarProps) {
  const [query, setQuery] = useState("");
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [status, setStatus] = useState<InboxSidebarStatusFilter>("all");
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settlementNowMs, setSettlementNowMs] = useState(() => Date.now());
  const setThreadSettlement = useCallback(
    async (row: InboxSidebarRow, settled: boolean): Promise<boolean> => {
      const api = readEnvironmentApi(row.environmentId);
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Could not update thread",
          description: "The owning machine is not connected.",
        });
        return false;
      }
      try {
        await api.orchestration.dispatchCommand(
          settled
            ? {
                type: "thread.settle",
                commandId: newCommandId(),
                threadId: row.threadId,
              }
            : {
                type: "thread.unsettle",
                commandId: newCommandId(),
                threadId: row.threadId,
                reason: "user",
              },
        );
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: settled ? "Could not settle thread" : "Could not move thread to Active",
          description: error instanceof Error ? error.message : "The request failed.",
        });
        return false;
      }
    },
    [],
  );
  const model = useMemo(
    () =>
      buildInboxSidebarModel({
        projects: props.projects,
        worktrees: props.worktrees,
        threads: props.threads,
        environments: props.environments,
        filters: { query, environmentId, status },
        deliveryUnknownThreadKeys: props.deliveryUnknownThreadKeys,
        localQueuedThreadKeys: props.localQueuedThreadKeys,
        activeThreadKey: props.activeThreadKey,
        aiFocusEnabled: props.aiFocusEnabled,
        autoSettleAfterDays: props.autoSettleAfterDays,
        pinnedThreadKeys: props.pinnedThreadKeys,
        nowMs: Math.max(settlementNowMs, Date.now()),
      }),
    [
      environmentId,
      props.activeThreadKey,
      props.aiFocusEnabled,
      props.autoSettleAfterDays,
      props.deliveryUnknownThreadKeys,
      props.environments,
      props.localQueuedThreadKeys,
      props.pinnedThreadKeys,
      props.projects,
      props.threads,
      props.worktrees,
      query,
      settlementNowMs,
      status,
    ],
  );
  useEffect(() => {
    if (model.nextSettlementEvaluationAtMs === null) return;
    const maxTimeoutMs = 2_147_483_647;
    const delayMs = Math.min(
      maxTimeoutMs,
      Math.max(1, model.nextSettlementEvaluationAtMs - Date.now() + 1),
    );
    const timer = window.setTimeout(() => setSettlementNowMs(Date.now()), delayMs);
    return () => window.clearTimeout(timer);
  }, [model.nextSettlementEvaluationAtMs]);
  useEffect(() => {
    const refresh = () => setSettlementNowMs(Date.now());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const sections = model.sections;
  const hasFilters = query.trim().length > 0 || environmentId !== null || status !== "all";

  return (
    <SidebarContent className="gap-0 px-2 pb-2" data-testid="inbox-sidebar">
      <div className="sticky top-0 z-10 space-y-1.5 bg-sidebar px-0.5 pb-2 pt-1">
        <label className="relative block">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            aria-label="Search inbox"
            className="bg-sidebar shadow-none [&_[data-slot=input]]:pl-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks"
            size="sm"
            type="search"
            value={query}
          />
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          <select
            aria-label="Filter Inbox by machine"
            className="h-7 min-w-0 rounded-md border border-input bg-sidebar px-2 text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) =>
              setEnvironmentId(event.target.value ? (event.target.value as EnvironmentId) : null)
            }
            value={environmentId ?? ""}
          >
            <option value="">All machines</option>
            {props.environments.map((environment) => (
              <option key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter Inbox by status"
            className="h-7 min-w-0 rounded-md border border-input bg-sidebar px-2 text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setStatus(event.target.value as InboxSidebarStatusFilter)}
            value={status}
          >
            {STATUS_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-xs font-medium text-sidebar-foreground">
            {hasFilters ? "No matching tasks" : "No tasks yet"}
          </p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            {hasFilters
              ? "Try a different search or clear a filter."
              : "Open a project and start a task to see it here."}
          </p>
        </div>
      ) : (
        sections.map((section) => {
          const collapsible = section.key === "settled" || section.key === "snoozed";
          const expanded =
            !collapsible ||
            (section.key === "snoozed" ? snoozedOpen : settledOpen) ||
            status === section.key ||
            query.trim().length > 0;
          return (
            <section
              key={section.key}
              aria-labelledby={`inbox-section-${section.key}`}
              className="pb-2"
            >
              {collapsible ? (
                <button
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    section.key === "snoozed"
                      ? setSnoozedOpen((open) => !open)
                      : setSettledOpen((open) => !open)
                  }
                  type="button"
                >
                  {expanded ? (
                    <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/55" />
                  ) : (
                    <ChevronRightIcon aria-hidden className="size-3 text-muted-foreground/55" />
                  )}
                  <h2
                    id={`inbox-section-${section.key}`}
                    className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/65"
                  >
                    {section.title}
                  </h2>
                  <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/45">
                    {section.rows.length}
                  </span>
                </button>
              ) : (
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <h2
                    id={`inbox-section-${section.key}`}
                    className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/65"
                  >
                    {section.title}
                  </h2>
                  <span className="text-[10px] tabular-nums text-muted-foreground/45">
                    {section.rows.length}
                  </span>
                </div>
              )}
              {expanded ? (
                <div className="space-y-0.5">
                  {section.rows.map((row) => (
                    <InboxThreadRow
                      key={row.key}
                      threadActions={props.threadActions}
                      active={props.activeThreadKey === row.key}
                      onOpen={() =>
                        props.onOpenThread(scopeThreadRef(row.environmentId, row.threadId))
                      }
                      onSetSettlement={setThreadSettlement}
                      row={row}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })
      )}
    </SidebarContent>
  );
}
