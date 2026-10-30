import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type FollowUpQueueHold,
  type OrchestrationEvent,
  type OrchestrationThread,
  type QueuedFollowUp,
  type ServerConfig,
  type ThreadFollowUpQueue,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStore } from "zustand/vanilla";

import {
  makeQueueAppState,
  QUEUE_ENV,
  queueKey,
  queueRef,
  type ThreadFixture,
} from "../../../test/queueThreadFixtures.ts";
import {
  applyOrchestrationEvent,
  syncServerThreadDetail,
  type AppState,
} from "../threads/store.ts";
import {
  createMessageQueueDrainCoordinator,
  type MessageQueueDrainPlatform,
  type MessageQueueSender,
  type QueueEntryMoveContext,
} from "./coordinator.ts";
import {
  QUEUE_MIGRATION_FAILED_CAUSE_PREFIX,
  resolveQueueDrainStep,
  type QueueDrainInput,
} from "./drain.ts";
import { createInterruptQueueHold, type QueueHold } from "./hold.ts";
import type { QueuedMessage } from "./logic.ts";
import {
  addFollowUpToServerQueue,
  buildFollowUpQueueAddCommand,
  buildFollowUpQueueEditCommand,
  buildFollowUpQueueMoveCommand,
  buildFollowUpQueuePauseCommand,
  buildFollowUpQueueRemoveCommand,
  buildFollowUpQueueResumeCommand,
  buildFollowUpQueueRetryCommand,
  buildFollowUpQueueSteerCommand,
  createFollowUpQueuePendingStore,
  deriveFollowUpQueueView,
  describeEndedFollowUpQueueEdit,
  FOLLOW_UP_ON_ITS_WAY_REASON,
  followUpQueueRowOnItsWayReason,
  followUpSendWaitsForServerQueue,
  isFollowUpQueueWaiting,
  MOVED_FAILED_ENTRY_FAILURE,
  movedFollowUpQueueFailure,
  PENDING_FOLLOW_UP_VISIBLE_TIMEOUT_MS,
  resolveFollowUpQueueEditState,
  selectServerFollowUpQueueSupported,
  selectServerFollowUpQueueWaiting,
  selectThreadFollowUpQueue,
  shouldQueueFollowUpOnServer,
  summarizeQueuedFollowUp,
  toFollowUpQueueHoldInput,
  type FollowUpQueueAddCommand,
  type FollowUpQueueEntryContent,
  followUpQueueBadgeOf,
  followUpQueueEditAttachments,
  followUpQueueEditOf,
  withoutFollowUpQueueEditAttachment,
} from "./serverQueue.ts";
import { createMessageQueueStore } from "./store.ts";

const THREAD_ID = ThreadId.make("t");
const AT = "2026-10-01T10:00:00.000Z";
const CONTENT: FollowUpQueueEntryContent = {
  text: "Run the tests",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  tokenMode: "balanced",
};

function queued(id: string, overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp {
  return {
    messageId: MessageId.make(id),
    text: `text of ${id}`,
    attachments: [],
    modelSelection: { instanceId: "codex", model: "gpt-5" } as QueuedFollowUp["modelSelection"],
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
    status: "queued",
    author: "user",
    ...overrides,
  };
}

const HOLD: FollowUpQueueHold = {
  reason: "interrupted",
  detail: null,
  causeKeys: ["interrupt:turn-1"],
  heldAt: AT,
};

let sequence = 0;
function queueEvent(type: OrchestrationEvent["type"], payload: object): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: AT,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { threadId: THREAD_ID, ...payload },
  } as OrchestrationEvent;
}

describe("server follow-up queue commands", () => {
  const base = { commandId: CommandId.make("cmd"), threadId: THREAD_ID, createdAt: AT };

  it("reads the capability from the node's config only", () => {
    const config = (serverFollowUpQueue?: true) =>
      ({
        environment: { capabilities: serverFollowUpQueue ? { serverFollowUpQueue } : {} },
      }) as unknown as ServerConfig;
    expect(selectServerFollowUpQueueSupported(config(true))).toBe(true);
    expect(selectServerFollowUpQueueSupported(config())).toBe(false);
    expect(selectServerFollowUpQueueSupported(null)).toBe(false);
  });

  it("carries this device's choice to skip the Claude resume review, and only that", () => {
    const add = (skipClaudeResumeReview: boolean | undefined) =>
      buildFollowUpQueueAddCommand({
        ...base,
        messageId: MessageId.make("m-1"),
        content: { ...CONTENT, skipClaudeResumeReview },
      }).entry;
    expect(add(true).claudeResumeReview).toBe("skip");
    expect(add(false)).not.toHaveProperty("claudeResumeReview");
    expect(add(undefined)).not.toHaveProperty("claudeResumeReview");
  });

  it("queues under the entry's own message id with its modes and mentions", () => {
    const otherThread = ThreadId.make("other-thread");
    const command = buildFollowUpQueueAddCommand({
      ...base,
      messageId: MessageId.make("m-1"),
      content: { ...CONTENT, text: `Compare with @thread:${otherThread}`, tokenMode: undefined },
    });
    expect(command).toEqual({
      type: "thread.queue.add",
      commandId: "cmd",
      threadId: "t",
      entry: {
        messageId: "m-1",
        text: `Compare with @thread:${otherThread}`,
        modelSelection: CONTENT.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        threadReferences: [otherThread],
        attachments: [],
      },
      createdAt: AT,
    });
  });

  it("moves a device hold and failure over with an add", () => {
    const command = buildFollowUpQueueAddCommand({
      ...base,
      messageId: MessageId.make("m-1"),
      content: CONTENT,
      hold: createInterruptQueueHold("turn-1", AT),
      failure: MOVED_FAILED_ENTRY_FAILURE,
    });
    expect(command.hold).toEqual({
      reason: "interrupted",
      detail: null,
      causeKeys: ["interrupt:turn-1"],
    });
    expect(command.entry.failure).toEqual(MOVED_FAILED_ENTRY_FAILURE);
  });

  it("moves a device's known failure with its reason, the detail cut to the contract", () => {
    expect(movedFollowUpQueueFailure("steer-uncertain", "The provider may have it.")).toEqual({
      reason: "steer-uncertain",
      detail: "The provider may have it.",
    });
    const long = movedFollowUpQueueFailure("start-failed", "x".repeat(1_500));
    expect(long.detail).toHaveLength(1_000);
    expect(movedFollowUpQueueFailure("start-failed", null).detail).toBeNull();
  });

  it("queues a busy send on the node only when nothing of the device's queue goes first", () => {
    const ready = {
      serverQueueSupported: true,
      serverThread: true,
      mutationReady: true,
      deviceQueueLength: 0,
      deviceDispatchPending: false,
    };
    expect(shouldQueueFollowUpOnServer(ready)).toBe(true);
    expect(shouldQueueFollowUpOnServer({ ...ready, movable: true })).toBe(true);
    // An older node, a local draft, an environment that is not ready.
    expect(shouldQueueFollowUpOnServer({ ...ready, serverQueueSupported: false })).toBe(false);
    expect(shouldQueueFollowUpOnServer({ ...ready, serverThread: false })).toBe(false);
    expect(shouldQueueFollowUpOnServer({ ...ready, mutationReady: false })).toBe(false);
    // The device's own entries, or its send whose turn has not started, go first.
    expect(shouldQueueFollowUpOnServer({ ...ready, deviceQueueLength: 1 })).toBe(false);
    expect(shouldQueueFollowUpOnServer({ ...ready, deviceDispatchPending: true })).toBe(false);
    // A send the node's queue cannot carry.
    expect(shouldQueueFollowUpOnServer({ ...ready, movable: false })).toBe(false);
  });

  it("bounds a hold's cause keys and detail for the contract", () => {
    const hold: QueueHold = {
      reason: "error",
      detail: "x".repeat(2_000),
      causeKeys: [],
      heldAt: AT,
    };
    expect(toFollowUpQueueHoldInput(hold)).toEqual({
      reason: "error",
      detail: "x".repeat(1_000),
      causeKeys: [`device:error:${AT}`],
    });
    const many = toFollowUpQueueHoldInput({
      ...hold,
      causeKeys: Array.from({ length: 40 }, (_, index) => ` key-${index} `),
    });
    // The newest keys are kept; a long one (a provider error's text) is cut and hashed.
    expect(many.causeKeys).toHaveLength(32);
    expect(many.causeKeys[0]).toBe("key-8");
    const long = toFollowUpQueueHoldInput({
      ...hold,
      causeKeys: [`error:turn-1:${"y".repeat(900)}`],
    });
    expect(long.causeKeys[0]!.length).toBeLessThanOrEqual(512);
    expect(
      buildFollowUpQueueAddCommand({
        commandId: CommandId.make("cmd"),
        threadId: THREAD_ID,
        createdAt: AT,
        messageId: MessageId.make("m-1"),
        content: CONTENT,
        hold: { ...hold, causeKeys: [`error:turn-1:${"y".repeat(900)}`] },
      }).hold,
    ).toEqual(long);
  });

  it("edits at the revision the user saw, keeping stored attachments by id", () => {
    const command = buildFollowUpQueueEditCommand({
      ...base,
      entry: { messageId: MessageId.make("m-1"), revision: 3 },
      content: CONTENT,
      keptAttachmentIds: ["att-1" as never],
    });
    expect(command).toMatchObject({
      type: "thread.queue.edit",
      messageId: "m-1",
      expectedRevision: 3,
      text: "Run the tests",
      tokenMode: "balanced",
      attachments: [],
      keptAttachmentIds: ["att-1"],
    });
    expect(
      buildFollowUpQueueEditCommand({
        ...base,
        entry: { messageId: MessageId.make("m-1"), revision: 3 },
        content: CONTENT,
        keptAttachmentIds: [],
      }),
    ).not.toHaveProperty("keptAttachmentIds");
  });

  it("maps up and down moves to the entry each goes before", () => {
    const entries = ["a", "b", "c"].map((id) => ({ messageId: MessageId.make(id) }));
    const move = (id: string, direction: "up" | "down") =>
      buildFollowUpQueueMoveCommand({ ...base, entries, messageId: MessageId.make(id), direction })
        ?.beforeMessageId;
    expect(move("b", "up")).toBe("a");
    expect(move("a", "down")).toBe("c");
    expect(move("b", "down")).toBeNull();
    expect(move("a", "up")).toBeUndefined();
    expect(move("c", "down")).toBeUndefined();
    expect(move("gone", "up")).toBeUndefined();
  });

  it("maps remove, steer, pause, resume and retry", () => {
    const messageId = MessageId.make("m-1");
    expect(buildFollowUpQueueRemoveCommand({ ...base, messageIds: [messageId] })).toEqual({
      type: "thread.queue.remove",
      commandId: "cmd",
      threadId: "t",
      messageIds: ["m-1"],
      createdAt: AT,
    });
    expect(
      buildFollowUpQueueSteerCommand({ ...base, messageId, expectedTurnId: TurnId.make("turn-1") }),
    ).toMatchObject({ type: "thread.queue.steer", messageId: "m-1", expectedTurnId: "turn-1" });
    expect(buildFollowUpQueuePauseCommand(base)).toEqual({
      type: "thread.queue.hold",
      commandId: "cmd",
      threadId: "t",
      createdAt: AT,
    });
    expect(buildFollowUpQueueResumeCommand({ ...base, hold: HOLD })).toMatchObject({
      type: "thread.queue.resume",
      acknowledgeCauseKeys: ["interrupt:turn-1"],
    });
    expect(buildFollowUpQueueRetryCommand({ ...base, messageId })).toMatchObject({
      type: "thread.queue.retry",
      messageId: "m-1",
    });
  });
});

describe("editing the node's queued entry", () => {
  const entry = {
    messageId: "m-1" as MessageId,
    revision: 3,
    attachments: [
      { type: "image", id: "img-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
      { type: "file", id: "file-1", name: "notes.md", mimeType: "text/markdown", sizeBytes: 2 },
      { type: "image", name: "unstored.png" },
    ] as unknown as QueuedFollowUp["attachments"],
  };

  it("edits at the revision shown, keeping the entry's stored attachments by id", () => {
    expect(followUpQueueEditOf("env:t", entry)).toEqual({
      threadKey: "env:t",
      messageId: "m-1",
      revision: 3,
      keptAttachmentIds: ["img-1", "file-1"],
    });
  });

  it("shows the stored attachments it keeps, and drops one the person removes", () => {
    const edit = followUpQueueEditOf("env:t", entry);
    expect(followUpQueueEditAttachments(edit, entry)).toEqual([
      { id: "img-1", name: "a.png", kind: "image" },
      { id: "file-1", name: "notes.md", kind: "file" },
    ]);
    const dropped = withoutFollowUpQueueEditAttachment(edit, "img-1");
    expect(dropped.keptAttachmentIds).toEqual(["file-1"]);
    expect(followUpQueueEditAttachments(dropped, entry)).toEqual([
      { id: "file-1", name: "notes.md", kind: "file" },
    ]);
    // The entry left the queue meanwhile: nothing to show.
    expect(followUpQueueEditAttachments(dropped, undefined)).toEqual([]);
  });
});

describe("follow-up queue badge", () => {
  const hold = {
    reason: "interrupted" as const,
    detail: null,
    causeKeys: ["interrupt:turn-1"],
    heldAt: "2026-10-24T10:00:00.000Z",
  };

  it("counts queued follow-ups, and says why nothing goes out", () => {
    expect(followUpQueueBadgeOf(undefined)).toBeNull();
    expect(followUpQueueBadgeOf({ count: 1, hold: null, headStatus: "queued" })).toEqual({
      label: "1 queued",
      title: "1 queued follow-up",
      held: false,
    });
    expect(followUpQueueBadgeOf({ count: 3, hold, headStatus: "queued" })).toEqual({
      label: "3 queued",
      title: "3 queued follow-ups: Paused after Stop",
      held: true,
    });
    expect(followUpQueueBadgeOf({ count: 2, hold: null, headStatus: "failed" })?.title).toBe(
      "2 queued follow-ups: The next one waits for Retry",
    );
  });
});

describe("server follow-up queue view", () => {
  it("shows a device entry whose add is on its way as moving, which refuses Edit and Steer", () => {
    const view = deriveFollowUpQueueView({
      server: null,
      pending: [{ messageId: "p-1", summary: "Sent while busy", createdAt: AT }],
      local: [
        { id: "q-1", summary: "Moving", steering: false, moving: true },
        {
          id: "q-2",
          summary: "Failed, moving",
          deliveryStatus: "failed",
          steering: false,
          moving: true,
        },
        { id: "q-3", summary: "Waiting", steering: false },
      ],
      localHold: null,
    });
    expect(view.rows.map((row) => [row.id, row.status])).toEqual([
      ["p-1", "queuing"],
      ["q-1", "moving"],
      ["q-2", "moving"],
      ["q-3", "queued"],
    ]);
    expect(view.rows.map(followUpQueueRowOnItsWayReason)).toEqual([
      FOLLOW_UP_ON_ITS_WAY_REASON,
      FOLLOW_UP_ON_ITS_WAY_REASON,
      FOLLOW_UP_ON_ITS_WAY_REASON,
      null,
    ]);
  });

  it("shows the node's entries and hold, head first, with their status", () => {
    const view = deriveFollowUpQueueView({
      server: {
        entries: [
          queued("a"),
          queued("b", { status: "steering" }),
          queued("c", {
            status: "failed",
            failure: { reason: "steer-uncertain", detail: "Maybe delivered." },
          }),
          queued("d", { author: "agent" }),
        ],
        hold: HOLD,
      },
      pending: [],
      local: [],
      localHold: null,
    });
    expect(view.rows.map((row) => [row.id, row.source, row.status, row.failureDetail])).toEqual([
      ["a", "server", "queued", null],
      ["b", "server", "steering", null],
      ["c", "server", "failed", "Maybe delivered."],
      ["d", "server", "queued", null],
    ]);
    expect(view.rows[3]!.author).toBe("agent");
    expect(view.hold).toEqual(HOLD);
    expect(view.holdSource).toBe("server");
  });

  it("shows an add as queuing until its entry or its message arrives", () => {
    const pending = [
      { messageId: "p-1", summary: "Queued text", createdAt: AT },
      { messageId: "p-2", summary: "Sent already", createdAt: AT },
      { messageId: "p-3", summary: "Arrived", createdAt: AT },
    ];
    const view = deriveFollowUpQueueView({
      server: { entries: [queued("p-3")], hold: null },
      pending,
      projectedMessageIds: new Set(["p-2"]),
      local: [],
      localHold: null,
    });
    expect(view.rows.map((row) => [row.id, row.source, row.status])).toEqual([
      ["p-3", "server", "queued"],
      ["p-1", "pending", "queuing"],
    ]);
  });

  it("shows device entries after the node's, once each, with the device hold", () => {
    const localHold = createInterruptQueueHold("turn-1", AT);
    const view = deriveFollowUpQueueView({
      server: { entries: [queued("moved")], hold: null },
      pending: [],
      local: [
        { id: "moved", summary: "moved", steering: false },
        { id: "l-1", summary: "local one", deliveryStatus: "sending", steering: false },
        { id: "l-2", summary: "local two", deliveryStatus: "failed", steering: false },
        { id: "l-3", summary: "local three", steering: true },
      ],
      localHold,
    });
    expect(view.rows.map((row) => [row.id, row.source, row.status])).toEqual([
      ["moved", "server", "queued"],
      ["l-1", "local", "sending"],
      ["l-2", "local", "failed"],
      ["l-3", "local", "steering"],
    ]);
    expect(view.hold).toBe(localHold);
    expect(view.holdSource).toBe("local");
  });

  it("is empty without entries, whatever a stale hold says", () => {
    const view = deriveFollowUpQueueView({
      server: null,
      pending: [],
      local: [],
      localHold: null,
    });
    expect(view.rows).toEqual([]);
    expect(view.hold).toBeNull();
  });

  it("summarizes an entry without its effort prefix, or by its attachments", () => {
    expect(summarizeQueuedFollowUp({ text: "Ultrathink:\nPlan it", attachments: [] })).toBe(
      "Plan it",
    );
    expect(
      summarizeQueuedFollowUp({
        text: "",
        attachments: [
          { type: "image", id: "i", name: "i.png", mimeType: "image/png", sizeBytes: 1 },
        ] as QueuedFollowUp["attachments"],
      }),
    ).toBe("1 image");
    expect(
      summarizeQueuedFollowUp({
        text: "",
        attachments: [
          { type: "file", id: "f", name: "f.txt", mimeType: "text/plain", sizeBytes: 1 },
        ] as QueuedFollowUp["attachments"],
      }),
    ).toBe("1 file");
  });
});

describe("optimistic follow-up adds", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function addCommand(): FollowUpQueueAddCommand {
    return buildFollowUpQueueAddCommand({
      commandId: CommandId.make("cmd"),
      threadId: THREAD_ID,
      createdAt: AT,
      messageId: MessageId.make("m-1"),
      content: CONTENT,
    });
  }

  it("shows the add as queuing until its entry arrives", async () => {
    const pendingStore = createFollowUpQueuePendingStore();
    const listeners = new Set<() => void>();
    let visible = false;
    let accept!: () => void;
    const result = addFollowUpToServerQueue({
      pendingStore,
      threadKey: "k",
      command: addCommand(),
      summary: "Run the tests",
      dispatch: () => new Promise<void>((resolve) => (accept = resolve)),
      isVisible: () => visible,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    expect(pendingStore.getState().pendingByThreadKey.k).toEqual([
      { messageId: "m-1", summary: "Run the tests", createdAt: AT },
    ]);
    accept();
    await expect(result).resolves.toEqual({ kind: "queued" });
    expect(pendingStore.getState().pendingByThreadKey.k).toHaveLength(1);
    visible = true;
    for (const listener of listeners) listener();
    expect(pendingStore.getState().pendingByThreadKey.k).toBeUndefined();
    expect(listeners.size).toBe(0);
  });

  it("drops an accepted add that never shows up after a while", async () => {
    const pendingStore = createFollowUpQueuePendingStore();
    await addFollowUpToServerQueue({
      pendingStore,
      threadKey: "k",
      command: addCommand(),
      summary: "Run the tests",
      dispatch: async () => undefined,
      isVisible: () => false,
      subscribe: () => () => undefined,
    });
    expect(pendingStore.getState().pendingByThreadKey.k).toHaveLength(1);
    vi.advanceTimersByTime(PENDING_FOLLOW_UP_VISIBLE_TIMEOUT_MS);
    expect(pendingStore.getState().pendingByThreadKey.k).toBeUndefined();
  });

  async function addFailingWith(error: unknown) {
    const pendingStore = createFollowUpQueuePendingStore();
    const result = await addFollowUpToServerQueue({
      pendingStore,
      threadKey: "k",
      command: addCommand(),
      summary: "Run the tests",
      dispatch: async () => {
        throw error;
      },
      isVisible: () => false,
      subscribe: () => () => undefined,
    });
    return { result, pending: pendingStore.getState().pendingByThreadKey.k };
  }

  it("returns the node's refusal and drops its row", async () => {
    const refusal = new OrchestrationDispatchCommandError({
      message: "The queue is full (20 follow-ups).",
    });
    const { result, pending } = await addFailingWith(refusal);
    expect(result).toEqual({ kind: "refused", error: refusal });
    expect(pending).toBeUndefined();
  });

  it("reports an add whose reply was lost as unknown, never as refused", async () => {
    // A direct connection without dispatch replay: the node may have committed the add.
    const lost = new Error("The connection closed before the node answered.");
    const { result, pending } = await addFailingWith(lost);
    expect(result).toEqual({ kind: "unknown", error: lost });
    expect(pending).toBeUndefined();
  });
});

describe("follow-up queue in the threads store", () => {
  const environmentId = EnvironmentId.make("env-store");
  const ref = { environmentId, threadId: THREAD_ID };

  function detail(followUpQueue?: ThreadFollowUpQueue): OrchestrationThread {
    return {
      id: THREAD_ID,
      projectId: ProjectId.make("p"),
      title: "Thread",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
      ...(followUpQueue ? { followUpQueue } : {}),
    } as unknown as OrchestrationThread;
  }

  function apply(state: AppState, event: OrchestrationEvent): AppState {
    return applyOrchestrationEvent(state, event, environmentId);
  }

  const empty: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };

  it("keeps the detail's queue and follows its events like the node", () => {
    let state = syncServerThreadDetail(
      empty,
      detail({ entries: [queued("a"), queued("b")], hold: null }),
      environmentId,
    );
    const shellBefore = state.environmentStateById[environmentId]!.threadShellById[THREAD_ID];
    const ids = () => selectThreadFollowUpQueue(state, ref)?.entries.map((e) => e.messageId);
    expect(ids()).toEqual(["a", "b"]);

    state = apply(
      state,
      queueEvent("thread.queue-entry-added", { entry: queued("c"), beforeMessageId: "b" }),
    );
    expect(ids()).toEqual(["a", "c", "b"]);
    // A replayed add keeps its place.
    state = apply(
      state,
      queueEvent("thread.queue-entry-added", {
        entry: queued("c", { text: "again" }),
        beforeMessageId: null,
      }),
    );
    expect(ids()).toEqual(["a", "c", "b"]);
    state = apply(
      state,
      queueEvent("thread.queue-entry-edited", { entry: queued("a", { revision: 2, text: "new" }) }),
    );
    expect(selectThreadFollowUpQueue(state, ref)?.entries[0]).toMatchObject({
      revision: 2,
      text: "new",
    });
    state = apply(
      state,
      queueEvent("thread.queue-reordered", { order: ["b", "a", "c"], updatedAt: AT }),
    );
    expect(ids()).toEqual(["b", "a", "c"]);
    state = apply(
      state,
      queueEvent("thread.queue-entry-failed", {
        messageId: "a",
        revision: 3,
        failure: { reason: "steer-uncertain", detail: null },
        updatedAt: AT,
      }),
    );
    expect(selectThreadFollowUpQueue(state, ref)?.entries[1]).toMatchObject({
      status: "failed",
      revision: 3,
    });
    state = apply(state, queueEvent("thread.queue-held", { hold: HOLD, updatedAt: AT }));
    expect(selectThreadFollowUpQueue(state, ref)?.hold).toEqual(HOLD);
    state = apply(
      state,
      queueEvent("thread.queue-entries-removed", {
        messageIds: ["b", "a", "c"],
        reason: "dispatched",
        updatedAt: AT,
      }),
    );
    expect(ids()).toEqual([]);
    state = apply(
      state,
      queueEvent("thread.queue-released", {
        acknowledgedCauseKeys: HOLD.causeKeys,
        updatedAt: AT,
      }),
    );
    // Empty and unheld: absent, as on the node.
    expect(selectThreadFollowUpQueue(state, ref)).toBeNull();
    // Queue events are not thread activity.
    expect(state.environmentStateById[environmentId]!.threadShellById[THREAD_ID]).toBe(shellBefore);
  });

  it("keeps the queue's identity when a detail snapshot repeats it", () => {
    const queue = { entries: [queued("a")], hold: null };
    const first = syncServerThreadDetail(empty, detail(queue), environmentId);
    const again = syncServerThreadDetail(
      first,
      detail(structuredClone(queue) as ThreadFollowUpQueue),
      environmentId,
    );
    expect(selectThreadFollowUpQueue(again, ref)).toBe(selectThreadFollowUpQueue(first, ref));
    const cleared = syncServerThreadDetail(again, detail(), environmentId);
    expect(selectThreadFollowUpQueue(cleared, ref)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Moving a device queue to the node (design §3.7)
// ---------------------------------------------------------------------------

type Entry = QueuedMessage<{ text: string; computerUse?: boolean }, Record<string, never>>;

const KEY = queueKey("t");
const IDLE: ThreadFixture = {
  id: "t",
  session: { status: "ready" },
  latestTurn: { turnId: "turn-1", state: "completed" },
  messageIds: ["m-0"],
};
const RUNNING: ThreadFixture = {
  id: "t",
  session: { status: "running", activeTurnId: "turn-1" },
  latestTurn: { turnId: "turn-1", state: "running" },
  messageIds: ["m-0"],
};

function entry(id: string, extra: Partial<Entry> = {}): Entry {
  return { id, composer: { text: id }, settings: {}, ...extra };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

/**
 * The node's side of `thread.queue.add`, with the decider's idempotence: an id already queued
 * or already a message of the thread succeeds without a change.
 */
function fakeNode() {
  const queue: Array<{ id: string; failed: boolean; hold: QueueHold | null }> = [];
  const messages = new Set<string>();
  let reject: Error | null = null;
  const add = (id: string, context: QueueEntryMoveContext) => {
    if (reject) throw reject;
    if (queue.some((item) => item.id === id) || messages.has(id)) return "no-op";
    queue.push({ id, failed: context.failed, hold: context.hold });
    return "added";
  };
  return {
    queue,
    messages,
    add,
    ids: () => queue.map((item) => item.id),
    rejectWith: (error: Error | null) => {
      reject = error;
    },
  };
}

function setupMove(
  options: {
    thread?: ThreadFixture;
    node?: ReturnType<typeof fakeNode>;
    serverQueue?: boolean;
    mutationReady?: boolean;
    /** The node's queue in the thread's detail. */
    nodeQueue?: ThreadFollowUpQueue;
    addPending?: () => boolean;
  } = {},
) {
  const threads = createStore<AppState>(() =>
    makeQueueAppState(
      [options.thread ?? RUNNING],
      options.nodeQueue ? { followUpQueueByThreadId: { [THREAD_ID]: options.nodeQueue } } : {},
    ),
  );
  const queue = createMessageQueueStore<Entry["composer"], Record<string, never>>();
  const node = options.node ?? fakeNode();
  let serverQueue = options.serverQueue ?? true;
  let mutationReady = options.mutationReady ?? true;
  const readinessListeners = new Set<() => void>();
  const moves: Array<{ id: string; context: QueueEntryMoveContext }> = [];
  let gate: Promise<void> | null = null;
  const sent: string[] = [];
  const background: MessageQueueSender<Entry["composer"], Record<string, never>> = {
    send: vi.fn(async (queuedEntry: Entry, hooks) => {
      sent.push(queuedEntry.id);
      hooks.onBeforeTurnStart();
      return { kind: "accepted" as const };
    }),
  };
  const platform = {
    threads: {
      getState: threads.getState,
      subscribe: (listener: () => void) => threads.subscribe(listener),
    },
    readEnvironment: vi.fn(() => ({ shellLive: true, mutationReady, serverQueue })),
    subscribeEnvironmentReadiness: (listener: () => void) => {
      readinessListeners.add(listener);
      return () => readinessListeners.delete(listener);
    },
    resolveSender: vi.fn((_key: string, view: { started: boolean } | null) =>
      view?.started ? { kind: "background" as const, sender: background } : null,
    ),
    headProviderInstanceId: () => "codex",
    onEntryRemoved: vi.fn(),
    moveEntryToServer: vi.fn(async (_key: string, moved: Entry, context: QueueEntryMoveContext) => {
      moves.push({ id: moved.id, context });
      if (gate) await gate;
      if (!mutationReady) throw new Error("The connection closed.");
      node.add(moved.id, context);
    }),
    isEntryMovable: (candidate: Entry) => candidate.composer.computerUse !== true,
    onServerQueueMigrated: vi.fn(),
    isServerQueueAddPending: () => options.addPending?.() ?? false,
  } satisfies MessageQueueDrainPlatform<Entry["composer"], Record<string, never>>;
  const coordinator = createMessageQueueDrainCoordinator(queue, platform);
  const release = coordinator.retain();
  const notifyReadiness = () => {
    for (const listener of readinessListeners) listener();
  };
  return {
    threads,
    queue,
    node,
    moves,
    sent,
    platform,
    coordinator,
    release,
    localIds: () => (queue.getState().queuesByThreadKey[KEY] ?? []).map((item) => item.id),
    holdGate: () => {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
    setMutationReady: (ready: boolean) => {
      mutationReady = ready;
      notifyReadiness();
    },
    setServerQueue: (supported: boolean) => {
      serverQueue = supported;
      notifyReadiness();
    },
  };
}

describe("moving a device queue to the node", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("moves every entry in order under its own id, dropping each only once acknowledged", async () => {
    const f = setupMove();
    const openGate = f.holdGate();
    for (const id of ["q-1", "q-2", "q-3"]) f.queue.getState().enqueue(KEY, entry(id));
    await flush();
    // The first add is on its way: nothing has left the device yet.
    expect(f.moves.map((move) => move.id)).toEqual(["q-1"]);
    expect(f.localIds()).toEqual(["q-1", "q-2", "q-3"]);
    expect(f.coordinator.inspect(KEY).inFlightMessageId).toBe("q-1");
    openGate();
    await flush();
    expect(f.node.ids()).toEqual(["q-1", "q-2", "q-3"]);
    expect(f.localIds()).toEqual([]);
    expect(f.sent).toEqual([]);
    expect(f.platform.onEntryRemoved).toHaveBeenCalledTimes(3);
    expect(f.platform.onServerQueueMigrated).toHaveBeenCalledWith(QUEUE_ENV);
    expect(f.coordinator.inspect(KEY).inFlightMessageId).toBeNull();
  });

  it("moves a failed entry as failed and a held queue with its hold", async () => {
    const f = setupMove();
    const hold = createInterruptQueueHold("turn-1", AT);
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    // Held by a Stop, and the head's send failed (it may have been delivered).
    f.queue.getState().hold(KEY, hold);
    expect(f.queue.getState().beginSend(KEY, "q-1")).toBe(true);
    f.queue.getState().finishSend(KEY, "q-1", false);
    await flush();
    expect(f.node.queue).toEqual([
      { id: "q-1", failed: true, hold },
      { id: "q-2", failed: false, hold },
    ]);
    expect(f.localIds()).toEqual([]);
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
  });

  it("resumes a move cut short by a lost connection from the entry it stopped at", async () => {
    const f = setupMove();
    const openGate = f.holdGate();
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    // The connection drops while the first add is on its way; its reply never comes.
    f.setMutationReady(false);
    openGate();
    await flush();
    expect(f.localIds()).toEqual(["q-1", "q-2"]);
    expect(f.node.ids()).toEqual([]);
    // Not a failure: no hold, and nothing is sent from the device meanwhile.
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    expect(f.sent).toEqual([]);

    f.setMutationReady(true);
    await flush();
    expect(f.node.ids()).toEqual(["q-1", "q-2"]);
    expect(f.localIds()).toEqual([]);
  });

  it("drops an entry whose add the node already has, without a second copy", async () => {
    const node = fakeNode();
    // A reply lost on an earlier connect: the node queued q-1 already.
    node.add("q-1", { hold: null, failed: false });
    const f = setupMove({ node });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    expect(node.ids()).toEqual(["q-1", "q-2"]);
    expect(f.localIds()).toEqual([]);
  });

  it("drops an entry whose send went through meanwhile: the node has it as a message", async () => {
    const f = setupMove();
    f.node.messages.add("q-1");
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    expect(f.node.ids()).toEqual(["q-2"]);
    expect(f.localIds()).toEqual([]);
  });

  it("keeps one copy when a second device moves an overlapping queue", async () => {
    const node = fakeNode();
    const first = setupMove({ node });
    const second = setupMove({ node });
    first.queue.getState().enqueue(KEY, entry("q-1"));
    first.queue.getState().enqueue(KEY, entry("q-2"));
    second.queue.getState().enqueue(KEY, entry("q-2"));
    second.queue.getState().enqueue(KEY, entry("q-3"));
    await flush();
    expect(node.ids().toSorted()).toEqual(["q-1", "q-2", "q-3"]);
    expect(first.localIds()).toEqual([]);
    expect(second.localIds()).toEqual([]);
  });

  it("holds the device queue with the node's answer when it refuses an entry, until Resume", async () => {
    const f = setupMove();
    f.node.rejectWith(new Error("The queue is full (20 follow-ups)."));
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    const hold = f.queue.getState().holdsByThreadKey[KEY];
    expect(hold).toMatchObject({
      reason: "error",
      detail: "The queue is full (20 follow-ups).",
    });
    expect(hold?.causeKeys[0]?.startsWith(QUEUE_MIGRATION_FAILED_CAUSE_PREFIX)).toBe(true);
    // No retry loop while held.
    await flush();
    expect(f.moves).toHaveLength(1);

    f.node.rejectWith(null);
    f.coordinator.resume(KEY);
    await flush();
    expect(f.node.ids()).toEqual(["q-1"]);
    expect(f.localIds()).toEqual([]);
  });

  it("waits for the device's own send to start before moving the rest", async () => {
    const f = setupMove({ thread: IDLE, serverQueue: false });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    // An older node: the device sends its head as a turn.
    expect(f.sent).toEqual(["q-1"]);
    expect(f.coordinator.inspect(KEY).pendingDispatch?.messageId).toBe("q-1");

    // The node now keeps queues; q-1's turn has not started yet.
    f.setServerQueue(true);
    await flush();
    expect(f.moves).toEqual([]);
    expect(f.localIds()).toEqual(["q-2"]);

    f.threads.setState(() =>
      makeQueueAppState([
        {
          ...RUNNING,
          latestTurn: { turnId: "turn-2", state: "running" },
          session: { status: "running", activeTurnId: "turn-2" },
          messageIds: ["m-0", "q-1"],
        },
      ]),
    );
    await flush();
    expect(f.node.ids()).toEqual(["q-2"]);
    expect(f.localIds()).toEqual([]);
    expect(f.sent).toEqual(["q-1"]);
  });

  it("marks each entry while its add is on its way, entry by entry", async () => {
    const f = setupMove();
    const marks: Array<string | null> = [];
    f.coordinator.subscribeMoving(() => marks.push(f.coordinator.inspect(KEY).movingMessageId));
    const openGate = f.holdGate();
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    // q-1's add is on its way: it must not be edited or steered; q-2 may still be.
    expect(f.coordinator.inspect(KEY).movingMessageId).toBe("q-1");
    openGate();
    await flush();
    expect(marks).toEqual(["q-1", null, "q-2", null]);
    expect(f.coordinator.inspect(KEY).movingMessageId).toBeNull();
    expect(f.node.ids()).toEqual(["q-1", "q-2"]);
  });

  it("clears the mark of an entry the node refused", async () => {
    const f = setupMove();
    f.node.rejectWith(new Error("Refused."));
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.coordinator.inspect(KEY).movingMessageId).toBeNull();
    expect(f.localIds()).toEqual(["q-1"]);
  });

  it("keeps a head the node cannot carry behind the node's own queue", async () => {
    const f = setupMove({
      thread: IDLE,
      nodeQueue: { entries: [queued("node-head")], hold: null },
    });
    f.queue.getState().enqueue(KEY, entry("q-1", { composer: { text: "q-1", computerUse: true } }));
    await flush();
    // The node is about to send its head; a turn of the device's own would jump ahead of it.
    expect(f.sent).toEqual([]);
    expect(f.coordinator.inspect(KEY).lastStep).toEqual({ kind: "wait", reason: "server-queue" });

    f.threads.setState(() => makeQueueAppState([IDLE]));
    await flush();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("keeps a head the node cannot carry behind an add still on its way", async () => {
    let pending = true;
    const f = setupMove({ thread: IDLE, addPending: () => pending });
    f.queue.getState().enqueue(KEY, entry("q-1", { composer: { text: "q-1", computerUse: true } }));
    await flush();
    expect(f.sent).toEqual([]);
    pending = false;
    f.coordinator.evaluate(KEY);
    await flush();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("sends from the device what the node's queue cannot carry, then moves the rest", async () => {
    const f = setupMove({ thread: IDLE });
    f.queue.getState().enqueue(KEY, entry("q-1", { composer: { text: "q-1", computerUse: true } }));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    expect(f.moves).toEqual([]);
  });

  it("leaves an unstarted thread's queue to the device's own first send", () => {
    const step = resolveQueueDrainStep({
      nowIso: AT,
      queue: [{ id: "q-1" }],
      steerAttempts: {},
      hold: null,
      acknowledgedCauseKeys: [],
      headProviderInstanceId: "codex",
      view: {
        ref: { environmentId: QUEUE_ENV, threadId: THREAD_ID },
        started: false,
        archived: false,
        detailLoaded: true,
        running: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        session: null,
        latestTurn: null,
        latestTurnPlaceholderCheckpoint: false,
        projectedMessageIds: new Set(),
        turnStartFailures: [],
        steerRejectionsByActivityId: new Map(),
        turnStartCancelledMessageIds: new Set(),
      },
      draft: false,
      environment: { shellLive: true, mutationReady: true, serverQueue: true },
      pendingDispatch: null,
      dispatchedMessageIds: new Set(),
      sender: "foreground",
    });
    expect(step).toEqual({ kind: "send", messageId: "q-1", sender: "foreground" });
  });

  it("keeps the device queue and sends it as before on a node without the capability", async () => {
    const f = setupMove({ thread: IDLE, serverQueue: false });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    expect(f.moves).toEqual([]);
    expect(f.platform.onServerQueueMigrated).not.toHaveBeenCalled();
  });
});

describe("sends while the node is about to send its queue", () => {
  const REF = queueRef("t");
  const queue = (entries: QueuedFollowUp[], hold: FollowUpQueueHold | null = null) => ({
    entries,
    hold,
  });

  it("waits for a queue with an unheld head that can go", () => {
    expect(isFollowUpQueueWaiting(queue([queued("a")]))).toBe(true);
    expect(isFollowUpQueueWaiting(queue([queued("a")], HOLD))).toBe(false);
    expect(isFollowUpQueueWaiting(queue([queued("a", { status: "failed" })]))).toBe(false);
    expect(isFollowUpQueueWaiting(queue([queued("a", { status: "steering" })]))).toBe(false);
    expect(isFollowUpQueueWaiting(queue([]))).toBe(false);
    expect(isFollowUpQueueWaiting(null)).toBe(false);
  });

  it("reads the thread's live queue once its detail is loaded, else its shell summary", () => {
    const withDetail = (followUpQueue?: ThreadFollowUpQueue) =>
      makeQueueAppState(
        [{ id: "t", session: { status: "ready" }, messageIds: ["m-0"] }],
        followUpQueue ? { followUpQueueByThreadId: { [THREAD_ID]: followUpQueue } } : {},
      );
    expect(selectServerFollowUpQueueWaiting(withDetail(queue([queued("a")])), REF)).toBe(true);
    expect(selectServerFollowUpQueueWaiting(withDetail(queue([queued("a")], HOLD)), REF)).toBe(
      false,
    );
    expect(selectServerFollowUpQueueWaiting(withDetail(), REF)).toBe(false);

    const shellOnly = (summary: object) =>
      makeQueueAppState([
        {
          id: "t",
          session: { status: "ready" },
          summary: { followUpQueueSummary: summary } as never,
        },
      ]);
    const summary = { count: 1, hold: null, headStatus: "queued", headPreview: "a" };
    expect(selectServerFollowUpQueueWaiting(shellOnly(summary), REF)).toBe(true);
    expect(selectServerFollowUpQueueWaiting(shellOnly({ ...summary, hold: HOLD }), REF)).toBe(
      false,
    );
    expect(
      selectServerFollowUpQueueWaiting(shellOnly({ ...summary, headStatus: "failed" }), REF),
    ).toBe(false);
    expect(selectServerFollowUpQueueWaiting(makeQueueAppState([{ id: "t" }]), REF)).toBe(false);
  });

  it("queues a send behind the node's queue or an add still on its way", () => {
    const supported = { serverQueueSupported: true, queueWaiting: false, pendingAdds: 0 };
    expect(followUpSendWaitsForServerQueue(supported)).toBe(false);
    expect(followUpSendWaitsForServerQueue({ ...supported, queueWaiting: true })).toBe(true);
    expect(followUpSendWaitsForServerQueue({ ...supported, pendingAdds: 1 })).toBe(true);
    expect(
      followUpSendWaitsForServerQueue({
        ...supported,
        serverQueueSupported: false,
        pendingAdds: 1,
      }),
    ).toBe(false);
  });

  it("keeps a head the node cannot carry waiting behind the node's queue", () => {
    const input: QueueDrainInput = {
      nowIso: AT,
      queue: [{ id: "q-1" }],
      steerAttempts: {},
      hold: null,
      acknowledgedCauseKeys: [],
      headProviderInstanceId: "codex",
      view: {
        ref: REF,
        started: true,
        archived: false,
        detailLoaded: true,
        running: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        session: null,
        latestTurn: null,
        latestTurnPlaceholderCheckpoint: false,
        projectedMessageIds: new Set(),
        turnStartFailures: [],
        steerRejectionsByActivityId: new Map(),
        turnStartCancelledMessageIds: new Set(),
      },
      draft: false,
      environment: { shellLive: true, mutationReady: true, serverQueue: true },
      headMigratable: false,
      pendingDispatch: null,
      dispatchedMessageIds: new Set(),
      sender: "foreground",
    };
    expect(resolveQueueDrainStep({ ...input, serverQueueWaiting: true })).toEqual({
      kind: "wait",
      reason: "server-queue",
    });
    expect(resolveQueueDrainStep(input)).toEqual({
      kind: "send",
      messageId: "q-1",
      sender: "foreground",
    });
  });
});

describe("editing the node's entry", () => {
  const entries = [queued("a", { revision: 2 })];

  it("ends an edit whose entry left the queue or changed meanwhile", () => {
    const base = {
      queue: { entries, hold: null },
      detailLoaded: true,
      messageId: "a",
      revision: 2,
      saving: false,
    };
    expect(resolveFollowUpQueueEditState(base)).toBe("editing");
    // Another device's edit, a Retry, or a steer that came back raised its revision.
    expect(resolveFollowUpQueueEditState({ ...base, revision: 1 })).toBe("changed");
    // This edit's own save raises it too: not a change by someone else.
    expect(resolveFollowUpQueueEditState({ ...base, revision: 1, saving: true })).toBe("editing");
    expect(resolveFollowUpQueueEditState({ ...base, queue: null })).toBe("gone");
    expect(resolveFollowUpQueueEditState({ ...base, queue: null, detailLoaded: false })).toBe(
      "editing",
    );
    expect(describeEndedFollowUpQueueEdit("changed").description).toMatch(/stays in the composer/);
    expect(describeEndedFollowUpQueueEdit("gone").description).toMatch(/stays in the composer/);
  });
});
