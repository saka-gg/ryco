import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentId, ServerProvider, StatisticsSnapshot } from "@ryco/contracts";
import {
  mergeUsageEnvironmentResults,
  SupersedingLoads,
  USAGE_UPDATE_MESSAGE,
  usageSummaryCache,
  type UsageEnvironmentResult,
  type StatRange,
} from "@ryco/client-runtime/usage";
import { readRpcClient } from "../../../connection/environmentApi";
import type { InboxEnvironment } from "../../inbox/inboxModel";

export type StatisticsTab = "usage" | "activity" | "limits";
export interface NodeStatistics {
  readonly environment: InboxEnvironment;
  readonly activity?: StatisticsSnapshot;
  readonly usage?: UsageEnvironmentResult;
  readonly providers?: readonly ServerProvider[];
  readonly error?: string;
}

/** Why this device is not asked for statistics right now, or `null` when it is. */
function statisticsUnavailableReason(environment: InboxEnvironment): string | null {
  if (environment.connectionState !== "connected" && environment.connectionState !== "read-only")
    return "Connect this device to load current data.";
  if (environment.role === "viewer" || environment.role === "operator")
    return "Statistics and provider limits require owner access on this device.";
  return null;
}

export interface NodeStatisticsLoadOptions {
  /** The caller stops waiting when this aborts; an abandoned usage scan is withdrawn. */
  readonly signal?: AbortSignal;
  /** An explicit refresh (see `SharedRequestOptions.fresh`). */
  readonly fresh?: boolean;
}

export async function loadNodeStatistics(
  environment: InboxEnvironment,
  tab: StatisticsTab,
  range: StatRange,
  options: NodeStatisticsLoadOptions = {},
): Promise<NodeStatistics> {
  try {
    const unavailable = statisticsUnavailableReason(environment);
    if (unavailable !== null) throw new Error(unavailable);
    const api = readRpcClient(environment.environmentId);
    if (!api) throw new Error("This device is reconnecting. Try again when it is connected.");
    if (tab === "activity") return { environment, activity: await api.server.getStatistics() };
    if (tab === "limits") {
      const refreshed = await api.server.refreshProviders();
      return { environment, providers: refreshed.providers };
    }
    // The shared cache classifies the answer, joins an identical request already
    // in flight, and keeps the last usable summary for the next visit.
    const usage = await usageSummaryCache.load(
      {
        environmentId: environment.environmentId,
        label: environment.label,
        getUsageSummary: (request, requestOptions) =>
          api.server.getUsageSummary(request, requestOptions),
      },
      range,
      usageTimeZone(),
      { signal: options.signal, fresh: options.fresh },
    );
    if (usage.status === "complete" || usage.status === "partial") return { environment, usage };
    return {
      environment,
      usage,
      error:
        usage.status === "stale-contract"
          ? USAGE_UPDATE_MESSAGE
          : (usage.message ?? "Usage could not be loaded from this device."),
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return {
      environment,
      error,
      ...(tab === "usage"
        ? {
            usage: {
              environmentId: environment.environmentId,
              label: environment.label,
              status: "failed" as const,
              message: error,
            },
          }
        : {}),
    };
  }
}

/**
 * Each device's last usable usage summary for this range, under its current
 * label. A device that will not be asked (offline, or without owner access)
 * shows none: its answer is about to be that error, not the old summary.
 */
export function cachedNodeUsage(
  environments: readonly InboxEnvironment[],
  range: StatRange,
  timeZone = usageTimeZone(),
): UsageEnvironmentResult[] {
  return environments.flatMap((environment) => {
    if (statisticsUnavailableReason(environment) !== null) return [];
    const cached = usageSummaryCache.peek(environment.environmentId, range, timeZone);
    return cached === undefined ? [] : [{ ...cached, label: environment.label }];
  });
}

function usageTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** What one device's answer is for: a change to any part asks that device again. */
function nodeScope(environment: InboxEnvironment, tab: StatisticsTab, range: StatRange): string {
  // Activity snapshots and provider limits do not depend on the date range.
  const view = tab === "usage" ? `${tab}:${range}` : tab;
  return JSON.stringify([
    view,
    environment.environmentId,
    environment.label,
    environment.connectionState,
    environment.role,
  ]);
}

/** One device's answer, tagged with what it answered. */
export interface NodeAnswer {
  readonly scope: string;
  readonly requestKey: string;
  readonly node: NodeStatistics;
}

export function nodeAnswer(
  environment: InboxEnvironment,
  tab: StatisticsTab,
  range: StatRange,
  revision: number,
  node: NodeStatistics,
): NodeAnswer {
  const scope = nodeScope(environment, tab, range);
  return { scope, requestKey: nodeRequestKey(scope, revision), node };
}

function nodeRequestKey(scope: string, revision: number): string {
  return `${scope}:${revision}`;
}

/**
 * What the screen shows for the selected devices: every device that answered
 * this request (or an earlier refresh of it, while it reloads), and for usage
 * the last usable summary of the devices that have not answered yet.
 */
export function deriveStatisticsView(
  selected: readonly InboxEnvironment[],
  answers: ReadonlyMap<EnvironmentId, NodeAnswer>,
  tab: StatisticsTab,
  range: StatRange,
  revision: number,
) {
  const nodes: NodeStatistics[] = [];
  const usageResults: UsageEnvironmentResult[] = [];
  let pending = 0;
  let refreshing = false;
  for (const environment of selected) {
    const scope = nodeScope(environment, tab, range);
    const answer = answers.get(environment.environmentId);
    // An earlier refresh of the same request stays on screen while it reloads.
    const visible = answer?.scope === scope ? answer.node : undefined;
    const answered = answer?.requestKey === nodeRequestKey(scope, revision);
    if (!answered) pending++;
    if (!answered && visible !== undefined) refreshing = true;
    if (visible !== undefined) nodes.push(visible);
    if (tab !== "usage") continue;
    if (visible?.usage !== undefined) {
      usageResults.push(visible.usage);
    } else if (visible === undefined) {
      // Until this range answers, show its last usable summary (stale while
      // revalidating) instead of an empty screen.
      usageResults.push(...cachedNodeUsage([environment], range));
    }
  }
  return {
    nodes,
    usage: tab === "usage" ? mergeUsageEnvironmentResults(usageResults) : null,
    loading: pending > 0,
    refreshing,
  };
}

export function useStatisticsData(
  environments: readonly InboxEnvironment[],
  tab: StatisticsTab,
  range: StatRange,
) {
  const [revision, setRevision] = useState(0);
  // Only connection/selection changes invalidate a request, not unrelated live config pushes.
  const key = JSON.stringify(
    environments.map(({ environmentId, label, connectionState, role }) => ({
      environmentId,
      label,
      connectionState,
      role,
    })),
  );
  const selected = useMemo(() => JSON.parse(key) as InboxEnvironment[], [key]);
  // The latest answer per device, tagged with the request it answered.
  const [answers, setAnswers] = useState<ReadonlyMap<EnvironmentId, NodeAnswer>>(() => new Map());
  // The request each device last answered, for the effect (state stays the render source).
  const answeredRequests = useRef(new Map<EnvironmentId, string>());
  // Devices answer one by one (a slow or hung device never hides the others),
  // and a range switch withdraws the scans it superseded.
  const loads = useRef(new SupersedingLoads());
  const handledRevision = useRef(revision);
  useEffect(() => {
    const fresh = revision !== handledRevision.current;
    handledRevision.current = revision;
    loads.current.run(
      // A device whose request already answered (another device changed) is not asked again.
      selected.filter(
        (environment) =>
          answeredRequests.current.get(environment.environmentId) !==
          nodeRequestKey(nodeScope(environment, tab, range), revision),
      ),
      (environment, signal) => loadNodeStatistics(environment, tab, range, { signal, fresh }),
      (environment, node) => {
        const answer = nodeAnswer(environment, tab, range, revision, node);
        answeredRequests.current.set(environment.environmentId, answer.requestKey);
        setAnswers((previous) => new Map(previous).set(environment.environmentId, answer));
      },
    );
  }, [range, revision, selected, tab]);

  const view = useMemo(
    () => deriveStatisticsView(selected, answers, tab, range, revision),
    [answers, range, revision, selected, tab],
  );
  return {
    nodes: view.nodes,
    loading: view.loading,
    refreshing: view.refreshing,
    refresh: () => setRevision((value) => value + 1),
    usage: view.usage,
  };
}
