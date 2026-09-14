import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

describe("decider project scripts", () => {
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          expectedUpdatedAt: now,
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-update-scripts-stale"),
            projectId: asProjectId("project-scripts"),
            expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
            scripts: Array.from(scripts),
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("changed after the command was authorized");
  });

  it("does not persist model defaults sent by legacy project creation clients", async () => {
    const now = new Date().toISOString();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("legacy-project-create"),
          projectId: asProjectId("legacy-project"),
          title: "Legacy client project",
          workspaceRoot: "/tmp/legacy-project",
          projectMetadataDir: ".ryco",
          defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5"),
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { defaultModelSelection: unknown }).defaultModelSelection).toBeNull();
  });

  it("ignores legacy project default model updates", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-default-model"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-default-model"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-default-model"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-default-model"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-default-model"),
          title: "Default model",
          workspaceRoot: "/tmp/default-model",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const defaultModelSelection = createModelSelection(
      ProviderInstanceId.make("claudeAgent"),
      "opus",
    );
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-default-model"),
          projectId: asProjectId("project-default-model"),
          defaultModelSelection,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect("defaultModelSelection" in event.payload).toBe(false);

    const updated = await Effect.runPromise(
      projectEvent(readModel, {
        sequence: 2,
        eventId: asEventId("evt-project-update-default-model"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-default-model"),
        type: event.type,
        occurredAt: now,
        commandId: CommandId.make("cmd-project-update-default-model"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-update-default-model"),
        metadata: {},
        payload: event.payload,
      }),
    );
    expect(
      updated.projects.find((project) => project.id === asProjectId("project-default-model"))
        ?.defaultModelSelection,
    ).toBeNull();
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ]),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("message-user-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
      runtimeMode: "approval-required",
    });
  });

  it("rejects thread.turn.start while the thread has an active running turn", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-active-turn"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-active-turn"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-active-turn"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-active-turn"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-active-turn"),
          title: "Project",
          workspaceRoot: "/tmp/project-active-turn",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withThread = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create-active-turn"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-active-turn"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create-active-turn"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create-active-turn"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-active-turn"),
          projectId: asProjectId("project-active-turn"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withThread, {
        sequence: 3,
        eventId: asEventId("evt-session-running-active-turn"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-active-turn"),
        type: "thread.session-set",
        occurredAt: now,
        commandId: CommandId.make("cmd-session-running-active-turn"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-session-running-active-turn"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-active-turn"),
          session: {
            threadId: ThreadId.make("thread-active-turn"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: TurnId.make("turn-active"),
            lastError: null,
            updatedAt: now,
          },
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-turn-start-overlap"),
            threadId: ThreadId.make("thread-active-turn"),
            message: {
              messageId: asMessageId("message-overlap"),
              role: "user",
              text: "overlap",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("already has active turn 'turn-active'");
  });

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-mode-set"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });

  it("emits thread.interaction-mode-set from thread.interaction-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-interaction-mode-set"),
          threadId: ThreadId.make("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single interaction-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.interaction-mode-set",
      payload: {
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
      },
    });
  });
});
