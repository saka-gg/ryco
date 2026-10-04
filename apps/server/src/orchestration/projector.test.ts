import {
  CheckpointRef,
  CommandId,
  DEFAULT_AGENT_TOKEN_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { latestUserMessage } from "./userMessageOrder.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("orchestration projector", () => {
  it("applies thread.created events", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        tokenMode: DEFAULT_AGENT_TOKEN_MODE,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        worktreeId: null,
        manualStatusBucket: null,
        manualPosition: 0,
        latestTurn: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ]);
  });

  it("projects thread lineage and resets it when a soft-deleted id is re-created", async () => {
    const createdAt = "2026-10-01T00:00:00.000Z";
    const createdPayload = {
      threadId: "thread-child",
      projectId: "project-1",
      title: "Child",
      modelSelection: {
        provider: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    };
    const lineage = {
      parentThreadId: "thread-parent",
      rootThreadId: "thread-root",
      relationship: "delegated",
    };
    const afterCreate = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-child",
          occurredAt: createdAt,
          commandId: "command-create-child",
          payload: { ...createdPayload, lineage },
        }),
      ),
    );
    expect(afterCreate.threads[0]?.lineage).toEqual(lineage);

    const afterDelete = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.deleted",
          aggregateKind: "thread",
          aggregateId: "thread-child",
          occurredAt: createdAt,
          commandId: "command-delete-child",
          payload: { threadId: "thread-child", deletedAt: createdAt },
        }),
      ),
    );
    expect(afterDelete.threads[0]?.lineage).toEqual(lineage);

    const afterRecreate = await Effect.runPromise(
      projectEvent(
        afterDelete,
        makeEvent({
          sequence: 3,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-child",
          occurredAt: createdAt,
          commandId: "command-recreate-child",
          payload: createdPayload,
        }),
      ),
    );
    expect(afterRecreate.threads).toHaveLength(1);
    expect(afterRecreate.threads[0]?.deletedAt).toBeNull();
    expect(afterRecreate.threads[0]).not.toHaveProperty("lineage");
  });

  it("projects settled and activity-unsettled events", async () => {
    const createdAt = "2026-07-31T00:00:00.000Z";
    const settledAt = "2026-07-31T01:00:00.000Z";
    const afterCreate = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-settlement",
          occurredAt: createdAt,
          commandId: "command-create",
          payload: {
            threadId: "thread-settlement",
            projectId: "project-1",
            title: "Settlement",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    const afterSettle = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.settled",
          aggregateKind: "thread",
          aggregateId: "thread-settlement",
          occurredAt: settledAt,
          commandId: "command-settle",
          payload: {
            threadId: "thread-settlement",
            settledAt,
            updatedAt: settledAt,
          },
        }),
      ),
    );
    expect(afterSettle.threads[0]?.settledOverride).toBe("settled");
    expect(afterSettle.threads[0]?.settledAt).toBe(settledAt);

    const afterActivity = await Effect.runPromise(
      projectEvent(
        afterSettle,
        makeEvent({
          sequence: 3,
          type: "thread.unsettled",
          aggregateKind: "thread",
          aggregateId: "thread-settlement",
          occurredAt: "2026-07-31T02:00:00.000Z",
          commandId: "command-activity",
          payload: {
            threadId: "thread-settlement",
            reason: "activity",
            updatedAt: "2026-07-31T02:00:00.000Z",
          },
        }),
      ),
    );
    expect(afterActivity.threads[0]?.settledOverride).toBeNull();
    expect(afterActivity.threads[0]?.settledAt).toBeNull();
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5-codex",
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("applies thread.archived and thread.unarchived events", async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.parse(now) + 1_000).toISOString();
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    );
    expect(archived.threads[0]?.archivedAt).toBe(later);

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(unarchived.threads[0]?.archivedAt).toBeNull();
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("preserves and settles the latest turn across session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const thread = afterRunning.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.session?.status).toBe("running");

    const afterReady = await Effect.runPromise(
      projectEvent(
        afterRunning,
        makeEvent({
          sequence: 3,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T08:00:10.000Z",
          commandId: "cmd-ready",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "ready",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-02-23T08:00:10.000Z",
            },
          },
        }),
      ),
    );

    expect(afterReady.threads[0]?.latestTurn).toEqual(afterRunning.threads[0]?.latestTurn);
    expect(afterReady.threads[0]?.session?.status).toBe("ready");

    const interruptedAt = "2026-02-23T08:00:11.000Z";
    const afterInterrupted = await Effect.runPromise(
      projectEvent(
        afterReady,
        makeEvent({
          sequence: 4,
          type: "thread.turn-interrupt-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: interruptedAt,
          commandId: "cmd-interrupt",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: interruptedAt,
          },
        }),
      ),
    );

    expect(afterInterrupted.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "interrupted",
      completedAt: interruptedAt,
    });
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/ryco/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/ryco/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/ryco/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/ryco/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  it("caps message and checkpoint retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: "thread-capped",
            messageId: `msg-${index}`,
            role: "assistant",
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 600 },
      (_, index) =>
        makeEvent({
          sequence: index + 2_102,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-checkpoint-${index}`,
          payload: {
            threadId: "thread-capped",
            turnId: `turn-${index}`,
            checkpointTurnCount: index + 1,
            checkpointRef: `refs/ryco/checkpoints/thread-capped/turn/${index + 1}`,
            status: "ready",
            files: [],
            assistantMessageId: `msg-${index}`,
            completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    );

    const thread = finalState.threads[0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
    expect(thread?.checkpoints).toHaveLength(500);
    expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
    expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
  });

  describe("message cap user anchors", () => {
    const threadId = "thread-anchored";
    const createdAt = "2026-03-01T10:00:00.000Z";
    const messageEvent = (
      sequence: number,
      messageId: string,
      role: "user" | "assistant",
      at = new Date(Date.parse(createdAt) + sequence * 1000).toISOString(),
    ): OrchestrationEvent => {
      return makeEvent({
        sequence,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at,
        commandId: `cmd-${messageId}`,
        payload: {
          threadId,
          messageId,
          role,
          text: messageId,
          turnId: null,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      });
    };
    const reduceEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
      [
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: "cmd-create-anchored",
          payload: {
            threadId,
            projectId: "project-1",
            title: "anchored",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
        ...events,
      ].reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
        (statePromise, event) =>
          statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
        Promise.resolve(createEmptyReadModel(createdAt)),
      );
    const assistantEvents = (firstSequence: number) =>
      Array.from({ length: 2_100 }, (_, index) =>
        messageEvent(firstSequence + index, `msg-${index}`, "assistant"),
      );

    it("keeps the first and latest user messages when the message cap evicts history", async () => {
      const state = await reduceEvents([
        messageEvent(2, "u-first", "user"),
        messageEvent(3, "u-latest", "user"),
        ...assistantEvents(4),
      ]);

      const messages = state.threads[0]?.messages ?? [];
      expect(messages).toHaveLength(2_000);
      expect(messages[0]?.id).toBe("u-first");
      expect(messages[1]?.id).toBe("u-latest");
      expect(messages[2]?.id).toBe("msg-102");
      expect(messages.at(-1)?.id).toBe("msg-2099");
      expect(messages.findLast((message) => message.role === "user")?.id).toBe("u-latest");
    });

    it("keeps the user message with the greatest createdAt even when it is not the last user message", async () => {
      // The fence's latest user message is max(createdAt), ties by insertion order
      // (latestUserMessage / latestUserMessageIdQuery), not findLast(user).
      const state = await reduceEvents([
        messageEvent(2, "u-first", "user"),
        messageEvent(3, "u-max", "user", "2026-03-02T10:00:00.000Z"),
        messageEvent(4, "u-skewed", "user", "2026-03-01T10:00:01.000Z"),
        ...assistantEvents(5),
      ]);

      const messages = state.threads[0]?.messages ?? [];
      expect(messages).toHaveLength(2_000);
      expect(messages.slice(0, 3).map((message) => message.id)).toEqual([
        "u-first",
        "u-max",
        "msg-102",
      ]);
      expect(latestUserMessage(messages)?.id).toBe("u-max");
    });

    it("caps exactly like slice when the only user message is in the newest window", async () => {
      const events = [...assistantEvents(2), messageEvent(2_102, "u-only", "user")];
      const state = await reduceEvents(events);

      const expectedIds = events
        .map((event) => (event.payload as { messageId: string }).messageId)
        .slice(-2_000);
      expect(expectedIds[0]).toBe("msg-101");
      expect(state.threads[0]?.messages.map((message) => message.id)).toEqual(expectedIds);
    });
  });
});

describe("orchestration projector turn finalization", () => {
  const createdAt = "2026-02-23T08:00:00.000Z";
  const startedAt = "2026-02-23T08:00:05.000Z";
  const releasedAt = "2026-02-23T08:00:10.000Z";
  const lateAt = "2026-02-23T08:00:20.000Z";

  function sessionPayload(input: {
    status: string;
    activeTurnId: string | null;
    updatedAt: string;
  }) {
    return {
      threadId: "thread-1",
      status: input.status,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: input.activeTurnId,
      lastError: null,
      updatedAt: input.updatedAt,
    };
  }

  async function runningThread() {
    const afterCreate = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5.3-codex" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    return Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: sessionPayload({
              status: "running",
              activeTurnId: "turn-1",
              updatedAt: startedAt,
            }),
          },
        }),
      ),
    );
  }

  function release(
    sequence: number,
    releasedTurn: { turnId: string; state: string; completedAt: string; reason: string },
  ) {
    return makeEvent({
      sequence,
      type: "thread.session-set",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: releasedTurn.completedAt,
      commandId: `cmd-release-${sequence}`,
      payload: {
        threadId: "thread-1",
        session: sessionPayload({
          status: "ready",
          activeTurnId: null,
          updatedAt: releasedTurn.completedAt,
        }),
        releasedTurn,
      },
    });
  }

  function diff(sequence: number, status: "ready" | "missing" | "error", completedAt: string) {
    return makeEvent({
      sequence,
      type: "thread.turn-diff-completed",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: completedAt,
      commandId: `cmd-diff-${sequence}`,
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/ryco/checkpoints/thread-1/turn/1",
        status,
        files: [],
        assistantMessageId: null,
        completedAt,
      },
    });
  }

  it("settles the running turn from releasedTurn", async () => {
    const running = await runningThread();
    const released = await Effect.runPromise(
      projectEvent(
        running,
        release(3, {
          turnId: "turn-1",
          state: "completed",
          completedAt: releasedAt,
          reason: "provider-turn-completed",
        }),
      ),
    );
    expect(released.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "completed",
      startedAt,
      completedAt: releasedAt,
    });
  });

  it("keeps an interrupted turn sticky across a later completed release", async () => {
    const running = await runningThread();
    const interrupted = await Effect.runPromise(
      projectEvent(
        running,
        makeEvent({
          sequence: 3,
          type: "thread.turn-interrupt-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: releasedAt,
          commandId: "cmd-interrupt",
          payload: { threadId: "thread-1", turnId: "turn-1", createdAt: releasedAt },
        }),
      ),
    );
    const released = await Effect.runPromise(
      projectEvent(
        interrupted,
        release(4, {
          turnId: "turn-1",
          state: "completed",
          completedAt: lateAt,
          reason: "provider-turn-completed",
        }),
      ),
    );
    expect(released.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "interrupted",
      completedAt: releasedAt,
    });
  });

  it("leaves latestTurn alone when releasedTurn names another turn", async () => {
    const running = await runningThread();
    const released = await Effect.runPromise(
      projectEvent(
        running,
        release(3, {
          turnId: "turn-other",
          state: "completed",
          completedAt: releasedAt,
          reason: "provider-turn-completed",
        }),
      ),
    );
    expect(released.threads[0]?.latestTurn).toEqual(running.threads[0]?.latestTurn);
  });

  it("keeps a running turn running when a placeholder diff lands mid-turn", async () => {
    const running = await runningThread();
    const afterPlaceholder = await Effect.runPromise(
      projectEvent(running, diff(3, "missing", releasedAt)),
    );
    expect(afterPlaceholder.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "running",
      completedAt: null,
    });
    expect(afterPlaceholder.threads[0]?.checkpoints).toHaveLength(1);

    const afterRealCapture = await Effect.runPromise(
      projectEvent(afterPlaceholder, diff(4, "ready", releasedAt)),
    );
    expect(afterRealCapture.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "running",
      completedAt: null,
    });
  });

  it("keeps the released state and completedAt when a late diff arrives", async () => {
    const running = await runningThread();
    const released = await Effect.runPromise(
      projectEvent(
        running,
        release(3, {
          turnId: "turn-1",
          state: "error",
          completedAt: releasedAt,
          reason: "provider-turn-completed",
        }),
      ),
    );
    const afterDiff = await Effect.runPromise(projectEvent(released, diff(4, "ready", lateAt)));
    expect(afterDiff.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "error",
      completedAt: releasedAt,
    });
    expect(afterDiff.threads[0]?.checkpoints[0]?.status).toBe("ready");
  });
});

describe("orchestration projector worktree PR terminal time", () => {
  const createdAt = "2026-05-19T00:00:00.000Z";
  const worktreeId = "worktree-pr-terminal";

  const project = (
    events: ReadonlyArray<OrchestrationEvent>,
  ): Promise<ReturnType<typeof createEmptyReadModel>> =>
    events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(createEmptyReadModel(createdAt)),
    );
  const created = makeEvent({
    sequence: 1,
    type: "worktree.created",
    aggregateKind: "project",
    aggregateId: "project-1",
    occurredAt: createdAt,
    commandId: "cmd-worktree-created",
    payload: {
      worktreeId,
      projectId: "project-1",
      branch: "feature/pr",
      worktreePath: "/tmp/feature-pr",
      origin: "pr",
      prNumber: 7,
      issueNumber: null,
      prTitle: "PR",
      issueTitle: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
  const stateUpdated = (
    sequence: number,
    payload: {
      readonly prState: "open" | "merged" | "closed" | null;
      readonly prTerminalAt?: string | null;
      readonly updatedAt: string;
    },
  ) =>
    makeEvent({
      sequence,
      type: "worktree.sourceControlStateUpdated",
      aggregateKind: "worktree",
      aggregateId: worktreeId,
      occurredAt: payload.updatedAt,
      commandId: `cmd-source-control-${sequence}`,
      payload: { worktreeId, prIsDraft: false, issueState: null, ...payload },
    });
  const prTerminalAtOf = (model: ReturnType<typeof createEmptyReadModel>) =>
    model.worktrees?.find((worktree) => worktree.worktreeId === worktreeId)?.prTerminalAt;

  it("creates worktrees with an explicit null prTerminalAt", async () => {
    const model = await project([created]);
    const worktree = model.worktrees?.find((entry) => entry.worktreeId === worktreeId);
    expect(worktree !== undefined && "prTerminalAt" in worktree).toBe(true);
    expect(prTerminalAtOf(model)).toBeNull();
  });

  it("takes prTerminalAt from the event when present", async () => {
    const model = await project([
      created,
      stateUpdated(2, {
        prState: "merged",
        prTerminalAt: "2026-05-19T00:30:00.000Z",
        updatedAt: "2026-05-19T01:00:00.000Z",
      }),
    ]);
    expect(prTerminalAtOf(model)).toBe("2026-05-19T00:30:00.000Z");
  });

  it("derives prTerminalAt for legacy events without the field", async () => {
    const merged = await project([
      created,
      stateUpdated(2, { prState: "open", updatedAt: "2026-05-19T01:00:00.000Z" }),
      stateUpdated(3, { prState: "merged", updatedAt: "2026-05-19T02:00:00.000Z" }),
    ]);
    expect(prTerminalAtOf(merged)).toBe("2026-05-19T02:00:00.000Z");

    const stillMerged = await Effect.runPromise(
      projectEvent(
        merged,
        stateUpdated(4, { prState: "merged", updatedAt: "2026-05-19T03:00:00.000Z" }),
      ),
    );
    expect(prTerminalAtOf(stillMerged)).toBe("2026-05-19T02:00:00.000Z");

    const reopened = await Effect.runPromise(
      projectEvent(
        stillMerged,
        stateUpdated(5, { prState: "open", updatedAt: "2026-05-19T04:00:00.000Z" }),
      ),
    );
    expect(prTerminalAtOf(reopened)).toBeNull();
  });
});

describe("orchestration projector usage limits", () => {
  const now = "2026-10-04T10:00:00.000Z";
  const later = "2026-10-04T10:05:00.000Z";
  const usageLimit = {
    limitId: "usage-limit:thread-1:turn-1",
    provider: "claudeAgent",
    providerInstanceId: "claudeAgent",
    turnId: "turn-1",
    message: "Claude usage limit reached.",
    limitedAt: now,
    resetAt: null,
    autoResume: null,
    updatedAt: now,
  };

  async function limitedThread() {
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );
    return Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.usage-limit-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-usage-limit-record",
          payload: { threadId: "thread-1", usageLimit },
        }),
      ),
    );
  }

  it("applies set and a matching clear", async () => {
    const limited = await limitedThread();
    expect(limited.threads[0]?.usageLimit).toEqual(usageLimit);
    const cleared = await Effect.runPromise(
      projectEvent(
        limited,
        makeEvent({
          sequence: 3,
          type: "thread.usage-limit-cleared",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-turn-start",
          payload: {
            threadId: "thread-1",
            limitId: usageLimit.limitId,
            reason: "turn-started",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(cleared.threads[0]?.usageLimit).toBeNull();
    expect(cleared.threads[0]?.updatedAt).toBe(later);
  });

  it("ignores a clear for another limit", async () => {
    const limited = await limitedThread();
    const ignored = await Effect.runPromise(
      projectEvent(
        limited,
        makeEvent({
          sequence: 3,
          type: "thread.usage-limit-cleared",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-turn-start",
          payload: {
            threadId: "thread-1",
            limitId: "usage-limit:thread-1:turn-0",
            reason: "turn-started",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(ignored.threads[0]?.usageLimit).toEqual(usageLimit);
  });
});

describe("orchestration projector checkpoint revert", () => {
  const t = (minute: number) => `2026-02-23T09:${String(minute).padStart(2, "0")}:00.000Z`;

  function hydratedThread(): OrchestrationThread {
    return {
      id: ThreadId.make("thread-hydrated"),
      projectId: ProjectId.make("project-1"),
      title: "Hydrated",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId: TurnId.make("turn-9"),
        state: "completed",
        requestedAt: t(9),
        startedAt: t(9),
        completedAt: t(9),
        assistantMessageId: null,
      },
      createdAt: t(0),
      updatedAt: t(9),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("user-anchor-1"),
          role: "user",
          text: "first",
          turnId: null,
          streaming: false,
          createdAt: t(1),
          updatedAt: t(1),
        },
        {
          id: MessageId.make("user-anchor-9"),
          role: "user",
          text: "latest",
          turnId: null,
          streaming: false,
          createdAt: t(9),
          updatedAt: t(9),
        },
      ],
      proposedPlans: [
        {
          id: "plan-3",
          turnId: TurnId.make("turn-3"),
          planMarkdown: "plan 3",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: t(3),
          updatedAt: t(3),
        },
        {
          id: "plan-9",
          turnId: TurnId.make("turn-9"),
          planMarkdown: "plan 9",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: t(9),
          updatedAt: t(9),
        },
      ],
      activities: [
        {
          id: EventId.make("activity-9"),
          tone: "tool",
          kind: "tool.completed",
          summary: "done",
          payload: {},
          turnId: TurnId.make("turn-9"),
          createdAt: t(9),
        },
      ],
      checkpoints: [],
      session: null,
    };
  }

  const latestTurn5 = {
    turnId: TurnId.make("turn-5"),
    state: "completed" as const,
    requestedAt: t(5),
    startedAt: t(5),
    completedAt: t(5),
    assistantMessageId: null,
  };

  function reverted(payload: Record<string, unknown>, threadId = "thread-hydrated") {
    return makeEvent({
      sequence: 50,
      type: "thread.reverted",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: t(20),
      commandId: "cmd-revert",
      payload: { threadId, ...payload },
    });
  }

  it("uses the authoritative latest turn and boundary on the hydrated command model", async () => {
    const model = { ...createEmptyReadModel(t(0)), threads: [hydratedThread()] };
    const next = await Effect.runPromise(
      projectEvent(
        model,
        reverted({
          turnCount: 5,
          droppedTurnIds: ["turn-6", "turn-7", "turn-8", "turn-9"],
          latestTurn: latestTurn5,
        }),
      ),
    );
    const thread = next.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-5");
    expect(thread?.messages.map((message) => message.id)).toEqual(["user-anchor-1"]);
    expect(thread?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-3"]);
    expect(thread?.activities).toEqual([]);
  });

  it("projects a full live thread the same with and without the authoritative fields", async () => {
    const checkpoint = (count: number) => ({
      turnId: TurnId.make(`turn-${count}`),
      checkpointTurnCount: count,
      checkpointRef: CheckpointRef.make(`refs/ryco/checkpoints/thread-live/turn/${count}`),
      status: "ready" as const,
      files: [],
      assistantMessageId: MessageId.make(`assistant-${count}`),
      completedAt: t(count * 2 + 1),
    });
    const live: OrchestrationThread = {
      ...hydratedThread(),
      id: ThreadId.make("thread-live"),
      latestTurn: { ...latestTurn5, turnId: TurnId.make("turn-2"), completedAt: t(5) },
      checkpoints: [checkpoint(1), checkpoint(2)],
      messages: [1, 2].flatMap((count) => [
        {
          id: MessageId.make(`user-${count}`),
          role: "user" as const,
          text: `user ${count}`,
          turnId: TurnId.make(`turn-${count}`),
          streaming: false,
          createdAt: t(count * 2),
          updatedAt: t(count * 2),
        },
        {
          id: MessageId.make(`assistant-${count}`),
          role: "assistant" as const,
          text: `assistant ${count}`,
          turnId: TurnId.make(`turn-${count}`),
          streaming: false,
          createdAt: t(count * 2 + 1),
          updatedAt: t(count * 2 + 1),
        },
      ]),
      proposedPlans: [],
      activities: [],
    };
    const model = { ...createEmptyReadModel(t(0)), threads: [live] };
    const legacy = await Effect.runPromise(
      projectEvent(model, reverted({ turnCount: 1 }, "thread-live")),
    );
    const authoritative = await Effect.runPromise(
      projectEvent(
        model,
        reverted(
          {
            turnCount: 1,
            droppedTurnIds: ["turn-2"],
            latestTurn: {
              turnId: "turn-1",
              state: "completed",
              requestedAt: t(3),
              startedAt: t(3),
              completedAt: t(3),
              assistantMessageId: "assistant-1",
            },
          },
          "thread-live",
        ),
      ),
    );
    expect(authoritative.threads[0]).toEqual(legacy.threads[0]);
    expect(legacy.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("keeps the legacy projection for payloads without the authoritative fields", async () => {
    const model = { ...createEmptyReadModel(t(0)), threads: [hydratedThread()] };
    const next = await Effect.runPromise(projectEvent(model, reverted({ turnCount: 5 })));
    const thread = next.threads[0];
    // Legacy behaviour on the hydrated shape: no checkpoints, so nothing bound to a turn
    // survives and the user anchors are kept by count.
    expect(thread?.latestTurn).toBeNull();
    expect(thread?.messages.map((message) => message.id)).toEqual([
      "user-anchor-1",
      "user-anchor-9",
    ]);
    expect(thread?.proposedPlans).toEqual([]);
  });
});
