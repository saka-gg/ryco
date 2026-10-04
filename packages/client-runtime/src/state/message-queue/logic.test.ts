import { describe, expect, it } from "vite-plus/test";
import type { CommandId, MessageId, ModelSelection, ThreadId, TurnId } from "@ryco/contracts";

import {
  buildQueuedMessageSteerCommand,
  getQueuedThreadKeys,
  indexTurnSteerRejections,
  moveQueuedMessage,
  resolveComposerFollowUpAction,
  resolveQueuedMessageSteerEligibility,
  resolveQueuedMessageSteerOutcome,
  type QueuedMessageSteerAttempt,
} from "./logic.ts";

const activeSelection = {
  instanceId: "codex-main",
  model: "gpt-5.6-codex",
  options: [{ id: "reasoningEffort", value: "high" }],
} as unknown as ModelSelection;

const steerable = {
  mutationReady: true,
  turnRunning: true,
  activeTurnId: "turn-active" as TurnId,
  supportsTurnSteering: true,
  queuedModelSelection: {
    instanceId: "codex-main",
    model: "gpt-5.6-codex",
    options: [{ id: "reasoningEffort", value: "high" }],
  } as unknown as ModelSelection,
  activeModelSelection: activeSelection,
  queuedRuntimeMode: "full-access" as const,
  activeRuntimeMode: "full-access" as const,
  queuedInteractionMode: "default" as const,
  activeInteractionMode: "default" as const,
  queuedTokenMode: "balanced" as const,
  activeTokenMode: "balanced" as const,
};

describe("message queue", () => {
  it("moves only the requested item by one position", () => {
    const queue = ["a", "b", "c"].map((id) => ({ id, composer: null, settings: null }));
    expect(moveQueuedMessage(queue, "b", "up").map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("allows structurally matching queued settings on the exact active turn", () => {
    expect(resolveQueuedMessageSteerEligibility(steerable)).toEqual({
      allowed: true,
      expectedTurnId: "turn-active",
    });
  });

  it("builds the provider-neutral steer command without turn-start overrides", () => {
    expect(
      buildQueuedMessageSteerCommand({
        commandId: "command-steer" as CommandId,
        threadId: "thread-steer" as ThreadId,
        expectedTurnId: "turn-active" as TurnId,
        messageId: "message-steer" as MessageId,
        text: "Preserve the retry state.",
        attachments: [],
        createdAt: "2026-08-17T10:00:00.000Z",
        requestedAt: "2026-08-17T10:00:01.000Z",
      }),
    ).toEqual({
      type: "thread.turn.steer",
      commandId: "command-steer",
      threadId: "thread-steer",
      expectedTurnId: "turn-active",
      message: {
        messageId: "message-steer",
        role: "user",
        text: "Preserve the retry state.",
        attachments: [],
      },
      createdAt: "2026-08-17T10:00:00.000Z",
      requestedAt: "2026-08-17T10:00:01.000Z",
    });
  });

  it("explains unsupported, stale-setting, and disconnected steer attempts", () => {
    expect(
      resolveQueuedMessageSteerEligibility({ ...steerable, supportsTurnSteering: false }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("does not support") });
    expect(
      resolveQueuedMessageSteerEligibility({
        ...steerable,
        queuedTokenMode: "aggressive",
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("settings") });
    expect(
      resolveQueuedMessageSteerEligibility({ ...steerable, mutationReady: false }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("connection") });
  });

  it("returns only scoped keys with non-empty queues", () => {
    expect(
      getQueuedThreadKeys({
        "environment-a:thread-a": [{ id: "message", composer: null, settings: null }],
        "environment-a:thread-b": [],
      }),
    ).toEqual(new Set(["environment-a:thread-a"]));
  });
});

describe("resolveComposerFollowUpAction", () => {
  const resolve = (overrides: Partial<Parameters<typeof resolveComposerFollowUpAction>[0]> = {}) =>
    resolveComposerFollowUpAction({
      turnRunning: true,
      followUpBehavior: "queue",
      invert: false,
      surfaceAllowsSteer: true,
      isSlashCommand: false,
      ...overrides,
    });

  it("sends when no turn runs, whatever the modifier", () => {
    expect(resolve({ turnRunning: false })).toBe("send");
    expect(resolve({ turnRunning: false, invert: true, followUpBehavior: "steer" })).toBe("send");
  });

  it("applies the setting and inverts it with the modifier", () => {
    expect(resolve()).toBe("queue");
    expect(resolve({ invert: true })).toBe("steer");
    expect(resolve({ followUpBehavior: "steer" })).toBe("steer");
    expect(resolve({ followUpBehavior: "steer", invert: true })).toBe("queue");
  });

  it("queues on a surface that cannot steer and for slash commands", () => {
    expect(resolve({ followUpBehavior: "steer", surfaceAllowsSteer: false })).toBe("queue");
    expect(resolve({ invert: true, surfaceAllowsSteer: false })).toBe("queue");
    expect(resolve({ followUpBehavior: "steer", isSlashCommand: true })).toBe("queue");
  });
});

describe("resolveQueuedMessageSteerOutcome", () => {
  const attempt: QueuedMessageSteerAttempt = {
    commandId: "cmd-new",
    expectedTurnId: "turn-active" as TurnId,
    startedAt: "2026-10-04T10:00:00.000Z",
    explicit: false,
  };
  const rejection = (commandId: string, payload: Record<string, unknown>) => ({
    id: `turn-steer-rejected:${commandId}`,
    kind: "provider.turn.steer.failed",
    payload: { messageId: "message-1", error: "Not now.", ...payload },
  });
  const outcome = (
    activities: ReadonlyArray<{ id: string; kind: string; payload: unknown }>,
    projected: ReadonlyArray<string> = [],
  ) =>
    resolveQueuedMessageSteerOutcome({
      messageId: "message-1",
      attempt,
      projectedMessageIds: new Set(projected),
      rejectionsByActivityId: indexTurnSteerRejections(activities),
    });

  it("is accepted once the message is projected", () => {
    expect(outcome([], ["message-1"])).toEqual({ status: "accepted" });
  });

  it("is rejected only by this attempt's own request", () => {
    expect(outcome([rejection("cmd-new", { reason: "deferred" })])).toEqual({
      status: "rejected",
      reason: "deferred",
      error: "Not now.",
    });
  });

  it("stays pending on a stale rejection of an earlier attempt", () => {
    expect(outcome([rejection("cmd-old", { reason: "failed" })])).toEqual({ status: "pending" });
  });

  it("reads a legacy rejection without a reason as failed", () => {
    expect(outcome([rejection("cmd-new", {})])).toEqual({
      status: "rejected",
      reason: "failed",
      error: "Not now.",
    });
  });
});
