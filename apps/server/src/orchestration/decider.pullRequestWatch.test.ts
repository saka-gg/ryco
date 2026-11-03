import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadPullRequestWatch,
  type ThreadPullRequestWatchUpdateCommand,
} from "@ryco/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  makePullRequestWatchRejections,
  PULL_REQUEST_WATCH_CHANGED_DETAIL,
  pullRequestWatchUpdateCommandId,
  pullRequestWatchWakeMessageId,
} from "./pullRequestWatchUpdates.ts";

const createdAt = "2026-10-04T10:00:00.000Z";
const watchStartedAt = "2026-10-04T10:05:00.000Z";
const updateAt = "2026-10-04T10:10:00.000Z";
const projectId = ProjectId.make("project-watch");
const threadId = ThreadId.make("thread-watch");
const worktreeId = WorktreeId.make("worktree-watch");
const otherProjectWorktreeId = WorktreeId.make("worktree-other-project");
const userMessageId = MessageId.make("message-user-1");
const codex = ProviderInstanceId.make("codex");
const watchId = "github.com/o/r#12";

let seedSequence = 0;
function seedEvent(
  event: Omit<
    OrchestrationEvent,
    "sequence" | "eventId" | "causationEventId" | "correlationId" | "metadata"
  >,
): OrchestrationEvent {
  seedSequence += 1;
  return {
    ...event,
    sequence: seedSequence,
    eventId: EventId.make(`event-seed-${seedSequence}`),
    causationEventId: null,
    correlationId: event.commandId,
    metadata: {},
  } as OrchestrationEvent;
}

async function seed(): Promise<OrchestrationReadModel> {
  let model = createEmptyReadModel(createdAt);
  const events: Array<Parameters<typeof seedEvent>[0]> = [
    {
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-project"),
      payload: {
        projectId,
        title: "Watch",
        workspaceRoot: "/tmp/watch",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "worktree",
      aggregateId: worktreeId,
      type: "worktree.created",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-worktree"),
      payload: {
        worktreeId,
        projectId,
        branch: "feature/watch",
        worktreePath: "/tmp/watch-feature",
        origin: "branch",
        prNumber: 12,
        issueNumber: null,
        prTitle: "Watch me",
        issueTitle: null,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "worktree",
      aggregateId: otherProjectWorktreeId,
      type: "worktree.created",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-other-worktree"),
      payload: {
        worktreeId: otherProjectWorktreeId,
        projectId: ProjectId.make("project-other"),
        branch: "feature/other",
        worktreePath: "/tmp/other-feature",
        origin: "branch",
        prNumber: 12,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-thread"),
      payload: {
        threadId,
        projectId,
        title: "Watch",
        modelSelection: { instanceId: codex, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: "feature/watch",
        worktreePath: "/tmp/watch-feature",
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.attachedToWorktree",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-attach"),
      payload: { threadId, worktreeId, attachedAt: createdAt },
    },
    {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.message-sent",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-message"),
      payload: {
        threadId,
        messageId: userMessageId,
        role: "user",
        text: "Open a pull request",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.session-set",
      occurredAt: createdAt,
      commandId: CommandId.make("provider:seed-session"),
      payload: {
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: codex,
          runtimeSessionId: RuntimeSessionId.make("runtime-1"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
      },
    },
  ];
  for (const event of events) {
    model = await Effect.runPromise(projectEvent(model, seedEvent(event)));
  }
  return model;
}

function watch(overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch {
  return {
    watchId,
    number: 12,
    url: "https://github.com/o/r/pull/12",
    provider: "github",
    worktreeId,
    revision: 1,
    startedAt: watchStartedAt,
    startedBy: "user",
    runtimeMode: "full-access",
    worktreePath: "/tmp/watch-feature",
    headSha: "abc1234",
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: watchStartedAt,
    remarkIds: [],
    outsideRemarks: 0,
    conflicting: false,
    wakes: 0,
    news: true,
    requiredChecks: null,
    failingChecks: 0,
    autoFix: null,
    delivery: null,
    beforeWake: null,
    lastChangeAt: null,
    ...overrides,
  };
}

function update(
  overrides: Partial<Omit<ThreadPullRequestWatchUpdateCommand, "type">> = {},
): ThreadPullRequestWatchUpdateCommand {
  const next = overrides.next === undefined ? watch() : overrides.next;
  return {
    type: "thread.pull-request-watch.update",
    commandId: pullRequestWatchUpdateCommandId({
      threadId,
      watchId,
      revision: next?.revision ?? 0,
    }),
    threadId,
    watchId,
    expectedRevision: null,
    expectedStartedAt: null,
    next,
    createdAt: updateAt,
    ...overrides,
  };
}

/** The news wake an update sends, recorded as the watch's pending delivery. */
function withWake(
  readModel: OrchestrationReadModel,
  revision: number,
  latestUserMessageId = userMessageId,
): ThreadPullRequestWatchUpdateCommand {
  const messageId = pullRequestWatchWakeMessageId(threadId);
  return update({
    expectedRevision: revision,
    expectedStartedAt: watchStartedAt,
    next: watch({
      revision: revision + 1,
      failedChecks: ["lint"],
      failingChecks: 1,
      delivery: { messageId, kind: "news", sentAt: updateAt },
      lastChangeAt: updateAt,
    }),
    wake: {
      messageId,
      text: "Ryco pull request update: checks failed on abc1234.",
      guard: {
        latestUserMessageId,
        projectId,
        runtimeMode: "full-access",
        worktreePath: readModel.threads[0]!.worktreePath,
      },
    },
  });
}

async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  return Effect.runPromise(Effect.exit(decideOrchestrationCommand({ command, readModel })));
}

async function rejection(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const exit = await decide(readModel, command);
  if (Exit.isSuccess(exit)) throw new Error(`expected ${command.type} to be rejected`);
  return Cause.pretty(exit.cause);
}

async function dispatch(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<{
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly readModel: OrchestrationReadModel;
}> {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const planned = Array.isArray(result) ? result : [result];
  let next = readModel;
  const events: OrchestrationEvent[] = [];
  for (const entry of planned) {
    const event = { ...entry, sequence: next.snapshotSequence + 1 } as OrchestrationEvent;
    events.push(event);
    next = await Effect.runPromise(projectEvent(next, event));
  }
  return { events, readModel: next };
}

async function watched(): Promise<OrchestrationReadModel> {
  return (await dispatch(await seed(), update())).readModel;
}

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === threadId)!;

describe("thread.pull-request-watch.update", () => {
  it("creates a watch only when none with its id is active", async () => {
    const { events, readModel } = await dispatch(await seed(), update());
    expect(events.map((event) => event.type)).toEqual(["thread.pull-request-watch-updated"]);
    expect(threadOf(readModel).pullRequestWatchState?.active).toEqual([watch()]);
    // Watch progress is not thread activity.
    expect(threadOf(readModel).updatedAt).toBe(createdAt);

    expect(await rejection(readModel, update())).toContain(PULL_REQUEST_WATCH_CHANGED_DETAIL);
    expect(await rejection(await seed(), update({ next: watch({ revision: 2 }) }))).toContain(
      "one revision at a time",
    );
  });

  it("rejects a stale revision and a revision that skips", async () => {
    const readModel = await watched();
    const stale = update({
      expectedRevision: 2,
      expectedStartedAt: watchStartedAt,
      next: watch({ revision: 3 }),
    });
    expect(await rejection(readModel, stale)).toContain(PULL_REQUEST_WATCH_CHANGED_DETAIL);
    const skips = update({
      expectedRevision: 1,
      expectedStartedAt: watchStartedAt,
      next: watch({ revision: 3 }),
    });
    expect(await rejection(readModel, skips)).toContain("one revision at a time");

    const { readModel: next } = await dispatch(
      readModel,
      update({
        expectedRevision: 1,
        expectedStartedAt: watchStartedAt,
        next: watch({ revision: 2, conflicting: true }),
      }),
    );
    expect(threadOf(next).pullRequestWatchState?.active[0]?.revision).toBe(2);
  });

  it("refuses a pass read before the watch was stopped and started again (ABA)", async () => {
    // A sweep reads the watch at revision 1 and prepares revision 2.
    const read = await watched();
    const stalePass = update({
      expectedRevision: 1,
      expectedStartedAt: watchStartedAt,
      next: watch({ revision: 2, failedChecks: ["lint"] }),
    });
    // Meanwhile the user stops watching and starts again: a new generation, revision 1 again.
    const { readModel: stopped } = await dispatch(
      read,
      update({
        expectedRevision: 1,
        expectedStartedAt: watchStartedAt,
        next: null,
        endReason: "unwatched",
      }),
    );
    const restartedAt = "2026-10-04T10:08:00.000Z";
    const { readModel: restarted } = await dispatch(
      stopped,
      update({ next: watch({ startedAt: restartedAt, remarksThrough: restartedAt }) }),
    );
    expect(threadOf(restarted).pullRequestWatchState?.active[0]?.revision).toBe(1);

    // The revision matches; the generation does not.
    expect(await rejection(restarted, stalePass)).toContain(PULL_REQUEST_WATCH_CHANGED_DETAIL);
    // A pass of the new generation applies, and cannot swap the generation either.
    const current = update({
      expectedRevision: 1,
      expectedStartedAt: restartedAt,
      next: watch({ revision: 2, startedAt: restartedAt, remarksThrough: restartedAt }),
    });
    expect(Exit.isSuccess(await decide(restarted, current))).toBe(true);
    expect(
      await rejection(restarted, {
        ...current,
        next: watch({ revision: 2, startedAt: watchStartedAt }),
      }),
    ).toContain(PULL_REQUEST_WATCH_CHANGED_DETAIL);
  });

  it("emits the watch event first, then the wake's message and turn start under one command id", async () => {
    const readModel = await watched();
    const command = withWake(readModel, 1);
    const { events, readModel: next } = await dispatch(readModel, command);
    expect(events.map((event) => event.type)).toEqual([
      "thread.pull-request-watch-updated",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(new Set(events.map((event) => event.commandId))).toEqual(new Set([command.commandId]));
    const turnStart = events[2];
    if (turnStart?.type !== "thread.turn-start-requested") throw new Error("no turn start");
    expect(turnStart.payload.delegationReturnGuard?.source).toBe("pull-request-watch");
    expect(turnStart.payload.messageId).toBe(command.wake?.messageId);
    expect(threadOf(next).pullRequestWatchState?.active[0]?.delivery?.messageId).toBe(
      command.wake?.messageId,
    );
  });

  it("rejects the whole update, progress included, when the wake's chat moved on", async () => {
    const readModel = await watched();
    // The user typed after the pass read the chat.
    const command = withWake(readModel, 1, MessageId.make("message-before-the-users-latest"));
    expect(await rejection(readModel, command)).toContain(
      "The chat changed while this pull request update was prepared.",
    );
  });

  it("rejects a wake into a running turn, and a wake the watch does not record as sent", async () => {
    const readModel = await watched();
    const running = await dispatch(readModel, {
      type: "thread.session.set",
      commandId: CommandId.make("provider:running"),
      threadId,
      session: {
        ...threadOf(readModel).session!,
        status: "running",
        activeTurnId: TurnId.make("turn-running"),
      },
      createdAt: updateAt,
    });
    expect(await rejection(running.readModel, withWake(running.readModel, 1))).toBeTruthy();

    const command = withWake(readModel, 1);
    expect(
      await rejection(readModel, { ...command, next: { ...command.next!, delivery: null } }),
    ).toContain("does not record this update as sent");
    expect(
      await rejection(readModel, {
        ...command,
        wake: { ...command.wake!, messageId: MessageId.make("not-a-watch-message") },
      }),
    ).toContain("pull request watch message id");
  });

  it("refuses an Auto-fix CI turn once the chat left its default mode", async () => {
    const readModel = await watched();
    const { readModel: planning } = await dispatch(readModel, {
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("client-plan-mode"),
      threadId,
      interactionMode: "plan",
      createdAt: updateAt,
    });
    const news = withWake(planning, 1);
    const fix = {
      ...news,
      next: { ...news.next!, delivery: { ...news.next!.delivery!, kind: "fix" as const } },
    };
    expect(await rejection(planning, fix)).toContain("left its default mode");
    // News still reaches a chat in plan mode.
    expect(Exit.isSuccess(await decide(planning, news))).toBe(true);
  });

  it("refuses watches and wakes on archived or settled chats", async () => {
    const readModel = await watched();
    const settled = await dispatch(readModel, {
      type: "thread.settle",
      commandId: CommandId.make("user-settle"),
      threadId,
    });
    expect(await rejection(settled.readModel, update())).toContain("settled chat");
    expect(await rejection(settled.readModel, withWake(settled.readModel, 1))).toBeTruthy();

    const archived = await dispatch(await seed(), {
      type: "thread.archive",
      commandId: CommandId.make("user-archive"),
      threadId,
    });
    expect(await rejection(archived.readModel, update())).toContain("Archived");
  });

  it("refuses a watch that could never deliver: Trash, or a removed checkout", async () => {
    const trashed = await dispatch(await seed(), {
      type: "thread.trash",
      commandId: CommandId.make("user-trash"),
      threadId,
    });
    expect(await rejection(trashed.readModel, update())).toContain("in Trash");

    // The chat's own checkout is gone: it takes no turns there.
    const ownRemoved = await dispatch(await seed(), {
      type: "worktree.checkout.remove",
      commandId: CommandId.make("server:checkout-remove-own"),
      worktreeId,
      reason: "removed",
      removedAt: updateAt,
    } as OrchestrationCommand);
    expect(await rejection(ownRemoved.readModel, update())).toContain("checkout");

    // The pull request's workspace (another of the project) lost the checkout it is read from.
    const otherWorktreeId = WorktreeId.make("worktree-watch-other");
    let readModel = await Effect.runPromise(
      projectEvent(
        await seed(),
        seedEvent({
          aggregateKind: "worktree",
          aggregateId: otherWorktreeId,
          type: "worktree.created",
          occurredAt: createdAt,
          commandId: CommandId.make("seed-worktree-other"),
          payload: {
            worktreeId: otherWorktreeId,
            projectId,
            branch: "feature/other",
            worktreePath: "/tmp/watch-other",
            origin: "branch",
            prNumber: 13,
            issueNumber: null,
            prTitle: null,
            issueTitle: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    const other = watch({ watchId: "github.com/o/r#13", number: 13, worktreeId: otherWorktreeId });
    const watchOther = update({ watchId: other.watchId, next: other });
    expect(Exit.isSuccess(await decide(readModel, watchOther))).toBe(true);
    readModel = (
      await dispatch(readModel, {
        type: "worktree.checkout.remove",
        commandId: CommandId.make("server:checkout-remove-other"),
        worktreeId: otherWorktreeId,
        reason: "removed",
        removedAt: updateAt,
      } as OrchestrationCommand)
    ).readModel;
    expect(await rejection(readModel, watchOther)).toContain("no checkout to read it from");
  });

  it("refuses a ninth watch and a pull request of another project's workspace", async () => {
    let readModel = await seed();
    for (let number = 1; number <= 8; number += 1) {
      readModel = (
        await dispatch(
          readModel,
          update({
            watchId: `github.com/o/r#${number}`,
            next: watch({ watchId: `github.com/o/r#${number}`, number }),
          }),
        )
      ).readModel;
    }
    expect(threadOf(readModel).pullRequestWatchState?.active).toHaveLength(8);
    expect(
      await rejection(
        readModel,
        update({
          watchId: "github.com/o/r#9",
          next: watch({ watchId: "github.com/o/r#9", number: 9 }),
        }),
      ),
    ).toContain("at most 8");

    expect(
      await rejection(
        await seed(),
        update({ next: watch({ worktreeId: otherProjectWorktreeId }) }),
      ),
    ).toContain("another project");

    // Settling ends all eight; the thread keeps the newest four ended entries.
    const { readModel: settled } = await dispatch(readModel, {
      type: "thread.settle",
      commandId: CommandId.make("client-settle-eight"),
      threadId,
    });
    expect(threadOf(settled).pullRequestWatchState?.active).toEqual([]);
    expect(threadOf(settled).pullRequestWatchState?.ended).toHaveLength(4);
  });

  it("ends a watch with its reason and keeps the newest ended entries", async () => {
    const readModel = await watched();
    expect(
      await rejection(
        readModel,
        update({ expectedRevision: 1, expectedStartedAt: watchStartedAt, next: null }),
      ),
    ).toContain("needs a reason");
    const { events, readModel: next } = await dispatch(
      readModel,
      update({
        expectedRevision: 1,
        expectedStartedAt: watchStartedAt,
        next: null,
        endReason: "merged",
      }),
    );
    const ended = events[0];
    if (ended?.type !== "thread.pull-request-watch-updated") throw new Error("no watch event");
    expect(ended.payload.changed).toEqual([{ watchId, ended: "merged" }]);
    expect(threadOf(next).pullRequestWatchState).toEqual({
      active: [],
      ended: [{ watchId, number: 12, reason: "merged", endedAt: updateAt }],
    });
  });
});

describe("lifecycle commands end pull request watches in the same command", () => {
  const endedReason = (events: ReadonlyArray<OrchestrationEvent>) => {
    const ended = events.find((event) => event.type === "thread.pull-request-watch-updated");
    if (ended?.type !== "thread.pull-request-watch-updated") return null;
    expect(ended.payload.watches.active).toEqual([]);
    return ended.payload.watches.ended[0]?.reason ?? null;
  };

  it("a user Stop ends the thread's pull request watches in the same command", async () => {
    const readModel = await watched();
    const { events, readModel: next } = await dispatch(readModel, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("client-interrupt"),
      threadId,
      createdAt: updateAt,
    });
    expect(events.map((event) => event.type)).toEqual([
      "thread.turn-interrupt-requested",
      "thread.pull-request-watch-updated",
    ]);
    expect(endedReason(events)).toBe("stopped");
    expect(new Set(events.map((event) => event.commandId)).size).toBe(1);
    expect(threadOf(next).pullRequestWatchState?.active).toEqual([]);
  });

  it.each(["agent-control:operation:turn-interrupt", "server:restart-interrupt"])(
    "an interrupt the node sends (%s) leaves watches alone",
    async (commandId) => {
      const { events } = await dispatch(await watched(), {
        type: "thread.turn.interrupt",
        commandId: CommandId.make(commandId),
        threadId,
        createdAt: updateAt,
      });
      expect(events.map((event) => event.type)).toEqual(["thread.turn-interrupt-requested"]);
    },
  );

  it("only the explicit Stop session ends watches, not other session stops", async () => {
    const readModel = await watched();
    const explicit = await dispatch(readModel, {
      type: "thread.session.stop",
      commandId: CommandId.make("client-stop"),
      threadId,
      userStop: true,
      createdAt: updateAt,
    });
    expect(endedReason(explicit.events)).toBe("stopped");

    for (const commandId of [
      "client-branch-switch",
      "session-stop-for-archive:client-archive",
      "workspace-lifecycle:operation:session-stop:thread",
    ]) {
      const { events } = await dispatch(readModel, {
        type: "thread.session.stop",
        commandId: CommandId.make(commandId),
        threadId,
        createdAt: updateAt,
      });
      expect(events.map((event) => event.type)).toEqual(["thread.session-stop-requested"]);
    }
    const forged = await dispatch(readModel, {
      type: "thread.session.stop",
      commandId: CommandId.make("server:chat-promotion-session-stop:1"),
      threadId,
      userStop: true,
      createdAt: updateAt,
    });
    expect(forged.events.map((event) => event.type)).toEqual(["thread.session-stop-requested"]);
  });

  it.each([
    ["thread.settle", "settled"],
    ["thread.archive", "archived"],
    ["thread.trash", "trashed"],
  ] as const)("%s ends watches as %s", async (type, reason) => {
    const { events } = await dispatch(await watched(), {
      type,
      commandId: CommandId.make(`client-${type}`),
      threadId,
    } as OrchestrationCommand);
    expect(events[0]?.type).not.toBe("thread.pull-request-watch-updated");
    expect(endedReason(events)).toBe(reason);
  });

  it("removing the checkout ends the watches of its chats and of its pull requests", async () => {
    const readModel = await watched();
    const { events } = await dispatch(readModel, {
      type: "worktree.checkout.remove",
      commandId: CommandId.make("server:checkout-remove"),
      worktreeId,
      reason: "removed",
      removedAt: updateAt,
    } as OrchestrationCommand);
    expect(endedReason(events)).toBe("unlinked");
    // The command's last event, whose receipt it keeps, is still the workspace's.
    expect(events.at(-1)?.aggregateKind).toBe("worktree");
  });

  it("commands on unwatched threads keep exactly their own events", async () => {
    const { events } = await dispatch(await seed(), {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("client-interrupt"),
      threadId,
      createdAt: updateAt,
    });
    expect(events.map((event) => event.type)).toEqual(["thread.turn-interrupt-requested"]);
  });
});

describe("refused pull request watch updates", () => {
  const generation = { threadId, watchId, startedAt: watchStartedAt };

  it("ends a watch after five refusals in a row, never for a stale read", () => {
    const rejections = makePullRequestWatchRejections();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(rejections.noteRefused(generation, PULL_REQUEST_WATCH_CHANGED_DETAIL)).toBe(false);
    }
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(rejections.noteRefused(generation, "Delegated wake refused")).toBe(false);
    }
    expect(rejections.noteRefused(generation, "Delegated wake refused")).toBe(true);
  });

  it("starts counting again after an accepted update or a new generation", () => {
    const rejections = makePullRequestWatchRejections();
    for (let attempt = 1; attempt < 5; attempt += 1) rejections.noteRefused(generation, "refused");
    rejections.noteAccepted(generation);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(rejections.noteRefused(generation, "refused")).toBe(false);
    }
    const restarted = { ...generation, startedAt: "2026-10-04T11:00:00.000Z" };
    expect(rejections.noteRefused(restarted, "refused")).toBe(false);
    rejections.forget(generation);
    expect(rejections.noteRefused(generation, "refused")).toBe(false);
  });
});
