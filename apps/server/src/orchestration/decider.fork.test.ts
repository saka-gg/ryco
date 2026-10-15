import {
  CommandId,
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
  type OrchestrationThreadActivity,
  type ThreadForkCreateCommand,
  type ThreadForkedActivityPayload,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { inheritedItemId, threadForkedActivityId } from "./forkInheritance.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const AT = "2026-10-11T10:00:00.000Z";
const FORKED_AT = "2026-10-11T12:00:00.000Z";
const PROJECT = ProjectId.make("project-fork");
const OTHER_PROJECT = ProjectId.make("project-fork-other");
const CHAT = ProjectId.make("chat-fork-source");
const OTHER_CHAT = ProjectId.make("chat-fork-target");
const SOURCE = ThreadId.make("thread-source");
const FORK = ThreadId.make("fork-1");
const BOUNDARY_TURN = TurnId.make("turn-boundary");
const BOUNDARY_MESSAGE = MessageId.make("message-boundary");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

let sequence = 0;

const projectAll = (
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) =>
  Effect.gen(function* () {
    let next = readModel;
    for (const event of events) {
      sequence += 1;
      next = yield* projectEvent(next, { ...event, sequence } as OrchestrationEvent);
    }
    return next;
  });

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const result = yield* decideOrchestrationCommand({ readModel, command });
    return Array.isArray(result) ? result : [result];
  });

const dispatch = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    return yield* projectAll(readModel, yield* decide(readModel, command));
  });

const projectCreated = (
  projectId: ProjectId,
  kind: "project" | "chat" = "project",
): Omit<OrchestrationEvent, "sequence"> => ({
  eventId: EventId.make(`evt-project-${projectId}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: AT,
  commandId: CommandId.make(`cmd-project-${projectId}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    projectId,
    kind,
    title: projectId,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: AT,
    updatedAt: AT,
  },
});

const threadCreate = (
  threadId: ThreadId,
  projectId: ProjectId = PROJECT,
): Extract<OrchestrationCommand, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`cmd-create-${threadId}`),
  threadId,
  projectId,
  title: "Source thread",
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: AT,
});

const seed = Effect.gen(function* () {
  const base = yield* projectAll(createEmptyReadModel(AT), [
    projectCreated(PROJECT),
    projectCreated(OTHER_PROJECT),
    projectCreated(CHAT, "chat"),
    projectCreated(OTHER_CHAT, "chat"),
  ]);
  return yield* dispatch(base, threadCreate(SOURCE));
});

const inherited = (sourceItemId: string) =>
  inheritedItemId({ forkThreadId: FORK, sourceThreadId: SOURCE, sourceItemId });

const forkedPayload = (
  providerContext: "native" | "handoff",
  overrides: Partial<ThreadForkedActivityPayload> = {},
): ThreadForkedActivityPayload => ({
  schemaVersion: 1,
  sourceThreadId: SOURCE,
  sourceMessageId: BOUNDARY_MESSAGE,
  sourceTurnId: BOUNDARY_TURN,
  sourceTitle: "Source thread",
  inheritedMessageCount: 2,
  providerContext,
  ...(providerContext === "handoff" ? { handoffReason: "provider-unsupported" as const } : {}),
  checkout: { kind: "current-checkout", worktreePath: null, branch: null },
  notices: [],
  ...overrides,
});

const toolActivity: OrchestrationThreadActivity = {
  id: EventId.make(inherited("activity-tool")),
  tone: "tool",
  kind: "tool.completed",
  summary: "Ran tests",
  payload: { providerItemId: "item-1" },
  turnId: BOUNDARY_TURN,
  // A source orchestration sequence: meaningless in the fork.
  sequence: 41,
  createdAt: "2026-10-11T10:00:02.000Z",
};

const forkCommand = (
  overrides: Partial<Omit<ThreadForkCreateCommand, "type">> = {},
): ThreadForkCreateCommand => ({
  ...threadCreate(FORK),
  type: "thread.fork.create",
  commandId: CommandId.make("cmd-fork-1"),
  title: "Source thread (fork)",
  createdAt: FORKED_AT,
  sourceThreadId: SOURCE,
  sourceMessageId: BOUNDARY_MESSAGE,
  sourceTurnId: BOUNDARY_TURN,
  worktreeId: null,
  newWorktree: null,
  messages: [
    {
      id: MessageId.make(inherited("message-question")),
      role: "user",
      text: "Question",
      attachments: [
        {
          type: "image",
          id: "fork-1-8a720b02-d57d-e14a-be64-160a759fb6ec",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 3,
        },
      ],
      turnId: BOUNDARY_TURN,
      streaming: false,
      createdAt: "2026-10-11T10:00:01.000Z",
      updatedAt: "2026-10-11T10:00:01.000Z",
    },
    {
      id: MessageId.make(inherited(BOUNDARY_MESSAGE)),
      role: "assistant",
      text: "Answer",
      turnId: BOUNDARY_TURN,
      streaming: false,
      createdAt: "2026-10-11T10:00:03.000Z",
      updatedAt: "2026-10-11T10:00:04.000Z",
    },
  ],
  proposedPlans: [
    {
      id: inherited("plan-1"),
      turnId: BOUNDARY_TURN,
      planMarkdown: "1. Do it",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-10-11T10:00:02.500Z",
      updatedAt: "2026-10-11T10:00:02.500Z",
    },
  ],
  activities: [toolActivity],
  forked: forkedPayload("handoff"),
  ...overrides,
});

const expectInvariant = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decide(readModel, command));
    assert.instanceOf(error, OrchestrationCommandInvariantError);
    assert.strictEqual(error.commandType, command.type);
    return error;
  });

describe("decider thread.fork.create", () => {
  it.effect("publishes the fork, its history and provenance in one decision", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const worktreeId = WorktreeId.make("worktree-fork-1");
      const command = forkCommand({
        branch: "ryco/fork-12345678",
        worktreePath: "/tmp/worktrees/fork-1",
        worktreeId,
        newWorktree: {
          worktreeId,
          branch: "ryco/fork-12345678",
          worktreePath: "/tmp/worktrees/fork-1",
        },
      });
      const events = yield* decide(readModel, command);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "worktree.created",
          "thread.created",
          "thread.message-sent",
          "thread.message-sent",
          "thread.proposed-plan-upserted",
          "thread.activity-appended",
          "thread.activity-appended",
          "thread.attachedToWorktree",
        ],
      );
      assert.isTrue(events.every((event) => event.commandId === command.commandId));

      const [worktreeCreated, created, question, answer, , toolAppended, forkedAppended] = events;
      assert.deepInclude(worktreeCreated?.payload, {
        worktreeId,
        projectId: PROJECT,
        origin: "branch",
        prNumber: null,
        issueNumber: null,
      });
      // Lineage is decider-computed provenance, never input.
      assert.deepStrictEqual((created!.payload as { lineage?: unknown }).lineage, {
        parentThreadId: SOURCE,
        rootThreadId: SOURCE,
        relationship: "forked",
        sourceMessageId: BOUNDARY_MESSAGE,
        sourceTurnId: BOUNDARY_TURN,
      });
      // History keeps attachments, turns and original timestamps, and is never streaming.
      assert.deepInclude(question?.payload, {
        messageId: command.messages[0]!.id,
        role: "user",
        attachments: command.messages[0]!.attachments,
        turnId: BOUNDARY_TURN,
        streaming: false,
        createdAt: "2026-10-11T10:00:01.000Z",
      });
      assert.deepInclude(answer?.payload, {
        updatedAt: "2026-10-11T10:00:04.000Z",
      });
      const tool = (toolAppended!.payload as { activity: OrchestrationThreadActivity }).activity;
      assert.strictEqual(tool.id, toolActivity.id);
      assert.notProperty(tool, "sequence");
      assert.deepInclude((forkedAppended!.payload as { activity: unknown }).activity, {
        id: EventId.make(threadForkedActivityId(FORK)),
        kind: "thread.forked",
        tone: "info",
        summary: "Forked from Source thread",
        payload: command.forked,
        turnId: null,
        createdAt: FORKED_AT,
      });

      const projected = yield* projectAll(readModel, events);
      const fork = projected.threads.find((thread) => thread.id === FORK);
      assert.strictEqual(fork?.worktreeId, worktreeId);
      // The command model keeps user-message anchors only: the inherited prompt, not the answer.
      assert.deepEqual(
        fork?.messages.map((message) => message.role),
        ["user"],
      );
      assert.strictEqual(fork?.proposedPlans.length, 1);
      // The command model keeps the fork record, not the inherited tool activity.
      assert.deepEqual(
        fork?.activities.map((activity) => activity.kind),
        ["thread.forked"],
      );
      // Nothing started: no turn, no session.
      assert.isNull(fork?.latestTurn);
      assert.isNull(fork?.session);
      // The id is taken now; re-publishing it is refused.
      yield* expectInvariant(projected, command);
    }),
  );

  it.effect("attaches to the source's worktree and roots the lineage at the source's root", () =>
    Effect.gen(function* () {
      const worktreeId = WorktreeId.make("worktree-existing");
      let readModel = yield* projectAll(yield* seed, [
        {
          eventId: EventId.make("evt-worktree-existing"),
          aggregateKind: "worktree",
          aggregateId: worktreeId,
          type: "worktree.created",
          occurredAt: AT,
          commandId: CommandId.make("cmd-worktree-existing"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            worktreeId,
            projectId: PROJECT,
            branch: "feature",
            worktreePath: "/tmp/worktrees/feature",
            origin: "branch",
            prNumber: null,
            issueNumber: null,
            prTitle: null,
            issueTitle: null,
            createdAt: AT,
            updatedAt: AT,
          },
        },
      ]);
      readModel = yield* dispatch(readModel, {
        ...threadCreate(ThreadId.make("thread-child")),
        type: "thread.delegated.create",
        commandId: CommandId.make("cmd-child"),
        parentThreadId: SOURCE,
      });
      const events = yield* decide(
        readModel,
        forkCommand({
          sourceThreadId: ThreadId.make("thread-child"),
          forked: forkedPayload("native", { sourceThreadId: ThreadId.make("thread-child") }),
          worktreeId,
          worktreePath: "/tmp/worktrees/feature",
          branch: "feature",
        }),
      );
      assert.deepStrictEqual(events.at(-1)?.payload, {
        threadId: FORK,
        worktreeId,
        attachedAt: FORKED_AT,
      });
      assert.deepInclude((events[0]!.payload as { lineage: unknown }).lineage, {
        parentThreadId: "thread-child",
        rootThreadId: SOURCE,
        relationship: "forked",
      });
    }),
  );

  it.effect("accepts a source moved to Trash or archived after acceptance", () =>
    Effect.gen(function* () {
      const trashed = yield* dispatch(yield* seed, {
        type: "thread.trash",
        commandId: CommandId.make("cmd-trash-source"),
        threadId: SOURCE,
      });
      const events = yield* decide(trashed, forkCommand());
      assert.strictEqual(events[0]?.type, "thread.created");
    }),
  );

  it.effect("forks a chat into a new chat, and nothing else across projects", () =>
    Effect.gen(function* () {
      const chatSource = ThreadId.make("thread-chat-source");
      const withChat = yield* dispatch(yield* seed, threadCreate(chatSource, CHAT));
      const chatFork = forkCommand({
        projectId: OTHER_CHAT,
        sourceThreadId: chatSource,
        forked: forkedPayload("handoff", { sourceThreadId: chatSource }),
      });
      const events = yield* decide(withChat, chatFork);
      assert.strictEqual(events[0]?.type, "thread.created");

      const error = yield* expectInvariant(withChat, forkCommand({ projectId: OTHER_PROJECT }));
      assert.include(error.detail, "different project");
      yield* expectInvariant(
        withChat,
        forkCommand({
          projectId: OTHER_PROJECT,
          sourceThreadId: chatSource,
          forked: forkedPayload("handoff", { sourceThreadId: chatSource }),
        }),
      );
    }),
  );

  it.effect("rejects missing, permanently deleted and self sources", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      yield* expectInvariant(
        readModel,
        forkCommand({
          sourceThreadId: ThreadId.make("missing"),
          forked: forkedPayload("handoff", { sourceThreadId: ThreadId.make("missing") }),
        }),
      );
      // A never-used thread is deleted without passing Trash.
      const deleted = yield* dispatch(readModel, {
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete-source"),
        threadId: SOURCE,
      });
      const deletedError = yield* expectInvariant(deleted, forkCommand());
      assert.include(deletedError.detail, "deleted permanently");
      const self = yield* expectInvariant(
        readModel,
        forkCommand({
          threadId: SOURCE,
          messages: [],
          proposedPlans: [],
          activities: [],
        }),
      );
      assert.include(self.detail, "cannot be forked from itself");
    }),
  );

  it.effect("refuses history that is not the fork's own or drives server state", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const base = forkCommand();
      const rejected = (overrides: Partial<Omit<ThreadForkCreateCommand, "type">>) =>
        expectInvariant(readModel, forkCommand(overrides)).pipe(
          Effect.map((error) => error.detail),
        );

      assert.include(
        yield* rejected({
          messages: [{ ...base.messages[0]!, id: MessageId.make("message-question") }],
        }),
        "does not carry an id of fork",
      );
      assert.include(
        yield* rejected({ messages: [{ ...base.messages[1]!, streaming: true }] }),
        "still streaming",
      );
      assert.include(
        yield* rejected({
          messages: [
            {
              ...base.messages[0]!,
              attachments: [
                {
                  type: "image",
                  id: "thread-source-8a720b02-d57d-e14a-be64-160a759fb6ec",
                  name: "screen.png",
                  mimeType: "image/png",
                  sizeBytes: 3,
                },
              ],
            },
          ],
        }),
        "not a copy owned by fork",
      );
      assert.include(
        yield* rejected({ proposedPlans: [{ ...base.proposedPlans[0]!, id: "plan-1" }] }),
        "does not carry an id of fork",
      );
      assert.include(
        yield* rejected({ activities: [{ ...toolActivity, id: EventId.make("activity-tool") }] }),
        "does not carry an id of fork",
      );
      for (const kind of [
        "context-handoff",
        "thread.forked",
        "approval.requested",
        "user-input.requested",
        "provider.turn.start.failed",
        "checkpoint.revert",
        "task.started",
      ]) {
        assert.include(
          yield* rejected({ activities: [{ ...toolActivity, kind }] }),
          `cannot inherit '${kind}'`,
        );
      }
      assert.include(
        yield* rejected({
          forked: forkedPayload("handoff", { sourceTurnId: TurnId.make("other") }),
        }),
        "provenance does not match",
      );
    }),
  );

  it.effect("refuses worktree records that do not match the fork's checkout", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const worktreeId = WorktreeId.make("worktree-fork-1");
      const newWorktree = {
        worktreeId,
        branch: "ryco/fork-12345678",
        worktreePath: "/tmp/worktrees/fork-1",
      };
      yield* expectInvariant(
        readModel,
        forkCommand({ worktreeId, newWorktree, worktreePath: null, branch: null }),
      );
      yield* expectInvariant(
        readModel,
        forkCommand({ worktreeId: WorktreeId.make("missing-worktree") }),
      );
    }),
  );
});

describe("fork context handoff", () => {
  const turnStart = (commandId: string, messageId: string): OrchestrationCommand => ({
    type: "thread.turn.start",
    commandId: CommandId.make(commandId),
    threadId: FORK,
    message: { messageId: MessageId.make(messageId), role: "user", text: "Next", attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-11T13:00:00.000Z",
  });
  const handoffActivity = (events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>) =>
    events.flatMap((event) =>
      event.type === "thread.activity-appended" &&
      (event.payload as { activity: OrchestrationThreadActivity }).activity.kind ===
        "context-handoff"
        ? [(event.payload as { activity: OrchestrationThreadActivity }).activity]
        : [],
    )[0];
  const terminal = (
    activity: OrchestrationThreadActivity,
    status: "consumed" | "failed",
  ): OrchestrationCommand => ({
    type: "thread.activity.append",
    commandId: CommandId.make(`cmd-handoff-${status}`),
    threadId: FORK,
    activity: {
      ...activity,
      payload: {
        ...(activity.payload as object),
        status,
        sources: [{ providerInstanceId: "codex", driverKind: "codex", modelSlug: "gpt-5.4" }],
        target: { providerInstanceId: "codex", driverKind: "codex", modelSlug: "gpt-5.4" },
        targetRuntimeSessionId: RuntimeSessionId.make("runtime-fork"),
        ...(status === "consumed"
          ? { contextVersion: 1, contextDigest: "a".repeat(64) }
          : { error: "Delivery failed" }),
      },
    },
    createdAt: "2026-10-11T13:00:01.000Z",
  });

  it.effect("hands the inherited conversation to the first turn of a handoff fork, once", () =>
    Effect.gen(function* () {
      const forked = yield* dispatch(yield* seed, forkCommand());
      const first = yield* decide(forked, turnStart("cmd-first", "message-first"));
      assert.deepStrictEqual(
        first.map((event) => event.type),
        [
          "thread.context-handoff-requested",
          "thread.activity-appended",
          "thread.message-sent",
          "thread.turn-start-requested",
        ],
      );
      const requested = handoffActivity(first)!;
      // The fork's own model: not a model change, a fork delivery.
      assert.deepInclude(requested.payload, {
        reason: "fork",
        status: "requested",
        targetMessageId: "message-first",
        sourceSelection: MODEL,
        targetSelection: MODEL,
      });

      // A failed delivery leaves it pending: the next send retries the handoff.
      const afterFirst = yield* projectAll(forked, first);
      const failed = yield* dispatch(afterFirst, terminal(requested, "failed"));
      const retried = yield* decide(failed, turnStart("cmd-retry", "message-retry"));
      assert.deepInclude(handoffActivity(retried)?.payload, { reason: "fork" });

      // Once consumed, later turns are ordinary.
      const consumed = yield* dispatch(afterFirst, terminal(requested, "consumed"));
      const second = yield* decide(consumed, turnStart("cmd-second", "message-second"));
      assert.deepStrictEqual(
        second.map((event) => event.type),
        ["thread.message-sent", "thread.turn-start-requested"],
      );
    }),
  );

  it.effect("never hands off a native fork for its inherited history", () =>
    Effect.gen(function* () {
      const forked = yield* dispatch(yield* seed, forkCommand({ forked: forkedPayload("native") }));
      const first = yield* decide(forked, turnStart("cmd-first", "message-first"));
      assert.deepStrictEqual(
        first.map((event) => event.type),
        ["thread.message-sent", "thread.turn-start-requested"],
      );
      // A model change still hands off as a model change.
      const changed = yield* decide(forked, {
        ...turnStart("cmd-change", "message-change"),
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5" },
      } as OrchestrationCommand);
      assert.deepInclude(handoffActivity(changed)?.payload, { reason: "model-change" });
    }),
  );

  it.effect("holds on the restart-hydrated shape: anchors and actionable activities only", () =>
    Effect.gen(function* () {
      const forked = yield* dispatch(yield* seed, forkCommand());
      // getCommandReadModel hydrates the first and latest user messages and the actionable
      // activity kinds (now including thread.forked), not the full history.
      const hydrated: OrchestrationReadModel = {
        ...forked,
        threads: forked.threads.map((thread) =>
          thread.id === FORK
            ? {
                ...thread,
                messages: thread.messages.filter((message) => message.role === "user"),
                proposedPlans: [],
                activities: thread.activities.filter(
                  (activity) => activity.kind === "thread.forked",
                ),
              }
            : thread,
        ),
      };
      const first = yield* decide(hydrated, turnStart("cmd-first", "message-first"));
      assert.deepInclude(handoffActivity(first)?.payload, { reason: "fork" });
    }),
  );

  // An imported turn whose prompt had no text starts with its reply: the fork's inherited
  // history then holds no user prompt at all.
  const assistantOnlyFork = () =>
    forkCommand({
      messages: forkCommand().messages.filter((message) => message.role === "assistant"),
      forked: forkedPayload("handoff", { inheritedMessageCount: 1 }),
    });

  it.effect("hands off a fork whose inherited history holds no user prompt", () =>
    Effect.gen(function* () {
      const forked = yield* dispatch(yield* seed, assistantOnlyFork());
      assert.isFalse(
        forked.threads
          .find((thread) => thread.id === FORK)!
          .messages.some((message) => message.role === "user"),
      );
      const first = yield* decide(forked, turnStart("cmd-first", "message-first"));
      assert.deepStrictEqual(
        first.map((event) => event.type),
        [
          "thread.context-handoff-requested",
          "thread.activity-appended",
          "thread.message-sent",
          "thread.turn-start-requested",
        ],
      );
      assert.deepInclude(handoffActivity(first)?.payload, {
        reason: "fork",
        targetMessageId: "message-first",
      });
    }),
  );

  it.effect("treats a fork as used before its first send, whatever it inherited", () =>
    Effect.gen(function* () {
      const forked = yield* dispatch(yield* seed, assistantOnlyFork());
      // Archive is offered for every fork (`threadHasConversation`); the node accepts it.
      const archived = yield* decide(forked, {
        type: "thread.archive",
        commandId: CommandId.make("cmd-archive-fork"),
        threadId: FORK,
      });
      assert.include(
        archived.map((event) => event.type),
        "thread.archived",
      );
      // Only a never-used thread may skip Trash; a fork never is (`isNeverUsedThread`).
      const error = yield* expectInvariant(forked, {
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete-fork"),
        threadId: FORK,
      });
      assert.include(error.detail, "must be moved to Trash");
    }),
  );
});

describe("fork lineage roots", () => {
  const delegatedCreate = (threadId: ThreadId, parentThreadId: ThreadId): OrchestrationCommand => ({
    ...threadCreate(threadId),
    type: "thread.delegated.create",
    commandId: CommandId.make(`cmd-delegate-${threadId}`),
    parentThreadId,
  });
  const lineageOf = (readModel: OrchestrationReadModel, threadId: ThreadId) =>
    readModel.threads.find((thread) => thread.id === threadId)?.lineage;

  it.effect("starts a new delegation tree at a fork and keeps the fork's own root", () =>
    Effect.gen(function* () {
      // SOURCE -> delegated CHILD -> fork FORK -> delegated GRANDCHILD -> delegated GREAT.
      const child = ThreadId.make("thread-delegated-child");
      const grandchild = ThreadId.make("thread-fork-delegate");
      const great = ThreadId.make("thread-fork-delegate-child");
      let readModel = yield* dispatch(yield* seed, delegatedCreate(child, SOURCE));
      readModel = yield* dispatch(
        readModel,
        forkCommand({
          sourceThreadId: child,
          forked: forkedPayload("handoff", { sourceThreadId: child }),
        }),
      );
      // The fork records the provenance of the whole chain.
      assert.deepInclude(lineageOf(readModel, FORK), {
        parentThreadId: child,
        rootThreadId: SOURCE,
        relationship: "forked",
      });
      // What is delegated from the fork belongs to the fork's tree, not to the chain it was
      // copied from: clients fold quiet delegated threads under their root.
      readModel = yield* dispatch(readModel, delegatedCreate(grandchild, FORK));
      assert.deepStrictEqual(lineageOf(readModel, grandchild), {
        parentThreadId: FORK,
        rootThreadId: FORK,
        relationship: "delegated",
      });
      readModel = yield* dispatch(readModel, delegatedCreate(great, grandchild));
      assert.deepStrictEqual(lineageOf(readModel, great), {
        parentThreadId: grandchild,
        rootThreadId: FORK,
        relationship: "delegated",
      });
    }),
  );
});

describe("reserved fork item ids", () => {
  const turnStart = (messageId: string): OrchestrationCommand => ({
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-start-${messageId}`),
    threadId: SOURCE,
    message: { messageId: MessageId.make(messageId), role: "user", text: "Hi", attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-11T13:00:00.000Z",
  });

  it.effect("refuses a sent message id minted for forked history in any thread", () =>
    Effect.gen(function* () {
      // SOURCE was never forked: the ids would still make its message permanent and invisible
      // to recency, revert and history repair.
      const readModel = yield* seed;
      for (const messageId of [
        `${SOURCE}:inherited:message-x`,
        `${FORK}:inherited:message-x`,
        threadForkedActivityId(SOURCE),
      ]) {
        const error = yield* expectInvariant(readModel, turnStart(messageId));
        assert.include(error.detail, "reserved for forked history");
      }
      const accepted = yield* decide(readModel, turnStart("message-ordinary"));
      assert.strictEqual(accepted[0]?.type, "thread.message-sent");
    }),
  );
});
