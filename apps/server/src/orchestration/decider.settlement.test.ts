import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string) => CommandId.make(value);
const asEventId = (value: string) => EventId.make(value);
const asProjectId = (value: string) => ProjectId.make(value);
const asThreadId = (value: string) => ThreadId.make(value);

async function seedThread(): Promise<OrchestrationReadModel> {
  const createdAt = "2026-07-31T00:00:00.000Z";
  const projectId = asProjectId("project-settlement");
  const threadId = asThreadId("thread-settlement");
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(createdAt), {
      sequence: 1,
      eventId: asEventId("event-project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: createdAt,
      commandId: asCommandId("command-project-created"),
      causationEventId: null,
      correlationId: asCommandId("command-project-created"),
      metadata: {},
      payload: {
        projectId,
        title: "Settlement",
        workspaceRoot: "/tmp/settlement",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("event-thread-created"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: createdAt,
      commandId: asCommandId("command-thread-created"),
      causationEventId: null,
      correlationId: asCommandId("command-thread-created"),
      metadata: {},
      payload: {
        threadId,
        projectId,
        title: "Settlement",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt,
        updatedAt: createdAt,
      },
    }),
  );
}

function asEvents(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  return Array.isArray(result) ? result : [result];
}

describe("thread settlement decider", () => {
  it("settles an eligible thread and preserves the timestamp when repeated", async () => {
    const readModel = await seedThread();
    const threadId = readModel.threads[0]!.id;
    const settled = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: asCommandId("command-settle"),
            threadId,
          },
          readModel,
        }),
      ),
    );

    expect(settled).toHaveLength(1);
    expect(settled[0]?.type).toBe("thread.settled");
    if (settled[0]?.type !== "thread.settled") {
      throw new Error("Expected thread.settled");
    }
    const projected = await Effect.runPromise(
      projectEvent(readModel, { ...settled[0], sequence: readModel.snapshotSequence + 1 }),
    );
    const repeated = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: asCommandId("command-settle-again"),
            threadId,
          },
          readModel: projected,
        }),
      ),
    );

    expect(repeated[0]?.type).toBe("thread.settled");
    if (repeated[0]?.type === "thread.settled") {
      expect(repeated[0].payload.settledAt).toBe(settled[0].payload.settledAt);
      expect(repeated[0].payload.updatedAt).toBe(settled[0].payload.updatedAt);
    }
  });

  it("rejects settlement while a provider session is running", async () => {
    const readModel = await seedThread();
    const thread = readModel.threads[0]!;
    const running: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          ...thread,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            tokenMode: "balanced",
            activeTurnId: TurnId.make("turn-running"),
            lastError: null,
            updatedAt: "2026-07-31T00:01:00.000Z",
          },
        },
      ],
    };

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: asCommandId("command-settle-running"),
            threadId: thread.id,
          },
          readModel: running,
        }),
      ),
    ).rejects.toThrow("provider session is running");
  });

  it("rejects settlement for pending input and archived worktrees", async () => {
    const readModel = await seedThread();
    const thread = readModel.threads[0]!;
    const pendingInput: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          ...thread,
          activities: [
            {
              id: asEventId("activity-input"),
              tone: "approval",
              kind: "user-input.requested",
              summary: "Input required",
              payload: { requestId: "request-input" },
              turnId: null,
              createdAt: "2026-07-31T00:01:00.000Z",
            },
          ],
        },
      ],
    };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: asCommandId("command-settle-input"),
            threadId: thread.id,
          },
          readModel: pendingInput,
        }),
      ),
    ).rejects.toThrow("user input is pending");

    const worktreeId = WorktreeId.make("worktree-archived");
    const archivedWorktree: OrchestrationReadModel = {
      ...readModel,
      worktrees: [
        {
          worktreeId,
          projectId: thread.projectId,
          title: null,
          branch: "feature/settlement",
          worktreePath: "/tmp/settlement-worktree",
          origin: "manual",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          workItemProvider: null,
          workItemKey: null,
          workItemTitle: null,
          workItemState: null,
          workItemStateName: null,
          workItemUrl: null,
          prState: null,
          prIsDraft: null,
          issueState: null,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:01:00.000Z",
          archivedAt: "2026-07-31T00:01:00.000Z",
          manualPosition: 0,
        },
      ],
      threads: [{ ...thread, worktreeId }],
    };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: asCommandId("command-settle-archived-worktree"),
            threadId: thread.id,
          },
          readModel: archivedWorktree,
        }),
      ),
    ).rejects.toThrow("worktree is archived");
  });

  it("reopens an explicitly settled thread before real activity", async () => {
    const readModel = await seedThread();
    const thread = {
      ...readModel.threads[0]!,
      settledOverride: "settled" as const,
      settledAt: "2026-07-31T00:01:00.000Z",
    };
    const settledReadModel: OrchestrationReadModel = { ...readModel, threads: [thread] };
    const turnCommand: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
      type: "thread.turn.start",
      commandId: asCommandId("command-turn-start"),
      threadId: thread.id,
      message: {
        messageId: MessageId.make("message-user"),
        role: "user",
        text: "Continue",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-07-31T00:02:00.000Z",
    };

    const turnEvents = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({ command: turnCommand, readModel: settledReadModel }),
      ),
    );
    expect(turnEvents.map((event) => event.type)).toEqual([
      "thread.unsettled",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(turnEvents[2]?.causationEventId).toBe(turnEvents[1]?.eventId);

    const sessionEvents = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: asCommandId("command-session-start"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "starting",
              providerName: "codex",
              runtimeMode: "full-access",
              tokenMode: "balanced",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-07-31T00:03:00.000Z",
            },
            createdAt: "2026-07-31T00:03:00.000Z",
          },
          readModel: settledReadModel,
        }),
      ),
    );
    expect(sessionEvents.map((event) => event.type)).toEqual([
      "thread.unsettled",
      "thread.session-set",
    ]);

    const requestEvents = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.activity.append",
            commandId: asCommandId("command-input-request"),
            threadId: thread.id,
            activity: {
              id: asEventId("activity-request"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval required",
              payload: { requestId: "request-approval" },
              turnId: null,
              createdAt: "2026-07-31T00:04:00.000Z",
            },
            createdAt: "2026-07-31T00:04:00.000Z",
          },
          readModel: settledReadModel,
        }),
      ),
    );
    expect(requestEvents.map((event) => event.type)).toEqual([
      "thread.unsettled",
      "thread.activity-appended",
    ]);
  });

  it("keeps neutral activity from reopening a settled thread", async () => {
    const readModel = await seedThread();
    const thread = {
      ...readModel.threads[0]!,
      settledOverride: "settled" as const,
      settledAt: "2026-07-31T00:01:00.000Z",
    };
    const result = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.activity.append",
            commandId: asCommandId("command-neutral-activity"),
            threadId: thread.id,
            activity: {
              id: asEventId("activity-neutral"),
              tone: "info",
              kind: "runtime.note",
              summary: "Still idle",
              payload: {},
              turnId: null,
              createdAt: "2026-07-31T00:02:00.000Z",
            },
            createdAt: "2026-07-31T00:02:00.000Z",
          },
          readModel: { ...readModel, threads: [thread] },
        }),
      ),
    );

    expect(result.map((event) => event.type)).toEqual(["thread.activity-appended"]);
  });
});

describe("thread snooze commands", () => {
  it("projects snooze and unsnooze without discarding conversation state", async () => {
    const readModel = await seedThread();
    const threadId = readModel.threads[0]!.id;
    const snoozedUntil = new Date(Date.now() + 3_600_000).toISOString();
    const events = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.snooze",
            commandId: asCommandId("snooze"),
            threadId,
            snoozedUntil,
          },
        }),
      ),
    );
    expect(events[0]?.type).toBe("thread.snoozed");
    const snoozed = await Effect.runPromise(
      projectEvent(readModel, { ...events[0]!, sequence: 3 }),
    );
    expect(snoozed.threads[0]).toMatchObject({ snoozedUntil, settledOverride: "active" });
    const wake = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: snoozed,
          command: { type: "thread.unsnooze", commandId: asCommandId("wake"), threadId },
        }),
      ),
    );
    const awake = await Effect.runPromise(projectEvent(snoozed, { ...wake[0]!, sequence: 4 }));
    expect(awake.threads[0]).toMatchObject({
      snoozedUntil: null,
      snoozedAt: null,
      settledOverride: "active",
      title: readModel.threads[0]!.title,
    });
  });
  it("allows running work but wakes permanently when input is requested", async () => {
    const original = await seedThread();
    const thread = original.threads[0]!;
    const now = new Date().toISOString();
    const session = {
      threadId: thread.id,
      status: "running" as const,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      tokenMode: "balanced" as const,
      activeTurnId: TurnId.make("running"),
      lastError: null,
      updatedAt: now,
    };
    const readModel: OrchestrationReadModel = { ...original, threads: [{ ...thread, session }] };
    const snoozeEvents = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.snooze",
            threadId: thread.id,
            commandId: asCommandId("snooze-running"),
            snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      ),
    );
    const snoozed = await Effect.runPromise(
      projectEvent(readModel, { ...snoozeEvents[0]!, sequence: 3 }),
    );
    const createdAt = new Date(Date.now() + 1_000).toISOString();
    const request = {
      id: asEventId("request-event"),
      kind: "user-input.requested",
      tone: "approval" as const,
      summary: "Input required",
      payload: { requestId: "input-request" },
      turnId: null,
      createdAt,
    };
    const progress = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: snoozed,
          command: {
            type: "thread.session.set",
            threadId: thread.id,
            commandId: asCommandId("progress"),
            session: { ...session, updatedAt: createdAt },
            createdAt,
          },
        }),
      ),
    );
    expect(progress.map((event) => event.type)).toEqual(["thread.session-set"]);
    const wake = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: snoozed,
          command: {
            type: "thread.activity.append",
            threadId: thread.id,
            commandId: asCommandId("request"),
            activity: request,
            createdAt,
          },
        }),
      ),
    );
    expect(wake.map((event) => event.type)).toEqual([
      "thread.unsnoozed",
      "thread.activity-appended",
    ]);
    let awake = snoozed;
    for (const [index, event] of wake.entries())
      awake = await Effect.runPromise(projectEvent(awake, { ...event, sequence: 4 + index }));
    expect(awake.threads[0]).toMatchObject({ snoozedUntil: null, snoozedAt: null });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: awake,
          command: {
            type: "thread.snooze",
            threadId: thread.id,
            commandId: asCommandId("blocked"),
            snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      ),
    ).rejects.toThrow("pending requests");
  });

  it("rejects a past deadline", async () => {
    const readModel = await seedThread();
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.snooze",
            commandId: asCommandId("past"),
            threadId: readModel.threads[0]!.id,
            snoozedUntil: "2020-01-01T00:00:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("future wake time");
  });
});

describe("pull request settlement signals in the decider", () => {
  const worktreeId = WorktreeId.make("worktree-pr-signal");

  async function seedPullRequestThread(input: {
    readonly prState: "open" | "merged" | "closed" | null;
  }): Promise<OrchestrationReadModel> {
    const readModel = await seedThread();
    const thread = readModel.threads[0]!;
    return {
      ...readModel,
      worktrees: [
        {
          worktreeId,
          projectId: thread.projectId,
          title: null,
          branch: "feature/pr-signal",
          worktreePath: "/tmp/pr-signal",
          origin: "pr",
          prNumber: 12,
          issueNumber: null,
          prTitle: "Signal",
          issueTitle: null,
          workItemProvider: null,
          workItemKey: null,
          workItemTitle: null,
          workItemState: null,
          workItemStateName: null,
          workItemUrl: null,
          prState: input.prState,
          prIsDraft: false,
          prTerminalAt: null,
          issueState: null,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
          archivedAt: null,
          manualPosition: 0,
        },
      ],
      threads: [{ ...thread, worktreeId }],
    };
  }

  const sourceControlUpdate = (
    prTerminalAt?: string | null,
  ): Extract<OrchestrationCommand, { type: "worktree.source-control-state.update" }> => ({
    type: "worktree.source-control-state.update",
    commandId: asCommandId(`command-source-control-${prTerminalAt ?? "absent"}`),
    worktreeId,
    prState: "merged",
    prIsDraft: false,
    issueState: null,
    updatedAt: "2026-07-31T01:00:00.000Z",
    ...(prTerminalAt !== undefined ? { prTerminalAt } : {}),
  });

  it("passes prTerminalAt through and resolves it when absent", async () => {
    const readModel = await seedPullRequestThread({ prState: "open" });
    const withTime = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: sourceControlUpdate("2026-07-31T00:30:00.000Z"),
          readModel,
        }),
      ),
    );
    expect(withTime[0]?.type).toBe("worktree.sourceControlStateUpdated");
    if (withTime[0]?.type === "worktree.sourceControlStateUpdated") {
      expect(withTime[0].payload.prTerminalAt).toBe("2026-07-31T00:30:00.000Z");
    }

    const withNull = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({ command: sourceControlUpdate(null), readModel }),
      ),
    );
    if (withNull[0]?.type === "worktree.sourceControlStateUpdated") {
      expect("prTerminalAt" in withNull[0].payload).toBe(true);
      expect(withNull[0].payload.prTerminalAt).toBeNull();
    }

    // Omitted: the decider resolves it (first observation = the update time),
    // so every event states the current pull request completely.
    const absent = asEvents(
      await Effect.runPromise(
        decideOrchestrationCommand({ command: sourceControlUpdate(), readModel }),
      ),
    );
    expect(absent[0]?.type).toBe("worktree.sourceControlStateUpdated");
    if (absent[0]?.type === "worktree.sourceControlStateUpdated") {
      expect(absent[0].payload.prTerminalAt).toBe("2026-07-31T01:00:00.000Z");
      expect(
        absent[0].payload.pullRequests?.map((link: { number: number }) => link.number),
      ).toEqual([absent[0].payload.prNumber]);
    }
  });

  it.each(["open", null] as const)(
    "allows manual settlement while the worktree PR is %s",
    async (prState) => {
      const readModel = await seedPullRequestThread({ prState });
      const settled = asEvents(
        await Effect.runPromise(
          decideOrchestrationCommand({
            command: {
              type: "thread.settle",
              commandId: asCommandId(`command-settle-pr-${prState ?? "unknown"}`),
              threadId: readModel.threads[0]!.id,
            },
            readModel,
          }),
        ),
      );
      expect(settled[0]?.type).toBe("thread.settled");
    },
  );
});
