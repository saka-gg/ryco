import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  THREAD_MOVED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  WorktreeId,
  type CheckpointRef,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectKind,
  type ThreadPullRequestWatch,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-11-01T00:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const chatProject = ProjectId.make("chat-1");
const threadId = ThreadId.make("thread-move");
const worktreeId = WorktreeId.make("worktree-a");

let sequence = 0;
const event = (
  input: Pick<OrchestrationEvent, "type" | "payload" | "aggregateKind" | "aggregateId">,
): OrchestrationEvent =>
  ({
    ...input,
    sequence: ++sequence,
    eventId: EventId.make(`evt-${sequence}`),
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${sequence}`),
    metadata: {},
  }) as OrchestrationEvent;

async function apply(model: OrchestrationReadModel, events: ReadonlyArray<OrchestrationEvent>) {
  let next = model;
  for (const entry of events) next = await Effect.runPromise(projectEvent(next, entry));
  return next;
}

async function decide(model: OrchestrationReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: model }),
  );
  const planned = Array.isArray(decided) ? decided : [decided];
  const events = planned.map(
    (entry) => Object.assign({}, entry, { sequence: ++sequence }) as OrchestrationEvent,
  );
  return { events, model: await apply(model, events) };
}

const refused = (model: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.runPromise(decideOrchestrationCommand({ command, readModel: model }));

const projectCreated = (projectId: ProjectId, title: string, kind: ProjectKind = "project") =>
  event({
    type: "project.created",
    aggregateKind: "project",
    aggregateId: projectId,
    payload: {
      projectId,
      kind,
      title,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

const threadCreated = (
  id: ThreadId,
  projectId: ProjectId,
  checkout: { readonly branch: string | null; readonly worktreePath: string | null },
) =>
  event({
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: id,
    payload: {
      threadId: id,
      projectId,
      title: "Started in the wrong project",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: checkout.branch,
      worktreePath: checkout.worktreePath,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

const userMessage = (id: ThreadId, messageId: string) =>
  event({
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: id,
    payload: {
      threadId: id,
      messageId: MessageId.make(messageId),
      role: "user",
      text: "Fix the login flow",
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

const checkpoint = (id: ThreadId, turnCount: number) =>
  event({
    type: "thread.turn-diff-completed",
    aggregateKind: "thread",
    aggregateId: id,
    payload: {
      threadId: id,
      turnId: TurnId.make(`turn-${turnCount}`),
      checkpointTurnCount: turnCount,
      checkpointRef: `refs/ryco/checkpoints/x/turn/${turnCount}` as CheckpointRef,
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: NOW,
    },
  });

/** Two projects and a chat; a used thread in project A, in a worktree when asked. */
async function seed(options: { readonly inWorktree?: boolean } = {}) {
  const worktreePath = options.inWorktree ? "/tmp/project-a-worktree" : null;
  const events: OrchestrationEvent[] = [
    projectCreated(projectA, "Alpha"),
    projectCreated(projectB, "Beta"),
    projectCreated(chatProject, "A chat", "chat"),
    threadCreated(threadId, projectA, {
      branch: options.inWorktree ? "feature/login" : "main",
      worktreePath,
    }),
    userMessage(threadId, "message-1"),
    checkpoint(threadId, 1),
    checkpoint(threadId, 2),
  ];
  if (options.inWorktree) {
    events.push(
      event({
        type: "worktree.created",
        aggregateKind: "worktree",
        aggregateId: worktreeId,
        payload: {
          worktreeId,
          projectId: projectA,
          branch: "feature/login",
          worktreePath: "/tmp/project-a-worktree",
          origin: "branch",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
      event({
        type: "thread.attachedToWorktree",
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: { threadId, worktreeId, attachedAt: NOW },
      }),
    );
  }
  return apply(createEmptyReadModel(NOW), events);
}

const threadOf = (model: OrchestrationReadModel, id: ThreadId = threadId) =>
  model.threads.find((thread) => thread.id === id)!;

const withThread = (
  model: OrchestrationReadModel,
  patch: Partial<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel => ({
  ...model,
  threads: model.threads.map((thread) =>
    thread.id === threadId ? { ...thread, ...patch } : thread,
  ),
});

let commandCount = 0;
const move = (
  projectId: ProjectId,
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.project.move" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.project.move" }> => ({
  type: "thread.project.move",
  commandId: CommandId.make(`move-${++commandCount}`),
  threadId,
  expectedProjectId: projectA,
  projectId,
  createdAt: NOW,
  ...overrides,
});

const session = (status: "starting" | "running" | "ready" | "stopped") => ({
  threadId,
  status,
  providerName: "claude",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
});

describe("thread.project.move", () => {
  it("moves a thread into another project's shared checkout and records where it came from", async () => {
    const before = await seed();
    const { events, model } = await decide(before, move(projectB));

    expect(events.map((entry) => entry.type)).toEqual([
      "thread.project-moved",
      "thread.activity-appended",
    ]);
    expect(events[0]!.payload).toMatchObject({
      threadId,
      projectId: projectB,
      previousProjectId: projectA,
      previousWorktreePath: null,
      previousWorktreeId: null,
      previousBranch: "main",
    });
    expect(threadOf(model)).toMatchObject({
      projectId: projectB,
      worktreePath: null,
      worktreeId: null,
      branch: null,
    });
    // History stays with the thread.
    expect(threadOf(model).messages).toEqual(threadOf(before).messages);
    expect(threadOf(model).checkpoints).toEqual(threadOf(before).checkpoints);
    const moved = threadOf(model).activities.find(
      (activity) => activity.kind === THREAD_MOVED_ACTIVITY_KIND,
    );
    expect(moved?.summary).toBe("Moved to Beta");
    expect(moved?.payload).toEqual({
      schemaVersion: 1,
      fromProjectId: projectA,
      fromProjectTitle: "Alpha",
      toProjectId: projectB,
      toProjectTitle: "Beta",
      fromWorktreePath: null,
      checkpointTurnCount: 2,
    });
  });

  it("leaves a thread's own worktree with the old project", async () => {
    const before = await seed({ inWorktree: true });
    const { events, model } = await decide(before, move(projectB));

    expect(events[0]!.payload).toMatchObject({
      previousWorktreePath: "/tmp/project-a-worktree",
      previousWorktreeId: worktreeId,
      previousBranch: "feature/login",
    });
    expect(threadOf(model)).toMatchObject({
      projectId: projectB,
      worktreePath: null,
      worktreeId: null,
      branch: null,
    });
    // The worktree record is untouched: still project A's, still listed there.
    expect(model.worktrees?.find((worktree) => worktree.worktreeId === worktreeId)?.projectId).toBe(
      projectA,
    );
    expect(model.worktrees?.find((worktree) => worktree.worktreeId === worktreeId)).toEqual(
      before.worktrees?.find((worktree) => worktree.worktreeId === worktreeId),
    );
  });

  it("stops an idle session that ran in the old directory", async () => {
    const before = withThread(await seed(), { session: session("ready") });
    const { events } = await decide(before, move(projectB));
    expect(events.map((entry) => entry.type)).toEqual([
      "thread.project-moved",
      "thread.activity-appended",
      "thread.session-stop-requested",
    ]);
  });

  it("ends pull request watches, which read the old project's pull request", async () => {
    const watch = {
      watchId: "github.com/o/r#12",
      number: 12,
      url: "https://github.com/o/r/pull/12",
      provider: "github",
      worktreeId,
      revision: 1,
      startedAt: NOW,
      startedBy: "user",
      runtimeMode: "full-access",
      worktreePath: null,
      headSha: "abc1234",
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: NOW,
      remarkIds: [],
      outsideRemarks: 0,
      conflicting: false,
      wakes: 0,
      news: false,
      requiredChecks: null,
      failingChecks: 0,
      autoFix: null,
      delivery: null,
      beforeWake: null,
      lastChangeAt: null,
    } as ThreadPullRequestWatch;
    const before = withThread(await seed(), {
      pullRequestWatchState: { active: [watch], ended: [] },
    });
    const { events, model } = await decide(before, move(projectB));
    const ended = events.find((entry) => entry.type === "thread.pull-request-watch-updated");
    expect(ended?.payload).toMatchObject({
      changed: [{ watchId: watch.watchId, ended: "scope-changed" }],
    });
    expect(threadOf(model).pullRequestWatchState?.active).toEqual([]);
  });

  it("moves a project thread to a new chat without a project, and a chat into a project", async () => {
    const toChat = await decide(await seed(), move(chatProject));
    expect(threadOf(toChat.model)).toMatchObject({ projectId: chatProject, worktreePath: null });

    const back = await decide(toChat.model, move(projectB, { expectedProjectId: chatProject }));
    expect(threadOf(back.model).projectId).toBe(projectB);
    expect(
      threadOf(back.model).activities.filter((a) => a.kind === THREAD_MOVED_ACTIVITY_KIND),
    ).toHaveLength(2);
  });

  it("refuses a chat that already holds a conversation", async () => {
    const other = ThreadId.make("thread-in-chat");
    const model = await apply(await seed(), [
      threadCreated(other, chatProject, { branch: null, worktreePath: null }),
    ]);
    await expect(refused(model, move(chatProject))).rejects.toThrow(/holds one conversation/);
  });

  it("refuses a replayed or stale move instead of moving the thread twice or back", async () => {
    const first = move(projectB);
    const { model } = await decide(await seed(), first);
    // The same command again (a client retry after a reconnect).
    await expect(refused(model, first)).rejects.toThrow(/moved to another project meanwhile/);
    // A stale client that still lists the thread in project A asks to move it to the chat.
    await expect(refused(model, move(chatProject))).rejects.toThrow(/meanwhile/);
    expect(threadOf(model).projectId).toBe(projectB);
  });

  it("refuses the project it is in, a missing one and a removed one", async () => {
    const model = await seed();
    await expect(refused(model, move(projectA))).rejects.toThrow(/already in this project/);
    await expect(refused(model, move(ProjectId.make("missing")))).rejects.toThrow(/does not exist/);
    const removed = await apply(model, [
      event({
        type: "project.deleted",
        aggregateKind: "project",
        aggregateId: projectB,
        payload: { projectId: projectB, deletedAt: NOW },
      }),
    ]);
    await expect(refused(removed, move(projectB))).rejects.toThrow(/was removed/);
  });

  it.each([
    ["a starting session", { session: session("starting") }, /turn to finish/],
    ["a running session", { session: session("running") }, /turn to finish/],
    ["an archived thread", { archivedAt: NOW }, /Unarchive/],
    ["a thread in Trash", { deletedAt: NOW, trashedAt: NOW }, /Deleted threads/],
  ] as const)("refuses %s", async (_label, patch, message) => {
    const model = withThread(await seed(), patch);
    await expect(refused(model, move(projectB))).rejects.toThrow(message);
  });

  it.each([
    ["approval.requested", /pending approval/],
    ["user-input.requested", /pending question/],
  ] as const)("refuses while %s waits on the user", async (kind, message) => {
    const model = withThread(await seed(), {
      activities: [
        {
          id: EventId.make(`activity-${kind}`),
          tone: "approval",
          kind,
          summary: "Waiting",
          payload: { requestId: `request-${kind}` },
          turnId: null,
          createdAt: NOW,
        },
      ],
    });
    await expect(refused(model, move(projectB))).rejects.toThrow(message);
  });

  it("refuses while a checkpoint revert is in progress", async () => {
    const reverting = await decide(await seed(), {
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("revert-1"),
      threadId,
      turnCount: 1,
      createdAt: new Date().toISOString(),
    });
    await expect(refused(reverting.model, move(projectB))).rejects.toThrow(/revert to finish/);
  });

  it("refuses reverts to checkpoints captured in the old checkout", async () => {
    const { model } = await decide(await seed(), move(projectB));
    const revert = (turnCount: number, type: "thread.checkpoint.revert" | "thread.files.revert") =>
      refused(model, {
        type,
        commandId: CommandId.make(`revert-${type}-${turnCount}`),
        threadId,
        turnCount,
        createdAt: new Date().toISOString(),
      });
    await expect(revert(1, "thread.checkpoint.revert")).rejects.toThrow(/before the thread moved/);
    await expect(revert(0, "thread.files.revert")).rejects.toThrow(/before the thread moved/);
    // The move's own count is the first turn's baseline in the new checkout.
    await expect(revert(2, "thread.checkpoint.revert")).resolves.toBeDefined();
  });

  it("converges when the decided events are replayed onto a fresh read model", async () => {
    const before = await seed({ inWorktree: true });
    const { events, model } = await decide(before, move(projectB));
    const replayed = await apply(before, events);
    expect(threadOf(replayed)).toEqual(threadOf(model));
  });
});
