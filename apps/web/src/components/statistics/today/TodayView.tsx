import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { projectPlaceLabel } from "@ryco/client-runtime/state/composer";
import {
  createWaitingThreadCountSelector,
  summarizeRecapUsage,
  type DailyRecapDigestInput,
  type MergedDailyRecapThread,
} from "@ryco/client-runtime/state/dailyRecap";
import {
  selectOpenTaskViews,
  useLocalTasksStore,
  type LocalTaskView,
} from "@ryco/client-runtime/state/tasks";
import { calendarDateInZone, currentTimeZone } from "@ryco/client-runtime/usage";
import { WS_METHODS, type EnvironmentId, type ThreadId } from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { isHostedHubMode } from "~/env";
import { useLocalDayNow } from "~/hooks/useLocalDayNow";
import { useHostedRpcCapability } from "~/hostedHub/capabilities";
import { formatDayLabel } from "~/lib/statisticsFormat";
import { selectEnvironmentState, useStore } from "~/store";
import { buildThreadRouteParams } from "~/threadRoutes";

import { dueDayDiff } from "../../tasks/taskDue.logic";
import { useLocalTasksSync } from "../../tasks/useLocalTasks";
import { tasksAvailable, useTasksEnvironment } from "../../tasks/useTasksEnvironment";
import type { StatisticsSearch } from "../statisticsSearch";
import { useUsageSummary } from "../useUsageSummary";
import { TodayRecapView } from "./TodayRecapView";
import { TODAY_USAGE_RANGE, useDailyRecap } from "./useDailyRecap";

const NO_TASKS: ReadonlyArray<LocalTaskView> = [];

const weekdayName = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

/** "Today, Fri Oct 24": the local day the Today view recaps, for the page header. */
export function TodayWindowLabel() {
  const nowMs = useLocalDayNow();
  const date = calendarDateInZone(nowMs, currentTimeZone());
  const weekday = weekdayName.format(Date.parse(`${date}T12:00:00.000Z`));
  return `Today, ${weekday} ${formatDayLabel(date)}`;
}

/**
 * The Today view: the daily recap of the selected devices, with provider
 * usage, open tasks due and chats waiting on the user woven in. This is the
 * wiring between the presentational `TodayRecapView` and the data.
 */
export function TodayView({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  const nowMs = useLocalDayNow();
  const recap = useDailyRecap({ environmentIds: search.environmentIds, nowMs });
  // hosted-capability: routed node
  const usageAllowed = useHostedRpcCapability(WS_METHODS.serverGetUsageSummary, null).allowed;
  const usageSummary = useUsageSummary({
    range: TODAY_USAGE_RANGE,
    environmentIds: search.environmentIds,
    nowMs,
    enabled: usageAllowed,
  });

  const selectedIds = useMemo(() => recap.nodes.map((node) => node.environmentId), [recap.nodes]);
  const recappedIds = useMemo(
    () => recap.nodes.flatMap((node) => (node.recap === undefined ? [] : [node.environmentId])),
    [recap.nodes],
  );
  const date = calendarDateInZone(nowMs, currentTimeZone());
  // Every selected device is asked, but only those in the recap add tokens.
  const usage = useMemo(
    () => summarizeRecapUsage(usageSummary.environments, recappedIds, date),
    [date, recappedIds, usageSummary.environments],
  );
  const tasks = useDueTasks(nowMs, selectedIds);
  const waitingThreads = useWaitingThreadCount(recappedIds);
  const projectLabel = useProjectPlaceLabel(recappedIds);

  const navigate = useNavigate();
  const { refresh: refreshRecap } = recap;
  const { refresh: refreshUsage } = usageSummary;
  const refresh = useCallback(() => {
    refreshRecap();
    refreshUsage();
  }, [refreshRecap, refreshUsage]);
  const openThread = useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      }),
    [navigate],
  );
  const openTasks = useCallback(() => void navigate({ to: "/tasks" }), [navigate]);

  return (
    <TodayRecapView
      search={search}
      onSearchChange={onSearchChange}
      recap={recap}
      usage={usage}
      tasks={tasks}
      waitingThreads={waitingThreads}
      hosted={isHostedHubMode()}
      projectLabel={projectLabel}
      onRefresh={refresh}
      onOpenThread={openThread}
      onOpenTasks={openTasks}
    />
  );
}

/**
 * Open tasks due today and overdue, while the tasks' device is selected;
 * null otherwise or where it has no tasks.
 */
function useDueTasks(
  nowMs: number,
  environmentIds: readonly EnvironmentId[],
): DailyRecapDigestInput["tasks"] {
  const tasksEnvironment = useTasksEnvironment();
  const environmentId =
    tasksAvailable(tasksEnvironment) && environmentIds.includes(tasksEnvironment.environmentId)
      ? tasksEnvironment.environmentId
      : null;
  useLocalTasksSync(environmentId, environmentId !== null);
  const openTasks = useLocalTasksStore((state) =>
    environmentId === null ? NO_TASKS : selectOpenTaskViews(state, environmentId),
  );
  return useMemo(() => {
    if (environmentId === null) return null;
    let dueToday = 0;
    let overdue = 0;
    for (const task of openTasks) {
      const days = task.dueAt === null ? null : dueDayDiff(task.dueAt, nowMs);
      if (days === 0) dueToday += 1;
      else if (days !== null && days < 0) overdue += 1;
    }
    return { dueToday, overdue };
  }, [environmentId, nowMs, openTasks]);
}

/** Chats on `environmentIds` waiting on the user for an approval or an answer. */
function useWaitingThreadCount(environmentIds: readonly EnvironmentId[]): number {
  const selectWaiting = useMemo(() => createWaitingThreadCountSelector(), []);
  return useStore((state) => selectWaiting(state, environmentIds));
}

/** Names a listed chat's place from the devices' projects: a chat's own folder is "No project". */
function useProjectPlaceLabel(
  environmentIds: readonly EnvironmentId[],
): (thread: MergedDailyRecapThread) => string {
  const projects = useStore(
    useShallow((state) =>
      environmentIds.map(
        (environmentId) => selectEnvironmentState(state, environmentId).projectById,
      ),
    ),
  );
  return useMemo(() => {
    const projectsByEnvironment = new Map(
      environmentIds.map((environmentId, index) => [environmentId, projects[index]]),
    );
    return (thread) =>
      projectPlaceLabel(
        projectsByEnvironment.get(thread.environmentId)?.[thread.projectId],
        thread.projectTitle,
      );
  }, [environmentIds, projects]);
}
