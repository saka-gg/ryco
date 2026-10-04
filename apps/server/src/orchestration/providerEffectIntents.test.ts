import {
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROVIDER_EFFECT_INTENT_PLAN,
  isTrackedProviderIntentEvent,
  planProviderEffectIntent,
  recoveryCopy,
  turnStartEndedMessageId,
} from "./providerEffectIntents.ts";

const threadId = ThreadId.make("thread-intents");
const messageId = MessageId.make("message-intents");
const handoffId = ContextHandoffId.make("handoff-intents");
const at = "2026-10-04T00:00:00.000Z";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

function event<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  sequence = 42,
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

const turnStartRequested = (contextHandoff?: boolean) =>
  event("thread.turn-start-requested", {
    threadId,
    messageId,
    runtimeMode: "full-access",
    interactionMode: "default",
    tokenMode: "balanced",
    ...(contextHandoff
      ? {
          contextHandoff: {
            handoffId,
            activityId: EventId.make("handoff-activity"),
            targetMessageId: messageId,
          },
        }
      : {}),
    createdAt: at,
  });

const activity = (kind: string, payload: unknown) =>
  event("thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.make(`activity-${kind}`),
      tone: "error",
      kind,
      summary: "Activity",
      payload,
      turnId: null,
      createdAt: at,
    },
  });

const handoffActivity = (status: string, extra: Record<string, unknown> = {}) =>
  activity("context-handoff", {
    schemaVersion: 1,
    handoffId,
    mode: "full-context-fresh-session",
    status,
    targetMessageId: messageId,
    sourceSelection: selection,
    targetSelection: selection,
    ...extra,
  });

const endpoint = {
  providerInstanceId: selection.instanceId,
  driverKind: "codex",
  modelSlug: selection.model,
};

const session = (status: "running" | "ready" | "stopped" | "error", activeTurnId: string | null) =>
  event("thread.session-set", {
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      providerInstanceId: selection.instanceId,
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
      lastError: null,
      updatedAt: at,
    },
  });

describe("planProviderEffectIntent", () => {
  it.each([
    {
      name: "turn start",
      event: turnStartRequested(),
      record: { kind: "turn-start", messageId, handoffId: null },
    },
    {
      name: "handoff turn start",
      event: turnStartRequested(true),
      record: { kind: "turn-start", messageId, handoffId },
    },
    {
      name: "steer",
      event: event("thread.turn-steer-requested", {
        threadId,
        expectedTurnId: TurnId.make("turn-1"),
        message: { messageId, role: "user", text: "steer", attachments: [] },
        createdAt: at,
        requestedAt: at,
      }),
      record: { kind: "turn-steer", messageId, handoffId: null },
    },
    {
      name: "session stop",
      event: event("thread.session-stop-requested", { threadId, createdAt: at }),
      record: { kind: "session-stop", messageId: null, handoffId: null },
    },
  ])("records a $name request", ({ event: requested, record }) => {
    expect(isTrackedProviderIntentEvent(requested)).toBe(true);
    expect(planProviderEffectIntent(requested)).toEqual({
      record: {
        sequence: 42,
        eventId: EventId.make("event-42"),
        threadId,
        recordedAt: at,
        ...record,
      },
      settlements: [],
      beforeSequence: 42,
    });
  });

  it.each([
    {
      name: "a start failure",
      event: activity("provider.turn.start.failed", { messageId, detail: "boom" }),
      settlements: [{ _tag: "ByMessage", threadId, kind: "turn-start", messageId }],
    },
    {
      name: "a Stop's start cancel",
      event: activity("provider.turn.start.cancelled", { messageId, detail: "stopped" }),
      settlements: [{ _tag: "ByMessage", threadId, kind: "turn-start", messageId }],
    },
    ...(["consumed", "failed", "delivery-uncertain"] as const).map((status) => ({
      name: `a ${status} handoff`,
      event: handoffActivity(status, {
        sources: [endpoint],
        target: endpoint,
        contextVersion: 1,
        contextDigest: "a".repeat(64),
        ...(status === "consumed" ? {} : { error: "failed" }),
      }),
      settlements: [{ _tag: "ByHandoff", threadId, handoffId }],
    })),
    {
      name: "a session stop failure",
      event: activity("provider.session.stop.failed", { detail: "boom" }),
      settlements: [{ _tag: "SessionStops", threadId }],
    },
    ...(["thread.turn-steer-accepted", "thread.turn-steer-rejected"] as const).map((type) => ({
      name: type,
      event:
        type === "thread.turn-steer-accepted"
          ? event(type, {
              threadId,
              messageId,
              expectedTurnId: TurnId.make("turn-1"),
              turnId: TurnId.make("turn-1"),
              resolvedAt: at,
            })
          : event(type, {
              threadId,
              messageId,
              expectedTurnId: TurnId.make("turn-1"),
              error: "rejected",
              resolvedAt: at,
            }),
      settlements: [{ _tag: "ByMessage", threadId, kind: "turn-steer", messageId }],
    })),
    {
      name: "a running session with a turn",
      event: session("running", "turn-1"),
      settlements: [{ _tag: "DispatchedTurnStarts", threadId }],
    },
    {
      name: "a stopped session",
      event: session("stopped", null),
      settlements: [{ _tag: "SessionStops", threadId }],
    },
    {
      name: "a deleted thread",
      event: event("thread.deleted", { threadId, deletedAt: at }),
      settlements: [{ _tag: "Thread", threadId }],
    },
  ])("settles on $name", ({ event: settling, settlements }) => {
    expect(planProviderEffectIntent(settling)).toEqual({
      record: null,
      settlements,
      beforeSequence: 42,
    });
  });

  it.each([
    ...(["requested", "preparing"] as const).map((status) => ({
      name: `a ${status} handoff`,
      event: handoffActivity(status),
    })),
    {
      name: "a dispatching handoff",
      event: handoffActivity("dispatching", {
        sources: [endpoint],
        target: endpoint,
        contextVersion: 1,
        contextDigest: "a".repeat(64),
      }),
    },
    { name: "an undecodable handoff payload", event: activity("context-handoff", { bad: true }) },
    {
      name: "a start failure without messageId",
      event: activity("provider.turn.start.failed", { detail: "boom" }),
    },
    {
      name: "a start failure with an empty messageId",
      event: activity("provider.turn.start.failed", { messageId: " ", detail: "boom" }),
    },
    { name: "a ready session", event: session("ready", null) },
    { name: "a running session without a turn", event: session("running", null) },
    { name: "an error session", event: session("error", null) },
    {
      name: "an untracked event",
      event: event("thread.turn-interrupt-requested", { threadId, createdAt: at }),
    },
  ])("plans nothing for $name", ({ event: untracked }) => {
    expect(planProviderEffectIntent(untracked)).toBe(EMPTY_PROVIDER_EFFECT_INTENT_PLAN);
  });

  it("only tracks turn start, steer and session stop requests", () => {
    expect(
      isTrackedProviderIntentEvent(
        event("thread.turn-interrupt-requested", { threadId, createdAt: at }),
      ),
    ).toBe(false);
    expect(isTrackedProviderIntentEvent(session("running", "turn-1"))).toBe(false);
  });
});

describe("turnStartEndedMessageId", () => {
  it("reads the message of failed and cancelled starts only", () => {
    const read = (kind: string, payload: unknown) => {
      const appended = activity(kind, payload);
      return appended.type === "thread.activity-appended"
        ? turnStartEndedMessageId(appended.payload.activity)
        : null;
    };
    expect(read("provider.turn.start.failed", { messageId })).toBe(messageId);
    expect(read("provider.turn.start.cancelled", { messageId })).toBe(messageId);
    expect(read("provider.turn.interrupt.failed", { messageId })).toBeNull();
    expect(read("provider.turn.start.failed", null)).toBeNull();
    expect(read("provider.turn.start.failed", { messageId: 7 })).toBeNull();
  });
});

describe("recoveryCopy", () => {
  it.each([
    {
      kind: "turn-start",
      deliveryState: "not-sent",
      delegatedReturn: false,
      summary: "Message was not sent",
      detail:
        "Ryco restarted before this message reached the provider. Nothing was sent. Send it again to continue.",
    },
    {
      kind: "turn-start",
      deliveryState: "uncertain",
      delegatedReturn: false,
      summary: "Message delivery unconfirmed",
      detail:
        "Ryco restarted after handing this message to the provider but before the provider confirmed it. It may have been received. Check the thread before sending it again.",
    },
    {
      kind: "turn-start",
      deliveryState: "not-sent",
      delegatedReturn: true,
      summary: "Delegated return was not submitted",
      detail:
        "Ryco restarted before this delegated result reached the provider. Inspect the result before sending it manually.",
    },
    {
      kind: "turn-start",
      deliveryState: "uncertain",
      delegatedReturn: true,
      summary: "Delegated return delivery unconfirmed",
      detail:
        "Ryco restarted while submitting this delegated result. It may have reached the provider. Inspect the parent thread before sending it manually.",
    },
    {
      kind: "turn-steer",
      deliveryState: "not-sent",
      delegatedReturn: false,
      summary: "Steer failed",
      detail: "Ryco restarted before this steer message reached the provider. It was not sent.",
    },
    {
      kind: "turn-steer",
      deliveryState: "uncertain",
      delegatedReturn: false,
      summary: "Steer failed",
      detail:
        "Ryco restarted while delivering this steer message. It may have reached the provider. Check the turn before sending it again.",
    },
  ] as const)(
    "words $kind / $deliveryState (delegated: $delegatedReturn)",
    ({ summary, detail, ...input }) => {
      expect(recoveryCopy(input)).toEqual({ summary, detail });
    },
  );
});
