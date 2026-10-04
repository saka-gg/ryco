import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";

const createdAt = "2026-08-17T10:00:00.000Z";
const requestedAt = "2026-08-17T10:00:01.000Z";
const resolvedAt = "2026-08-17T10:00:02.000Z";
const threadId = ThreadId.make("thread-steer");
const turnId = TurnId.make("turn-active");
const messageId = MessageId.make("message-steer");

const thread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-steer"),
  title: "Steering",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId,
    state: "running",
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId,
    status: "running",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeSessionId: RuntimeSessionId.make("runtime-steer"),
    runtimeMode: "full-access",
    activeTurnId: turnId,
    lastError: null,
    updatedAt: createdAt,
  },
};

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [],
  threads: [thread],
  updatedAt: createdAt,
};

const message = {
  messageId,
  role: "user" as const,
  text: "Take the failing retry into account.",
  attachments: [],
};

describe("turn steering decider", () => {
  it("persists only a request before the provider accepts", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("command-steer-request"),
          threadId,
          expectedTurnId: turnId,
          message,
          createdAt,
          requestedAt,
        },
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual(["thread.turn-steer-requested"]);
  });

  it("projects an accepted steer as a user message on the existing turn", async () => {
    const command: OrchestrationCommand = {
      type: "thread.turn.steer.resolve",
      commandId: CommandId.make("command-steer-accepted"),
      requestCommandId: CommandId.make("command-steer-request"),
      threadId,
      expectedTurnId: turnId,
      message,
      createdAt,
      requestedAt,
      resolution: { status: "accepted", turnId, resolvedAt },
    };
    const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-steer-accepted",
    ]);
    const projected = events[0];
    expect(projected?.type).toBe("thread.message-sent");
    if (projected?.type !== "thread.message-sent") return;
    expect(projected.payload).toMatchObject({
      messageId,
      turnId,
      dispatchMode: "steer",
      createdAt,
      updatedAt: resolvedAt,
    });
  });

  it("keeps the message unprojected when steering is rejected", async () => {
    const command: OrchestrationCommand = {
      type: "thread.turn.steer.resolve",
      commandId: CommandId.make("command-steer-rejected"),
      requestCommandId: CommandId.make("command-steer-request"),
      threadId,
      expectedTurnId: turnId,
      message,
      createdAt,
      requestedAt,
      resolution: { status: "rejected", error: "turn already completed", resolvedAt },
    };
    const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.turn-steer-rejected",
      "thread.activity-appended",
    ]);
    expect(events.some((event) => event.type === "thread.message-sent")).toBe(false);
  });

  const steerCommand = (model: OrchestrationReadModel, expectedTurnId = turnId) =>
    decideOrchestrationCommand({
      readModel: model,
      command: {
        type: "thread.turn.steer",
        commandId: CommandId.make("command-steer-late"),
        threadId,
        expectedTurnId,
        message,
        createdAt,
        requestedAt,
      },
    });

  const expectDeferredRejection = (result: unknown) => {
    const events = (Array.isArray(result) ? result : [result]) as ReadonlyArray<{
      readonly type: string;
      readonly payload: Record<string, unknown>;
    }>;
    expect(events.map((event) => event.type)).toEqual([
      "thread.turn-steer-rejected",
      "thread.activity-appended",
    ]);
    expect(events[0]?.payload).toMatchObject({ messageId, reason: "deferred" });
    expect(events[1]?.payload.activity).toMatchObject({
      id: "turn-steer-rejected:command-steer-late",
      kind: "provider.turn.steer.failed",
      tone: "info",
      summary: "Steer deferred",
      payload: { messageId, reason: "deferred" },
    });
  };

  it("defers a steer when the thread has no running session", async () => {
    const idle: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          ...thread,
          session: { ...thread.session!, status: "ready", activeTurnId: null },
        },
      ],
    };
    expectDeferredRejection(await Effect.runPromise(steerCommand(idle)));
  });

  it("defers a steer aimed at a turn that is no longer active", async () => {
    expectDeferredRejection(
      await Effect.runPromise(steerCommand(readModel, TurnId.make("turn-ended"))),
    );
  });

  const resolveRejected = (resolution: {
    readonly error: string;
    readonly reason?: "deferred" | "failed";
  }) =>
    decideOrchestrationCommand({
      readModel,
      command: {
        type: "thread.turn.steer.resolve",
        commandId: CommandId.make("command-steer-rejected"),
        requestCommandId: CommandId.make("command-steer-request"),
        threadId,
        expectedTurnId: turnId,
        message,
        createdAt,
        requestedAt,
        resolution: { status: "rejected", resolvedAt, ...resolution },
      },
    });

  it("records a deferred provider rejection as a quiet info activity", async () => {
    const result = await Effect.runPromise(
      resolveRejected({ error: "The turn finished.", reason: "deferred" }),
    );
    const events = Array.isArray(result) ? result : [result];
    const activity = events[1];
    expect(activity?.type).toBe("thread.activity-appended");
    if (activity?.type !== "thread.activity-appended") return;
    expect(activity.payload.activity).toMatchObject({
      id: "turn-steer-rejected:command-steer-request",
      tone: "info",
      summary: "Steer deferred",
      payload: { reason: "deferred", error: "The turn finished." },
    });
  });

  it("reads a resolve without a reason as a failed steer", async () => {
    const result = await Effect.runPromise(resolveRejected({ error: "Provider exploded." }));
    const events = Array.isArray(result) ? result : [result];
    const rejected = events[0];
    expect(rejected?.type === "thread.turn-steer-rejected" && rejected.payload.reason).toBe(
      "failed",
    );
    const activity = events[1];
    if (activity?.type !== "thread.activity-appended") throw new Error("missing activity");
    expect(activity.payload.activity).toMatchObject({
      tone: "error",
      summary: "Steer failed",
      payload: { reason: "failed", error: "Provider exploded." },
    });
  });
});
