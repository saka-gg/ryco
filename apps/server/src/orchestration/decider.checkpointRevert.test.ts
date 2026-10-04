import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-08-04T00:10:00.000Z";
const threadId = ThreadId.make("thread-revert");

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-revert"),
    title: "Revert",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/tmp/worktree",
    latestTurn: {
      turnId: TurnId.make("turn-2"),
      state: "completed",
      requestedAt: "2026-08-04T00:00:00.000Z",
      startedAt: "2026-08-04T00:00:01.000Z",
      completedAt: "2026-08-04T00:01:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-user-2"),
        role: "user",
        text: "Second",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return { snapshotSequence: 1, projects: [], threads: [thread], updatedAt: now };
}

function revertCommand(overrides: { commandId?: string; createdAt?: string } = {}) {
  return {
    type: "thread.checkpoint.revert",
    commandId: CommandId.make(overrides.commandId ?? "cmd-revert"),
    threadId,
    turnCount: 1,
    createdAt: overrides.createdAt ?? now,
  } satisfies OrchestrationCommand;
}

function revertActivity(input: {
  readonly status: string;
  readonly createdAt: string;
  readonly id?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id ?? "checkpoint-revert:cmd-earlier"),
    tone: "info",
    kind: "checkpoint.revert",
    summary: "Reverting to checkpoint 1",
    payload: {
      schemaVersion: 1,
      revertRequestId: "cmd-earlier",
      turnCount: 1,
      status: input.status,
    },
    turnId: null,
    createdAt: input.createdAt,
  };
}

async function decide(command: OrchestrationCommand, thread: OrchestrationThread) {
  return Effect.runPromiseExit(
    decideOrchestrationCommand({ command, readModel: makeReadModel(thread) }),
  );
}

async function expectRejected(
  command: OrchestrationCommand,
  thread: OrchestrationThread,
  detail: string,
) {
  const exit = await decide(command, thread);
  expect(Exit.isFailure(exit)).toBe(true);
  expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(detail);
}

describe("checkpoint revert admission", () => {
  it("rejects a revert while the session is running or starting", async () => {
    for (const status of ["running", "starting"] as const) {
      const thread = makeThread({
        session: { ...makeThread().session!, status, activeTurnId: null },
      });
      await expectRejected(revertCommand(), thread, "This thread is still working");
    }
  });

  it("rejects a revert while the latest turn is still running", async () => {
    const thread = makeThread({
      latestTurn: { ...makeThread().latestTurn!, state: "running", completedAt: null },
    });
    await expectRejected(revertCommand(), thread, "This thread is still working");
  });

  it("rejects a revert with an open approval or question", async () => {
    await expectRejected(
      revertCommand(),
      makeThread({
        activities: [
          {
            id: EventId.make("approval-1"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approve",
            payload: { requestId: "request-1" },
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-08-04T00:00:30.000Z",
          },
        ],
      }),
      "waiting for your approval",
    );
    await expectRejected(
      revertCommand(),
      makeThread({
        activities: [
          {
            id: EventId.make("input-1"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Question",
            payload: { requestId: "request-2" },
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-08-04T00:00:30.000Z",
          },
        ],
      }),
      "waiting for your answer",
    );
  });

  it("rejects a revert while a context handoff is actionable", async () => {
    const thread = makeThread({
      activities: [
        {
          id: EventId.make("context-handoff-activity:cmd"),
          tone: "info",
          kind: "context-handoff",
          summary: "Handing off",
          payload: { status: "dispatching" },
          turnId: null,
          createdAt: "2026-08-04T00:00:30.000Z",
        },
      ],
    });
    await expectRejected(revertCommand(), thread, "switching models");
  });

  it("rejects a revert while a sent message is still waiting for its turn", async () => {
    const thread = makeThread({
      messages: [
        ...makeThread().messages,
        {
          id: MessageId.make("message-user-3"),
          role: "user",
          text: "Third",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-04T00:09:30.000Z",
          updatedAt: "2026-08-04T00:09:30.000Z",
        },
      ],
    });
    await expectRejected(revertCommand(), thread, "A message you just sent is still starting");
  });

  it("rejects a revert while another revert is pending, but not once it is stale", async () => {
    await expectRejected(
      revertCommand(),
      makeThread({
        activities: [
          revertActivity({ status: "requested", createdAt: "2026-08-04T00:09:00.000Z" }),
        ],
      }),
      "A revert is already in progress",
    );

    const stale = await decide(
      revertCommand(),
      makeThread({
        activities: [
          revertActivity({ status: "rolling-back", createdAt: "2026-08-04T00:00:00.000Z" }),
        ],
      }),
    );
    expect(Exit.isSuccess(stale)).toBe(true);
  });

  it("emits the pending revert activity before the revert request on an idle thread", async () => {
    const exit = await decide(revertCommand(), makeThread());
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const events = Array.isArray(exit.value) ? exit.value : [exit.value];
    expect(events.map((event) => event.type)).toEqual([
      "thread.activity-appended",
      "thread.checkpoint-revert-requested",
    ]);
    const activityEvent = events[0];
    if (activityEvent?.type !== "thread.activity-appended") throw new Error("expected activity");
    expect(activityEvent.payload.activity).toMatchObject({
      id: "checkpoint-revert:cmd-revert",
      kind: "checkpoint.revert",
      tone: "info",
      turnId: null,
      payload: {
        schemaVersion: 1,
        revertRequestId: "cmd-revert",
        turnCount: 1,
        status: "requested",
      },
    });
    expect(activityEvent.payload.activity.payload).not.toHaveProperty("fromTurnCount");
    expect(events.every((event) => event.commandId === "cmd-revert")).toBe(true);
  });

  it("stamps the pending revert with server time, not the client's clock", async () => {
    // A client clock far behind the server must not sort this revert before an
    // older, server-stamped revert phase.
    const before = Date.now();
    const exit = await decide(
      revertCommand({ createdAt: "2020-01-01T00:00:00.000Z" }),
      makeThread({ updatedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const after = Date.now();
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const events = Array.isArray(exit.value) ? exit.value : [exit.value];
    const activityEvent = events[0];
    if (activityEvent?.type !== "thread.activity-appended") throw new Error("expected activity");
    const stampedAt = Date.parse(activityEvent.payload.activity.createdAt);
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after);
  });
});

describe("turn start during a pending revert", () => {
  const turnStart = {
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-turn"),
    threadId,
    message: {
      messageId: MessageId.make("message-next"),
      role: "user",
      text: "Next",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
  } satisfies OrchestrationCommand;

  it("rejects a turn start while a revert is pending", async () => {
    await expectRejected(
      turnStart,
      makeThread({
        activities: [
          revertActivity({ status: "restoring-files", createdAt: "2026-08-04T00:09:00.000Z" }),
        ],
      }),
      "A checkpoint revert is in progress for this thread",
    );
  });

  it("accepts a turn start once the revert completed", async () => {
    const exit = await decide(
      turnStart,
      makeThread({
        activities: [
          revertActivity({ status: "completed", createdAt: "2026-08-04T00:09:00.000Z" }),
        ],
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("thread.revert.complete", () => {
  it("passes droppedTurnIds and latestTurn into thread.reverted", async () => {
    const latestTurn = {
      turnId: TurnId.make("turn-1"),
      state: "completed" as const,
      requestedAt: "2026-08-03T00:00:00.000Z",
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:00.000Z",
      assistantMessageId: null,
    };
    const command = {
      type: "thread.revert.complete",
      commandId: CommandId.make("cmd-complete"),
      threadId,
      turnCount: 1,
      droppedTurnIds: [TurnId.make("turn-2")],
      latestTurn,
      createdAt: now,
    } as OrchestrationCommand;
    const exit = await decide(command, makeThread());
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const event = Array.isArray(exit.value) ? exit.value[0] : exit.value;
    expect(event?.type).toBe("thread.reverted");
    expect(event?.payload).toEqual({
      threadId,
      turnCount: 1,
      droppedTurnIds: ["turn-2"],
      latestTurn,
    });
  });
});
