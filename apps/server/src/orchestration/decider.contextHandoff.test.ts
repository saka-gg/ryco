import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadTurnStartCommand,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-08-04T00:00:00.000Z";

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-handoff"),
    projectId: ProjectId.make("project-handoff"),
    title: "Context handoff",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: "gpt-5.6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/tmp/worktree",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-before"),
        role: "user",
        text: "Continue the work",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: ThreadId.make("thread-handoff"),
      status: "ready",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      runtimeSessionId: RuntimeSessionId.make("runtime-a1"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [thread],
    updatedAt: now,
  };
}

function makeCommand(
  overrides: Partial<typeof ThreadTurnStartCommand.Type> = {},
): typeof ThreadTurnStartCommand.Type {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("command-handoff"),
    threadId: ThreadId.make("thread-handoff"),
    message: {
      messageId: MessageId.make("message-target"),
      role: "user",
      text: "Please continue exactly from here. 👩🏽‍💻",
      attachments: [],
    },
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude_work"),
      model: "claude-fable-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
    ...overrides,
  };
}

describe("context handoff decider", () => {
  it("atomically captures the pre-command source before the unchanged user message", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeCommand(),
        readModel: makeReadModel(makeThread()),
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.context-handoff-requested",
      "thread.activity-appended",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);

    const requested = events[0];
    expect(requested?.type).toBe("thread.context-handoff-requested");
    if (requested?.type !== "thread.context-handoff-requested") return;
    expect(requested.payload.sourceSelection).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.6",
    });
    expect(requested.payload.targetSelection).toEqual({
      instanceId: "claude_work",
      model: "claude-fable-5",
    });
    expect(requested.payload.sourceRuntimeSessionId).toBe("runtime-a1");
    expect(requested.payload.handoffId).toBe("context-handoff:command-handoff");

    const activity = events[1];
    expect(activity?.type).toBe("thread.activity-appended");
    if (activity?.type !== "thread.activity-appended") return;
    expect(activity.payload.activity.id).toBe("context-handoff-activity:command-handoff");
    expect(activity.payload.activity.payload).not.toHaveProperty("structuredContext");

    const message = events[2];
    expect(message?.type).toBe("thread.message-sent");
    if (message?.type !== "thread.message-sent") return;
    expect(message.payload.text).toBe("Please continue exactly from here. 👩🏽‍💻");

    const turn = events[3];
    expect(turn?.type).toBe("thread.turn-start-requested");
    if (turn?.type !== "thread.turn-start-requested") return;
    expect(turn.payload.contextHandoff).toEqual({
      handoffId: "context-handoff:command-handoff",
      activityId: "context-handoff-activity:command-handoff",
      targetMessageId: "message-target",
    });
    expect(turn.payload.modelSelection).toEqual({
      instanceId: "claude_work",
      model: "claude-fable-5",
    });
  });

  it("does not hand off on a first turn or same-instance selection change", async () => {
    const firstTurn = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeCommand(),
        readModel: makeReadModel(makeThread({ messages: [] })),
      }),
    );
    expect(Array.isArray(firstTurn) ? firstTurn.map((event) => event.type) : []).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);

    const modelOnly = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeCommand({
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex_work"),
            model: "gpt-5.7",
          },
        }),
        readModel: makeReadModel(makeThread()),
      }),
    );
    const modelOnlyEvents = Array.isArray(modelOnly) ? modelOnly : [modelOnly];
    expect(modelOnlyEvents.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const modelOnlyTurn = modelOnlyEvents[1];
    expect(modelOnlyTurn?.type).toBe("thread.turn-start-requested");
    if (modelOnlyTurn?.type !== "thread.turn-start-requested") return;
    expect(modelOnlyTurn.payload.modelSelection).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.7",
    });
    expect(modelOnlyTurn.payload.contextHandoff).toBeUndefined();

    const optionsOnly = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeCommand({
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex_work"),
            model: "gpt-5.6",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
        readModel: makeReadModel(makeThread()),
      }),
    );
    expect(Array.isArray(optionsOnly) ? optionsOnly.map((event) => event.type) : []).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });

  describe("an earlier handoff that never dispatched", () => {
    const earlierHandoffActivity = {
      id: EventId.make("context-handoff-activity:command-earlier"),
      tone: "info" as const,
      kind: "context-handoff",
      summary: "Context handoff requested",
      payload: {
        schemaVersion: 1,
        handoffId: "context-handoff:command-earlier",
        mode: "full-context-fresh-session",
        status: "requested",
        targetMessageId: "message-before",
        sourceSelection: { instanceId: "codex_work", model: "gpt-5.6" },
        targetSelection: { instanceId: "grok_work", model: "grok-4.5" },
      },
      turnId: null,
      createdAt: now,
    };
    const turnStartFailure = (messageId: string) => ({
      id: EventId.make(`turn-start-failed:${messageId}`),
      tone: "error" as const,
      kind: "provider.turn.start.failed",
      summary: "Provider turn start failed",
      payload: { messageId, detail: "Ryco could not read or save its local state." },
      turnId: null,
      createdAt: now,
    });
    const decide = (activities: OrchestrationThread["activities"]) =>
      Effect.runPromise(
        Effect.result(
          decideOrchestrationCommand({
            command: makeCommand(),
            readModel: makeReadModel(makeThread({ activities })),
          }),
        ),
      );

    it("blocks a new handoff while it is still requested", async () => {
      const result = await decide([earlierHandoffActivity]);
      expect(result._tag).toBe("Failure");
      expect(result._tag === "Failure" ? result.failure.message : "").toContain(
        "already has an actionable context handoff",
      );
    });

    it("stops blocking once its target turn start failed", async () => {
      const result = await decide([
        earlierHandoffActivity,
        turnStartFailure("some-other-message"),
        turnStartFailure("message-before"),
      ]);
      expect(result._tag).toBe("Success");
      const events = result._tag === "Success" ? result.success : [];
      expect((Array.isArray(events) ? events : [events]).map((event) => event.type)).toContain(
        "thread.context-handoff-requested",
      );
    });

    it("keeps blocking when only another message's turn start failed", async () => {
      const result = await decide([earlierHandoffActivity, turnStartFailure("some-other-message")]);
      expect(result._tag).toBe("Failure");
    });
  });

  it("derives stable correlation ids and captures repeated A→B→A source selection", async () => {
    const command = makeCommand({
      commandId: CommandId.make("command-return-to-a"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex_work"),
        model: "gpt-5.6",
      },
    });
    const thread = makeThread({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude_work"),
        model: "claude-fable-5",
      },
      session: {
        ...makeThread().session!,
        providerName: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claude_work"),
        runtimeSessionId: RuntimeSessionId.make("runtime-b1"),
      },
    });
    const first = await Effect.runPromise(
      decideOrchestrationCommand({ command, readModel: makeReadModel(thread) }),
    );
    const duplicate = await Effect.runPromise(
      decideOrchestrationCommand({ command, readModel: makeReadModel(thread) }),
    );
    const firstEvents = Array.isArray(first) ? first : [first];
    const duplicateEvents = Array.isArray(duplicate) ? duplicate : [duplicate];
    const requested = firstEvents[0];
    expect(requested?.type).toBe("thread.context-handoff-requested");
    if (requested?.type !== "thread.context-handoff-requested") return;
    expect(requested.payload.sourceSelection.instanceId).toBe("claude_work");
    expect(requested.payload.targetSelection.instanceId).toBe("codex_work");
    expect(requested.payload.sourceRuntimeSessionId).toBe("runtime-b1");
    expect(requested.payload.handoffId).toBe("context-handoff:command-return-to-a");
    const duplicateRequested = duplicateEvents[0];
    expect(duplicateRequested?.type).toBe("thread.context-handoff-requested");
    if (duplicateRequested?.type !== "thread.context-handoff-requested") return;
    expect(duplicateRequested.payload.handoffId).toBe(requested.payload.handoffId);
  });

  it.each([
    ["starting session", makeThread({ session: { ...makeThread().session!, status: "starting" } })],
    [
      "pending approval",
      makeThread({
        activities: [
          {
            id: EventId.make("approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "approval-1" },
            turnId: null,
            createdAt: now,
          },
        ],
      }),
    ],
    [
      "pending user input",
      makeThread({
        activities: [
          {
            id: EventId.make("input-requested"),
            tone: "approval",
            kind: "user-input.requested",
            summary: "Input requested",
            payload: { requestId: "input-1" },
            turnId: null,
            createdAt: now,
          },
        ],
      }),
    ],
    [
      "actionable handoff",
      makeThread({
        activities: [
          {
            id: EventId.make("handoff-pending"),
            tone: "info",
            kind: "context-handoff",
            summary: "Context handoff requested",
            payload: {
              schemaVersion: 1,
              handoffId: "handoff-pending",
              mode: "full-context-fresh-session",
              status: "preparing",
              targetMessageId: "other-target",
              sourceSelection: { instanceId: "codex_work", model: "gpt-5.6" },
              targetSelection: { instanceId: "claude_work", model: "claude-fable-5" },
            },
            turnId: null,
            createdAt: now,
          },
        ],
      }),
    ],
  ])("rejects handoff while %s is active", async (_label, thread) => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeCommand(),
          readModel: makeReadModel(thread),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("turn interrupt decider", () => {
  it("persists the active orchestration turn when the caller interrupts by session", async () => {
    const activeTurnId = TurnId.make("turn-active");
    const baseThread = makeThread();
    const thread = makeThread({
      session: {
        ...baseThread.session!,
        status: "running",
        activeTurnId,
      },
      latestTurn: {
        turnId: activeTurnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("command-interrupt-active"),
          threadId: thread.id,
          createdAt: now,
        },
        readModel: makeReadModel(thread),
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;

    expect(event).toMatchObject({
      type: "thread.turn-interrupt-requested",
      payload: { turnId: activeTurnId },
    });
  });
});

describe("delegation return atomic origin fence", () => {
  const parent = () =>
    makeThread({
      latestTurn: {
        turnId: TurnId.make("origin-turn"),
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
    });
  const queuedReturn = () =>
    makeCommand({
      modelSelection: parent().modelSelection,
      delegationReturnGuard: {
        turnMessageId: MessageId.make("message-before"),
        projectId: parent().projectId,
        turnId: TurnId.make("origin-turn"),
        runtimeSessionId: RuntimeSessionId.make("runtime-a1"),
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        runtimeMode: "full-access",
        worktreePath: "/tmp/worktree",
        latestUserMessageId: MessageId.make("message-before"),
      },
    });
  it("accepts the exact idle origin through normal turn-start processing", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: queuedReturn(), readModel: makeReadModel(parent()) }),
    );
    expect(
      (Array.isArray(result) ? result : [result]).some(
        (event) => event.type === "thread.turn-start-requested",
      ),
    ).toBe(true);
    expect(
      (Array.isArray(result) ? result : [result]).find(
        (event) => event.type === "thread.turn-start-requested",
      )?.payload,
    ).toMatchObject({ delegationReturnGuard: queuedReturn().delegationReturnGuard });
  });
  for (const change of [
    "turn",
    "runtime",
    "archive",
    "project",
    "mode",
    "worktree",
    "provider",
    "pending-user-start",
    "model",
  ] as const) {
    it(`rejects ${change} changed between outbox check and authoritative dispatch`, async () => {
      let thread = parent();
      if (change === "turn")
        thread = {
          ...thread,
          latestTurn: { ...thread.latestTurn!, turnId: TurnId.make("new-turn") },
        };
      if (change === "runtime")
        thread = {
          ...thread,
          session: { ...thread.session!, runtimeSessionId: RuntimeSessionId.make("new-runtime") },
        };
      if (change === "archive") thread = { ...thread, archivedAt: now };
      if (change === "project") thread = { ...thread, projectId: ProjectId.make("other") };
      if (change === "mode") thread = { ...thread, runtimeMode: "approval-required" };
      if (change === "worktree") thread = { ...thread, worktreePath: "/other" };
      if (change === "provider")
        thread = {
          ...thread,
          session: { ...thread.session!, providerInstanceId: ProviderInstanceId.make("other") },
        };
      if (change === "pending-user-start")
        thread = {
          ...thread,
          messages: [
            ...thread.messages,
            { ...thread.messages[0]!, id: MessageId.make("new-user-message") },
          ],
        };
      if (change === "model")
        thread = { ...thread, modelSelection: { ...thread.modelSelection, model: "another" } };
      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command: queuedReturn(),
          readModel: makeReadModel(thread),
        }).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
    });
  }
});

it("does not adopt a newer pending user start even if the outbox observed that message before dispatch", async () => {
  const thread = makeThread({
    latestTurn: {
      turnId: TurnId.make("origin-turn"),
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
  });
  const pending = { ...thread.messages[0]!, id: MessageId.make("pending-user-start") };
  const command = makeCommand({
    modelSelection: thread.modelSelection,
    delegationReturnGuard: {
      projectId: thread.projectId,
      turnId: TurnId.make("origin-turn"),
      runtimeSessionId: RuntimeSessionId.make("runtime-a1"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      runtimeMode: "full-access",
      worktreePath: "/tmp/worktree",
      turnMessageId: MessageId.make("message-before"),
      latestUserMessageId: pending.id,
    },
  });
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command,
      readModel: makeReadModel({ ...thread, messages: [...thread.messages, pending] }),
    }).pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
});
