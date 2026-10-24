/**
 * Latest-state thread activities: the one definition shared by write pacing at ingestion, the live
 * WebSocket frame coalescer and event-log compaction.
 *
 * Some activities are not history but "what is this agent doing right now": a task's progress, a
 * tool heartbeat, a streaming subagent message, a reasoning block. Providers rewrite them many
 * times under one stable activity id, and every reader replaces the activity by id (the
 * `projection_thread_activities` upsert writes every column from the event; the client store
 * replaces the activity and orders it by the activity's own `(sequence, createdAt, id)`). So the
 * event log only needs the newest event of each `(thread, activity id)`; older versions are dead
 * weight that each rebuild and resume replays.
 *
 * Why deleting a superseded version is safe (the equivalence argument; the compaction worker in
 * `apps/server/src/persistence/Layers/EventLogCompaction.ts` relies on it): let L be the log and D
 * the deleted set, where every d in D has a kept event e of the same stream and activity id with
 * sequence(e) > sequence(d). Compactable events affect any consumer only through (i) a full
 * replace-by-id of one activity and (ii) `thread.updatedAt := occurredAt`, both last-writer-wins;
 * no reducer reads one of these activities while applying another event, except revert and thread
 * re-creation, which act per row and commute with "older version absent" because the later event
 * re-applies the id. A consumer that applied the log up to a cursor c already applied every deleted
 * event at or below c; a deleted event above c has its superseding event above c in the replay. So
 * apply(S_c, (L \ D) after c) = apply(S_c, L after c): server projection rebuild (c = 0), projector
 * catch-up and client resume all reach the same state.
 *
 * `context-window.updated` is listed but never compacted: statistics read every token sample from
 * the event log (`apps/server/src/statistics/StatisticsQuery.ts`), so deleting older Claude gauge
 * versions would silently change token statistics.
 *
 * @module latestStateActivities
 */
import { EventId } from "@ryco/contracts/base-schemas";

export type LiveCoalescing = "always" | "while-streaming" | "never";

export interface LatestStateActivityGroupDefinition {
  /** The activity kind every version carries. */
  readonly kind: string;
  /** Prefixes of the stable ids this group's writer mints; each is followed by `<threadId>:`. */
  readonly idPrefixes: ReadonlyArray<string>;
  /** Ingestion persists at most one version per interval (null: every version is written). */
  readonly writeIntervalMs: number | null;
  /** When the live WebSocket stream may collapse frames of this kind to the latest per id. */
  readonly liveCoalescing: LiveCoalescing;
  /** Whether superseded versions may be deleted from the event log. */
  readonly logCompaction: boolean;
}

export const LATEST_STATE_ACTIVITY_GROUPS = {
  "task-progress": {
    kind: "task.progress",
    idPrefixes: ["task-progress:", "task-usage:"],
    writeIntervalMs: 5_000,
    liveCoalescing: "always",
    logCompaction: true,
  },
  "tool-progress": {
    kind: "tool.progress",
    idPrefixes: ["tool-progress:"],
    writeIntervalMs: null,
    liveCoalescing: "always",
    logCompaction: true,
  },
  "subagent-message": {
    kind: "agent.message",
    idPrefixes: ["agent-message:"],
    writeIntervalMs: 300,
    liveCoalescing: "while-streaming",
    logCompaction: true,
  },
  reasoning: {
    kind: "reasoning",
    idPrefixes: ["reasoning:"],
    writeIntervalMs: 900,
    liveCoalescing: "never",
    logCompaction: true,
  },
  "context-window": {
    kind: "context-window.updated",
    // Claude only; other providers use the runtime event id, so each sample is its own activity.
    idPrefixes: ["claude-context-usage:"],
    writeIntervalMs: null,
    liveCoalescing: "always",
    // Statistics read every sample from the event log.
    logCompaction: false,
  },
} as const satisfies Record<string, LatestStateActivityGroupDefinition>;

export type LatestStateActivityGroup = keyof typeof LATEST_STATE_ACTIVITY_GROUPS;

const GROUP_ENTRIES = Object.entries(LATEST_STATE_ACTIVITY_GROUPS) as ReadonlyArray<
  readonly [LatestStateActivityGroup, LatestStateActivityGroupDefinition]
>;

const COMPACTION_GROUP_BY_KIND: ReadonlyMap<string, LatestStateActivityGroupDefinition> = new Map(
  GROUP_ENTRIES.filter(([, group]) => group.logCompaction).map(([, group]) => [group.kind, group]),
);

const LIVE_COALESCING_BY_KIND: ReadonlyMap<string, LiveCoalescing> = new Map(
  GROUP_ENTRIES.map(([, group]) => [group.kind, group.liveCoalescing]),
);

/** Activity kinds whose superseded versions the event log may drop, in table order. */
export const LOG_COMPACTION_ACTIVITY_KINDS: ReadonlyArray<string> = [
  ...COMPACTION_GROUP_BY_KIND.keys(),
];

// ---------------------------------------------------------------------------
// Stable id builders (the writers of each group)
// ---------------------------------------------------------------------------

/** A task's meaningful progress (title, summary, status), one per task. */
export function taskProgressActivityId(threadId: string, taskId: string): EventId {
  return EventId.make(`task-progress:${threadId}:${taskId}`);
}

/** A task's usage-only ticks, kept apart so a usage tick never blanks meaningful progress. */
export function taskUsageActivityId(threadId: string, taskId: string): EventId {
  return EventId.make(`task-usage:${threadId}:${taskId}`);
}

/** An agent-owned tool heartbeat, one per task. */
export function toolProgressActivityId(threadId: string, taskId: string): EventId {
  return EventId.make(`tool-progress:${threadId}:${taskId}`);
}

/** A subagent's message, rewritten while it streams. */
export function subagentMessageActivityId(input: {
  readonly threadId: string;
  readonly providerThreadId: string;
  readonly providerItemId: string;
}): EventId {
  return EventId.make(
    `agent-message:${input.threadId}:${input.providerThreadId}:${input.providerItemId}`,
  );
}

/** One reasoning block, rewritten while it streams and once more when it closes. */
export function reasoningActivityId(
  threadId: string,
  turnId: string | null,
  segmentKey: string,
): EventId {
  return EventId.make(`reasoning:${threadId}:${turnId ?? "none"}:${segmentKey}`);
}

/** Claude's context-window gauge, one per thread (never compacted, see the module comment). */
export function claudeContextUsageActivityId(threadId: string): EventId {
  return EventId.make(`claude-context-usage:${threadId}`);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The live WebSocket coalescing key of an activity, or null when its frames must pass through.
 * Kind-based on purpose (no id check): every frame of these kinds is an upsert the client
 * replaces by id, so the newest frame per id subsumes the ones it skips.
 */
export function liveCoalescingActivityKey(activity: {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}): string | null {
  const coalescing = LIVE_COALESCING_BY_KIND.get(activity.kind);
  if (coalescing === "always") return activity.id;
  if (coalescing === "while-streaming") {
    // Streaming upserts carry the full text so far; the final (non-streaming) frame shares the
    // id and must always be delivered.
    const streaming = (activity.payload as { streaming?: unknown } | null)?.streaming;
    return streaming === true ? activity.id : null;
  }
  return null;
}

const COMPACTION_KEY_SEPARATOR = "\u0000";

/**
 * The event-log compaction key of an activity appended to stream `streamId`, or null when no
 * version of it may ever be deleted. Requires a compactable kind and an id its group's writer
 * minted for this very thread (`<prefix><streamId>:`), which excludes fork copies
 * (`<fork>:inherited:…`), imported or recovered rows with foreign ids, and ids minted for another
 * thread.
 */
export function latestStateCompactionKey(
  streamId: string,
  activity: { readonly id: string | null; readonly kind: string | null },
): string | null {
  if (activity.id === null || activity.kind === null) return null;
  const group = COMPACTION_GROUP_BY_KIND.get(activity.kind);
  if (group === undefined) return null;
  const id = activity.id;
  const owned = group.idPrefixes.some((prefix) => id.startsWith(`${prefix}${streamId}:`));
  return owned ? `${streamId}${COMPACTION_KEY_SEPARATOR}${id}` : null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface LatestStateEventRow {
  readonly sequence: number;
  readonly streamId: string;
  readonly activityId: string | null;
  readonly kind: string | null;
  /** Stored size of the event (payload + metadata), for accounting only. */
  readonly bytes: number;
}

export interface LatestStateSurvivor {
  readonly sequence: number;
  readonly bytes: number;
}

export interface SupersededLatestStateEvent {
  readonly sequence: number;
  readonly bytes: number;
  /** A later event of the same key that is not deleted by this selection. */
  readonly supersededBy: number;
}

/**
 * The newest kept event per key seen so far, carried across consecutive windows of one pass.
 * Insertion order is recency order; the caller bounds it (`capacity`), and evicting an entry only
 * means its event is never deleted, which is always safe.
 */
export type LatestStateCarry = Map<string, LatestStateSurvivor>;

/**
 * Picks the events of `rows` (ascending sequence, one window of the log) that a later event of the
 * same key supersedes, including the survivors carried in from earlier windows. Updates `carry` in
 * place to the newest event per key. Every returned deletion names a survivor: the newest event of
 * its key that this selection keeps (in this window or carried), so the newest event per key is
 * never deleted.
 */
export function selectSupersededLatestStateEvents(
  rows: ReadonlyArray<LatestStateEventRow>,
  carry: LatestStateCarry,
  capacity: number = Number.POSITIVE_INFINITY,
): {
  readonly deletions: ReadonlyArray<SupersededLatestStateEvent>;
  readonly survivors: ReadonlySet<number>;
} {
  const superseded: Array<{ sequence: number; bytes: number; by: number }> = [];
  for (const row of rows) {
    const key = latestStateCompactionKey(row.streamId, { id: row.activityId, kind: row.kind });
    if (key === null) continue;
    const previous = carry.get(key);
    if (previous !== undefined) {
      if (previous.sequence >= row.sequence) continue;
      superseded.push({ sequence: previous.sequence, bytes: previous.bytes, by: row.sequence });
      carry.delete(key);
    }
    if (capacity <= 0) continue;
    carry.set(key, { sequence: row.sequence, bytes: row.bytes });
    if (carry.size > capacity) {
      const oldest = carry.keys().next();
      if (oldest.done !== true) carry.delete(oldest.value);
    }
  }

  // A survivor may itself be superseded later in the window; resolve each deletion to the newest
  // version of its key that stays. Superseders are always later, so walking newest first resolves
  // every chain in one pass.
  const deletedBy = new Map<number, number>();
  for (const entry of superseded) deletedBy.set(entry.sequence, entry.by);
  const finalSurvivor = new Map<number, number>();
  const deletions: Array<SupersededLatestStateEvent> = [];
  const survivors = new Set<number>();
  for (let index = superseded.length - 1; index >= 0; index -= 1) {
    const entry = superseded[index]!;
    const resolved = deletedBy.has(entry.by) ? finalSurvivor.get(entry.by)! : entry.by;
    finalSurvivor.set(entry.sequence, resolved);
    survivors.add(resolved);
    deletions.push({ sequence: entry.sequence, bytes: entry.bytes, supersededBy: resolved });
  }
  deletions.sort((left, right) => left.sequence - right.sequence);
  return { deletions, survivors };
}
