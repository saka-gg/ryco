import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { threadForkedActivityId } from "./forkInheritance.ts";
import {
  isThreadSessionWakeEvent,
  isThreadWaitWakeActivity,
  isThreadWaitWakeEvent,
} from "./threadWaitWakeEvents.ts";

const threadId = ThreadId.make("thread-waited");
const now = "2026-10-23T00:00:00.000Z";

const event = (type: OrchestrationEventType, payload: Record<string, unknown> = {}) =>
  ({
    sequence: 1,
    eventId: EventId.make(`event-${type}`),
    aggregateKind: type.startsWith("project.")
      ? "project"
      : type.startsWith("worktree.")
        ? "worktree"
        : "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { threadId, ...payload },
  }) as unknown as OrchestrationEvent;

const activity = (
  kind: string,
  payload: Record<string, unknown> = {},
  id = `activity-${kind}`,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId: null,
  createdAt: now,
});

const appended = (value: OrchestrationThreadActivity) =>
  event("thread.activity-appended", { activity: value });

describe("isThreadWaitWakeEvent", () => {
  it("wakes on the lifecycle events that can settle a thread", () => {
    for (const type of [
      "thread.session-set",
      "thread.turn-diff-completed",
      "thread.turn-interrupt-requested",
      "thread.reverted",
      "thread.deleted",
      "thread.archived",
      "thread.approval-response-requested",
      "thread.user-input-response-requested",
    ] as const) {
      expect(isThreadWaitWakeEvent(event(type)), type).toBe(true);
    }
  });

  it("ignores every message, streaming or completed, from any role", () => {
    for (const payload of [
      { role: "assistant", streaming: true },
      // One per agent step: the turn's end arrives with the session-set that releases it.
      { role: "assistant", streaming: false },
      { role: "user", streaming: false },
    ]) {
      expect(isThreadWaitWakeEvent(event("thread.message-sent", payload))).toBe(false);
    }
  });

  it("ignores events that cannot move a waited predicate", () => {
    for (const type of [
      "thread.goal-updated",
      "thread.snoozed",
      "thread.settled",
      "thread.proposed-plan-upserted",
      "thread.turn-start-requested",
      "thread.turn-steer-requested",
      "thread.session-stop-requested",
      "project.deleted",
      "worktree.created",
    ] as const) {
      expect(isThreadWaitWakeEvent(event(type)), type).toBe(false);
    }
  });

  it("ignores an event type this build does not know", () => {
    expect(isThreadWaitWakeEvent(event("thread.future-event" as OrchestrationEventType))).toBe(
      false,
    );
  });
});

describe("isThreadWaitWakeActivity", () => {
  it("wakes on every pending-request transition", () => {
    for (const kind of [
      "approval.requested",
      "approval.resolved",
      "provider.approval.respond.failed",
      "user-input.requested",
      "user-input.resolved",
      "provider.user-input.respond.failed",
    ]) {
      expect(isThreadWaitWakeActivity(threadId, activity(kind)), kind).toBe(true);
      expect(isThreadWaitWakeEvent(appended(activity(kind))), kind).toBe(true);
    }
  });

  it("wakes on task and subagent ends and on session boundaries", () => {
    for (const kind of ["task.completed", "subagent.completed"]) {
      expect(isThreadWaitWakeActivity(threadId, activity(kind, { status: "completed" }))).toBe(
        true,
      );
    }
    // Ingestion clears liveness after the stopping session-set; this activity follows the clear.
    expect(
      isThreadWaitWakeActivity(
        threadId,
        activity("background-work.session-boundary", { state: "stopped" }),
      ),
    ).toBe(true);
  });

  it("wakes on task and subagent updates only when their status ends liveness", () => {
    for (const kind of ["task.updated", "task.progress", "subagent.updated"]) {
      for (const status of ["idle", "completed", "failed", "stopped", "cancelled", "interrupted"]) {
        expect(isThreadWaitWakeActivity(threadId, activity(kind, { status })), kind).toBe(true);
      }
      // The per-tick updates of a busy fleet.
      for (const status of ["running", "waiting", "starting", "pending"]) {
        expect(isThreadWaitWakeActivity(threadId, activity(kind, { status })), kind).toBe(false);
      }
      expect(isThreadWaitWakeActivity(threadId, activity(kind, {})), kind).toBe(false);
      expect(isThreadWaitWakeActivity(threadId, activity(kind, { status: 1 })), kind).toBe(false);
    }
  });

  it("ignores starts, tool activity, agent messages and context updates", () => {
    for (const kind of [
      "task.started",
      "subagent.started",
      "tool.progress",
      "tool.updated",
      "tool.completed",
      "agent.message",
      "context-window.updated",
    ]) {
      expect(isThreadWaitWakeActivity(threadId, activity(kind)), kind).toBe(false);
    }
  });

  it("wakes on a failed or cancelled turn start that names its message", () => {
    expect(
      isThreadWaitWakeActivity(
        threadId,
        activity("provider.turn.start.failed", { messageId: MessageId.make("message-1") }),
      ),
    ).toBe(true);
    expect(isThreadWaitWakeActivity(threadId, activity("provider.turn.start.failed", {}))).toBe(
      false,
    );
  });

  it("wakes on the fork provenance of the waited thread only", () => {
    const provenance = activity(
      "thread.forked",
      {
        schemaVersion: 1,
        sourceThreadId: "thread-source",
        sourceMessageId: "message-boundary",
        sourceTurnId: "turn-boundary",
        sourceTitle: "Source",
        inheritedMessageCount: 2,
        inheritedTurnOutcomes: [{ turnId: TurnId.make("turn-stopped"), state: "interrupted" }],
        providerContext: "handoff",
        handoffReason: "provider-unsupported",
        checkout: { kind: "current-checkout", worktreePath: null, branch: null },
        notices: [],
      },
      threadForkedActivityId(threadId),
    );
    expect(isThreadWaitWakeActivity(threadId, provenance)).toBe(true);
    expect(isThreadWaitWakeActivity(ThreadId.make("thread-other"), provenance)).toBe(false);
  });
});

describe("isThreadSessionWakeEvent", () => {
  it("wakes only on session, archive and delete events", () => {
    expect(isThreadSessionWakeEvent(event("thread.session-set"))).toBe(true);
    expect(isThreadSessionWakeEvent(event("thread.archived"))).toBe(true);
    expect(isThreadSessionWakeEvent(event("thread.deleted"))).toBe(true);
    for (const type of [
      "thread.turn-diff-completed",
      "thread.activity-appended",
      "thread.message-sent",
      "thread.unarchived",
    ] as const) {
      expect(isThreadSessionWakeEvent(event(type)), type).toBe(false);
    }
  });
});
