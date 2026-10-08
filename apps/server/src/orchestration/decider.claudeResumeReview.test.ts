import {
  CommandId,
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
import { Effect, Schema } from "effect";

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
      providerName: "claudeAgent",
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

describe("Claude resume review guards", () => {
  it("accepts a current reviewed runtime and rejects stale session, model, turn, and readiness", async () => {
    const thread = makeThread();
    const command = makeCommand({
      modelSelection: thread.modelSelection,
      claudeResumeGuard: {
        runtimeSessionId: thread.session!.runtimeSessionId!,
        latestTurnId: null,
        modelSelection: thread.modelSelection,
        requireReady: true,
      },
    });
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ command, readModel: makeReadModel(thread) })),
    ).resolves.toBeDefined();
    const changes: Partial<OrchestrationThread>[] = [
      { session: { ...thread.session!, runtimeSessionId: RuntimeSessionId.make("replacement") } },
      { session: { ...thread.session!, status: "running", activeTurnId: null } },
      { modelSelection: { ...thread.modelSelection, model: "other-model" } },
      {
        modelSelection: {
          ...thread.modelSelection,
          options: [{ id: "contextWindow", value: "1m" }],
        },
      },
      {
        latestTurn: {
          turnId: TurnId.make("newer-turn"),
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
      },
    ];
    for (const change of changes) {
      await expect(
        Effect.runPromise(
          decideOrchestrationCommand({
            command,
            readModel: makeReadModel({ ...thread, ...change }),
          }),
        ),
      ).rejects.toThrow("resume review is stale");
    }
  });

  it("accepts a review of a stopped session only while no runtime is bound", async () => {
    const live = makeThread();
    const stopped = makeThread({
      session: { ...live.session!, status: "stopped", runtimeSessionId: undefined },
    });
    const command = makeCommand({
      modelSelection: stopped.modelSelection,
      claudeResumeGuard: {
        runtimeSessionId: null,
        latestTurnId: null,
        modelSelection: stopped.modelSelection,
        requireReady: false,
      },
    });
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ command, readModel: makeReadModel(stopped) })),
    ).resolves.toBeDefined();
    // A runtime started since the review (even a ready one) makes it stale.
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ command, readModel: makeReadModel(live) })),
    ).rejects.toThrow("resume review is stale");
    // A runtime-naming review never matches a stopped session that has none.
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeCommand({
            modelSelection: stopped.modelSelection,
            claudeResumeGuard: {
              runtimeSessionId: RuntimeSessionId.make("runtime-a1"),
              latestTurnId: null,
              modelSelection: stopped.modelSelection,
              requireReady: false,
            },
          }),
          readModel: makeReadModel(stopped),
        }),
      ),
    ).rejects.toThrow("resume review is stale");
  });

  it("keeps decoding runtime-naming guards from older clients", () => {
    const thread = makeThread();
    const decoded = Schema.decodeUnknownSync(ThreadTurnStartCommand)({
      ...makeCommand({ modelSelection: thread.modelSelection }),
      claudeResumeGuard: {
        runtimeSessionId: "runtime-a1",
        latestTurnId: null,
        modelSelection: thread.modelSelection,
        requireReady: false,
      },
    });
    expect(decoded.claudeResumeGuard?.runtimeSessionId).toBe("runtime-a1");
  });
});
