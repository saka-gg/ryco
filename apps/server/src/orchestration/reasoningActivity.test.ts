import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";

import {
  REASONING_ACTIVITY_KIND,
  REASONING_LIVE_TAIL_CHARS,
  ReasoningTracker,
  buildReasoningActivity,
  completionTextFromReasoningItem,
  historyReasoningActivities,
  reasoningHeadline,
} from "./reasoningActivity.ts";

const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");

let eventCounter = 0;
function runtimeEvent(
  input: Partial<ProviderRuntimeEvent> & Pick<ProviderRuntimeEvent, "type" | "payload">,
): ProviderRuntimeEvent {
  eventCounter += 1;
  return {
    eventId: EventId.make(`event-${eventCounter}`),
    provider: ProviderDriverKind.make("codex"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt: `2026-01-01T00:00:${String(eventCounter).padStart(2, "0")}.000Z`,
    ...input,
  } as ProviderRuntimeEvent;
}

function delta(
  text: string,
  options: { itemId?: string; summaryIndex?: number; raw?: boolean } = {},
) {
  return runtimeEvent({
    type: "content.delta",
    ...(options.itemId ? { itemId: RuntimeItemId.make(options.itemId) } : {}),
    payload: {
      streamKind: options.raw ? "reasoning_text" : "reasoning_summary_text",
      delta: text,
      ...(options.summaryIndex !== undefined ? { summaryIndex: options.summaryIndex } : {}),
    },
  });
}

describe("ReasoningTracker", () => {
  it("opens a block on the first delta and keeps one stable activity id", () => {
    const tracker = new ReasoningTracker();
    const first = delta("**Inspecting** the client", { itemId: "rs_1" });
    const opened = tracker.appendDelta({
      event: first,
      threadId: THREAD_ID,
      streamKind: "reasoning_summary_text",
      delta: "**Inspecting** the client",
    });
    const next = tracker.appendDelta({
      event: delta(" more", { itemId: "rs_1" }),
      threadId: THREAD_ID,
      streamKind: "reasoning_summary_text",
      delta: " more",
    });

    expect(opened.created).toBe(true);
    expect(next.created).toBe(false);
    expect(next.segment.activityId).toBe(opened.segment.activityId);
    expect(String(opened.segment.activityId)).toBe(`reasoning:${THREAD_ID}:${TURN_ID}:item:rs_1`);
    expect(next.segment.startedAt).toBe(first.createdAt);
  });

  it("prefers Codex summary parts over raw reasoning and separates parts", () => {
    const tracker = new ReasoningTracker();
    const append = (text: string, summaryIndex: number | undefined, raw = false) =>
      tracker.appendDelta({
        event: delta(text, { itemId: "rs_2" }),
        threadId: THREAD_ID,
        streamKind: raw ? "reasoning_text" : "reasoning_summary_text",
        delta: text,
        summaryIndex,
      });
    append("raw chain of thought", undefined, true);
    append("**First**\n\nLooked at A.", 0);
    const { segment } = append("**Second**\n\nThen B.", 1);

    const activity = buildReasoningActivity(segment, { final: true });
    expect(activity.payload).toMatchObject({
      itemType: "reasoning",
      text: "**First**\n\nLooked at A.\n\n**Second**\n\nThen B.",
      headline: "Second",
      streaming: false,
    });
  });

  it("writes only a tail while streaming and the full text when final", () => {
    const tracker = new ReasoningTracker();
    const long = `${"word ".repeat(400)}end`;
    const { segment } = tracker.appendDelta({
      event: delta(long, { raw: true }),
      threadId: THREAD_ID,
      streamKind: "reasoning_text",
      delta: long,
    });

    const live = buildReasoningActivity(segment, { final: false });
    const final = buildReasoningActivity(segment, { final: true });
    const liveText = (live.payload as { text: string }).text;
    expect(liveText.length).toBeLessThanOrEqual(REASONING_LIVE_TAIL_CHARS + 1);
    expect(liveText.endsWith("end")).toBe(true);
    expect((final.payload as { text: string }).text).toBe(long);
    // The row keeps its start time across upserts so it never reorders.
    expect(live.createdAt).toBe(segment.startedAt);
    expect(final.createdAt).toBe(segment.startedAt);
    expect(final.kind).toBe(REASONING_ACTIVITY_KIND);
  });

  it("shares one implicit block per turn for itemless deltas until the agent moves on", () => {
    const tracker = new ReasoningTracker();
    const a = tracker.appendDelta({
      event: delta("thinking", { raw: true }),
      threadId: THREAD_ID,
      streamKind: "reasoning_text",
      delta: "thinking",
    });
    const b = tracker.appendDelta({
      event: delta(" more", { raw: true }),
      threadId: THREAD_ID,
      streamKind: "reasoning_text",
      delta: " more",
    });
    expect(b.segment.key).toBe(a.segment.key);

    const closed = tracker.closeImplicit(
      THREAD_ID,
      TURN_ID,
      runtimeEvent({
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Hi" },
      }),
    );
    expect(closed.map((segment) => segment.key)).toEqual([a.segment.key]);

    const c = tracker.appendDelta({
      event: delta("again", { raw: true }),
      threadId: THREAD_ID,
      streamKind: "reasoning_text",
      delta: "again",
    });
    expect(c.created).toBe(true);
    expect(c.segment.activityId).not.toBe(a.segment.activityId);
  });

  it("leaves explicit blocks open until their completion arrives", () => {
    const tracker = new ReasoningTracker();
    const started = runtimeEvent({
      type: "item.started",
      itemId: RuntimeItemId.make("rs_3"),
      payload: { itemType: "reasoning", status: "inProgress" },
    });
    tracker.open(THREAD_ID, started);
    const closed = tracker.closeImplicit(
      THREAD_ID,
      TURN_ID,
      runtimeEvent({
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "x" },
      }),
    );
    expect(closed).toEqual([]);

    const completed = tracker.complete(
      THREAD_ID,
      runtimeEvent({
        type: "item.completed",
        itemId: RuntimeItemId.make("rs_3"),
        payload: {
          itemType: "reasoning",
          status: "completed",
          data: { item: { id: "rs_3", summary: ["**Plan**\n\nDo it."], content: [] } },
        },
      }),
    );
    expect(completed.startedAt).toBe(started.createdAt);
    expect(buildReasoningActivity(completed, { final: true }).payload).toMatchObject({
      text: "**Plan**\n\nDo it.",
      headline: "Plan",
      completedAt: completed.updatedAt,
    });
  });

  it("keeps the start time when a completion arrives after the block was closed", () => {
    const tracker = new ReasoningTracker();
    const first = delta("streamed", { itemId: "reasoning-9", raw: true });
    tracker.appendDelta({
      event: first,
      threadId: THREAD_ID,
      streamKind: "reasoning_text",
      delta: "streamed",
    });
    tracker.closeTurn(
      THREAD_ID,
      TURN_ID,
      runtimeEvent({ type: "turn.completed", payload: { state: "completed" } }),
    );
    const late = tracker.complete(
      THREAD_ID,
      runtimeEvent({
        type: "item.completed",
        itemId: RuntimeItemId.make("reasoning-9"),
        payload: { itemType: "reasoning", detail: "streamed and complete" },
      }),
    );
    expect(late.startedAt).toBe(first.createdAt);
  });
});

describe("ReasoningTracker late events", () => {
  it("continues a closed block with its earlier text instead of overwriting it", () => {
    const tracker = new ReasoningTracker();
    const first = delta("Full earlier thought.", { itemId: "rs_late", raw: true });
    tracker.appendDelta({
      event: first,
      threadId: THREAD_ID,
      streamKind: "reasoning_text",
      delta: "Full earlier thought.",
    });
    tracker.complete(
      THREAD_ID,
      runtimeEvent({
        type: "item.completed",
        itemId: RuntimeItemId.make("rs_late"),
        payload: { itemType: "reasoning" },
      }),
    );

    const late = tracker.appendDelta({
      event: delta(" A late tail.", { itemId: "rs_late", raw: true }),
      threadId: THREAD_ID,
      streamKind: "reasoning_text",
      delta: " A late tail.",
    });
    expect(late.segment.startedAt).toBe(first.createdAt);
    expect(buildReasoningActivity(late.segment, { final: true }).payload).toMatchObject({
      text: "Full earlier thought. A late tail.",
    });
  });
});

describe("reasoning helpers", () => {
  it("extracts the latest bold headline", () => {
    expect(reasoningHeadline("**One**\n\nA\n\n**Two words**\n\nB")).toBe("Two words");
    expect(reasoningHeadline("Plain prose with **inline bold** only")).toBeUndefined();
  });

  it("reads completion text from Codex items and Copilot details", () => {
    expect(
      completionTextFromReasoningItem(
        runtimeEvent({
          type: "item.completed",
          payload: { itemType: "reasoning", data: { item: { summary: [], content: ["raw"] } } },
        }),
      ),
    ).toBe("raw");
    expect(
      completionTextFromReasoningItem(
        runtimeEvent({
          type: "item.completed",
          payload: { itemType: "reasoning", detail: "full" },
        }),
      ),
    ).toBe("full");
  });

  it("turns replayed reasoning items into settled rows", () => {
    const [activity] = historyReasoningActivities(
      THREAD_ID,
      runtimeEvent({
        type: "item.completed",
        itemId: RuntimeItemId.make("rs_hist"),
        payload: { itemType: "reasoning", data: { item: { summary: ["Recovered"] } } },
      }),
    );
    expect(activity?.payload).toMatchObject({
      providerItemId: "rs_hist",
      text: "Recovered",
      streaming: false,
    });
  });
});
