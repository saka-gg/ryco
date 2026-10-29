import {
  QUEUE_MIGRATION_FAILED_CAUSE_PREFIX,
  type QueueEnvironmentReadiness,
  type QueueHold,
  type QueueThreadView,
} from "@ryco/client-runtime/state/message-queue";
import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const kv = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => kv.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      kv.set(key, value);
    },
    removeItem: async (key: string) => {
      kv.delete(key);
    },
  },
}));

import {
  drainThreadOutbox,
  enqueueThreadOutboxMessage,
  getThreadOutboxHold,
  getThreadOutboxMovingMessageId,
  holdThreadOutboxForInterrupt,
  hydrateThreadOutbox,
  isThreadOutboxDispatchPending,
  listThreadOutboxMessages,
  markThreadOutboxSteering,
  releaseThreadOutboxHold,
  resetThreadOutboxForTests,
  subscribeThreadOutbox,
  type ThreadOutboxDrainDeps,
} from "./threadOutbox";
import type { QueuedThreadMessage } from "./threadOutboxModel";

// The outbox on a node that keeps follow-up queues itself (design §3.7): its messages move to
// the node's queue as `thread.queue.add` under their own ids instead of being sent as turns.

const ENV = "env-a" as EnvironmentId;
const OTHER_ENV = "env-b" as EnvironmentId;
const THREAD = "t1" as ThreadId;
const KEY = `${ENV}:${THREAD}`;
const SERVER_QUEUE = { shellLive: true, mutationReady: true, serverQueue: true } as const;

function queued(
  id: string,
  createdAt: string,
  overrides: Partial<QueuedThreadMessage> = {},
): QueuedThreadMessage {
  return {
    environmentId: ENV,
    threadId: THREAD,
    messageId: id as MessageId,
    commandId: `cmd-${id}` as never,
    text: `msg ${id}`,
    attachments: [],
    createdAt,
    ...overrides,
  };
}

function view(overrides: Partial<QueueThreadView> = {}): QueueThreadView {
  return {
    ref: { environmentId: ENV, threadId: THREAD },
    started: true,
    archived: false,
    detailLoaded: true,
    running: false,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    session: { status: "ready", lastError: null, providerInstanceId: "codex", activeTurnId: null },
    latestTurn: { turnId: "turn-1" as TurnId, state: "completed" },
    latestTurnPlaceholderCheckpoint: false,
    projectedMessageIds: new Set(),
    turnStartFailures: [],
    steerRejectionsByActivityId: new Map(),
    turnStartCancelledMessageIds: new Set(),
    ...overrides,
  };
}

const IDLE = view();
const RUNNING = view({
  running: true,
  session: {
    status: "running",
    lastError: null,
    providerInstanceId: "codex",
    activeTurnId: "turn-1" as TurnId,
  },
  latestTurn: { turnId: "turn-1" as TurnId, state: "running" },
});

/** The node's side of `thread.queue.add`, with the decider's no-op for an id it already has. */
function fakeNode() {
  const queue: Array<{ id: string; hold: QueueHold | null; held: boolean }> = [];
  let refusal: Error | null = null;
  let gate: Promise<void> | null = null;
  const move = vi.fn(
    async (message: QueuedThreadMessage, context: { readonly hold: QueueHold | null }) => {
      if (gate) await gate;
      if (refusal) throw refusal;
      if (queue.some((entry) => entry.id === message.messageId)) return;
      queue.push({
        id: message.messageId,
        hold: context.hold,
        held: Boolean(message.uncertainSteerError || message.resumeReviewError),
      });
    },
  );
  return {
    queue,
    move,
    ids: () => queue.map((entry) => entry.id),
    refuseWith: (error: Error | null) => {
      refusal = error;
    },
    holdGate: () => {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

function deps(
  node: ReturnType<typeof fakeNode>,
  options: {
    readonly current?: QueueThreadView | null;
    readonly environment?: QueueEnvironmentReadiness;
  } = {},
) {
  const sendQueuedMessage = vi.fn(async () => {});
  const onServerQueueMigrated = vi.fn();
  const value: ThreadOutboxDrainDeps = {
    readThreadDrainState: () => ({
      view: options.current === undefined ? RUNNING : options.current,
      environment: options.environment ?? SERVER_QUEUE,
    }),
    sendQueuedMessage,
    moveQueuedMessageToServer: node.move,
    onServerQueueMigrated,
  };
  return { value, sendQueuedMessage, onServerQueueMigrated };
}

function persistedIds(): string[] {
  const raw = kv.get("ryco.threadOutbox.v1");
  return raw ? (JSON.parse(raw) as Array<{ messageId: string }>).map((m) => m.messageId) : [];
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

beforeEach(() => {
  kv.clear();
  resetThreadOutboxForTests();
});

describe("outbox intake on a node that keeps the follow-up queue", () => {
  it("queues a message sent offline on the node, not as a delayed turn start", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    const node = fakeNode();
    const d = deps(node, { current: IDLE });

    await drainThreadOutbox(d.value);

    expect(node.ids()).toEqual(["m1"]);
    expect(node.move.mock.calls[0]![0].messageId).toBe("m1");
    expect(d.sendQueuedMessage).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toEqual([]);
    expect(persistedIds()).toEqual([]);
    expect(d.onServerQueueMigrated).toHaveBeenCalledWith(ENV);
  });

  it("still sends it as a turn start on a node without the capability", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    const node = fakeNode();
    const d = deps(node, {
      current: IDLE,
      environment: { shellLive: true, mutationReady: true },
    });

    await drainThreadOutbox(d.value);

    expect(d.sendQueuedMessage).toHaveBeenCalledTimes(1);
    expect(node.move).not.toHaveBeenCalled();
    expect(d.onServerQueueMigrated).not.toHaveBeenCalled();
  });

  it("waits for the connection, like a turn start", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    const node = fakeNode();

    await drainThreadOutbox(
      deps(node, { environment: { shellLive: true, mutationReady: false, serverQueue: true } })
        .value,
    );

    expect(node.move).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(1);
  });
});

describe("moving the outbox to the node's queue", () => {
  it("moves head first and drops each message, persisted copy included, only once acknowledged", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-10-01T10:01:00.000Z"));
    enqueueThreadOutboxMessage(queued("m3", "2026-10-01T10:02:00.000Z"));
    const node = fakeNode();
    const openGate = node.holdGate();
    const d = deps(node);

    const drained = drainThreadOutbox(d.value);
    await flush();
    // The first add is on its way: nothing left the device, and nothing else moves or sends.
    expect(node.move).toHaveBeenCalledTimes(1);
    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(persistedIds()).toEqual(["m1", "m2", "m3"]);
    expect(getThreadOutboxMovingMessageId(KEY)).toBe("m1");
    expect(isThreadOutboxDispatchPending(KEY)).toBe(true);
    await drainThreadOutbox(d.value);
    expect(node.move).toHaveBeenCalledTimes(1);

    openGate();
    await drained;
    expect(node.ids()).toEqual(["m1", "m2", "m3"]);
    expect(listThreadOutboxMessages()).toEqual([]);
    expect(persistedIds()).toEqual([]);
    expect(getThreadOutboxMovingMessageId(KEY)).toBeNull();
    expect(d.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it("marks only the message whose add is on its way, so the others stay editable", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-10-01T10:01:00.000Z"));
    const node = fakeNode();
    const marks: Array<string | null> = [];
    const unsubscribe = subscribeThreadOutbox(() => {
      const moving = getThreadOutboxMovingMessageId(KEY);
      if (marks.at(-1) !== moving) marks.push(moving);
    });
    try {
      await drainThreadOutbox(deps(node).value);
    } finally {
      unsubscribe();
    }
    // Each message is marked from its add until the node answered, then dropped.
    expect(marks).toEqual(["m1", null, "m2", null]);
  });

  it("moves the thread's hold with every add, then deletes it with the empty thread", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-10-01T10:01:00.000Z"));
    holdThreadOutboxForInterrupt(KEY, "turn-1");
    const hold = getThreadOutboxHold(KEY);
    expect(hold?.reason).toBe("interrupted");
    const node = fakeNode();

    await drainThreadOutbox(deps(node).value);

    expect(node.queue).toEqual([
      { id: "m1", hold, held: false },
      { id: "m2", hold, held: false },
    ]);
    expect(getThreadOutboxHold(KEY)).toBeNull();
    const persistedHolds = JSON.parse(kv.get("ryco.threadOutboxHolds.v1") ?? "{}") as {
      holds?: Record<string, unknown>;
    };
    expect(persistedHolds.holds?.[KEY]).toBeUndefined();
  });

  it("moves a message waiting for an explicit retry too, so it waits for Retry on the node", async () => {
    enqueueThreadOutboxMessage(
      queued("m1", "2026-10-01T10:00:00.000Z", { uncertainSteerError: "The steer was cut off." }),
    );
    enqueueThreadOutboxMessage(
      queued("m2", "2026-10-01T10:01:00.000Z", { resumeReviewError: "Review the resume first." }),
    );
    enqueueThreadOutboxMessage(queued("m3", "2026-10-01T10:02:00.000Z"));
    const node = fakeNode();

    await drainThreadOutbox(deps(node).value);

    expect(node.queue.map(({ id, held }) => ({ id, held }))).toEqual([
      { id: "m1", held: true },
      { id: "m2", held: true },
      { id: "m3", held: false },
    ]);
    expect(listThreadOutboxMessages()).toEqual([]);
  });

  it("keeps a request the node cannot carry, and what follows it, on the device", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage({
      ...queued("m2", "2026-10-01T10:01:00.000Z"),
      projectMemory: { enabled: true },
    } as QueuedThreadMessage);
    enqueueThreadOutboxMessage(queued("m3", "2026-10-01T10:02:00.000Z"));
    const node = fakeNode();
    const d = deps(node);

    await drainThreadOutbox(d.value);
    await drainThreadOutbox(d.value);

    expect(node.ids()).toEqual(["m1"]);
    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m2", "m3"]);
    expect(d.sendQueuedMessage).not.toHaveBeenCalled();
    expect(d.onServerQueueMigrated).not.toHaveBeenCalled();
  });

  it("resumes a move cut short by a lost connection from the message it stopped at", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-10-01T10:01:00.000Z"));
    const node = fakeNode();
    let environment: QueueEnvironmentReadiness = SERVER_QUEUE;
    const d: ThreadOutboxDrainDeps = {
      readThreadDrainState: () => ({ view: RUNNING, environment }),
      sendQueuedMessage: vi.fn(async () => {}),
      moveQueuedMessageToServer: node.move,
    };
    node.move.mockImplementationOnce(async () => {
      environment = { ...environment, mutationReady: false };
      throw new Error("The connection closed.");
    });

    await drainThreadOutbox(d);
    // Not a refusal: nothing is held, nothing left the device.
    expect(getThreadOutboxHold(KEY)).toBeNull();
    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m1", "m2"]);

    environment = { ...environment, mutationReady: true };
    await drainThreadOutbox(d);
    expect(node.ids()).toEqual(["m1", "m2"]);
    expect(listThreadOutboxMessages()).toEqual([]);
  });

  it("resumes after an app kill: an add the node already took is a no-op, never a second copy", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-10-01T10:01:00.000Z"));
    await flush();
    const node = fakeNode();
    // The node took m1, and the app was killed before the device dropped its copy.
    node.queue.push({ id: "m1", hold: null, held: false });
    resetThreadOutboxForTests();
    expect(listThreadOutboxMessages()).toEqual([]);
    await hydrateThreadOutbox();
    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m1", "m2"]);

    await drainThreadOutbox(deps(node).value);

    expect(node.ids()).toEqual(["m1", "m2"]);
    expect(node.move).toHaveBeenCalledTimes(2);
    expect(listThreadOutboxMessages()).toEqual([]);
    expect(persistedIds()).toEqual([]);
  });

  it("holds the thread with the node's answer when it refuses a message, until Resume", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-10-01T10:01:00.000Z"));
    const node = fakeNode();
    node.refuseWith(new Error("The queue is full (20 follow-ups)."));
    const d = deps(node);

    await drainThreadOutbox(d.value);
    const hold = getThreadOutboxHold(KEY);
    expect(hold).toMatchObject({ reason: "error", detail: "The queue is full (20 follow-ups)." });
    expect(hold?.causeKeys).toContain(`${QUEUE_MIGRATION_FAILED_CAUSE_PREFIX}m1`);
    // No retry loop while held, and nothing is sent from the device instead.
    await drainThreadOutbox(d.value);
    expect(node.move).toHaveBeenCalledTimes(1);
    expect(d.sendQueuedMessage).not.toHaveBeenCalled();
    expect(d.onServerQueueMigrated).not.toHaveBeenCalled();

    node.refuseWith(null);
    releaseThreadOutboxHold(KEY);
    await drainThreadOutbox(d.value);
    expect(node.ids()).toEqual(["m1", "m2"]);
    expect(listThreadOutboxMessages()).toEqual([]);
    expect(d.onServerQueueMigrated).toHaveBeenCalledWith(ENV);
  });

  it("waits for a steer in flight before moving the thread", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    markThreadOutboxSteering("m1", {
      commandId: "cmd-steer",
      expectedTurnId: "turn-1" as TurnId,
      startedAt: "2026-10-01T10:00:01.000Z",
      explicit: true,
    });
    const node = fakeNode();

    await drainThreadOutbox(deps(node).value);

    expect(node.move).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(1);
  });

  it("records the environment as moved only once every message of it has", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-10-01T10:00:00.000Z"));
    enqueueThreadOutboxMessage({
      ...queued("m2", "2026-10-01T10:01:00.000Z"),
      threadId: "t2" as ThreadId,
    });
    enqueueThreadOutboxMessage({
      ...queued("m3", "2026-10-01T10:02:00.000Z"),
      environmentId: OTHER_ENV,
    });
    const node = fakeNode();
    node.move.mockImplementation(async (message: QueuedThreadMessage) => {
      if (message.messageId === "m2") throw new Error("Refused.");
      node.queue.push({ id: message.messageId, hold: null, held: false });
    });
    const d = deps(node);

    await drainThreadOutbox(d.value);

    expect(node.ids().toSorted()).toEqual(["m1", "m3"]);
    // env-a still holds m2 (refused); env-b moved entirely.
    expect(d.onServerQueueMigrated.mock.calls).toEqual([[OTHER_ENV]]);
  });
});
