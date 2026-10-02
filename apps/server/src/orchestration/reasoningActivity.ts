// FILE: reasoningActivity.ts
// Purpose: Projects provider reasoning (Claude thinking, Codex reasoning
//          summaries, Copilot/OpenCode/ACP thoughts) into one upserted thread
//          activity per reasoning block, so the transcript can show a live
//          "Thinking" step that settles into "Thought for 6s" with its text.
// Layer: Orchestration ingestion helper (pure state; dispatch lives in
//        ProviderRuntimeIngestion)
// Exports: ReasoningTracker, buildReasoningActivity, historyReasoningActivities,
//          reasoning constants
//
// Write budget: every activity write is a permanent event, so a block is
// written when it opens, at most once per REASONING_LIVE_FLUSH_INTERVAL_MS
// while it streams (carrying only a short tail for the live preview), and
// once more with the full, capped text when it closes.

import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ThreadId,
  TurnId,
} from "@ryco/contracts";

export const REASONING_ACTIVITY_KIND = "reasoning";
export const REASONING_LIVE_FLUSH_INTERVAL_MS = 900;
/** Live writes carry only the end of the text — enough for the preview line. */
export const REASONING_LIVE_TAIL_CHARS = 600;
/** Final text cap; stays under activityDataCap's 16k string threshold. */
export const REASONING_MAX_TEXT_CHARS = 15_000;
const REASONING_HEADLINE_MAX_CHARS = 120;
/** Closed blocks remembered so a late event continues them instead of starting over. */
const CLOSED_SEGMENT_MEMORY = 128;

export interface ReasoningSegment {
  readonly key: string;
  readonly activityId: EventId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly providerItemId: string | undefined;
  readonly startedAt: string;
  /** Opened by an explicit `item.started`; waits for `item.completed`. */
  explicit: boolean;
  summaryParts: string[];
  rawText: string;
  updatedAt: string;
  dirty: boolean;
  flushScheduled: boolean;
  /** Bumped on every write so stale scheduled flushes can be ignored. */
  generation: number;
  flushCount: number;
  lastEvent: ProviderRuntimeEvent;
}

export interface ReasoningDeltaInput {
  readonly event: ProviderRuntimeEvent;
  readonly threadId: ThreadId;
  readonly streamKind: "reasoning_text" | "reasoning_summary_text";
  readonly delta: string;
  readonly summaryIndex?: number | undefined;
}

function turnKey(threadId: ThreadId, turnId: TurnId | null): string {
  return `${threadId}:${turnId ?? "none"}`;
}

export function reasoningActivityId(
  threadId: ThreadId,
  turnId: TurnId | null,
  segmentKey: string,
): EventId {
  return EventId.make(`reasoning:${threadId}:${turnId ?? "none"}:${segmentKey}`);
}

function eventTurnId(event: ProviderRuntimeEvent): TurnId | null {
  return event.turnId === undefined ? null : TurnId.make(String(event.turnId));
}

/** The readable text: Codex summaries win over raw reasoning when both stream. */
export function reasoningSegmentText(
  segment: Pick<ReasoningSegment, "summaryParts" | "rawText">,
): string {
  const summary = segment.summaryParts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  return summary.length > 0 ? summary : segment.rawText.trim();
}

/**
 * Codex summary parts lead with a bold title ("**Inspecting the relay
 * client**"). The latest one is the best one-line label for the block.
 */
export function reasoningHeadline(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:^|\n)\s*\*\*([^*\n]{2,})\*\*\s*(?=\n|$)/g)];
  const headline = matches.at(-1)?.[1]?.trim();
  if (!headline) return undefined;
  return headline.length > REASONING_HEADLINE_MAX_CHARS
    ? `${headline.slice(0, REASONING_HEADLINE_MAX_CHARS - 1)}…`
    : headline;
}

function capReasoningText(text: string): { text: string; truncated: boolean } {
  if (text.length <= REASONING_MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, REASONING_MAX_TEXT_CHARS - 1)}…`, truncated: true };
}

function tailReasoningText(text: string): string {
  if (text.length <= REASONING_LIVE_TAIL_CHARS) return text;
  const tail = text.slice(text.length - REASONING_LIVE_TAIL_CHARS);
  const firstSpace = tail.indexOf(" ");
  return `…${firstSpace > 0 ? tail.slice(firstSpace + 1) : tail}`;
}

/** Full text a provider attaches when it completes a reasoning item. */
export function completionTextFromReasoningItem(event: ProviderRuntimeEvent): string | undefined {
  if (event.type !== "item.completed" || event.payload.itemType !== "reasoning") {
    return undefined;
  }
  const data =
    event.payload.data && typeof event.payload.data === "object"
      ? (event.payload.data as Record<string, unknown>)
      : null;
  const item =
    data?.item && typeof data.item === "object" ? (data.item as Record<string, unknown>) : null;
  const joinParts = (value: unknown) =>
    Array.isArray(value)
      ? value
          .flatMap((part) => {
            if (typeof part === "string") return [part];
            if (
              part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string"
            ) {
              return [(part as { text: string }).text];
            }
            return [];
          })
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .join("\n\n")
      : "";
  const summary = joinParts(item?.summary);
  if (summary.length > 0) return summary;
  const content = joinParts(item?.content);
  if (content.length > 0) return content;
  if (typeof data?.content === "string" && data.content.trim().length > 0)
    return data.content.trim();
  const detail = event.payload.detail?.trim();
  return detail && detail.length > 0 ? detail : undefined;
}

export function buildReasoningActivity(
  segment: ReasoningSegment,
  options: { readonly final: boolean },
): OrchestrationThreadActivity {
  const fullText = reasoningSegmentText(segment);
  const headline = reasoningHeadline(fullText);
  const { text, truncated } = options.final
    ? capReasoningText(fullText)
    : { text: tailReasoningText(fullText), truncated: false };
  return {
    id: segment.activityId,
    tone: "info",
    kind: REASONING_ACTIVITY_KIND,
    summary: headline ?? "Reasoning",
    payload: {
      itemType: "reasoning",
      ...(segment.providerItemId ? { providerItemId: segment.providerItemId } : {}),
      text,
      ...(truncated ? { truncated: true } : {}),
      streaming: !options.final,
      startedAt: segment.startedAt,
      updatedAt: segment.updatedAt,
      ...(options.final ? { completedAt: segment.updatedAt } : {}),
      ...(headline ? { headline } : {}),
    },
    turnId: segment.turnId,
    // The row keeps its start time: upserts overwrite createdAt, and moving it
    // would reorder the block behind the paragraph it led to.
    createdAt: segment.startedAt,
  };
}

/**
 * Open reasoning blocks per thread. Explicit blocks (providers that send
 * item.started/item.completed) close on completion; implicit ones (deltas
 * only — Claude without lifecycle, ACP thoughts, OpenCode parts) close when
 * the agent moves on: assistant text, a tool call, a request, or turn end.
 */
export class ReasoningTracker {
  private readonly segments = new Map<string, ReasoningSegment>();
  private readonly implicitOrdinalByTurn = new Map<string, number>();
  private readonly closed = new Map<
    string,
    Pick<ReasoningSegment, "startedAt" | "summaryParts" | "rawText" | "flushCount">
  >();

  get(key: string): ReasoningSegment | undefined {
    return this.segments.get(key);
  }

  private segmentKeyFor(threadId: ThreadId, event: ProviderRuntimeEvent): string {
    const turnId = eventTurnId(event);
    if (event.itemId !== undefined) {
      return `${turnKey(threadId, turnId)}:item:${event.itemId}`;
    }
    // Itemless deltas share one implicit block per turn until it closes.
    for (const segment of this.segments.values()) {
      if (
        segment.threadId === threadId &&
        segment.turnId === turnId &&
        segment.providerItemId === undefined &&
        !segment.explicit
      ) {
        return segment.key;
      }
    }
    const ordinalKey = turnKey(threadId, turnId);
    const ordinal = (this.implicitOrdinalByTurn.get(ordinalKey) ?? 0) + 1;
    this.implicitOrdinalByTurn.set(ordinalKey, ordinal);
    return `${ordinalKey}:block:${ordinal}`;
  }

  private create(
    threadId: ThreadId,
    event: ProviderRuntimeEvent,
    key: string,
    explicit: boolean,
  ): ReasoningSegment {
    const turnId = eventTurnId(event);
    // A late delta or completion for a block we already closed continues it:
    // same start, same text so far, so the next write never truncates it.
    const previous = this.closed.get(key);
    this.closed.delete(key);
    const segment: ReasoningSegment = {
      key,
      activityId: reasoningActivityId(
        threadId,
        turnId,
        key.slice(turnKey(threadId, turnId).length + 1),
      ),
      threadId,
      turnId,
      providerItemId: event.itemId === undefined ? undefined : String(event.itemId),
      startedAt: previous?.startedAt ?? event.createdAt,
      explicit,
      summaryParts: previous ? [...previous.summaryParts] : [],
      rawText: previous?.rawText ?? "",
      updatedAt: event.createdAt,
      dirty: false,
      flushScheduled: false,
      generation: 0,
      flushCount: previous?.flushCount ?? 0,
      lastEvent: event,
    };
    this.segments.set(key, segment);
    return segment;
  }

  /** `item.started` for a reasoning item. */
  open(
    threadId: ThreadId,
    event: ProviderRuntimeEvent,
  ): { segment: ReasoningSegment; created: boolean } {
    const key = this.segmentKeyFor(threadId, event);
    const existing = this.segments.get(key);
    if (existing) {
      existing.explicit = true;
      existing.lastEvent = event;
      return { segment: existing, created: false };
    }
    return { segment: this.create(threadId, event, key, true), created: true };
  }

  appendDelta(input: ReasoningDeltaInput): { segment: ReasoningSegment; created: boolean } {
    const key = this.segmentKeyFor(input.threadId, input.event);
    const existing = this.segments.get(key);
    const segment = existing ?? this.create(input.threadId, input.event, key, false);
    if (input.streamKind === "reasoning_summary_text") {
      const index = Math.max(0, input.summaryIndex ?? segment.summaryParts.length - 1, 0);
      while (segment.summaryParts.length <= index) segment.summaryParts.push("");
      segment.summaryParts[index] += input.delta;
    } else {
      segment.rawText += input.delta;
    }
    segment.updatedAt = input.event.createdAt;
    segment.lastEvent = input.event;
    segment.dirty = true;
    return { segment, created: existing === undefined };
  }

  /**
   * `item.completed` for a reasoning item. Providers that only report
   * completion (Copilot, history replay) get a block created on the spot.
   */
  complete(threadId: ThreadId, event: ProviderRuntimeEvent): ReasoningSegment {
    const key = this.segmentKeyFor(threadId, event);
    const segment = this.segments.get(key) ?? this.create(threadId, event, key, true);
    const finalText = completionTextFromReasoningItem(event);
    if (finalText && finalText.length >= reasoningSegmentText(segment).length) {
      segment.summaryParts = [];
      segment.rawText = finalText;
    }
    segment.updatedAt = event.createdAt;
    segment.lastEvent = event;
    this.remove(segment);
    return segment;
  }

  /** The agent moved on (text, tool, request): close blocks with no lifecycle. */
  closeImplicit(
    threadId: ThreadId,
    turnId: TurnId | null,
    event: ProviderRuntimeEvent,
  ): ReasoningSegment[] {
    return this.closeWhere(
      (segment) => segment.threadId === threadId && segment.turnId === turnId && !segment.explicit,
      event,
    );
  }

  closeTurn(
    threadId: ThreadId,
    turnId: TurnId | null,
    event: ProviderRuntimeEvent,
  ): ReasoningSegment[] {
    return this.closeWhere(
      (segment) => segment.threadId === threadId && (turnId === null || segment.turnId === turnId),
      event,
    );
  }

  closeThread(threadId: ThreadId, event: ProviderRuntimeEvent): ReasoningSegment[] {
    for (const key of this.implicitOrdinalByTurn.keys()) {
      if (key.startsWith(`${threadId}:`)) this.implicitOrdinalByTurn.delete(key);
    }
    return this.closeWhere((segment) => segment.threadId === threadId, event);
  }

  markWritten(segment: ReasoningSegment) {
    segment.dirty = false;
    segment.flushScheduled = false;
    segment.flushCount += 1;
    segment.generation += 1;
  }

  private closeWhere(
    predicate: (segment: ReasoningSegment) => boolean,
    event: ProviderRuntimeEvent,
  ): ReasoningSegment[] {
    const closed: ReasoningSegment[] = [];
    // Deleting the entry being visited is safe during Map iteration.
    for (const segment of this.segments.values()) {
      if (!predicate(segment)) continue;
      segment.updatedAt = event.createdAt > segment.updatedAt ? event.createdAt : segment.updatedAt;
      segment.lastEvent = event;
      this.remove(segment);
      closed.push(segment);
    }
    return closed;
  }

  private remove(segment: ReasoningSegment) {
    this.segments.delete(segment.key);
    this.closed.set(segment.key, {
      startedAt: segment.startedAt,
      summaryParts: segment.summaryParts,
      rawText: segment.rawText,
      flushCount: segment.flushCount,
    });
    if (this.closed.size > CLOSED_SEGMENT_MEMORY) {
      const oldest = this.closed.keys().next().value;
      if (oldest !== undefined) this.closed.delete(oldest);
    }
  }
}

/** History replay: completed reasoning items become settled rows (no live state). */
export function historyReasoningActivities(
  threadId: ThreadId,
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  if (event.type !== "item.completed" || event.payload.itemType !== "reasoning") {
    return [];
  }
  const tracker = new ReasoningTracker();
  const segment = tracker.complete(threadId, event);
  return [buildReasoningActivity(segment, { final: true })];
}
