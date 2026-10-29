import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type QueuedFollowUp,
} from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { delegationSlotHold } from "./delegationSlotHold.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { projectEvent } from "./projector.ts";

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, "0")}:00.000Z`;
const threadId = ThreadId.make("thread-queue");
const projectId = ProjectId.make("project-queue");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claude");
const runningTurn = TurnId.make("turn-running");

const baseThread: OrchestrationThread = {
  id: threadId,
  projectId,
  title: "Queue",
  modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const modelWith = (thread: Partial<OrchestrationThread> = {}): OrchestrationReadModel => ({
  snapshotSequence: 1,
  projects: [
    {
      id: projectId,
      title: "Queue",
      workspaceRoot: "/tmp/queue",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at(0),
      updatedAt: at(0),
      deletedAt: null,
    } as unknown as OrchestrationReadModel["projects"][number],
  ],
  threads: [{ ...baseThread, ...thread }],
  updatedAt: at(0),
});

const running = {
  latestTurn: {
    turnId: runningTurn,
    state: "running" as const,
    requestedAt: at(0),
    startedAt: at(0),
    completedAt: null,
    assistantMessageId: null,
  },
  session: {
    threadId,
    status: "running" as const,
    providerName: "codex",
    providerInstanceId: CODEX,
    runtimeSessionId: RuntimeSessionId.make("runtime-1"),
    runtimeMode: "full-access" as const,
    activeTurnId: runningTurn,
    lastError: null,
    updatedAt: at(0),
  },
};

let commandCounter = 0;
const nextCommandId = (label: string) => CommandId.make(`cmd-${label}-${(commandCounter += 1)}`);

const addCommand = (
  messageId: string,
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.queue.add" }>> = {},
  entry: Partial<Extract<OrchestrationCommand, { type: "thread.queue.add" }>["entry"]> = {},
): OrchestrationCommand => ({
  type: "thread.queue.add",
  commandId: nextCommandId("add"),
  threadId,
  entry: {
    messageId: MessageId.make(messageId),
    text: `text ${messageId}`,
    attachments: [],
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    ...entry,
  },
  createdAt: at(1),
  ...overrides,
});

const decide = (model: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.runPromise(decideOrchestrationCommand({ readModel: model, command })).then((decided) =>
    "type" in decided ? [decided] : [...decided],
  );

const refusal = (model: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.runPromise(Effect.flip(decideOrchestrationCommand({ readModel: model, command })));

/** Decides and projects, like the engine: the model after the command and its events. */
const apply = async (model: OrchestrationReadModel, command: OrchestrationCommand) => {
  const events = await decide(model, command);
  let next = model;
  for (const [index, event] of events.entries()) {
    next = await Effect.runPromise(
      projectEvent(next, {
        ...event,
        sequence: next.snapshotSequence + index + 1,
      } as OrchestrationEvent),
    );
  }
  return { events, model: next };
};

const queueOf = (model: OrchestrationReadModel) =>
  model.threads.find((thread) => thread.id === threadId)?.followUpQueue;

/** A model whose queue holds `ids`, in order. */
const queued = async (ids: ReadonlyArray<string>, thread: Partial<OrchestrationThread> = {}) => {
  let model = modelWith(thread);
  for (const id of ids) model = (await apply(model, addCommand(id))).model;
  return model;
};

const types = (events: ReadonlyArray<{ readonly type: string }>) => events.map((e) => e.type);

describe("follow-up queue decider: add", () => {
  it("queues an entry as the user's, at the tail or the head", async () => {
    const { events, model } = await apply(await queued(["a"]), addCommand("b"));
    expect(events).toHaveLength(1);
    const added = events[0] as Extract<OrchestrationEvent, { type: "thread.queue-entry-added" }>;
    expect(added.type).toBe("thread.queue-entry-added");
    expect(added.payload.beforeMessageId).toBeNull();
    expect(added.payload.entry).toMatchObject({
      messageId: "b",
      revision: 1,
      status: "queued",
      author: "user",
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    const head = await apply(model, addCommand("c", { position: "head" }));
    expect(queueOf(head.model)?.entries.map((entry) => entry.messageId)).toEqual(["c", "a", "b"]);
  });

  it("is idempotent on the message id: queued, already sent, or found sent by normalization", async () => {
    const model = await queued(["a"]);
    expect(await decide(model, addCommand("a", {}, { text: "other copy" }))).toEqual([]);
    const sent = modelWith({
      messages: [
        {
          id: MessageId.make("sent"),
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: at(0),
          updatedAt: at(0),
        },
      ],
    });
    expect(await decide(sent, addCommand("sent"))).toEqual([]);
    expect(
      await decide(
        modelWith(),
        addCommand("older", { alreadySent: true } as Partial<
          Extract<OrchestrationCommand, { type: "thread.queue.add" }>
        >),
      ),
    ).toEqual([]);
  });

  it("refuses ids the node mints, archived threads, a full queue and empty entries", async () => {
    for (const reserved of [
      "delegation-result:child:0",
      "message-agent-control-op-1",
      "pull-request-watch:thread:1",
      `${threadId}:inherited:message-x`,
    ]) {
      const error = await refusal(modelWith(), addCommand(reserved));
      expect(error).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect(error.detail).toContain("reserved");
    }
    expect((await refusal(modelWith({ archivedAt: at(0) }), addCommand("a"))).detail).toContain(
      "Unarchive",
    );
    const full = await queued(Array.from({ length: 20 }, (_, index) => `m${index}`));
    expect((await refusal(full, addCommand("m20"))).detail).toContain("full");
    expect((await refusal(modelWith(), addCommand("empty", {}, { text: "  " }))).detail).toContain(
      "text or an attachment",
    );
  });

  it("lets only the node's own agent add keep an Agent Control message id", async () => {
    const agentAdd = addCommand("message-agent-control-op-2-send-message", {
      author: "agent",
    } as Partial<Extract<OrchestrationCommand, { type: "thread.queue.add" }>>);
    const { model } = await apply(modelWith(), agentAdd);
    const entry = model.threads[0]?.followUpQueue?.entries[0];
    expect(entry?.messageId).toBe("message-agent-control-op-2-send-message");
    expect(entry?.author).toBe("agent");
    // Other reserved prefixes stay refused, also for the agent.
    const delegated = await refusal(
      modelWith(),
      addCommand("delegation-result:child:1", {
        author: "agent",
      } as Partial<Extract<OrchestrationCommand, { type: "thread.queue.add" }>>),
    );
    expect(delegated.detail).toContain("reserved");
  });

  it("queues a capped task's first message with stored copies, held until its slot frees", async () => {
    const copy = {
      type: "file" as const,
      id: "thread-queue-00000000-0000-4000-8000-000000000002",
      name: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 6,
      handoff: { threadId: ThreadId.make("thread-origin"), messageId: MessageId.make("render-1") },
    };
    const slot = delegationSlotHold("proposal-capped", 2);
    const { events, model } = await apply(
      modelWith(),
      addCommand(
        "message-agent-control-op-4-create-2",
        { author: "agent", hold: slot } as Partial<
          Extract<OrchestrationCommand, { type: "thread.queue.add" }>
        >,
        { attachments: [copy] },
      ),
    );
    expect(types(events)).toEqual(["thread.queue-entry-added", "thread.queue-held"]);
    expect(queueOf(model)?.entries[0]).toMatchObject({ author: "agent", attachments: [copy] });
    expect(queueOf(model)?.hold).toMatchObject({ reason: "paused", causeKeys: slot.causeKeys });
    // The person pauses too; the slot's release leaves that pause.
    const paused = await apply(model, {
      type: "thread.queue.hold",
      commandId: nextCommandId("pause"),
      threadId,
      createdAt: at(2),
    });
    const release: OrchestrationCommand = {
      type: "thread.queue.resume",
      commandId: CommandId.make("delegation-slot-release:proposal-capped:thread-queue"),
      threadId,
      acknowledgeCauseKeys: slot.causeKeys,
      createdAt: at(3),
    };
    const released = await apply(paused.model, release);
    expect(queueOf(released.model)?.hold?.causeKeys).toEqual([`paused:${at(2)}`]);
    expect(await decide(released.model, release)).toEqual([]);
  });

  it("keeps a device queue's failed entry failed and its hold, and a server author", async () => {
    const { events, model } = await apply(
      modelWith(),
      addCommand(
        "moved",
        {
          hold: { reason: "interrupted", causeKeys: ["interrupt:turn-1"], detail: null },
          author: "agent",
        } as Partial<Extract<OrchestrationCommand, { type: "thread.queue.add" }>>,
        { failure: { reason: "start-failed", detail: "Delivery unknown." } },
      ),
    );
    expect(types(events)).toEqual(["thread.queue-entry-added", "thread.queue-held"]);
    expect(queueOf(model)?.entries[0]).toMatchObject({ status: "failed", author: "agent" });
    expect(queueOf(model)?.hold?.causeKeys).toEqual(["interrupt:turn-1"]);
  });
});

describe("follow-up queue decider: edit, move, remove, retry", () => {
  it("edits against the revision it saw and keeps place, status and author", async () => {
    const model = await queued(["a", "b"]);
    const edit = (expectedRevision: number): OrchestrationCommand => ({
      type: "thread.queue.edit",
      commandId: nextCommandId("edit"),
      threadId,
      messageId: MessageId.make("a"),
      expectedRevision,
      text: "edited",
      attachments: [],
      modelSelection: { instanceId: CLAUDE, model: "sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at(2),
    });
    const { model: edited } = await apply(model, edit(1));
    expect(queueOf(edited)?.entries[0]).toMatchObject({
      messageId: "a",
      text: "edited",
      revision: 2,
      status: "queued",
      author: "user",
      createdAt: at(1),
      updatedAt: at(2),
    });
    expect((await refusal(edited, edit(1))).detail).toContain("changed since you opened it");
  });

  it("keeps only the entry's own stored attachments the edit names", async () => {
    const image = {
      type: "image" as const,
      id: "thread-queue-00000000-0000-4000-8000-000000000001",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const { model } = await apply(modelWith(), addCommand("a", {}, { attachments: [image] }));
    const edit = (keptAttachmentIds: ReadonlyArray<string>): OrchestrationCommand => ({
      type: "thread.queue.edit",
      commandId: nextCommandId("edit"),
      threadId,
      messageId: MessageId.make("a"),
      expectedRevision: 1,
      text: "edited",
      attachments: [],
      keptAttachmentIds: keptAttachmentIds as never,
      modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdAt: at(2),
    });
    const kept = await apply(model, edit([image.id]));
    expect(queueOf(kept.model)?.entries[0]?.attachments).toEqual([image]);
    const dropped = await apply(model, edit([]));
    expect(queueOf(dropped.model)?.entries[0]?.attachments).toEqual([]);
    expect((await refusal(model, edit(["other-thread-attachment"]))).detail).toContain(
      "not one of this follow-up's",
    );
  });

  it("moves an entry before another or to the end, and a move that changes nothing records nothing", async () => {
    const model = await queued(["a", "b", "c"]);
    const move = (messageId: string, before: string | null): OrchestrationCommand => ({
      type: "thread.queue.move",
      commandId: nextCommandId("move"),
      threadId,
      messageId: MessageId.make(messageId),
      beforeMessageId: before === null ? null : MessageId.make(before),
      createdAt: at(2),
    });
    const moved = await apply(model, move("c", "a"));
    expect(moved.events[0]?.payload).toMatchObject({ order: ["c", "a", "b"] });
    const toEnd = await apply(moved.model, move("c", null));
    expect(queueOf(toEnd.model)?.entries.map((entry) => entry.messageId)).toEqual(["a", "b", "c"]);
    expect(await decide(model, move("b", "c"))).toEqual([]);
    expect((await refusal(model, move("a", "gone"))).detail).toContain("no longer queued");
  });

  it("removes entries, and emptying a held queue also releases its hold", async () => {
    let model = await queued(["a", "b"]);
    model = (
      await apply(model, {
        type: "thread.queue.hold",
        commandId: nextCommandId("pause"),
        threadId,
        createdAt: at(2),
      })
    ).model;
    const remove = (ids: string[]): OrchestrationCommand => ({
      type: "thread.queue.remove",
      commandId: nextCommandId("remove"),
      threadId,
      messageIds: ids.map((id) => MessageId.make(id)),
      createdAt: at(3),
    });
    expect(await decide(model, remove(["gone"]))).toEqual([]);
    const { events, model: emptied } = await apply(model, remove(["a", "b", "gone"]));
    expect(types(events)).toEqual(["thread.queue-entries-removed", "thread.queue-released"]);
    expect(events[0]?.payload).toMatchObject({ messageIds: ["a", "b"], reason: "user" });
    expect(queueOf(emptied)).toBeUndefined();
  });

  it("retries a failed entry and ignores one that is queued", async () => {
    const { model } = await apply(
      modelWith(),
      addCommand("a", {}, { failure: { reason: "steer-uncertain", detail: null } }),
    );
    const retry: OrchestrationCommand = {
      type: "thread.queue.retry",
      commandId: nextCommandId("retry"),
      threadId,
      messageId: MessageId.make("a"),
      createdAt: at(2),
    };
    const retried = await apply(model, retry);
    expect(queueOf(retried.model)?.entries[0]).toMatchObject({ status: "queued", revision: 2 });
    expect(queueOf(retried.model)?.entries[0]?.failure).toBeUndefined();
    expect(await decide(retried.model, { ...retry, commandId: nextCommandId("retry") })).toEqual(
      [],
    );
  });
});

describe("follow-up queue decider: pause and resume", () => {
  it("pauses and resumes only the causes the client showed", async () => {
    const paused = await apply(await queued(["a"]), {
      type: "thread.queue.hold",
      commandId: nextCommandId("pause"),
      threadId,
      createdAt: at(2),
    });
    const hold = queueOf(paused.model)?.hold;
    expect(hold).toEqual({
      reason: "paused",
      detail: null,
      causeKeys: [`paused:${at(2)}`],
      heldAt: at(2),
    });
    // A restart cause recorded meanwhile stays held after the client resumes what it saw.
    const restarted = await apply(paused.model, {
      type: "thread.queue.hold.record",
      commandId: nextCommandId("restart"),
      threadId,
      hold: { reason: "restart", causeKeys: ["restart:7"], detail: "Ryco restarted." },
      createdAt: at(3),
    });
    const resume = (keys: ReadonlyArray<string>): OrchestrationCommand => ({
      type: "thread.queue.resume",
      commandId: nextCommandId("resume"),
      threadId,
      acknowledgeCauseKeys: keys,
      createdAt: at(4),
    });
    const partly = await apply(restarted.model, resume(hold!.causeKeys));
    expect(types(partly.events)).toEqual(["thread.queue-held"]);
    expect(queueOf(partly.model)?.hold?.causeKeys).toEqual(["restart:7"]);
    const released = await apply(partly.model, resume(["restart:7"]));
    expect(released.events[0]?.payload).toMatchObject({ acknowledgedCauseKeys: ["restart:7"] });
    expect(queueOf(released.model)?.hold).toBeNull();
    expect(await decide(released.model, resume(["restart:7"]))).toEqual([]);
  });

  it("records nothing for a node hold on an empty queue or one it already covers", async () => {
    const record: OrchestrationCommand = {
      type: "thread.queue.hold.record",
      commandId: nextCommandId("record"),
      threadId,
      hold: { reason: "error", causeKeys: ["start-failed:x"], detail: "Failed." },
      createdAt: at(2),
    };
    expect(await decide(modelWith(), record)).toEqual([]);
    const held = await apply(await queued(["a"]), record);
    expect(await decide(held.model, { ...record, commandId: nextCommandId("record") })).toEqual([]);
  });
});

describe("follow-up queue decider: steer", () => {
  const steer = (messageId: string, expectedTurnId = runningTurn): OrchestrationCommand => ({
    type: "thread.queue.steer",
    commandId: nextCommandId("steer"),
    threadId,
    messageId: MessageId.make(messageId),
    expectedTurnId,
    createdAt: at(2),
  });

  it("sends a queued entry into the running turn and removes it once accepted", async () => {
    const model = await queued(["a", "b"], running);
    const steered = await apply(model, steer("a"));
    expect(types(steered.events)).toEqual([
      "thread.queue-entry-edited",
      "thread.turn-steer-requested",
    ]);
    expect(steered.events[1]?.payload).toMatchObject({
      expectedTurnId: runningTurn,
      message: { messageId: "a", text: "text a", role: "user" },
    });
    expect(queueOf(steered.model)?.entries[0]?.status).toBe("steering");
    // A steering entry is not edited or steered twice.
    expect(await decide(steered.model, steer("a"))).toEqual([]);

    const accepted = await apply(steered.model, {
      type: "thread.turn.steer.resolve",
      commandId: nextCommandId("resolve"),
      requestCommandId: steered.events[1]!.commandId!,
      threadId,
      expectedTurnId: runningTurn,
      message: { messageId: MessageId.make("a"), role: "user", text: "text a", attachments: [] },
      createdAt: at(2),
      requestedAt: at(2),
      resolution: { status: "accepted", turnId: runningTurn, resolvedAt: at(3) },
    });
    expect(types(accepted.events)).toEqual([
      "thread.message-sent",
      "thread.turn-steer-accepted",
      "thread.queue-entries-removed",
    ]);
    expect(accepted.events[2]?.payload).toMatchObject({ messageIds: ["a"], reason: "steered" });
  });

  it("adds nothing for a device's copy of an entry being steered or steered already", async () => {
    // A device queue moving to the node (design §3.7) may still hold an entry the node is
    // steering, or one its steer delivered: either way the add, hold included, is a no-op.
    const deviceHold = {
      reason: "interrupted" as const,
      causeKeys: ["interrupt:device-turn"],
      detail: null,
    };
    const steered = await apply(await queued(["a"], running), steer("a"));
    expect(await decide(steered.model, addCommand("a", { hold: deviceHold }))).toEqual([]);
    const accepted = await apply(steered.model, {
      type: "thread.turn.steer.resolve",
      commandId: nextCommandId("resolve"),
      requestCommandId: steered.events[1]!.commandId!,
      threadId,
      expectedTurnId: runningTurn,
      message: { messageId: MessageId.make("a"), role: "user", text: "text a", attachments: [] },
      createdAt: at(2),
      requestedAt: at(2),
      resolution: { status: "accepted", turnId: runningTurn, resolvedAt: at(3) },
    });
    expect(queueOf(accepted.model)).toBeUndefined();
    expect(await decide(accepted.model, addCommand("a", { hold: deviceHold }))).toEqual([]);
    // A second device's copy of an entry the first one moved over: no second entry either.
    const moved = await apply(accepted.model, addCommand("b"));
    expect(await decide(moved.model, addCommand("b", {}, { text: "second device" }))).toEqual([]);
    expect(queueOf(moved.model)?.entries.map((entry) => entry.messageId)).toEqual(["b"]);
  });

  it("returns a rejected steer to the queue, or fails it when delivery is uncertain", async () => {
    const steered = await apply(await queued(["a"], running), steer("a"));
    const reject = (deliveryUncertain: boolean): OrchestrationCommand => ({
      type: "thread.turn.steer.resolve",
      commandId: nextCommandId("resolve"),
      requestCommandId: steered.events[1]!.commandId!,
      threadId,
      expectedTurnId: runningTurn,
      message: { messageId: MessageId.make("a"), role: "user", text: "text a", attachments: [] },
      createdAt: at(2),
      requestedAt: at(2),
      resolution: {
        status: "rejected",
        error: "Steer failed.",
        deliveryUncertain,
        resolvedAt: at(3),
      },
    });
    const back = await apply(steered.model, reject(false));
    expect(queueOf(back.model)?.entries[0]).toMatchObject({ status: "queued", revision: 3 });
    const uncertain = await apply(steered.model, reject(true));
    expect(queueOf(uncertain.model)?.entries[0]).toMatchObject({
      status: "failed",
      revision: 3,
      failure: { reason: "steer-uncertain", detail: "Steer failed." },
    });
  });

  it("leaves the entry queued when the turn it targets is no longer running", async () => {
    expect(await decide(await queued(["a"], running), steer("a", TurnId.make("old")))).toEqual([]);
    expect(await decide(await queued(["a"]), steer("a"))).toEqual([]);
  });
});

describe("follow-up queue decider: dispatch", () => {
  const dispatch = (
    head: Pick<QueuedFollowUp, "messageId" | "revision">,
    overrides: Partial<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = {},
  ): OrchestrationCommand => ({
    type: "thread.turn.start",
    commandId: nextCommandId("queue-drain"),
    threadId,
    message: { messageId: head.messageId, role: "user", text: "text a", attachments: [] },
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    delegationReturnGuard: {
      latestUserMessageId: null,
      projectId,
      runtimeMode: "full-access",
      worktreePath: null,
      source: "follow-up-queue",
    },
    queueDispatch: { messageId: head.messageId, revision: head.revision },
    createdAt: at(5),
    ...overrides,
  });
  const a = { messageId: MessageId.make("a"), revision: 1 };

  it("sends the head with its own modes and removes it in the same batch", async () => {
    const model = await queued(["a", "b"]);
    const { events, model: next } = await apply(model, dispatch(a));
    expect(types(events)).toEqual([
      "thread.runtime-mode-set",
      "thread.interaction-mode-set",
      "thread.message-sent",
      "thread.turn-start-requested",
      "thread.queue-entries-removed",
    ]);
    expect(events[3]?.payload).toMatchObject({
      messageId: "a",
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(events[4]?.payload).toMatchObject({ messageIds: ["a"], reason: "dispatched" });
    expect(queueOf(next)?.entries.map((entry) => entry.messageId)).toEqual(["b"]);
  });

  it("refuses a stale revision, a head that moved, a held queue and more privilege", async () => {
    const model = await queued(["a", "b"]);
    expect((await refusal(model, dispatch({ ...a, revision: 2 }))).detail).toContain("changed");
    expect(
      (
        await refusal(
          model,
          dispatch(
            { messageId: MessageId.make("b"), revision: 1 },
            {
              message: { messageId: MessageId.make("b"), role: "user", text: "b", attachments: [] },
            },
          ),
        )
      ).detail,
    ).toContain("changed");
    const paused = await apply(model, {
      type: "thread.queue.hold",
      commandId: nextCommandId("pause"),
      threadId,
      createdAt: at(2),
    });
    expect((await refusal(paused.model, dispatch(a))).detail).toContain("paused");
    expect((await refusal(model, dispatch(a, { runtimeMode: "full-access" }))).detail).toContain(
      "more permissions",
    );
  });

  it("never lets an entry the person did not queue raise the chat's runtime mode", async () => {
    const { model } = await apply(
      modelWith({ runtimeMode: "approval-required" }),
      addCommand(
        "a",
        { author: "agent" } as Partial<Extract<OrchestrationCommand, { type: "thread.queue.add" }>>,
        { runtimeMode: "full-access" },
      ),
    );
    const guard = {
      latestUserMessageId: null,
      projectId,
      runtimeMode: "approval-required" as const,
      worktreePath: null,
      source: "follow-up-queue" as const,
    };
    expect(
      (
        await refusal(
          model,
          dispatch(a, { runtimeMode: "full-access", delegationReturnGuard: guard }),
        )
      ).detail,
    ).toContain("never raises");
    const lowered = await decide(
      model,
      dispatch(a, { runtimeMode: "approval-required", delegationReturnGuard: guard }),
    );
    expect(types(lowered)).toContain("thread.turn-start-requested");
    expect(types(lowered)).not.toContain("thread.runtime-mode-set");
  });

  it("lets a queued follow-up change the model, which other wakes may not", async () => {
    const model = await queued(["a"]);
    const claude = { instanceId: CLAUDE, model: "sonnet" };
    const events = await decide(model, dispatch(a, { modelSelection: claude }));
    expect(types(events)).toContain("thread.turn-start-requested");
    const watchWake = await refusal(
      model,
      dispatch(a, {
        modelSelection: claude,
        delegationReturnGuard: {
          latestUserMessageId: null,
          projectId,
          runtimeMode: "full-access",
          worktreePath: null,
          source: "pull-request-watch",
        },
      }),
    );
    expect(watchWake.detail).toContain("pull request update");
  });

  it("an older client's own send of a queued id takes it out of the queue", async () => {
    const model = await queued(["a"]);
    const { events, model: next } = await apply(model, {
      type: "thread.turn.start",
      commandId: nextCommandId("client-send"),
      threadId,
      message: { messageId: MessageId.make("a"), role: "user", text: "text a", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at(5),
    });
    expect(types(events).at(-1)).toBe("thread.queue-entries-removed");
    expect(queueOf(next)).toBeUndefined();
  });
});

describe("follow-up queue decider: holds other commands record", () => {
  const interrupt = (holdQueue: boolean): OrchestrationCommand => ({
    type: "thread.turn.interrupt",
    commandId: nextCommandId("interrupt"),
    threadId,
    turnId: runningTurn,
    ...(holdQueue ? { holdQueue: true as const } : {}),
    createdAt: at(6),
  });

  it("a person's Stop holds a non-empty queue in the interrupt's batch", async () => {
    const { events, model } = await apply(await queued(["a"], running), interrupt(true));
    expect(types(events)).toEqual(["thread.turn-interrupt-requested", "thread.queue-held"]);
    expect(queueOf(model)?.hold).toEqual({
      reason: "interrupted",
      detail: null,
      causeKeys: [`interrupt:${runningTurn}`],
      heldAt: at(6),
    });
    expect(types(await decide(await queued(["a"], running), interrupt(false)))).toEqual([
      "thread.turn-interrupt-requested",
    ]);
    expect(types(await decide(modelWith(running), interrupt(true)))).toEqual([
      "thread.turn-interrupt-requested",
    ]);
  });

  it("a usage limit holds the queue until it clears, unless the head targets another instance", async () => {
    const limited = {
      latestTurn: { ...running.latestTurn, state: "error" as const, completedAt: at(1) },
      session: { ...running.session, status: "ready" as const, activeTurnId: null },
    };
    const record: OrchestrationCommand = {
      type: "thread.usage-limit.record",
      commandId: nextCommandId("limit"),
      threadId,
      limitId: "limit-1",
      provider: "codex",
      providerInstanceId: CODEX,
      turnId: runningTurn,
      message: "Usage limit reached.",
      resetAt: null,
      createdAt: at(7),
    } as unknown as OrchestrationCommand;
    const held = await apply(await queued(["a"], limited), record);
    expect(queueOf(held.model)?.hold).toMatchObject({
      reason: "limit",
      causeKeys: [`limit:${runningTurn}`],
      detail: "Usage limit reached.",
    });
    // The user's resume (an accepted turn start) clears the limit, and with it its cause.
    const cleared = await apply(held.model, {
      type: "thread.turn.start",
      commandId: nextCommandId("resume"),
      threadId,
      message: {
        messageId: MessageId.make("resume"),
        role: "user",
        text: "Continue",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at(8),
    });
    expect(types(cleared.events)).toContain("thread.usage-limit-cleared");
    expect(types(cleared.events).at(-1)).toBe("thread.queue-released");
    expect(queueOf(cleared.model)?.hold).toBeNull();

    const otherInstance = await queued(["a"], limited);
    const recovering = otherInstance.threads[0]!.followUpQueue!.entries.map((entry) => ({
      ...entry,
      modelSelection: { instanceId: CLAUDE, model: "sonnet" },
    }));
    const exempt = await apply(
      {
        ...otherInstance,
        threads: [
          { ...otherInstance.threads[0]!, followUpQueue: { entries: recovering, hold: null } },
        ],
      },
      { ...record, commandId: nextCommandId("limit") },
    );
    expect(queueOf(exempt.model)?.hold).toBeNull();
  });

  it("a failed turn holds the queue; another instance's failure and a restart do not", async () => {
    const sessionSet = (
      status: "error" | "ready",
      lastError: string | null,
    ): OrchestrationCommand =>
      ({
        type: "thread.session.set",
        commandId: nextCommandId("session"),
        threadId,
        session: { ...running.session, status, activeTurnId: null, lastError, updatedAt: at(8) },
        createdAt: at(8),
      }) as OrchestrationCommand;
    const failed = await apply(await queued(["a"], running), sessionSet("error", "Provider died."));
    expect(queueOf(failed.model)?.hold).toMatchObject({
      reason: "error",
      causeKeys: [`error:${runningTurn}:Provider died.`],
      detail: "Provider died.",
    });
    // A repeated error session is no new failure.
    expect(types(await decide(failed.model, sessionSet("error", "Provider died.")))).toEqual([
      "thread.session-set",
    ]);
    const restart = await apply(
      await queued(["a"], running),
      sessionSet("error", ORPHANED_PROVIDER_SESSION_ERROR),
    );
    expect(queueOf(restart.model)?.hold).toBeNull();

    const recovering = await queued(["a"], running);
    const onClaude = {
      ...recovering,
      threads: [
        {
          ...recovering.threads[0]!,
          followUpQueue: {
            entries: recovering.threads[0]!.followUpQueue!.entries.map((entry) => ({
              ...entry,
              modelSelection: { instanceId: CLAUDE, model: "sonnet" },
            })),
            hold: null,
          },
        },
      ],
    };
    const exempt = await apply(onClaude, sessionSet("error", "Provider died."));
    expect(queueOf(exempt.model)?.hold).toBeNull();
  });

  it("Trash pauses the queue, a restore keeps the pause, and deletion ends it", async () => {
    const model = await queued(["a", "b"]);
    const trash = await apply(model, {
      type: "thread.trash",
      commandId: nextCommandId("trash"),
      threadId,
    } as OrchestrationCommand);
    expect(types(trash.events).at(-1)).toBe("thread.queue-held");
    const held = queueOf(trash.model);
    expect(held?.entries.map((entry) => entry.messageId)).toEqual(["a", "b"]);
    expect(held?.hold).toMatchObject({
      reason: "paused",
      detail: "The chat was moved to Trash.",
    });
    expect(held?.hold?.causeKeys[0]).toMatch(/^trash:/);
    expect((await refusal(trash.model, addCommand("c"))).detail).toContain("Trash");

    const restored = await apply(trash.model, {
      type: "thread.untrash",
      commandId: nextCommandId("untrash"),
      threadId,
    } as OrchestrationCommand);
    expect(queueOf(restored.model)).toEqual(held);

    const deleted = await apply(trash.model, {
      type: "thread.delete",
      commandId: nextCommandId("delete"),
      threadId,
    } as OrchestrationCommand);
    expect(types(deleted.events).slice(-2)).toEqual([
      "thread.queue-entries-removed",
      "thread.queue-released",
    ]);
    expect(deleted.events.at(-2)?.payload).toMatchObject({ reason: "thread-ended" });
    expect(queueOf(deleted.model)).toBeUndefined();
  });

  it("a person's Stop session holds a non-empty queue; the node's own stops do not", async () => {
    const stop = (commandId: CommandId): OrchestrationCommand => ({
      type: "thread.session.stop",
      commandId,
      threadId,
      createdAt: at(9),
    });
    const stopped = await apply(await queued(["a"], running), stop(nextCommandId("stop")));
    expect(types(stopped.events)).toEqual(["thread.session-stop-requested", "thread.queue-held"]);
    expect(queueOf(stopped.model)?.hold).toEqual({
      reason: "interrupted",
      detail: null,
      causeKeys: [`interrupt:${runningTurn}`],
      heldAt: at(9),
    });
    const nodeStop = await decide(
      await queued(["a"], running),
      stop(CommandId.make("server:archive-stop")),
    );
    expect(types(nodeStop)).toEqual(["thread.session-stop-requested"]);
    expect(types(await decide(modelWith(running), stop(nextCommandId("stop"))))).toEqual([
      "thread.session-stop-requested",
    ]);
  });
});
