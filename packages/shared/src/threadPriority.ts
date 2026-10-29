import type { OrchestrationLatestTurn, ThreadPriorityProjectedRanking } from "@ryco/contracts";

export const THREAD_PRIORITY_FOCUS_TARGET = 5;
export const THREAD_PRIORITY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type ThreadPriorityFocusSource = "pin" | "approval" | "input" | "failure" | "ai";

export interface ThreadPriorityFocusMetadata {
  readonly source: ThreadPriorityFocusSource;
  readonly ranking: ThreadPriorityProjectedRanking | null;
}

export interface ThreadPriorityFocusExplanation {
  readonly title: string;
  readonly detail: string;
  readonly aiGenerated: boolean;
}

/** Shared user-facing vocabulary for why a thread entered Focus. */
export function describeThreadPriorityFocus(
  focus: ThreadPriorityFocusMetadata,
): ThreadPriorityFocusExplanation {
  switch (focus.source) {
    case "pin":
      return { title: "Pinned", detail: "Pinned by you.", aiGenerated: false };
    case "approval":
      return {
        title: "Approval required",
        detail: "This thread is waiting for your approval.",
        aiGenerated: false,
      };
    case "input":
      return {
        title: "Input required",
        detail: "This thread is waiting for your response.",
        aiGenerated: false,
      };
    case "failure":
      return {
        title: "Recent failure",
        detail: "The latest turn failed and has not received a newer request.",
        aiGenerated: false,
      };
    case "ai":
      return {
        title: focus.ranking?.tier === "now" ? "Now" : "Soon",
        detail: focus.ranking?.reason ?? "Selected by the Inbox ranking model.",
        aiGenerated: true,
      };
  }
}

export interface ThreadPriorityPartitionCandidate {
  readonly scopedKey: string;
  readonly pinned: boolean;
  readonly serverOwned: boolean;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly latestUserMessageAt: string | null;
  readonly priority?: ThreadPriorityProjectedRanking | undefined;
}

export interface ThreadPriorityFocusedValue<T> {
  readonly value: T;
  readonly focus: ThreadPriorityFocusMetadata;
}

export interface ThreadPriorityPartition<T> {
  readonly focus: ReadonlyArray<ThreadPriorityFocusedValue<T>>;
  readonly active: ReadonlyArray<T>;
}

function timestamp(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isFreshLatestFailure(
  candidate: Pick<ThreadPriorityPartitionCandidate, "latestTurn" | "latestUserMessageAt">,
  nowMs: number,
): boolean {
  if (candidate.latestTurn?.state !== "error") return false;
  const failedAt = timestamp(
    candidate.latestTurn.completedAt ??
      candidate.latestTurn.startedAt ??
      candidate.latestTurn.requestedAt,
  );
  if (failedAt === null || nowMs < failedAt || nowMs - failedAt >= THREAD_PRIORITY_MAX_AGE_MS) {
    return false;
  }
  const latestUserMessageAt = timestamp(candidate.latestUserMessageAt);
  return latestUserMessageAt === null || latestUserMessageAt <= failedAt;
}

export function isUsableThreadPriorityRanking(
  ranking: ThreadPriorityProjectedRanking | null | undefined,
  nowMs: number,
): ranking is ThreadPriorityProjectedRanking {
  if (ranking === null || ranking === undefined) return false;
  if (ranking.confidence === "low" || (ranking.tier !== "now" && ranking.tier !== "soon")) {
    return false;
  }
  const rankedAt = timestamp(ranking.rankedAt);
  const usableUntil = timestamp(ranking.usableUntil);
  return (
    rankedAt !== null &&
    usableUntil !== null &&
    nowMs >= rankedAt &&
    nowMs < usableUntil &&
    nowMs - rankedAt < THREAD_PRIORITY_MAX_AGE_MS
  );
}

function deterministicSource(
  candidate: ThreadPriorityPartitionCandidate,
  nowMs: number,
): Exclude<ThreadPriorityFocusSource, "pin" | "ai"> | null {
  if (candidate.hasPendingApprovals) return "approval";
  if (candidate.hasPendingUserInput) return "input";
  if (isFreshLatestFailure(candidate, nowMs)) return "failure";
  return null;
}

export function partitionThreadPriorities<T>(input: {
  readonly active: ReadonlyArray<T>;
  readonly enabled: boolean;
  readonly nowMs: number;
  readonly toCandidate: (value: T) => ThreadPriorityPartitionCandidate;
  readonly target?: number | undefined;
}): ThreadPriorityPartition<T> {
  if (!input.enabled) return { focus: [], active: input.active };

  const candidates = input.active.map((value, index) => ({
    value,
    index,
    candidate: input.toCandidate(value),
  }));
  const focus: ThreadPriorityFocusedValue<T>[] = [];
  const selected = new Set<string>();

  const add = (
    item: (typeof candidates)[number],
    source: ThreadPriorityFocusSource,
    ranking: ThreadPriorityProjectedRanking | null = null,
  ) => {
    if (selected.has(item.candidate.scopedKey)) return;
    selected.add(item.candidate.scopedKey);
    focus.push({ value: item.value, focus: { source, ranking } });
  };

  for (const item of candidates) {
    if (item.candidate.serverOwned && item.candidate.pinned) add(item, "pin");
  }

  const target = Math.max(input.target ?? THREAD_PRIORITY_FOCUS_TARGET, focus.length);
  const deterministic = candidates
    .map((item) => ({ ...item, source: deterministicSource(item.candidate, input.nowMs) }))
    .filter(
      (
        item,
      ): item is typeof item & {
        readonly source: Exclude<ThreadPriorityFocusSource, "pin" | "ai">;
      } => item.candidate.serverOwned && item.source !== null,
    )
    .toSorted((left, right) => {
      const order = { approval: 0, input: 1, failure: 2 } as const;
      return order[left.source] - order[right.source] || left.index - right.index;
    });
  for (const item of deterministic) {
    if (focus.length >= target) break;
    add(item, item.source);
  }

  const ai = candidates
    .filter(
      (item) =>
        item.candidate.serverOwned &&
        isUsableThreadPriorityRanking(item.candidate.priority, input.nowMs),
    )
    .toSorted((left, right) => {
      const order = { now: 0, soon: 1 } as const;
      const leftRanking = left.candidate.priority!;
      const rightRanking = right.candidate.priority!;
      return (
        order[leftRanking.tier as "now" | "soon"] - order[rightRanking.tier as "now" | "soon"] ||
        left.index - right.index
      );
    });
  for (const item of ai) {
    if (focus.length >= target) break;
    add(item, "ai", item.candidate.priority!);
  }

  return {
    focus,
    active: candidates
      .filter((item) => !selected.has(item.candidate.scopedKey))
      .map((item) => item.value),
  };
}
