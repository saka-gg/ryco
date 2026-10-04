import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import {
  restartContinuationGuardOf,
  restartContinuationIds,
  restartContinuationPrompt,
} from "./restartContinuationPolicy.ts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "./restartReconciliation.ts";
import { buildRestartContinuationTurnStart } from "./threadContinuation.ts";

const now = "2026-10-04T10:10:00.000Z";
const threadId = ThreadId.make("thread-restart");
const sourceTurnId = TurnId.make("turn-source");
const instanceId = ProviderInstanceId.make("codex");

/** A thread as startup reconciliation leaves an orphaned in-flight turn. */
function reconciledThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-restart"),
    title: "Restart",
    modelSelection: { instanceId, model: "gpt-5", options: [{ id: "fastMode", value: true }] },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: sourceTurnId,
      userMessageId: MessageId.make("message-source"),
      state: "interrupted",
      requestedAt: "2026-10-04T10:00:00.000Z",
      startedAt: "2026-10-04T10:00:01.000Z",
      completedAt: "2026-10-04T10:09:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-10-04T09:00:00.000Z",
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-source"),
        role: "user",
        text: "Work",
        turnId: null,
        streaming: false,
        createdAt: "2026-10-04T10:00:00.000Z",
        updatedAt: "2026-10-04T10:00:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "error",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: ORPHANED_PROVIDER_SESSION_ERROR,
      updatedAt: "2026-10-04T10:09:00.000Z",
    },
    ...overrides,
  };
}

const readModel = (thread: OrchestrationThread): OrchestrationReadModel => ({
  snapshotSequence: 1,
  projects: [],
  threads: [thread],
  updatedAt: now,
});

function continuation(captured: OrchestrationThread) {
  const ids = restartContinuationIds(threadId, sourceTurnId);
  return buildRestartContinuationTurnStart(captured, {
    commandId: ids.turnStartCommandId,
    messageId: ids.messageId,
    text: restartContinuationPrompt({
      kind: "in-flight",
      backgroundWork: { tasks: [], omitted: 0, detailsOmitted: false },
    }),
    createdAt: now,
    guard: restartContinuationGuardOf({
      kind: "in-flight",
      sourceTurnId,
      latestUserMessageId: MessageId.make("message-source"),
      modelSelection: captured.modelSelection,
      runtimeMode: captured.runtimeMode,
      interactionMode: captured.interactionMode,
      worktreePath: captured.worktreePath,
      providerInstanceId: instanceId,
    }),
  });
}

const decide = (thread: OrchestrationThread, command = continuation(reconciledThread())) =>
  Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: readModel(thread) }).pipe(Effect.flip),
  );

describe("restart continuation guard", () => {
  it("decides a matching guard like a plain turn start, without a context handoff", async () => {
    const events = await Effect.runPromise(
      decideOrchestrationCommand({
        command: continuation(reconciledThread()),
        readModel: readModel(reconciledThread()),
      }),
    );
    const list = Array.isArray(events) ? events : [events];
    expect(list.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const start = list[1];
    expect(start?.type === "thread.turn-start-requested" ? start.payload : null).toMatchObject({
      messageId: restartContinuationIds(threadId, sourceTurnId).messageId,
      modelSelection: reconciledThread().modelSelection,
    });
    expect(start?.payload).not.toHaveProperty("contextHandoff");
    expect(start?.payload).not.toHaveProperty("restartContinuationGuard");
  });

  it("rejects when a user message arrived after capture", async () => {
    const thread = reconciledThread();
    const error = await decide({
      ...thread,
      messages: [
        ...thread.messages,
        {
          ...thread.messages[0]!,
          id: MessageId.make("message-newer"),
          createdAt: "2026-10-04T10:09:30.000Z",
        },
      ],
    });
    expect(error._tag).toBe("OrchestrationCommandInvariantError");
    expect(error.message).toContain("Restart continuation target changed (thread-changed).");
  });

  it("rejects after a model change", async () => {
    const thread = reconciledThread();
    const error = await decide({
      ...thread,
      modelSelection: { ...thread.modelSelection, model: "gpt-5-mini" },
    });
    expect(error.message).toContain("Restart continuation target changed (thread-changed).");
  });

  it("is stripped from client-decoded turn starts", () => {
    const command = continuation(reconciledThread());
    const decoded = Schema.decodeUnknownSync(ClientOrchestrationCommand)(
      JSON.parse(JSON.stringify({ ...command, commandId: CommandId.make("client-command") })),
    );
    expect(decoded.type).toBe("thread.turn.start");
    expect(decoded).not.toHaveProperty("restartContinuationGuard");
  });
});
