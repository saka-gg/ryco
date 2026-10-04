import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStore } from "zustand/vanilla";

import {
  makeQueueAppState,
  QUEUE_ENV,
  queueKey,
  steerFailed,
  turnStartFailed,
  withThread,
  type ThreadFixture,
} from "../../../test/queueThreadFixtures.ts";
import { applyOrchestrationEvent, type AppState } from "../threads/store.ts";
import {
  createMessageQueueDrainCoordinator,
  type MessageQueueDrainPlatform,
  type MessageQueueSender,
  type QueueSendHooks,
  type QueueSendResult,
} from "./coordinator.ts";
import { createInterruptQueueHold } from "./hold.ts";
import type { QueuedMessage } from "./logic.ts";
import { createMessageQueueStore } from "./store.ts";

type Entry = QueuedMessage<{ text: string }, Record<string, never>>;

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

function entry(id: string): Entry {
  return { id, composer: { text: id }, settings: {} };
}

function threadEvent(
  sequence: number,
  type: OrchestrationEvent["type"],
  payload: object,
): OrchestrationEvent {
  const threadId = ThreadId.make("t");
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-10-01T10:00:02.000Z",
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { threadId, ...payload },
  } as OrchestrationEvent;
}

/**
 * `placeholder` is the `missing` checkpoint ProviderRuntimeIngestion records on
 * a Codex turn's first diff update; `missing` alone is a real capture of an
 * interrupted turn.
 */
function turnDiffCompleted(
  sequence: number,
  turnId: string,
  status: "ready" | "missing" | "placeholder",
): OrchestrationEvent {
  return threadEvent(sequence, "thread.turn-diff-completed", {
    turnId: TurnId.make(turnId),
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make(
      status === "placeholder" ? `provider-diff:event-${sequence}` : `checkpoint-${sequence}`,
    ),
    status: status === "placeholder" ? "missing" : status,
    files: [],
    assistantMessageId: MessageId.make(`assistant:${turnId}`),
    completedAt: "2026-10-01T10:00:02.000Z",
  });
}

/**
 * `session-set` leaves the latest turn alone unless it starts one or the server
 * releases it (`releasedTurn`, decided by the server's turn finalization).
 */
function sessionSet(
  sequence: number,
  status: "running" | "ready",
  activeTurnId: string | null,
  released?: { readonly turnId: string; readonly state: "completed" | "interrupted" | "error" },
): OrchestrationEvent {
  return threadEvent(sequence, "thread.session-set", {
    ...(released
      ? {
          releasedTurn: {
            turnId: TurnId.make(released.turnId),
            state: released.state,
            reason: "provider-turn-completed",
            completedAt: `2026-10-01T10:00:${String(10 + sequence).padStart(2, "0")}.000Z`,
          },
        }
      : {}),
    session: {
      threadId: ThreadId.make("t"),
      status,
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
      lastError: null,
      updatedAt: `2026-10-01T10:00:${String(10 + sequence).padStart(2, "0")}.000Z`,
    },
  });
}

function turnInterruptRequested(sequence: number, turnId: string): OrchestrationEvent {
  return threadEvent(sequence, "thread.turn-interrupt-requested", {
    turnId: TurnId.make(turnId),
    createdAt: "2026-10-01T10:00:03.000Z",
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function setup(options: { thread?: ThreadFixture; mutationReady?: boolean } = {}) {
  const threads = createStore<AppState>(() => makeQueueAppState([options.thread ?? IDLE]));
  const queue = createMessageQueueStore<{ text: string }, Record<string, never>>();
  let mutationReady = options.mutationReady ?? true;
  const readinessListeners = new Set<() => void>();
  const sent: string[] = [];
  let respond: (entry: Entry, hooks: QueueSendHooks) => Promise<QueueSendResult> = async (
    _entry,
    hooks,
  ) => {
    hooks.onBeforeTurnStart();
    return { kind: "accepted" };
  };
  const background: MessageQueueSender<{ text: string }, Record<string, never>> = {
    send: vi.fn((queued: Entry, hooks: QueueSendHooks) => {
      sent.push(queued.id);
      return respond(queued, hooks);
    }),
  };
  const releaseDetail = vi.fn();
  const platform = {
    threads: {
      getState: threads.getState,
      subscribe: (listener: () => void) => threads.subscribe(listener),
    },
    readEnvironment: vi.fn(() => ({ shellLive: true, mutationReady })),
    subscribeEnvironmentReadiness: (listener: () => void) => {
      readinessListeners.add(listener);
      return () => readinessListeners.delete(listener);
    },
    resolveSender: vi.fn((_key: string, view: { started: boolean } | null) =>
      view?.started ? { kind: "background" as const, sender: background } : null,
    ),
    headProviderInstanceId: () => "codex",
    retainThreadDetail: vi.fn(() => releaseDetail),
    onEntryRemoved: vi.fn(),
    onSteerRejected: vi.fn(),
  } satisfies MessageQueueDrainPlatform<{ text: string }, Record<string, never>>;
  const coordinator = createMessageQueueDrainCoordinator(queue, platform);
  const release = coordinator.retain();
  return {
    threads,
    queue,
    platform,
    coordinator,
    release,
    sent,
    background,
    releaseDetail,
    setThread: (fixture: Omit<ThreadFixture, "id">) =>
      threads.setState((state) => withThread(state, { id: "t", ...fixture })),
    apply: (event: OrchestrationEvent) =>
      threads.setState((state) => applyOrchestrationEvent(state, event, QUEUE_ENV)),
    latestTurnState: () =>
      threads.getState().environmentStateById[QUEUE_ENV]?.threadTurnStateById[ThreadId.make("t")]
        ?.latestTurn?.state,
    setMutationReady: (ready: boolean) => {
      mutationReady = ready;
      for (const listener of readinessListeners) listener();
    },
    respondWith: (next: typeof respond) => {
      respond = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("message queue drain coordinator", () => {
  it("ends a steer only on its own rejection and then sends the message as the next turn", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    const attempt = {
      commandId: "cmd-new",
      expectedTurnId: TurnId.make("turn-1"),
      startedAt: "2026-10-01T10:00:01.000Z",
      explicit: true,
    };
    f.queue.getState().beginSteer(KEY, "q-1", attempt);
    // A stale rejection of an earlier attempt for the same message.
    f.setThread({ ...RUNNING, activities: [steerFailed("turn-steer-rejected:cmd-old", "q-1")] });
    await flush();
    expect(f.queue.getState().steerAttemptsByThreadKey[KEY]?.["q-1"]).toEqual(attempt);
    expect(f.platform.onSteerRejected).not.toHaveBeenCalled();

    // The turn ended; the steer is deferred and the message goes as the next turn.
    f.setThread({
      ...IDLE,
      activities: [
        steerFailed("turn-steer-rejected:cmd-old", "q-1"),
        steerFailed("turn-steer-rejected:cmd-new", "q-1", "deferred"),
      ],
    });
    await flush();
    expect(f.platform.onSteerRejected).toHaveBeenCalledWith(KEY, {
      messageId: "q-1",
      attempt,
      reason: "deferred",
      error: "Steer rejected.",
    });
    expect(f.queue.getState().steerAttemptsByThreadKey[KEY]).toBeUndefined();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("drains an off-screen started thread through the background sender once its turn settles", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.sent).toEqual([]);
    f.setThread(IDLE);
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    expect(f.queue.getState().queuesByThreadKey[KEY]).toEqual([]);
    expect(f.platform.onEntryRemoved).toHaveBeenCalledWith(KEY, entry("q-1"), "accepted");
  });

  it("sends one message per thread and waits for the next turn to start", async () => {
    const f = setup();
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    // startSession's bind: session-set(ready) with a new updatedAt, no turn yet.
    f.setThread({ ...IDLE, session: { status: "ready", updatedAt: "2026-10-01T10:00:05.000Z" } });
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    f.setThread({
      session: { status: "running", activeTurnId: "turn-2" },
      latestTurn: { turnId: "turn-2", state: "running" },
      messageIds: ["m-0", "q-1"],
    });
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    f.setThread({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "q-1"],
    });
    await flush();
    expect(f.sent).toEqual(["q-1", "q-2"]);
  });

  it("holds on a start failure for the dispatched message and does not send the next head", async () => {
    const f = setup();
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    f.setThread({
      ...IDLE,
      activities: [turnStartFailed("a-1", "q-1", "Thread already has active turn")],
    });
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    expect(f.queue.getState().holdsByThreadKey[KEY]).toMatchObject({
      reason: "error",
      detail: "Thread already has active turn",
      causeKeys: ["start-failed:a-1"],
    });
    expect(f.coordinator.inspect(KEY).pendingDispatch).toBeNull();
  });

  it("holds after Stop until Resume", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    f.queue.getState().hold(KEY, createInterruptQueueHold("turn-1", "2026-10-01T10:00:01.000Z"));
    f.setThread({ ...IDLE, latestTurn: { turnId: "turn-1", state: "interrupted" } });
    await flush();
    expect(f.sent).toEqual([]);
    expect(f.coordinator.inspect(KEY).lastStep).toEqual({ kind: "wait", reason: "held" });
    f.coordinator.resume(KEY);
    await flush();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("does not hold on a mid-turn placeholder checkpoint that reads as interrupted", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.coordinator.inspect(KEY).lastStep).toEqual({ kind: "wait", reason: "busy" });
    // A Codex turn in a git repo: the first turn.diff.updated dispatches a
    // placeholder `missing` checkpoint. Checkpoints never change an existing turn's
    // state, so the turn keeps reading as running.
    f.apply(turnDiffCompleted(1, "turn-1", "placeholder"));
    expect(f.latestTurnState()).toBe("running");
    await flush();
    expect(f.coordinator.inspect(KEY).lastStep).toEqual({ kind: "wait", reason: "busy" });
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    // The real capture lands and the turn settles normally.
    f.apply(turnDiffCompleted(2, "turn-1", "ready"));
    f.setThread(IDLE);
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("does not hold when a placeholder-checkpoint turn settles before its real capture", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    f.apply(turnDiffCompleted(1, "turn-1", "placeholder"));
    // turn.completed settles the session; the capture is still running (or failed).
    f.apply(sessionSet(2, "ready", null, { turnId: "turn-1", state: "completed" }));
    expect(f.latestTurnState()).toBe("completed");
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    expect(f.sent).toEqual(["q-1"]);
    // The real capture lands late; q-2 still waits for q-1's own turn.
    f.apply(turnDiffCompleted(3, "turn-1", "ready"));
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    expect(f.coordinator.inspect(KEY).lastStep).toEqual({ kind: "wait", reason: "awaiting-ack" });
  });

  it("holds when the server releases the turn as interrupted", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    f.apply(turnDiffCompleted(1, "turn-1", "placeholder"));
    f.apply(sessionSet(2, "ready", null, { turnId: "turn-1", state: "interrupted" }));
    f.apply(turnDiffCompleted(3, "turn-1", "missing"));
    expect(f.latestTurnState()).toBe("interrupted");
    await flush();
    expect(f.sent).toEqual([]);
    expect(f.queue.getState().holdsByThreadKey[KEY]).toMatchObject({
      reason: "interrupted",
      causeKeys: ["interrupt:turn-1"],
    });
  });

  it("sends a follow-up composed after Stop while the aborted turn was still settling", async () => {
    const f = setup({ thread: RUNNING });
    // Stop with an empty queue: no explicit hold, the turn reads interrupted at once.
    f.apply(turnInterruptRequested(1, "turn-1"));
    expect(f.latestTurnState()).toBe("interrupted");
    f.queue.getState().enqueue(KEY, entry("q-1"));
    expect(f.queue.getState().acknowledgedCauseKeysByThreadKey[KEY]).toEqual(["interrupt:turn-1"]);
    await flush();
    expect(f.sent).toEqual([]);
    // turn.aborted: the session settles, then the interrupt is re-requested.
    f.apply(sessionSet(2, "ready", null));
    f.apply(turnInterruptRequested(3, "turn-1"));
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("arms the ack when a send is projected before its reply is lost", async () => {
    const f = setup();
    let rejectSend!: (error: Error) => void;
    f.respondWith(
      (_entry, hooks) =>
        new Promise<QueueSendResult>((_resolve, reject) => {
          hooks.onBeforeTurnStart();
          rejectSend = reject;
        }),
    );
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    expect(f.coordinator.inspect(KEY).inFlightMessageId).toBe("q-1");
    // thread.message-sent lands first: reconcile removes the in-flight head.
    f.setThread({ ...IDLE, messageIds: ["m-0", "q-1"] });
    await flush();
    expect(f.queue.getState().queuesByThreadKey[KEY]!.map((queued) => queued.id)).toEqual(["q-2"]);
    f.respondWith(async () => ({ kind: "accepted" }));
    rejectSend(new Error("socket closed"));
    await flush();
    // startSession's bind: ready, no turn yet. q-2 must wait for q-1's turn.
    f.setThread({
      session: { status: "ready", updatedAt: "2026-10-01T10:00:05.000Z" },
      latestTurn: { turnId: "turn-1", state: "completed" },
      messageIds: ["m-0", "q-1"],
    });
    await flush();
    expect(f.coordinator.inspect(KEY).pendingDispatch?.messageId).toBe("q-1");
    expect(f.sent).toEqual(["q-1"]);
    f.setThread({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "q-1"],
    });
    await flush();
    expect(f.sent).toEqual(["q-1", "q-2"]);
  });

  it("sends past a running turn row its session already released", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    f.setThread({
      session: { status: "ready", updatedAt: "2026-10-01T10:00:05.000Z" },
      latestTurn: { turnId: "turn-1", state: "running" },
      messageIds: ["m-0"],
    });
    await flush();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("holds when a start failure follows a false ack on a server-initiated turn", async () => {
    const f = setup();
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    f.setThread({
      session: { status: "running", activeTurnId: "server-turn" },
      latestTurn: { turnId: "server-turn", state: "running" },
      messageIds: ["m-0"],
    });
    await flush();
    expect(f.coordinator.inspect(KEY).pendingDispatch).toBeNull();
    f.setThread({
      session: { status: "ready" },
      latestTurn: { turnId: "server-turn", state: "completed" },
      messageIds: ["m-0"],
      activities: [turnStartFailed("a-1", "q-1")],
    });
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    expect(f.queue.getState().holdsByThreadKey[KEY]?.causeKeys).toEqual(["start-failed:a-1"]);
  });

  it("retries a deferred send after 250 ms without spinning", async () => {
    const f = setup();
    let deferred = true;
    f.respondWith(async () => (deferred ? { kind: "deferred" } : { kind: "accepted" }));
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    expect(f.queue.getState().queuesByThreadKey[KEY]![0]!.deliveryStatus).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(f.sent).toEqual(["q-1"]);
    deferred = false;
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(f.sent).toEqual(["q-1", "q-1"]);
  });

  it("turns a needs-review result into a review hold and releases the claim", async () => {
    const f = setup();
    f.respondWith(async () => ({
      kind: "needs-review",
      detail: "This Claude resume needs review.",
    }));
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toMatchObject({
      reason: "review",
      detail: "This Claude resume needs review.",
      causeKeys: ["review:q-1"],
    });
    expect(f.queue.getState().queuesByThreadKey[KEY]![0]!.deliveryStatus).toBeUndefined();
    expect(f.sent).toEqual(["q-1"]);
  });

  it("arms the ack when a send whose reply was lost is projected", async () => {
    const f = setup();
    f.respondWith(async (_entry, hooks) => {
      hooks.onBeforeTurnStart();
      throw new Error("socket closed");
    });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    expect(f.queue.getState().queuesByThreadKey[KEY]![0]!.deliveryStatus).toBe("failed");
    f.respondWith(async () => ({ kind: "accepted" }));
    f.setThread({ ...IDLE, messageIds: ["m-0", "q-1"] });
    await flush();
    expect(f.queue.getState().queuesByThreadKey[KEY]!.map((queued) => queued.id)).toEqual(["q-2"]);
    expect(f.platform.onEntryRemoved).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ id: "q-1" }),
      "projected",
    );
    expect(f.coordinator.inspect(KEY).pendingDispatch?.messageId).toBe("q-1");
    expect(f.sent).toEqual(["q-1"]);
    f.setThread({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "q-1"],
    });
    await flush();
    expect(f.sent).toEqual(["q-1", "q-2"]);
  });

  it("holds a stalled send and auto-releases it when the turn starts late", async () => {
    const f = setup();
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    await vi.advanceTimersByTimeAsync(90_000);
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toMatchObject({
      reason: "stalled",
      causeKeys: ["stalled:q-1"],
    });
    f.setThread({
      session: { status: "running", activeTurnId: "turn-2" },
      latestTurn: { turnId: "turn-2", state: "running" },
      messageIds: ["m-0", "q-1"],
    });
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    f.setThread({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "q-1"],
    });
    await flush();
    expect(f.sent).toEqual(["q-1", "q-2"]);
  });

  it("carries no pending ack or timer across a stop and restart", async () => {
    const f = setup();
    f.queue.getState().enqueue(KEY, entry("q-1"));
    f.queue.getState().enqueue(KEY, entry("q-2"));
    await flush();
    expect(f.coordinator.inspect(KEY).pendingDispatch?.messageId).toBe("q-1");
    f.release();
    expect(f.coordinator.inspect(KEY)).toEqual({
      pendingDispatch: null,
      inFlightMessageId: null,
      lastStep: null,
    });
    expect(f.releaseDetail).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.queue.getState().holdsByThreadKey[KEY]).toBeUndefined();
    const releaseAgain = f.coordinator.retain();
    await flush();
    expect(f.sent).toEqual(["q-1", "q-2"]);
    releaseAgain();
  });

  it("ignores a completion from before a reset and arms no ack", async () => {
    const f = setup();
    let resolveSend!: (result: QueueSendResult) => void;
    f.respondWith(
      () =>
        new Promise<QueueSendResult>((resolve) => {
          resolveSend = resolve;
        }),
    );
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.coordinator.inspect(KEY).inFlightMessageId).toBe("q-1");
    f.queue.getState().reset();
    await flush();
    resolveSend({ kind: "accepted" });
    await flush();
    expect(f.coordinator.inspect(KEY).pendingDispatch).toBeNull();
    expect(f.platform.onEntryRemoved).not.toHaveBeenCalled();
    expect(f.queue.getState().queuesByThreadKey).toEqual({});
  });

  it("does not re-resolve the environment or sender for an unrelated thread update", async () => {
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    f.platform.readEnvironment.mockClear();
    f.platform.resolveSender.mockClear();
    f.threads.setState((state) => withThread(state, { ...IDLE, id: "other" }));
    await flush();
    f.threads.setState((state) =>
      withThread(state, { ...RUNNING, id: "other", messageIds: ["m-1"] }),
    );
    await flush();
    expect(f.platform.readEnvironment).not.toHaveBeenCalled();
    expect(f.platform.resolveSender).not.toHaveBeenCalled();
  });

  it("retains thread detail only while mutation-ready and releases it when the queue empties", async () => {
    const f = setup({ thread: RUNNING, mutationReady: false });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    expect(f.platform.retainThreadDetail).not.toHaveBeenCalled();
    f.setMutationReady(true);
    await flush();
    expect(f.platform.retainThreadDetail).toHaveBeenCalledTimes(1);
    f.setMutationReady(false);
    await flush();
    expect(f.releaseDetail).toHaveBeenCalledTimes(1);
    f.setMutationReady(true);
    await flush();
    expect(f.platform.retainThreadDetail).toHaveBeenCalledTimes(2);
    f.queue.getState().remove(KEY, "q-1");
    await flush();
    expect(f.releaseDetail).toHaveBeenCalledTimes(2);
  });
});

describe("message queue drain coordinator usage limits", () => {
  const RESET_MS = Date.parse("2026-10-01T15:00:00.000Z");
  const LIMITED: Omit<ThreadFixture, "id"> = {
    session: { status: "error", lastError: "You've hit your usage limit." },
    latestTurn: { turnId: "turn-1", state: "error" },
    messageIds: ["m-0"],
    usageLimit: {
      limitId: "usage-limit:t:turn-1",
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      turnId: TurnId.make("turn-1"),
      message: "You've hit your usage limit.",
      limitedAt: "2026-10-01T10:00:00.000Z",
      resetAt: new Date(RESET_MS).toISOString(),
      autoResume: null,
      updatedAt: "2026-10-01T10:00:00.000Z",
    },
  };

  it("wakes itself to drain when an unarmed usage-limit hold ends", async () => {
    vi.setSystemTime(RESET_MS - 3_600_000);
    const f = setup({ thread: RUNNING });
    f.queue.getState().enqueue(KEY, entry("q-1"));
    await flush();
    f.setThread(LIMITED);
    await flush();
    expect(f.queue.getState().holdsByThreadKey[KEY]).toMatchObject({ reason: "limit" });
    expect(f.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_600_000 + 60_000);
    await flush();
    expect(f.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(f.sent).toEqual(["q-1"]);
  });
});
