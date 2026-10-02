import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import { ChevronDownIcon, ChevronRightIcon, ListFilterIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { PREFERS_REDUCED_MOTION_QUERY, shouldEnableAutoAnimate } from "../../lib/perf/motion";
import { newCommandId } from "../../lib/utils";
import { sidebarUndo } from "../../sidebarUndo";
import { SIDEBAR_AUTO_ANIMATE_VISIBLE_THREAD_LIMIT } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarContent } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { TooltipCreateHandle } from "../ui/tooltip";
import { InboxHoverLayer } from "./InboxHoverLayer";
import type { InboxRowPreviewPayload } from "./InboxRowPreview";
import {
  buildInboxSidebarModel,
  type InboxSidebarEnvironment,
  type InboxSidebarRow,
  type InboxSidebarStatusFilter,
} from "./inboxSidebarModel";
import { InboxThreadRow, type InboxThreadActions } from "./InboxThreadRow";
import { InboxMotionContext, useInboxListMotion } from "./useInboxListMotion";

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
  /** Rows on other machines are labelled; this one is implicit. */
  readonly primaryEnvironmentId?: EnvironmentId | null | undefined;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
  /** Offered from the empty state when no project exists yet; omit when adding is unavailable. */
  readonly onAddProject?: (() => void) | undefined;
}

const STATUS_FILTERS: ReadonlyArray<{
  readonly value: InboxSidebarStatusFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All status" },
  { value: "pinned", label: "Pinned" },
  { value: "focus", label: "Focus" },
  { value: "active", label: "Active now" },
  { value: "needs-input", label: "Needs input" },
  { value: "recent", label: "Recent" },
  { value: "snoozed", label: "Snoozed" },
  { value: "settled", label: "Settled" },
];

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
        await sidebarUndo.dispatch(
          { environmentId: row.environmentId, threadId: row.threadId },
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
        primaryEnvironmentId: props.primaryEnvironmentId ?? null,
        nowMs: Math.max(settlementNowMs, Date.now()),
      }),
    [
      environmentId,
      props.primaryEnvironmentId,
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
  const hasNoProjects = props.projects.length === 0;
  const isExpanded = (key: string) =>
    (key !== "settled" && key !== "snoozed") ||
    (key === "snoozed" ? snoozedOpen : settledOpen) ||
    status === key ||
    query.trim().length > 0;
  const orderSignature = sections
    .map((section) =>
      isExpanded(section.key)
        ? `${section.key}:${section.rows.map((row) => row.key).join(",")}`
        : section.key,
    )
    .join("|");
  const rowCount = sections.reduce((total, section) => total + section.rows.length, 0);
  const prefersReducedMotion = useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);
  const motionEnabled = shouldEnableAutoAnimate({
    prefersReducedMotion,
    withinThreshold: rowCount <= SIDEBAR_AUTO_ANIMATE_VISIBLE_THREAD_LIMIT,
  });
  const { listRef, highlightRef, gateRef, onPointerMove, onPointerLeave } = useInboxListMotion({
    enabled: motionEnabled,
    orderSignature,
  });
  const [previewHandle] = useState(() => TooltipCreateHandle<InboxRowPreviewPayload>());
  const [hintHandle] = useState(() => TooltipCreateHandle<ReactNode>());

  return (
    <InboxMotionContext value={gateRef}>
      <SidebarContent className="gap-0 px-2 pb-2" data-testid="inbox-sidebar">
        <InboxHoverLayer hintHandle={hintHandle} previewHandle={previewHandle}>
          <div className="sticky top-0 z-10 space-y-1.5 bg-sidebar px-0.5 pb-2 pt-1">
            <label className="relative block">
              {/* "Filter", not "Search": the command palette above searches
                  everything, this only narrows the list below. */}
              <ListFilterIcon className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                aria-label="Filter inbox"
                className="bg-sidebar shadow-none [&_[data-slot=input]]:pl-8"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter tasks"
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
                  setEnvironmentId(
                    event.target.value ? (event.target.value as EnvironmentId) : null,
                  )
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
                {hasFilters
                  ? "No matching tasks"
                  : hasNoProjects
                    ? "No projects yet"
                    : "No tasks yet"}
              </p>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {hasFilters
                  ? "Change or clear a filter to see more tasks."
                  : hasNoProjects
                    ? "Add a folder or clone a repository to start your first task."
                    : "Open a project and start a task to see it here."}
              </p>
              {!hasFilters && hasNoProjects && props.onAddProject ? (
                <Button
                  className="mt-1"
                  data-testid="inbox-add-project-button"
                  onClick={props.onAddProject}
                  size="xs"
                  variant="outline"
                >
                  Add project
                </Button>
              ) : null}
            </div>
          ) : (
            <div
              ref={listRef}
              className="relative"
              onPointerLeave={onPointerLeave}
              onPointerMove={onPointerMove}
            >
              <div
                ref={highlightRef}
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 rounded-lg bg-sidebar-accent opacity-0 scale-[0.985] transition-[transform,height,opacity,scale] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle) motion-reduce:transition-none data-[visible=true]:scale-100 data-[visible=true]:opacity-100"
                data-visible="false"
              />
              {sections.map((section) => {
                const collapsible = section.key === "settled" || section.key === "snoozed";
                const expanded = isExpanded(section.key);
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
                          <ChevronDownIcon
                            aria-hidden
                            className="size-3 text-muted-foreground/55"
                          />
                        ) : (
                          <ChevronRightIcon
                            aria-hidden
                            className="size-3 text-muted-foreground/55"
                          />
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
                      <div className="space-y-px">
                        {section.rows.map((row) => (
                          <InboxThreadRow
                            key={row.key}
                            threadActions={props.threadActions}
                            active={props.activeThreadKey === row.key}
                            motionEnabled={motionEnabled}
                            previewHandle={previewHandle}
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
              })}
            </div>
          )}
        </InboxHoverLayer>
      </SidebarContent>
    </InboxMotionContext>
  );
}
