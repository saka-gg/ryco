import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const createdAt = "2026-10-16T10:00:00.000Z";
const threadId = ThreadId.make("thread-writing");
const other = ThreadId.make("thread-mentioned");
const turnId = TurnId.make("turn-active");

const idleThread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-mentions"),
  title: "Writing",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
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
  session: null,
};

const runningThread: OrchestrationThread = {
  ...idleThread,
  latestTurn: {
    turnId,
    state: "running",
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    assistantMessageId: null,
  },
  session: {
    threadId,
    status: "running",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeSessionId: RuntimeSessionId.make("runtime-mentions"),
    runtimeMode: "full-access",
    activeTurnId: turnId,
    lastError: null,
    updatedAt: createdAt,
  },
};

const readModelWith = (thread: OrchestrationThread): OrchestrationReadModel => ({
  snapshotSequence: 1,
  projects: [],
  threads: [thread],
  updatedAt: createdAt,
});

const message = (id: string) => ({
  messageId: MessageId.make(id),
  role: "user" as const,
  text: `Compare with @thread:${other}`,
  attachments: [],
});

function eventOfType<T extends OrchestrationEvent["type"]>(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  type: T,
) {
  const events = Array.isArray(result) ? result : [result];
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`missing ${type}`);
  return event as unknown as Extract<OrchestrationEvent, { type: T }>;
}

describe("thread mentions in the decider", () => {
  it("records a turn start's mentions without repeats or the thread itself", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: readModelWith(idleThread),
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-mention-start"),
          threadId,
          message: message("message-mention-start"),
          runtimeMode: "full-access",
          interactionMode: "default",
          threadReferences: [other, threadId, other],
          createdAt,
        },
      }),
    );
    expect(eventOfType(result, "thread.turn-start-requested").payload.threadReferences).toEqual([
      other,
    ]);
    // The stored message keeps the token, never an excerpt.
    expect(eventOfType(result, "thread.message-sent").payload.text).toBe(
      `Compare with @thread:${other}`,
    );
  });

  it("leaves a turn start without mentions unchanged", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: readModelWith(idleThread),
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-mention-none"),
          threadId,
          message: message("message-mention-none"),
          runtimeMode: "full-access",
          interactionMode: "default",
          threadReferences: [threadId],
          createdAt,
        },
      }),
    );
    expect(eventOfType(result, "thread.turn-start-requested").payload).not.toHaveProperty(
      "threadReferences",
    );
  });

  it("records a steer's mentions", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: readModelWith(runningThread),
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("command-mention-steer"),
          threadId,
          expectedTurnId: turnId,
          message: message("message-mention-steer"),
          threadReferences: [other],
          createdAt,
          requestedAt: createdAt,
        },
      }),
    );
    expect(eventOfType(result, "thread.turn-steer-requested").payload.threadReferences).toEqual([
      other,
    ]);
  });
});
