import { ClaudeResumeReviewError } from "@ryco/client-runtime/state/composer";
import { useStore } from "@ryco/client-runtime/state/threads";
import type { QueueSendHooks, QueueThreadView } from "@ryco/client-runtime/state/message-queue";
import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

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
  holdThreadOutboxForInterrupt,
  hydrateThreadOutbox,
  listThreadOutboxMessages,
  releaseThreadOutboxHold,
  resetThreadOutboxForTests,
  retryThreadOutboxReview,
  trackThreadOutboxLiveCauses,
  type ThreadOutboxDrainDeps,
} from "./threadOutbox";
import type { QueuedThreadMessage } from "./threadOutboxModel";

const ENV = "env-a" as EnvironmentId;
const THREAD = "t1" as ThreadId;
const KEY = `${ENV}:${THREAD}`;
const LIVE = { shellLive: true, mutationReady: true };

function queued(id: string, createdAt: string): QueuedThreadMessage {
  return {
    environmentId: ENV,
    threadId: THREAD,
    messageId: id as MessageId,
    commandId: `cmd-${id}` as never,
    text: `msg ${id}`,
    attachments: [],
    createdAt,
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
    steerFailedMessageIds: new Set(),
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
const errored = (lastError: string) =>
  view({
    session: { status: "error", lastError, providerInstanceId: "codex", activeTurnId: null },
    latestTurn: { turnId: "turn-1" as TurnId, state: "error" },
  });

function deps(
  current: QueueThreadView | null,
  sendQueuedMessage: ThreadOutboxDrainDeps["sendQueuedMessage"],
  overrides: Partial<ThreadOutboxDrainDeps> = {},
): ThreadOutboxDrainDeps {
  return {
    readThreadDrainState: () => ({ view: current, environment: LIVE }),
    sendQueuedMessage,
    ...overrides,
  };
}

/** A sender that reaches the final turn.start, like commitSendTurnDispatch. */
const accepting = () =>
  vi.fn(async (_message: QueuedThreadMessage, hooks: QueueSendHooks) => {
    hooks.onBeforeTurnStart();
  });

beforeEach(() => {
  kv.clear();
  resetThreadOutboxForTests();
});

describe("threadOutbox store + drain", () => {
  it("enqueues (deduped) and lists persisted messages", () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-07-24T11:00:00.000Z"));
    // re-enqueue m1 replaces rather than duplicates
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:30:00.000Z"));
    expect(
      listThreadOutboxMessages()
        .map((m) => m.messageId)
        .toSorted(),
    ).toEqual(["m1", "m2"]);
  });

  it("sends one message per thread per pass; the second waits for the turn-start ack", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-07-24T11:00:00.000Z"));
    const sendQueuedMessage = accepting();

    await drainThreadOutbox(deps(IDLE, sendQueuedMessage));
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m2"]);

    // startSession's bind: the session is ready again but no turn has started.
    await drainThreadOutbox(deps(IDLE, sendQueuedMessage));
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);

    const turn2 = view({
      running: true,
      session: {
        status: "running",
        lastError: null,
        providerInstanceId: "codex",
        activeTurnId: "turn-2" as TurnId,
      },
      latestTurn: { turnId: "turn-2" as TurnId, state: "running" },
      projectedMessageIds: new Set(["m1"]),
    });
    await drainThreadOutbox(deps(turn2, sendQueuedMessage));
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);

    await drainThreadOutbox(
      deps(
        view({
          latestTurn: { turnId: "turn-2" as TurnId, state: "completed" },
          projectedMessageIds: new Set(["m1"]),
        }),
        sendQueuedMessage,
      ),
    );
    expect(sendQueuedMessage).toHaveBeenCalledTimes(2);
    expect(listThreadOutboxMessages()).toHaveLength(0);
  });

  it("removes an already projected message without sending it again", async () => {
    enqueueThreadOutboxMessage(queued("m-steered", "2026-08-17T10:00:00.000Z"));
    const sendQueuedMessage = accepting();

    await drainThreadOutbox(
      deps(view({ projectedMessageIds: new Set(["m-steered"]) }), sendQueuedMessage),
    );

    expect(sendQueuedMessage).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(0);
  });

  it("waits for detailed message reconciliation before delivery", async () => {
    enqueueThreadOutboxMessage(queued("m-unknown", "2026-08-17T10:00:00.000Z"));
    const sendQueuedMessage = accepting();

    await drainThreadOutbox(deps(view({ detailLoaded: false }), sendQueuedMessage));

    expect(sendQueuedMessage).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(1);
  });

  it("retains a message on a transient send failure (retry)", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => {
      throw { _tag: "ConnectionTransientError" };
    });

    await drainThreadOutbox(deps(IDLE, sendQueuedMessage));

    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m1"]);
  });

  it("discards a message on a permanent send failure", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => {
      throw new Error("bad request");
    });

    await drainThreadOutbox(deps(IDLE, sendQueuedMessage));

    expect(listThreadOutboxMessages()).toHaveLength(0);
  });

  it("removes a queued message whose thread has vanished from a live shell", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = accepting();

    await drainThreadOutbox(deps(null, sendQueuedMessage));

    expect(sendQueuedMessage).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(0);
  });

  it("keeps a vanished thread's message while the shell is not live", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    await drainThreadOutbox(
      deps(null, accepting(), {
        readThreadDrainState: () => ({
          view: null,
          environment: { shellLive: false, mutationReady: false },
        }),
      }),
    );
    expect(listThreadOutboxMessages()).toHaveLength(1);
  });
});

function syncShell(session: { status: string; lastError: string | null }, turnState: string) {
  const AT = "2026-07-24T09:00:00.000Z";
  useStore.getState().syncServerShellSnapshot(
    {
      snapshotSequence: 1,
      projects: [],
      worktrees: [],
      threads: [
        {
          id: THREAD,
          projectId: "p1",
          title: "Thread",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: "turn-1",
            state: turnState,
            requestedAt: AT,
            startedAt: AT,
            completedAt: turnState === "running" ? null : AT,
            assistantMessageId: null,
          },
          createdAt: AT,
          updatedAt: AT,
          archivedAt: null,
          session: {
            threadId: THREAD,
            status: session.status,
            providerName: "codex",
            providerInstanceId: "codex",
            runtimeMode: "full-access",
            activeTurnId: session.status === "running" ? "turn-1" : null,
            lastError: session.lastError,
            updatedAt: AT,
          },
          latestUserMessageAt: AT,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ],
      updatedAt: AT,
    } as never,
    ENV,
  );
}

describe("threadOutbox holds", () => {
  it("baselines a legacy persisted outbox at its first live drain and sends", async () => {
    // Persisted before holds existed: no baseline, so the first live
    // evaluation records one and an error already there does not hold.
    kv.set("ryco.threadOutbox.v1", JSON.stringify([queued("m1", "2026-07-24T10:00:00.000Z")]));
    await hydrateThreadOutbox();
    const sendQueuedMessage = accepting();
    await drainThreadOutbox(
      deps(errored("Provider session did not survive a server restart."), sendQueuedMessage),
    );
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
  });

  it("holds a failure first seen on reconnect when the message was queued against cached rows", async () => {
    // The user saw the turn running, then the phone went offline: the rows are
    // demoted to last-known state (no session) while they compose.
    syncShell({ status: "running", lastError: null }, "running");
    useStore.getState().demoteEnvironmentStateToCachedSnapshot(ENV, Date.now());
    try {
      enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
      const sendQueuedMessage = accepting();
      // On reconnect the turn had ended in an error the user never saw.
      await drainThreadOutbox(deps(errored("Usage limit reached"), sendQueuedMessage));
      expect(sendQueuedMessage).not.toHaveBeenCalled();
      expect(getThreadOutboxHold(KEY)).toMatchObject({
        reason: "error",
        detail: "Usage limit reached",
      });
    } finally {
      useStore.getState().removeEnvironmentState(ENV);
    }
  });

  it("sends an offline reply to an error the user saw live, after a cold start from cache", async () => {
    await hydrateThreadOutbox();
    const stopTracking = trackThreadOutboxLiveCauses();
    const orphaned =
      "Provider session did not survive a server restart. Send a new message to continue.";
    try {
      syncShell({ status: "error", lastError: orphaned }, "completed");
      await vi.waitFor(() => expect(kv.get("ryco.threadOutboxHolds.v1")).toContain(orphaned));
      // The app is killed offline: a cold start replays the persisted outbox and
      // the cached rows, which carry no session.
      const live = useStore.getState().environmentStateById[ENV]!;
      const cached = {
        capturedAt: Date.now(),
        projects: [],
        worktrees: [],
        threads: [
          { shell: live.threadShellById[THREAD]!, summary: live.sidebarThreadSummaryById[THREAD]! },
        ],
      };
      stopTracking();
      const persisted = new Map(kv);
      resetThreadOutboxForTests();
      for (const [key, value] of persisted) kv.set(key, value);
      useStore.getState().removeEnvironmentState(ENV);
      useStore.getState().hydrateEnvironmentStateFromCache(cached, ENV);
      expect(
        useStore.getState().environmentStateById[ENV]?.threadSessionById[THREAD] ?? null,
      ).toBeNull();
      await hydrateThreadOutbox();

      enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
      const sendQueuedMessage = accepting();
      await drainThreadOutbox(
        deps(
          view({
            session: {
              status: "error",
              lastError: orphaned,
              providerInstanceId: "codex",
              activeTurnId: null,
            },
          }),
          sendQueuedMessage,
        ),
      );
      expect(getThreadOutboxHold(KEY)).toBeNull();
      expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
    } finally {
      stopTracking();
      useStore.getState().removeEnvironmentState(ENV);
    }
  });

  it("does not record causes from cached rows", async () => {
    await hydrateThreadOutbox();
    syncShell({ status: "error", lastError: "Rate limited" }, "error");
    useStore.getState().demoteEnvironmentStateToCachedSnapshot(ENV, Date.now());
    const stopTracking = trackThreadOutboxLiveCauses();
    try {
      // Tracking started only after the demotion: nothing was seen live.
      enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
      const sendQueuedMessage = accepting();
      await drainThreadOutbox(deps(errored("Rate limited"), sendQueuedMessage));
      expect(sendQueuedMessage).not.toHaveBeenCalled();
      expect(getThreadOutboxHold(KEY)?.reason).toBe("error");
    } finally {
      stopTracking();
      useStore.getState().removeEnvironmentState(ENV);
    }
  });

  it("baselines a Stop the user saw while the aborted turn was still settling", async () => {
    syncShell({ status: "running", lastError: null }, "interrupted");
    try {
      enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
      const sendQueuedMessage = accepting();
      await drainThreadOutbox(
        deps(
          view({ latestTurn: { turnId: "turn-1" as TurnId, state: "interrupted" } }),
          sendQueuedMessage,
        ),
      );
      expect(getThreadOutboxHold(KEY)).toBeNull();
      expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
    } finally {
      useStore.getState().removeEnvironmentState(ENV);
    }
  });

  it("records the baseline at enqueue from the live thread the user saw", async () => {
    syncShell({ status: "error", lastError: "Rate limited" }, "error");
    try {
      enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
      const sendQueuedMessage = accepting();
      // Even a first drain that sees the thread running then erroring again with
      // the same failure does not hold: the user composed in response to it.
      await drainThreadOutbox(deps(RUNNING, sendQueuedMessage));
      await drainThreadOutbox(deps(errored("Rate limited"), sendQueuedMessage));
      expect(getThreadOutboxHold(KEY)).toBeNull();
      expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
    } finally {
      useStore.getState().removeEnvironmentState(ENV);
    }
  });

  it("holds when a failure arrives after enqueue, and Resume sends", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = accepting();
    await drainThreadOutbox(deps(RUNNING, sendQueuedMessage));
    await drainThreadOutbox(deps(errored("Usage limit reached"), sendQueuedMessage));
    expect(sendQueuedMessage).not.toHaveBeenCalled();
    expect(getThreadOutboxHold(KEY)).toMatchObject({
      reason: "error",
      detail: "Usage limit reached",
    });

    releaseThreadOutboxHold(KEY);
    expect(getThreadOutboxHold(KEY)).toBeNull();
    await drainThreadOutbox(deps(errored("Usage limit reached"), sendQueuedMessage));
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
  });

  it("holds after a start failure for the dispatched message", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-07-24T11:00:00.000Z"));
    const sendQueuedMessage = accepting();
    await drainThreadOutbox(deps(IDLE, sendQueuedMessage));
    await drainThreadOutbox(
      deps(
        view({
          turnStartFailures: [
            { activityId: "a-1", messageId: "m1", detail: "Thread already has active turn" },
          ],
        }),
        sendQueuedMessage,
      ),
    );
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
    expect(getThreadOutboxHold(KEY)).toMatchObject({
      reason: "error",
      causeKeys: ["start-failed:a-1"],
    });
  });

  it("holds a Stop until Resume and undoes a Stop whose interrupt failed", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = accepting();
    await drainThreadOutbox(deps(RUNNING, sendQueuedMessage));

    const failedStop = holdThreadOutboxForInterrupt(KEY, "turn-1");
    expect(getThreadOutboxHold(KEY)?.reason).toBe("interrupted");
    failedStop.undo();
    expect(getThreadOutboxHold(KEY)).toBeNull();

    holdThreadOutboxForInterrupt(KEY, "turn-1");
    const interrupted = view({ latestTurn: { turnId: "turn-1" as TurnId, state: "interrupted" } });
    await drainThreadOutbox(deps(interrupted, sendQueuedMessage));
    expect(sendQueuedMessage).not.toHaveBeenCalled();
    releaseThreadOutboxHold(KEY);
    await drainThreadOutbox(deps(interrupted, sendQueuedMessage));
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
  });

  it("persists a hold across hydration", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    holdThreadOutboxForInterrupt(KEY, "turn-1");
    await vi.waitFor(() => expect(kv.get("ryco.threadOutboxHolds.v1")).toContain("interrupt"));
    const persisted = new Map(kv);

    resetThreadOutboxForTests();
    for (const [key, value] of persisted) kv.set(key, value);
    await hydrateThreadOutbox();

    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m1"]);
    expect(getThreadOutboxHold(KEY)).toMatchObject({
      reason: "interrupted",
      causeKeys: ["interrupt:turn-1"],
    });
    const sendQueuedMessage = accepting();
    await drainThreadOutbox(deps(IDLE, sendQueuedMessage));
    expect(sendQueuedMessage).not.toHaveBeenCalled();
  });

  it("drops malformed persisted holds and a hold for an empty thread", async () => {
    kv.set(
      "ryco.threadOutboxHolds.v1",
      JSON.stringify({
        holds: {
          [KEY]: { reason: "bogus", causeKeys: ["x"], heldAt: "2026-07-24T10:00:00.000Z" },
          "env-a:empty": { reason: "error", causeKeys: ["e"], heldAt: "2026-07-24T10:00:00.000Z" },
        },
        acknowledged: { [KEY]: ["seen", 3] },
      }),
    );
    await hydrateThreadOutbox();
    expect(getThreadOutboxHold(KEY)).toBeNull();
    expect(getThreadOutboxHold("env-a:empty")).toBeNull();
  });

  it("holds a send whose turn has not started after the ack timeout", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-07-24T11:00:00.000Z"));
    const sendQueuedMessage = accepting();
    let now = Date.parse("2026-07-24T12:00:00.000Z");
    await drainThreadOutbox(deps(IDLE, sendQueuedMessage, { now: () => now }));
    now += 91_000;
    await drainThreadOutbox(deps(IDLE, sendQueuedMessage, { now: () => now }));
    expect(getThreadOutboxHold(KEY)).toMatchObject({
      reason: "stalled",
      causeKeys: ["stalled:m1"],
    });
    // A late start auto-releases the stall.
    await drainThreadOutbox(
      deps(
        view({ latestTurn: { turnId: "turn-2" as TurnId, state: "completed" } }),
        sendQueuedMessage,
        { now: () => now },
      ),
    );
    expect(getThreadOutboxHold(KEY)).toBeNull();
    expect(sendQueuedMessage).toHaveBeenCalledTimes(2);
  });

  it("returns to the Stop copy when a stalled send starts late", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-07-24T11:00:00.000Z"));
    const sendQueuedMessage = accepting();
    let now = Date.parse("2026-07-24T12:00:00.000Z");
    await drainThreadOutbox(deps(IDLE, sendQueuedMessage, { now: () => now }));
    holdThreadOutboxForInterrupt(KEY, null);
    now += 91_000;
    await drainThreadOutbox(deps(IDLE, sendQueuedMessage, { now: () => now }));
    expect(getThreadOutboxHold(KEY)?.reason).toBe("stalled");
    await drainThreadOutbox(
      deps(
        view({ latestTurn: { turnId: "turn-2" as TurnId, state: "completed" } }),
        sendQueuedMessage,
        { now: () => now },
      ),
    );
    expect(getThreadOutboxHold(KEY)).toMatchObject({ reason: "interrupted", detail: null });
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
  });
});

it("keeps legacy memory requests without dispatching a changed prompt or later queued messages", async () => {
  const legacy = {
    ...queued("legacy", "2026-09-15T10:00:00.000Z"),
    projectMemory: { projectId: "old", references: [] },
  };
  enqueueThreadOutboxMessage(legacy);
  enqueueThreadOutboxMessage(queued("later", "2026-09-15T11:00:00.000Z"));
  const sendQueuedMessage = accepting();
  await drainThreadOutbox(deps(IDLE, sendQueuedMessage));
  expect(sendQueuedMessage).not.toHaveBeenCalled();
  expect(listThreadOutboxMessages()).toEqual([
    legacy,
    expect.objectContaining({ messageId: "later" }),
  ]);
});

it("retains and pauses reviewed sends with attachments until an explicit retry", async () => {
  const original = {
    ...queued("reviewed", "2026-09-27T00:00:00.000Z"),
    attachments: [
      {
        id: "attachment",
        type: "image",
        name: "fixture.png",
        previewUri: "data:image/png;base64,AA==",
        dataUrl: "data:image/png;base64,AA==",
        mimeType: "image/png",
        sizeBytes: 1,
      },
    ],
  } as QueuedThreadMessage;
  enqueueThreadOutboxMessage(original);
  const sendQueuedMessage = vi.fn(async () => {
    throw new ClaudeResumeReviewError("Send cancelled; draft retained.");
  });
  await drainThreadOutbox(deps(IDLE, sendQueuedMessage));
  expect(listThreadOutboxMessages()[0]?.attachments).toEqual(original.attachments);
  expect(listThreadOutboxMessages()[0]?.resumeReviewError).toContain("cancelled");
  await drainThreadOutbox(deps(IDLE, sendQueuedMessage));
  expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
  retryThreadOutboxReview(original.messageId);
  await drainThreadOutbox(deps(IDLE, async () => {}));
  expect(listThreadOutboxMessages()).toHaveLength(0);
});
