import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  MessageId,
  type ThreadGoal,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const threadId = ThreadId.make("goal-thread");
const projectId = ProjectId.make("goal-project");
type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence"> : never;
type PlannedEvent = WithoutSequence<OrchestrationEvent>;

function expectSingleEvent(value: unknown): PlannedEvent {
  if (Array.isArray(value)) {
    throw new Error(`Expected one event, received ${value.length}.`);
  }
  return value as PlannedEvent;
}

async function seedThread(at: string) {
  const projectEventValue = {
    sequence: 1,
    eventId: EventId.make("goal-project-created"),
    aggregateKind: "project" as const,
    aggregateId: projectId,
    type: "project.created" as const,
    occurredAt: at,
    commandId: CommandId.make("goal-project-create"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId,
      title: "Goal project",
      workspaceRoot: "/tmp/goal-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  } satisfies OrchestrationEvent;
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(at), projectEventValue),
  );
  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.make("goal-thread-created"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: at,
      commandId: CommandId.make("goal-thread-create"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        projectId,
        title: "Goal thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
}

describe("thread goal decider", () => {
  it("sets, pauses without inventing provider usage, and requests a clear", async () => {
    const createdAt = "2026-08-17T10:00:00.000Z";
    const initial = await seedThread(createdAt);
    const setEvent = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: initial,
          command: {
            type: "thread.goal.set",
            commandId: CommandId.make("goal-set"),
            threadId,
            objective: "Ship durable thread goals",
            createdAt,
          },
        }),
      ),
    );
    if (setEvent.type !== "thread.goal-updated") return;
    expect(setEvent.payload.goal).toMatchObject({
      objective: "Ship durable thread goals",
      status: "active",
      timeUsedSeconds: 0,
      tokensUsed: 0,
    });

    const withGoal = await Effect.runPromise(
      projectEvent(initial, { ...setEvent, sequence: 3 } as OrchestrationEvent),
    );
    const pausedAt = "2026-08-17T10:01:01.000Z";
    const pauseEvent = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: withGoal,
          command: {
            type: "thread.goal.set",
            commandId: CommandId.make("goal-pause"),
            threadId,
            status: "paused",
            createdAt: pausedAt,
          },
        }),
      ),
    );
    if (pauseEvent.type !== "thread.goal-updated") return;
    expect(pauseEvent.payload.goal.status).toBe("paused");
    expect(pauseEvent.payload.goal.timeUsedSeconds).toBe(0);
    expect(pauseEvent.payload.goal.synchronization?.fields).toEqual(["objective", "status"]);

    const paused = await Effect.runPromise(
      projectEvent(withGoal, { ...pauseEvent, sequence: 4 } as OrchestrationEvent),
    );
    const clearEvent = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: paused,
          command: {
            type: "thread.goal.clear",
            commandId: CommandId.make("goal-clear"),
            threadId,
            createdAt: pausedAt,
          },
        }),
      ),
    );
    expect(clearEvent.type).toBe("thread.goal-updated");
    if (clearEvent.type === "thread.goal-updated") {
      expect(clearEvent.payload.goal.synchronization).toMatchObject({
        state: "pending",
        action: "clear",
      });
    }
  });
});

const goalTime = "2026-08-17T10:00:00.000Z";
const nativeGoal = {
  objective: "Ship the migration",
  status: "active" as const,
  tokenBudget: 1000,
  tokensUsed: 250,
  timeUsedSeconds: 30,
  createdAt: goalTime,
  updatedAt: goalTime,
};
async function modelWithGoal(goal: ThreadGoal = nativeGoal) {
  const initial = await seedThread(goalTime);
  const event = expectSingleEvent(
    await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "thread.goal.sync",
          commandId: CommandId.make("native-goal"),
          threadId,
          goal,
          createdAt: goalTime,
        },
      }),
    ),
  );
  return Effect.runPromise(projectEvent(initial, { ...event, sequence: 3 } as OrchestrationEvent));
}

describe("goal confirmation and lifecycle", () => {
  it("rejects late notifications and superseded confirmations while a change is pending", async () => {
    const state = await modelWithGoal({
      ...nativeGoal,
      synchronization: { requestId: "new-request", state: "pending", action: "set" },
    });
    for (const expectedRequestId of [undefined, "old-request"]) {
      await expect(
        Effect.runPromise(
          decideOrchestrationCommand({
            readModel: state,
            command: {
              type: "thread.goal.sync",
              commandId: CommandId.make("late"),
              threadId,
              goal: nativeGoal,
              ...(expectedRequestId ? { expectedRequestId } : {}),
              createdAt: goalTime,
            },
          }),
        ),
      ).rejects.toThrow("Superseded goal update");
    }
    const confirmed = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: state,
          command: {
            type: "thread.goal.sync",
            commandId: CommandId.make("confirmed"),
            threadId,
            goal: nativeGoal,
            expectedRequestId: "new-request",
            createdAt: goalTime,
          },
        }),
      ),
    );
    expect(confirmed).toMatchObject({
      type: "thread.goal-updated",
      payload: { goal: nativeGoal, origin: "provider" },
    });
  });

  it("only clears a pending goal after the matching confirmation", async () => {
    const state = await modelWithGoal({
      ...nativeGoal,
      synchronization: { requestId: "clear-request", state: "pending", action: "clear" },
    });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: state,
          command: {
            type: "thread.goal.provider-clear",
            commandId: CommandId.make("late-clear"),
            threadId,
            createdAt: goalTime,
          },
        }),
      ),
    ).rejects.toThrow("Superseded goal clear");
    const confirmed = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: state,
          command: {
            type: "thread.goal.provider-clear",
            commandId: CommandId.make("confirmed-clear"),
            threadId,
            expectedRequestId: "clear-request",
            createdAt: goalTime,
          },
        }),
      ),
    );
    expect(confirmed.type).toBe("thread.goal-cleared");
  });

  it("preserves usage for status edits and resets completed objectives when explicitly set again", async () => {
    const state = await modelWithGoal({ ...nativeGoal, status: "complete" });
    const decide = (update: {
      objective?: string;
      status?: "paused";
      tokenBudget?: number | null;
    }) =>
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: state,
          command: {
            type: "thread.goal.set",
            commandId: CommandId.make("edit-goal"),
            threadId,
            ...update,
            createdAt: "2026-08-17T11:00:00.000Z",
          },
        }),
      );
    expect(expectSingleEvent(await decide({ tokenBudget: 2000 }))).toMatchObject({
      payload: { goal: { synchronization: { fields: ["tokenBudget"] } } },
    });
    expect(expectSingleEvent(await decide({ status: "paused" }))).toMatchObject({
      payload: { goal: { tokensUsed: 250, timeUsedSeconds: 30, tokenBudget: 1000 } },
    });
    expect(expectSingleEvent(await decide({ objective: nativeGoal.objective }))).toMatchObject({
      payload: { goal: { status: "active", tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null } },
    });
  });

  it("commits the goal before requesting the first turn", async () => {
    const events = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: await seedThread(goalTime),
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("start-goal"),
          threadId,
          goal: { objective: nativeGoal.objective },
          message: {
            messageId: MessageId.make("goal-message"),
            role: "user",
            text: nativeGoal.objective,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: goalTime,
        },
      }),
    );
    expect(Array.isArray(events) && events.map((event) => event.type)).toEqual([
      "thread.goal-updated",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
