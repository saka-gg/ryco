import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { PREFERS_REDUCED_MOTION_QUERY, shouldEnableAutoAnimate } from "../../lib/perf/motion";
import { newCommandId } from "../../lib/utils";
import { sidebarUndo } from "../../sidebarUndo";
import { SIDEBAR_AUTO_ANIMATE_VISIBLE_THREAD_LIMIT } from "../Sidebar.logic";
import { handleSidebarListScroll } from "../sidebar/sidebarFold";
import { omnifieldListQuery } from "../sidebar/sidebarOmnifield.logic";
import { Button } from "../ui/button";
import { SidebarContent } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { TooltipCreateHandle } from "../ui/tooltip";
import { InboxDelegatedGroup } from "./InboxDelegatedGroup";
import { useInboxFilterStore } from "./inboxFilterStore";
import { InboxHoverLayer } from "./InboxHoverLayer";
import type { InboxRowPreviewPayload } from "./InboxRowPreview";
import {
  buildInboxSidebarModel,
  type InboxSidebarEnvironment,
  type InboxSidebarRow,
  type InboxSidebarSectionKey,
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

export function InboxSidebar(props: InboxSidebarProps) {
  // Edited by the sidebar header's Omnifield; a token still being typed narrows nothing.
  const draft = useInboxFilterStore((store) => store.draft);
  const environmentId = useInboxFilterStore((store) => store.environmentId);
  const status = useInboxFilterStore((store) => store.status);
  const publishCounts = useInboxFilterStore((store) => store.publishCounts);
  const query = useMemo(() => omnifieldListQuery(draft), [draft]);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settlementNowMs, setSettlementNowMs] = useState(() => Date.now());
  // The web phone tier is frozen (AGENTS.md): no delegated folding there.
  const nestDelegated = usePresentationTier() !== "phone";
  const [expandedHostKeys, setExpandedHostKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggleHost = useCallback((hostKey: string) => {
    setExpandedHostKeys((previous) => {
      const next = new Set(previous);
      if (next.has(hostKey)) next.delete(hostKey);
      else next.add(hostKey);
      return next;
    });
  }, []);
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
        nestDelegated,
        nowMs: Math.max(settlementNowMs, Date.now()),
      }),
    [
      environmentId,
      nestDelegated,
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
  useEffect(() => {
    const counts: Partial<Record<InboxSidebarSectionKey, number>> = {};
    let total = 0;
    for (const section of sections) {
      counts[section.key] = section.rows.length;
      total += section.rows.length;
    }
    publishCounts(total, status === "all" ? counts : null);
  }, [publishCounts, sections, status]);
  const hasFilters = query.trim().length > 0 || environmentId !== null || status !== "all";
  const hasNoProjects = props.projects.length === 0;
  const isExpanded = (key: string) =>
    (key !== "settled" && key !== "snoozed") ||
    (key === "snoozed" ? snoozedOpen : settledOpen) ||
    status === key ||
    query.trim().length > 0;
  // A host stays open while the open thread is one of its folded children.
  const isHostExpanded = (row: InboxSidebarRow) =>
    expandedHostKeys.has(row.key) ||
    row.delegatedChildren.some((child) => child.key === props.activeThreadKey);
  const visibleRowKeys = (row: InboxSidebarRow) =>
    isHostExpanded(row) && row.delegatedChildren.length > 0
      ? [row.key, ...row.delegatedChildren.map((child) => child.key)]
      : [row.key];
  const orderSignature = sections
    .map((section) =>
      isExpanded(section.key)
        ? `${section.key}:${section.rows.flatMap(visibleRowKeys).join(",")}`
        : section.key,
    )
    .join("|");
  const rowCount = sections.reduce(
    (total, section) => total + section.rows.flatMap(visibleRowKeys).length,
    0,
  );
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
  const renderRow = (row: InboxSidebarRow) => (
    <InboxThreadRow
      threadActions={props.threadActions}
      active={props.activeThreadKey === row.key}
      motionEnabled={motionEnabled}
      previewHandle={previewHandle}
      onOpen={() => props.onOpenThread(scopeThreadRef(row.environmentId, row.threadId))}
      onSetSettlement={setThreadSettlement}
      row={row}
    />
  );

  return (
    <InboxMotionContext value={gateRef}>
      <SidebarContent
        className="gap-0 px-2 pt-1 pb-2"
        data-testid="inbox-sidebar"
        onViewportScroll={handleSidebarListScroll}
      >
        <InboxHoverLayer hintHandle={hintHandle} previewHandle={previewHandle}>
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
                          <Fragment key={row.key}>
                            {renderRow(row)}
                            {row.delegatedChildren.length > 0 ? (
                              <InboxDelegatedGroup
                                count={row.delegatedChildren.length}
                                expanded={isHostExpanded(row)}
                                hostTitle={row.title}
                                onToggle={() => toggleHost(row.key)}
                              >
                                {row.delegatedChildren.map((child) => (
                                  <Fragment key={child.key}>{renderRow(child)}</Fragment>
                                ))}
                              </InboxDelegatedGroup>
                            ) : null}
                          </Fragment>
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
