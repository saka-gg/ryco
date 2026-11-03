import type { MessageId } from "@ryco/contracts";

import type { ChatMessage, ProposedPlan } from "../threads/types.ts";
import type {
  ContextCompactionTimelineEntry,
  TimelineEntry,
  WorkLogEntry,
} from "./session-logic.ts";
import type { ContextHandoffTimelineEntry } from "./contextHandoff.ts";
import {
  forkTimelineBand,
  forkTimelineInheritedPrefix,
  type ForkOriginTimelineEntry,
} from "./forkOrigin.ts";
import {
  userInputExchangeTimeline,
  type UserInputExchangeTimelineEntry,
} from "./userInputExchange.ts";

export interface TimelineEntrySources {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly proposedPlans: ReadonlyArray<ProposedPlan>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly contextCompactionEntries: ReadonlyArray<ContextCompactionTimelineEntry>;
  readonly contextHandoffEntries: ReadonlyArray<ContextHandoffTimelineEntry>;
  /** `ThreadActivityViewModel.forkOriginEntries`: at most one, on forked threads. */
  readonly forkOriginEntries: ReadonlyArray<ForkOriginTimelineEntry>;
  /**
   * `ThreadActivityViewModel.userInputExchangeEntries`; each stands in for its request and
   * resolution work rows (`userInputExchangeTimeline`).
   */
  readonly userInputExchangeEntries: ReadonlyArray<UserInputExchangeTimelineEntry>;
}

export interface TimelineEntryIndex {
  readonly update: (sources: TimelineEntrySources) => TimelineEntry[];
  readonly inspect: () => {
    readonly mode: "full" | "incremental" | "reuse";
    readonly indexedEntries: number;
  };
}

type SourceKind = TimelineEntry["kind"];

interface IndexedTimelineEntry {
  readonly key: string;
  /** `forkTimelineBand`: a fork's inherited history, its divider, then its own items. */
  readonly band: number;
  readonly sourceKind: SourceKind;
  readonly sourceRank: number;
  readonly sourceIndex: number;
  readonly source: object;
  readonly entry: TimelineEntry;
}

const SOURCE_RANK: Record<SourceKind, number> = {
  message: 0,
  "proposed-plan": 1,
  work: 2,
  "context-compaction": 3,
  "context-handoff": 4,
  // Its own band on a fork (`forkTimelineBand`); the rank only matters without one.
  "fork-origin": 5,
  "user-input-exchange": 6,
};

function compareIndexedEntries(left: IndexedTimelineEntry, right: IndexedTimelineEntry): number {
  return (
    left.band - right.band ||
    left.entry.createdAt.localeCompare(right.entry.createdAt) ||
    left.sourceRank - right.sourceRank ||
    left.sourceIndex - right.sourceIndex ||
    left.key.localeCompare(right.key)
  );
}

function sameIndexedEntry(left: IndexedTimelineEntry, right: IndexedTimelineEntry): boolean {
  return left.source === right.source && left.sourceRank === right.sourceRank;
}

function insertSorted(entries: IndexedTimelineEntry[], entry: IndexedTimelineEntry): void {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = entries[middle];
    if (candidate && compareIndexedEntries(candidate, entry) <= 0) low = middle + 1;
    else high = middle;
  }
  entries.splice(low, 0, entry);
}

function isSorted(entries: ReadonlyArray<IndexedTimelineEntry>): boolean {
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous && current && compareIndexedEntries(previous, current) > 0) return false;
  }
  return true;
}

function indexedEntry(
  previousByKey: ReadonlyMap<string, IndexedTimelineEntry>,
  inheritedPrefix: string | null,
  input: {
    readonly sourceKind: SourceKind;
    readonly sourceIndex: number;
    readonly source: object;
    readonly entry: TimelineEntry;
  },
): IndexedTimelineEntry {
  const key = `${input.sourceKind}:${input.entry.id}`;
  const previous = previousByKey.get(key);
  const entry =
    previous?.source === input.source &&
    previous.entry.createdAt === input.entry.createdAt &&
    previous.entry.kind === input.entry.kind
      ? previous.entry
      : input.entry;
  return {
    key,
    band: forkTimelineBand(input.entry, inheritedPrefix),
    sourceKind: input.sourceKind,
    sourceRank: SOURCE_RANK[input.sourceKind],
    sourceIndex: input.sourceIndex,
    source: input.source,
    entry,
  };
}

function reuseResult(previous: TimelineEntry[], next: TimelineEntry[]): TimelineEntry[] {
  return previous.length === next.length && previous.every((entry, index) => entry === next[index])
    ? previous
    : next;
}

export function createTimelineEntryIndex(): TimelineEntryIndex {
  let indexedByKey = new Map<string, IndexedTimelineEntry>();
  let sortedBaseEntries: IndexedTimelineEntry[] = [];
  let result: TimelineEntry[] = [];
  let mode: "full" | "incremental" | "reuse" = "full";
  // The bands `sortedBaseEntries` was ordered with; when the divider arrives, they all change.
  let sortedInheritedPrefix: string | null = null;

  return {
    update: (sources) => {
      const messageIds = new Set<MessageId>(sources.messages.map((message) => message.id));
      const nextByKey = new Map<string, IndexedTimelineEntry>();
      const baseByKey = new Map<string, IndexedTimelineEntry>();
      const anchoredHandoffs = new Map<MessageId, IndexedTimelineEntry[]>();
      const inheritedPrefix = forkTimelineInheritedPrefix(sources.forkOriginEntries);
      const add = (entry: IndexedTimelineEntry, base: boolean) => {
        nextByKey.set(entry.key, entry);
        if (base) baseByKey.set(entry.key, entry);
      };

      sources.messages.forEach((message, sourceIndex) =>
        add(
          indexedEntry(indexedByKey, inheritedPrefix, {
            sourceKind: "message",
            sourceIndex,
            source: message,
            entry: { id: message.id, kind: "message", createdAt: message.createdAt, message },
          }),
          true,
        ),
      );
      sources.proposedPlans.forEach((proposedPlan, sourceIndex) =>
        add(
          indexedEntry(indexedByKey, inheritedPrefix, {
            sourceKind: "proposed-plan",
            sourceIndex,
            source: proposedPlan,
            entry: {
              id: proposedPlan.id,
              kind: "proposed-plan",
              createdAt: proposedPlan.createdAt,
              proposedPlan,
            },
          }),
          true,
        ),
      );
      const userInputExchanges = userInputExchangeTimeline(
        sources.workEntries,
        sources.userInputExchangeEntries,
      );
      sources.workEntries.forEach((workEntry, sourceIndex) => {
        if (!userInputExchanges.keepsWorkEntry(workEntry)) return;
        add(
          indexedEntry(indexedByKey, inheritedPrefix, {
            sourceKind: "work",
            sourceIndex,
            source: workEntry,
            entry: {
              id: workEntry.id,
              kind: "work",
              createdAt: workEntry.createdAt,
              entry: workEntry,
            },
          }),
          true,
        );
      });
      sources.contextCompactionEntries.forEach((marker, sourceIndex) =>
        add(
          indexedEntry(indexedByKey, inheritedPrefix, {
            sourceKind: "context-compaction",
            sourceIndex,
            source: marker,
            entry: {
              id: marker.id,
              kind: "context-compaction",
              createdAt: marker.createdAt,
              marker,
            },
          }),
          true,
        ),
      );
      sources.contextHandoffEntries.forEach((marker, sourceIndex) => {
        const indexed = indexedEntry(indexedByKey, inheritedPrefix, {
          sourceKind: "context-handoff",
          sourceIndex,
          source: marker,
          entry: {
            id: marker.id,
            kind: "context-handoff",
            createdAt: marker.createdAt,
            marker,
          },
        });
        add(indexed, !messageIds.has(marker.targetMessageId));
        if (messageIds.has(marker.targetMessageId)) {
          const atAnchor = anchoredHandoffs.get(marker.targetMessageId);
          if (atAnchor) atAnchor.push(indexed);
          else anchoredHandoffs.set(marker.targetMessageId, [indexed]);
        }
      });

      sources.forkOriginEntries.forEach((marker, sourceIndex) =>
        add(
          indexedEntry(indexedByKey, inheritedPrefix, {
            sourceKind: "fork-origin",
            sourceIndex,
            source: marker,
            entry: { id: marker.id, kind: "fork-origin", createdAt: marker.createdAt, marker },
          }),
          true,
        ),
      );

      userInputExchanges.entries.forEach((entry, sourceIndex) =>
        add(
          indexedEntry(indexedByKey, inheritedPrefix, {
            sourceKind: "user-input-exchange",
            sourceIndex,
            source: entry,
            entry,
          }),
          true,
        ),
      );

      const tieCounts = new Map<string, number>();
      for (const entry of baseByKey.values()) {
        const tieKey = `${entry.sourceKind}:${entry.entry.createdAt}`;
        tieCounts.set(tieKey, (tieCounts.get(tieKey) ?? 0) + 1);
      }
      const previousBaseKeys = new Set(sortedBaseEntries.map((entry) => entry.key));
      const changedEntries = [...baseByKey.values()].filter((entry) => {
        if (!previousBaseKeys.has(entry.key)) return true;
        const previous = indexedByKey.get(entry.key);
        if (!previous || !sameIndexedEntry(previous, entry)) return true;
        return (
          previous.sourceIndex !== entry.sourceIndex &&
          (tieCounts.get(`${entry.sourceKind}:${entry.entry.createdAt}`) ?? 0) > 1
        );
      });
      const deletedCount = sortedBaseEntries.reduce(
        (count, entry) => count + (baseByKey.has(entry.key) ? 0 : 1),
        0,
      );
      const changeCount = changedEntries.length + deletedCount;
      const incrementalLimit = Math.max(32, Math.ceil(baseByKey.size / 3));

      if (
        sortedBaseEntries.length === 0 ||
        changeCount > incrementalLimit ||
        inheritedPrefix !== sortedInheritedPrefix
      ) {
        sortedBaseEntries = [...baseByKey.values()].toSorted(compareIndexedEntries);
        mode = "full";
      } else if (changeCount === 0) {
        mode = "reuse";
      } else {
        const changedKeys = new Set(changedEntries.map((entry) => entry.key));
        const nextSorted = sortedBaseEntries.filter(
          (entry) => baseByKey.has(entry.key) && !changedKeys.has(entry.key),
        );
        for (const entry of changedEntries) insertSorted(nextSorted, entry);
        sortedBaseEntries = isSorted(nextSorted)
          ? nextSorted
          : [...baseByKey.values()].toSorted(compareIndexedEntries);
        mode = isSorted(nextSorted) ? "incremental" : "full";
      }

      const nextResult: TimelineEntry[] = [];
      for (const indexed of sortedBaseEntries) {
        if (indexed.entry.kind === "message") {
          const markers = anchoredHandoffs.get(indexed.entry.message.id);
          if (markers) nextResult.push(...markers.map((marker) => marker.entry));
        }
        nextResult.push(indexed.entry);
      }
      indexedByKey = nextByKey;
      sortedInheritedPrefix = inheritedPrefix;
      result = reuseResult(result, nextResult);
      return result;
    },
    inspect: () => ({ mode, indexedEntries: indexedByKey.size }),
  };
}
