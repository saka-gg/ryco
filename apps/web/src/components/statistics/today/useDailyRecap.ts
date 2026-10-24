import {
  createLatestTurnCompletionSelector,
  DAILY_RECAP_FOCUS_STALE_MS,
  DAILY_RECAP_POLL_MS,
  dailyRecapCache,
  dailyRecapRequest,
  hostedDailyRecapReadiness,
  mergeDailyRecaps,
  nextCompletionRefreshDelay,
  nodesWithNewTurnCompletions,
  previousDayRecapRequest,
  savedDailyRecapReadiness,
  type DailyRecapNodeResult,
  type DailyRecapReadiness,
  type DailyRecapTarget,
  type MergedDailyRecap,
  type ReadyDailyRecap,
} from "@ryco/client-runtime/state/dailyRecap";
import { calendarDateInZone, currentTimeZone, SupersedingLoads } from "@ryco/client-runtime/usage";
import { WS_METHODS, type DailyRecapRequest, type EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { isHostedHubMode } from "~/env";
import {
  listEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { readHostedRpcCapability, subscribeHostedRpcCapabilities } from "~/hostedHub/capabilities";
import { useStore } from "~/store";

import type { StatisticsRange } from "../statisticsSearch";
import {
  selectConnections,
  useStatisticsEnvironments,
  type StatisticsEnvironments,
} from "../useConnectedEnvironments";

type EnvironmentConnection = ReturnType<typeof listEnvironmentConnections>[number];

/** The provider usage range Today reads its two days from: the shortest that holds both. */
export const TODAY_USAGE_RANGE = "7d" satisfies StatisticsRange;

function recapTarget(connection: EnvironmentConnection): DailyRecapTarget {
  return {
    environmentId: connection.environmentId,
    label: connection.knownEnvironment.label,
    getDailyRecap: (request, options) => connection.client.server.getDailyRecap(request, options),
  };
}

function readRecapReadiness(connection: EnvironmentConnection): DailyRecapReadiness {
  if (isHostedHubMode()) {
    return hostedDailyRecapReadiness(
      readHostedRpcCapability(WS_METHODS.serverGetDailyRecap, connection.environmentId),
    );
  }
  if (connection.kind === "primary") return "ask";
  return savedDailyRecapReadiness(
    useSavedEnvironmentRuntimeStore.getState().byId[connection.environmentId],
  );
}

function subscribeRecapReadiness(listener: () => void): () => void {
  const unsubscribeHosted = subscribeHostedRpcCapabilities(listener);
  const unsubscribeSaved = useSavedEnvironmentRuntimeStore.subscribe(() => listener());
  return () => {
    unsubscribeHosted();
    unsubscribeSaved();
  };
}

/** Each connection's readiness, kept as one object while no answer changes. */
function useRecapReadiness(
  connections: readonly EnvironmentConnection[],
): ReadonlyMap<EnvironmentId, DailyRecapReadiness> {
  const snapshot = useRef<{
    readonly key: string;
    readonly readiness: ReadonlyMap<EnvironmentId, DailyRecapReadiness>;
  } | null>(null);
  const read = useCallback(() => {
    const readiness = new Map(
      connections.map((connection) => [connection.environmentId, readRecapReadiness(connection)]),
    );
    const key = [...readiness].map((entry) => entry.join("\0")).join("\n");
    if (snapshot.current?.key !== key) snapshot.current = { key, readiness };
    return snapshot.current.readiness;
  }, [connections]);
  return useSyncExternalStore(subscribeRecapReadiness, read, read);
}

/**
 * Start the recap requests the Today view will make (route loader, link
 * intent). The view joins them while they run, or takes their answers if they
 * settled just before it mounted. A node the view would not ask is not asked.
 */
export function prefetchDailyRecap(environmentIds?: readonly string[] | undefined): void {
  const request = dailyRecapRequest(Date.now(), currentTimeZone());
  for (const connection of selectConnections(listEnvironmentConnections(), environmentIds)) {
    if (readRecapReadiness(connection) !== "ask") continue;
    dailyRecapCache.prefetch(recapTarget(connection), request);
  }
}

interface Answer {
  readonly key: string;
  readonly result: DailyRecapNodeResult;
}

/**
 * Each target's latest answer, tagged with the key it answered. A target is
 * asked when it has no answer for its current key. Answers arrive one by one
 * (a slow node never hides a fast one), and a newer run supersedes an older
 * one. A target that leaves the list forgets its answer, so it is asked again
 * when it comes back: a node that reconnects may have missed finished turns.
 */
function useLatestAnswers(
  targets: readonly EnvironmentConnection[],
  keyOf: (target: EnvironmentConnection) => string,
  load: (target: EnvironmentConnection, signal: AbortSignal) => Promise<DailyRecapNodeResult>,
): ReadonlyMap<EnvironmentId, Answer> {
  const [answers, setAnswers] = useState<ReadonlyMap<EnvironmentId, Answer>>(() => new Map());
  // The key each target last answered, for the effect (state stays the render source).
  const answered = useRef(new Map<EnvironmentId, string>());
  const loads = useRef(new SupersedingLoads());
  useEffect(() => {
    const listed = new Set(targets.map((target) => target.environmentId));
    const left = [...answered.current.keys()].filter((environmentId) => !listed.has(environmentId));
    if (left.length > 0) {
      for (const environmentId of left) answered.current.delete(environmentId);
      setAnswers((previous) => {
        const next = new Map(previous);
        for (const environmentId of left) next.delete(environmentId);
        return next;
      });
    }
    const keys = new Map(targets.map((target) => [target.environmentId, keyOf(target)]));
    loads.current.run(
      targets.filter(
        (target) => answered.current.get(target.environmentId) !== keys.get(target.environmentId),
      ),
      load,
      (target, result) => {
        const key = keys.get(target.environmentId) ?? "";
        answered.current.set(target.environmentId, key);
        setAnswers((previous) => new Map(previous).set(target.environmentId, { key, result }));
      },
    );
  }, [keyOf, load, targets]);
  return answers;
}

/** One selected node of the recap. */
export interface DailyRecapNodeView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /**
   * Its latest answer for the day, kept while it is asked again, or why it was
   * not asked; undefined until its first answer of the day or while its
   * session is still being set up.
   */
  readonly result: DailyRecapNodeResult | undefined;
  /**
   * The recap merged for it: its answer, else the last one this client
   * received for the day, else none. A node that refuses access shows none.
   */
  readonly recap: ReadyDailyRecap | undefined;
  /** `recap` is that earlier one: the node has no answer today yet, or its latest is no recap. */
  readonly stale: boolean;
}

export interface UseDailyRecapResult {
  /** Today across the selected nodes that have a recap; null when none has. */
  readonly today: MergedDailyRecap | null;
  /** The day before, from the nodes in `today`; null until one of them answers. */
  readonly yesterday: MergedDailyRecap | null;
  readonly nodes: readonly DailyRecapNodeView[];
  readonly availableEnvironments: StatisticsEnvironments["availableEnvironments"];
  /** Selected nodes without an answer for the day yet. */
  readonly pendingEnvironmentIds: readonly EnvironmentId[];
  readonly connecting: StatisticsEnvironments["connecting"];
  /** Some selected node has no answer for the day yet. */
  readonly loading: boolean;
  /** Some node that already answered is being asked again. */
  readonly refreshing: boolean;
  /** Ask every selected node again for today and the day before. */
  readonly refresh: () => void;
}

/**
 * The daily recap of the local day that contains `nowMs`, merged across the
 * selected connected nodes. Today is asked again when a node finishes a turn
 * (only that node, at most every 20 s), every 5 minutes while the page is
 * visible, when the page comes back after a minute or more, and on a new day.
 * The day before is asked once per node after its today answers, and again
 * only on {@link UseDailyRecapResult.refresh}.
 */
export function useDailyRecap(input: {
  readonly environmentIds?: readonly string[] | undefined;
  /** A time on the local day to recap; a new day asks again. */
  readonly nowMs: number;
}): UseDailyRecapResult {
  const { selected, availableEnvironments, connecting } = useStatisticsEnvironments(
    input.environmentIds,
  );
  const readiness = useRecapReadiness(selected);
  const timeZone = currentTimeZone();
  const date = calendarDateInZone(input.nowMs, timeZone);
  const todayRequest = useMemo((): DailyRecapRequest => ({ date, timeZone }), [date, timeZone]);
  const yesterdayRequest = useMemo(() => previousDayRecapRequest(todayRequest), [todayRequest]);
  const dayKey = `${date}\0${timeZone}`;

  // Every node asked again for today (refresh, poll, focus): how often, and when last (at
  // first, when the view opened). The poll and the focus check count from that time.
  const [todayRefresh, setTodayRefresh] = useState(() => ({ count: 0, atMs: Date.now() }));
  // Every node asked again for the day before (refresh).
  const [yesterdayRefresh, setYesterdayRefresh] = useState(0);
  // Single nodes asked again for today because they finished a turn.
  const [revisions, setRevisions] = useState<ReadonlyMap<EnvironmentId, number>>(() => new Map());
  // When a node's newest finished turn moved: an answer to an earlier request may miss it.
  const finishedSince = useRef(new Map<EnvironmentId, number>());

  /** Ask every node for today again, unless that was done less than `minAgeMs` ago. */
  const refreshToday = useCallback((minAgeMs = 0) => {
    setTodayRefresh((previous) => {
      const nowMs = Date.now();
      return nowMs - previous.atMs < minAgeMs
        ? previous
        : { count: previous.count + 1, atMs: nowMs };
    });
  }, []);
  const refresh = useCallback(() => {
    refreshToday();
    setYesterdayRefresh((value) => value + 1);
  }, [refreshToday]);

  const todayTargets = useMemo(
    () => selected.filter((connection) => readiness.get(connection.environmentId) === "ask"),
    [readiness, selected],
  );
  const todayKeyOf = useCallback(
    (connection: EnvironmentConnection) =>
      `${dayKey}\0${todayRefresh.count}\0${revisions.get(connection.environmentId) ?? 0}`,
    [dayKey, revisions, todayRefresh.count],
  );
  const loadToday = useCallback(
    (connection: EnvironmentConnection, signal: AbortSignal) => {
      const revision = revisions.get(connection.environmentId) ?? 0;
      return dailyRecapCache.load(recapTarget(connection), todayRequest, {
        signal,
        // Only the first ask may take the route's prefetched answer.
        fresh: todayRefresh.count > 0 || revision > 0,
        sinceMs: finishedSince.current.get(connection.environmentId),
      });
    },
    [revisions, todayRefresh.count, todayRequest],
  );
  const todayAnswers = useLatestAnswers(todayTargets, todayKeyOf, loadToday);

  // The day before waits for a node's today, so a node never runs both reads at once.
  const yesterdayTargetIds = todayTargets
    .filter((connection) => {
      const answer = todayAnswers.get(connection.environmentId);
      return answer?.result.status === "ready" && answer.key.startsWith(`${dayKey}\0`);
    })
    .map((connection) => connection.environmentId)
    .join("\n");
  const yesterdayTargets = useMemo(() => {
    const ids = new Set(yesterdayTargetIds.split("\n"));
    return todayTargets.filter((connection) => ids.has(connection.environmentId));
  }, [todayTargets, yesterdayTargetIds]);
  const yesterdayKeyOf = useCallback(
    () => `${yesterdayRequest.date}\0${timeZone}\0${yesterdayRefresh}`,
    [timeZone, yesterdayRefresh, yesterdayRequest],
  );
  const loadYesterday = useCallback(
    (connection: EnvironmentConnection, signal: AbortSignal) =>
      dailyRecapCache.load(recapTarget(connection), yesterdayRequest, {
        signal,
        fresh: yesterdayRefresh > 0,
      }),
    [yesterdayRefresh, yesterdayRequest],
  );
  const yesterdayAnswers = useLatestAnswers(yesterdayTargets, yesterdayKeyOf, loadYesterday);

  // A node whose newest finished turn moved is asked again, at most every 20 s.
  const selectCompletions = useMemo(() => createLatestTurnCompletionSelector(), []);
  const completions = useStore(selectCompletions);
  const seenCompletions = useRef(completions);
  const completionsDue = useRef(new Set<EnvironmentId>());
  const completionRefreshAtMs = useRef<number | null>(null);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const moved = nodesWithNewTurnCompletions(seenCompletions.current, completions);
    seenCompletions.current = completions;
    if (moved.length === 0) return;
    const movedAtMs = Date.now();
    for (const environmentId of moved) {
      finishedSince.current.set(environmentId, movedAtMs);
      completionsDue.current.add(environmentId);
    }
    if (completionTimer.current !== null) return;
    const askAgain = () => {
      completionTimer.current = null;
      completionRefreshAtMs.current = Date.now();
      const due = [...completionsDue.current];
      completionsDue.current.clear();
      setRevisions((previous) => {
        const next = new Map(previous);
        for (const environmentId of due)
          next.set(environmentId, (next.get(environmentId) ?? 0) + 1);
        return next;
      });
    };
    const delay = nextCompletionRefreshDelay(completionRefreshAtMs.current, movedAtMs);
    if (delay === 0) askAgain();
    else completionTimer.current = setTimeout(askAgain, delay);
  }, [completions]);
  useEffect(
    () => () => {
      if (completionTimer.current === null) return;
      clearTimeout(completionTimer.current);
      completionTimer.current = null;
    },
    [],
  );

  // Poll while visible; a hidden page catches up when it comes back.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        if (document.visibilityState === "visible") refreshToday();
      },
      todayRefresh.atMs + DAILY_RECAP_POLL_MS - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [refreshToday, todayRefresh.atMs]);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") refreshToday(DAILY_RECAP_FOCUS_STALE_MS);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refreshToday]);

  const { nodes, refreshing } = useMemo(() => {
    const entries = selected.map((connection) => {
      const { environmentId } = connection;
      const label = connection.knownEnvironment.label;
      const nodeReadiness = readiness.get(environmentId) ?? "pending";
      const answer = todayAnswers.get(environmentId);
      let result: DailyRecapNodeResult | undefined;
      if (nodeReadiness === "ask") {
        // Asked again (a finished turn, the poll), a node keeps its last answer of the day
        // meanwhile, so neither its numbers nor its footer note blink.
        result = answer?.key.startsWith(`${dayKey}\0`) === true ? answer.result : undefined;
      } else if (nodeReadiness !== "pending") {
        result = { environmentId, label, requestedAtMs: input.nowMs, status: nodeReadiness };
      }
      const recap =
        result?.status === "ready"
          ? result
          : result?.status === "forbidden"
            ? undefined
            : dailyRecapCache.peek(environmentId, todayRequest);
      const view: DailyRecapNodeView = {
        environmentId,
        label,
        result,
        recap: recap && { ...recap, label },
        stale: recap !== undefined && recap !== result,
      };
      return {
        view,
        reasking:
          nodeReadiness === "ask" && result !== undefined && answer?.key !== todayKeyOf(connection),
      };
    });
    return {
      nodes: entries.map((entry) => entry.view),
      refreshing: entries.some((entry) => entry.reasking),
    };
  }, [dayKey, input.nowMs, readiness, selected, todayAnswers, todayKeyOf, todayRequest]);
  const today = useMemo(() => mergeDailyRecaps(nodes.flatMap((node) => node.recap ?? [])), [nodes]);
  const yesterday = useMemo(() => {
    const yesterdayKey = yesterdayKeyOf();
    return mergeDailyRecaps(
      nodes.flatMap((node): ReadyDailyRecap[] => {
        if (node.recap === undefined) return [];
        const answer = yesterdayAnswers.get(node.environmentId);
        const recap =
          answer?.key === yesterdayKey && answer.result.status === "ready"
            ? answer.result
            : dailyRecapCache.peek(node.environmentId, yesterdayRequest);
        return recap === undefined ? [] : [{ ...recap, label: node.label }];
      }),
    );
  }, [nodes, yesterdayAnswers, yesterdayKeyOf, yesterdayRequest]);
  const pendingEnvironmentIds = useMemo(
    () => nodes.filter((node) => node.result === undefined).map((node) => node.environmentId),
    [nodes],
  );
  return {
    today,
    yesterday,
    nodes,
    availableEnvironments,
    pendingEnvironmentIds,
    connecting,
    loading: pendingEnvironmentIds.length > 0,
    refreshing,
    refresh,
  };
}
