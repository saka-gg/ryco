import { assert, describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FollowUpQueueHold,
  type InternalOrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type QueuedFollowUp,
  type RuntimeMode,
  type ThreadTurnStartCommand,
} from "@ryco/contracts";
import { Duration, Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import { makeKeyedSerialWorker } from "@ryco/shared/KeyedSerialWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { restartCauseKey, turnStartFailedCauseKey } from "@ryco/shared/queueHold";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { WakeStartState } from "../persistence/serverWakeQueries.ts";
import { runtimeModePrivilegeRank, serverWakeGuard } from "./serverWake.ts";
import {
  makeServerQueueDrain,
  MAX_QUEUE_DISPATCH_ATTEMPTS,
  QUEUE_DISPATCH_STALL_MS,
  queueDispatchModes,
  queueDispatchRuntimeMode,
  queueStartEndedOf,
  RESTART_HOLD_DETAIL,
  sweptThreadIds,
} from "./serverQueueDrainRuntime.ts";
import type { ServerWakeFenceShape, ServerWakeHold } from "./Services/ServerWakeFence.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claude");

const entry = (id: string, overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp => ({
  messageId: MessageId.make(id),
  text: `text of ${id}`,
  attachments: [],
  modelSelection: { instanceId: CLAUDE, model: "sonnet" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  tokenMode: "balanced",
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  revision: 1,
  status: "queued",
  author: "user",
  ...overrides,
});

type Dispatched = InternalOrchestrationCommand | ThreadTurnStartCommand;

/** The engine's receipts: a command id it saw is answered from its receipt, never run again. */
type Receipts = Map<string, { readonly rejected: string } | "accepted">;

/**
 * The drain on fakes. Dispatches act like the engine and the decider: a seen command id replays
 * its receipt (a refusal stays a refusal), a sent head leaves, a hold merges.
 */
const harness = (
  entries: ReadonlyArray<QueuedFollowUp>,
  queuedAtBoot: ThreadId[] = [],
  options: {
    readonly receipts?: Receipts;
    readonly bootId?: string;
    readonly claudeResumeReview?: Parameters<typeof makeServerQueueDrain>[0]["claudeResumeReview"];
  } = {},
) =>
  Effect.gen(function* () {
    const receipts: Receipts = options.receipts ?? new Map();
    const state = {
      entries: [...entries],
      hold: null as FollowUpQueueHold | null,
      fenceHold: null as ServerWakeHold | null,
      cold: false,
      budgetFull: false,
      slotFree: true,
      reverting: false,
      refuse: null as string | null,
      startStates: new Map<string, WakeStartState>(),
      trashedAt: null as string | null,
      threadRuntimeMode: "full-access" as RuntimeMode,
      session: null as Pick<
        NonNullable<OrchestrationThread["session"]>,
        "providerName" | "providerInstanceId"
      > | null,
    };
    const dispatched: Dispatched[] = [];
    const fenceCalls: string[] = [];
    const holdReasonInputs: Array<{ instanceId: string; source: string | undefined }> = [];
    const fence: ServerWakeFenceShape = {
      holdReason: (shell, _nowMs, source) =>
        Effect.sync(() => {
          holdReasonInputs.push({ instanceId: shell.modelSelection.instanceId, source });
          return state.fenceHold;
        }),
      reverting: () =>
        Effect.sync(() => {
          fenceCalls.push("reverting");
          return state.reverting;
        }),
      coldStart: () => Effect.sync(() => ({ cold: state.cold, budgetFull: state.budgetFull })),
      reserveColdSlot: (_threadId, messageId) =>
        Effect.sync(() => {
          fenceCalls.push(`reserve:${messageId}`);
          return state.slotFree;
        }),
      noteColdWake: (_threadId, messageId) =>
        Effect.sync(() => void fenceCalls.push(`note:${messageId}`)),
      releaseColdSlot: (_threadId, messageId) =>
        Effect.sync(() => void fenceCalls.push(`release:${messageId}`)),
      releaseColdSlots: () => Effect.void,
      wakeStartState: (_threadId, messageId) =>
        Effect.sync(() => state.startStates.get(messageId) ?? "pending"),
      latestUserMessageId: () => Effect.succeed(MessageId.make("latest-user")),
    };
    const thread = () => ({
      id: threadId,
      deletedAt: null,
      trashedAt: state.trashedAt,
      session: state.session,
      followUpQueue:
        state.entries.length === 0 && state.hold === null
          ? undefined
          : { entries: state.entries, hold: state.hold },
    });
    const shell = () =>
      ({
        id: threadId,
        projectId,
        runtimeMode: state.threadRuntimeMode,
        worktreePath: null,
        modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
      }) as unknown as OrchestrationThreadShell;
    const drain = yield* makeServerQueueDrain({
      readModel: Effect.sync(() => ({ threads: [thread()] }) as unknown as OrchestrationReadModel),
      findThread: (threads, id) => threads.find((candidate) => candidate.id === id),
      subscribeDomainEvents: Effect.die("not used"),
      getThreadShellById: () => Effect.sync(() => Option.some(shell())),
      fence,
      serverWakeGuard,
      makeKeyedSerialWorker,
      losslessBackpressureQueuePolicy,
      dispatch: (command) =>
        Effect.suspend(() => {
          dispatched.push(command);
          const receipt = receipts.get(command.commandId);
          if (receipt !== undefined) {
            return receipt === "accepted"
              ? Effect.succeed({ sequence: 1 })
              : Effect.fail(new OrchestrationDispatchCommandError({ message: receipt.rejected }));
          }
          if (command.type === "thread.queue.hold.record") {
            receipts.set(command.commandId, "accepted");
            if (state.entries.length > 0) {
              state.hold = {
                reason: command.hold.reason,
                detail: command.hold.detail,
                causeKeys: [...(state.hold?.causeKeys ?? []), ...command.hold.causeKeys],
                heldAt: state.hold?.heldAt ?? command.createdAt,
              };
            }
            return Effect.succeed({ sequence: 1 });
          }
          if (state.refuse !== null) {
            receipts.set(command.commandId, { rejected: state.refuse });
            return Effect.fail(new OrchestrationDispatchCommandError({ message: state.refuse }));
          }
          receipts.set(command.commandId, "accepted");
          state.entries.shift();
          return Effect.succeed({ sequence: 1 });
        }),
      runtimeModePrivilegeRank,
      queuedAtBoot,
      bootId: options.bootId ?? "42",
      ...(options.claudeResumeReview === undefined
        ? {}
        : { claudeResumeReview: options.claudeResumeReview }),
    });
    const sent = () =>
      dispatched.flatMap((command) =>
        command.type === "thread.turn.start" ? [command.message.messageId as string] : [],
      );
    return { drain, state, dispatched, sent, fenceCalls, holdReasonInputs, receipts };
  });

describe("ServerQueueDrain: Claude resume review", () => {
  const review = { reason: "This large conversation has been idle.", promptTokens: 120_400 };

  it.effect(
    "holds a head that would resume a cold Claude conversation until the person resumes",
    () =>
      Effect.gen(function* () {
        const asked: string[] = [];
        const h = yield* harness([entry("a"), entry("b")], [], {
          claudeResumeReview: (_threadId, target) =>
            Effect.sync(() => {
              asked.push(target.instanceId);
              return review;
            }),
        });
        h.state.session = { providerName: "claudeAgent", providerInstanceId: CLAUDE };
        yield* h.drain.drainThread(threadId);
        assert.deepEqual(h.sent(), []);
        assert.deepEqual(h.state.hold, {
          reason: "review",
          detail:
            "This large conversation has been idle. Resume sends it anyway: Claude reads the whole conversation again (about 120k tokens) without its cache.",
          causeKeys: ["review:a"],
          heldAt: h.state.hold!.heldAt,
        });
        // Held: nothing more is asked or sent.
        yield* h.drain.drainThread(threadId);
        assert.deepEqual(asked, [CLAUDE]);
        // The person's Resume answers the review: the head goes without another one.
        h.state.hold = null;
        yield* h.drain.drainThread(threadId);
        assert.deepEqual(h.sent(), ["a"]);
        assert.deepEqual(asked, [CLAUDE]);
        // Once the queue is gone, nothing about it is remembered.
        h.state.entries = [];
        yield* h.drain.drainThread(threadId);
        assert.equal(h.drain.reviewCount(), 0);
      }),
  );

  it.effect("asks only for a native resume of the thread's own Claude session", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const reviewer = {
        claudeResumeReview: () =>
          Effect.sync(() => {
            asked.push("asked");
            return review;
          }),
      };
      // A Codex session, or a Claude session while the head goes to another instance.
      for (const session of [
        { providerName: "codex", providerInstanceId: CLAUDE },
        { providerName: "claudeAgent", providerInstanceId: CODEX },
      ]) {
        const h = yield* harness([entry("a")], [], reviewer);
        h.state.session = session;
        yield* h.drain.drainThread(threadId);
        assert.deepEqual(h.sent(), ["a"]);
      }
      assert.deepEqual(asked, []);
      // A review that needs nothing sends at once.
      const warm = yield* harness([entry("a")], [], {
        claudeResumeReview: () => Effect.succeed(null),
      });
      warm.state.session = { providerName: "claudeAgent", providerInstanceId: CLAUDE };
      yield* warm.drain.drainThread(threadId);
      assert.deepEqual(warm.sent(), ["a"]);
    }),
  );

  it.effect("sends nothing while the review cannot be read, and asks again on the next pass", () =>
    Effect.gen(function* () {
      let fail = true;
      const h = yield* harness([entry("a")], [], {
        claudeResumeReview: () =>
          fail
            ? Effect.fail(new PersistenceSqlError({ operation: "window", detail: "busy" }))
            : Effect.succeed(null),
      });
      h.state.session = { providerName: "claudeAgent", providerInstanceId: CLAUDE };
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.dispatched, []);
      fail = false;
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a"]);
    }),
  );
});

describe("ServerQueueDrain", () => {
  it.effect("sends one head per idle edge, and the next head waits for the previous start", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a"), entry("b")]);
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a"]);
      const [command] = h.dispatched as [ThreadTurnStartCommand];
      assert.equal(command.commandId, "queue-drain:thread-1:a:1:42:1");
      assert.deepEqual(command.queueDispatch, { messageId: "a", revision: 1 });
      // The entry's own model and modes, behind the thread's wake guard.
      assert.deepEqual(command.modelSelection, { instanceId: CLAUDE, model: "sonnet" });
      assert.equal(command.runtimeMode, "approval-required");
      assert.equal(command.interactionMode, "plan");
      assert.equal(command.tokenMode, "balanced");
      assert.deepEqual(command.delegationReturnGuard, {
        latestUserMessageId: MessageId.make("latest-user"),
        projectId,
        runtimeMode: "full-access",
        worktreePath: null,
        source: "follow-up-queue",
      });
      // The usage limit is judged for the instance the head targets, and the queue's own pass
      // is not held behind itself.
      assert.deepEqual(h.holdReasonInputs[0], { instanceId: CLAUDE, source: "follow-up-queue" });

      // "a" has not started yet: "b" waits even though the fence reads idle.
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a"]);
      h.state.startStates.set("a", "bound");
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a", "b"]);
    }),
  );

  it.effect("sends nothing while held, busy, limited, or while its head waits for Retry", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a")]);
      h.state.hold = { reason: "paused", detail: null, causeKeys: ["paused:x"], heldAt: "now" };
      yield* h.drain.drainThread(threadId);
      h.state.hold = null;
      h.state.fenceHold = "busy";
      yield* h.drain.drainThread(threadId);
      h.state.fenceHold = "usage-limited";
      yield* h.drain.drainThread(threadId);
      h.state.fenceHold = null;
      h.state.entries = [entry("a", { status: "failed" })];
      yield* h.drain.drainThread(threadId);
      h.state.entries = [entry("a", { status: "steering" })];
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.dispatched, []);
    }),
  );

  it.effect("a cold start takes a slot, notes the accepted wake and waits on a full budget", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a"), entry("b"), entry("c")]);
      h.state.cold = true;
      h.state.budgetFull = true;
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), []);

      h.state.budgetFull = false;
      h.state.slotFree = false;
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), []);
      assert.deepEqual(h.fenceCalls, ["reserve:a"]);

      h.state.slotFree = true;
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a"]);
      assert.deepEqual(h.fenceCalls.slice(1), ["reserve:a", "reverting", "note:a"]);

      // A refused cold dispatch gives its slot back.
      h.state.startStates.set("a", "bound");
      h.state.refuse = "The chat changed while this queued message was being sent.";
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.fenceCalls.slice(4), ["reserve:b", "reverting", "release:b"]);
    }),
  );

  it.effect("checks a pending revert last and gives the slot back", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a")]);
      h.state.cold = true;
      h.state.reverting = true;
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), []);
      assert.deepEqual(h.fenceCalls, ["reserve:a", "reverting", "release:a"]);
    }),
  );

  it.effect("holds every queue an earlier process left, never sending it", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a")], [threadId]);
      yield* h.drain.holdQueuedAtBoot;
      assert.deepEqual(h.dispatched, [
        {
          type: "thread.queue.hold.record",
          commandId: "queue-restart-hold:thread-1:42",
          threadId,
          // The drain spells the shared cause keys out; they must stay the same.
          hold: {
            reason: "restart",
            causeKeys: [restartCauseKey("42")],
            detail: RESTART_HOLD_DETAIL,
          },
          createdAt: "1970-01-01T00:00:00.000Z",
        },
      ] as never);
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), []);
    }),
  );

  it.effect("a sent entry's failed start holds the rest; a Stop-cancelled one does not", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a"), entry("b"), entry("c")]);
      yield* h.drain.drainThread(threadId);
      h.state.startStates.set("a", "failed");
      // Until the failure's event is handled, nothing else goes.
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a"]);
      yield* h.drain.onStartEnded(threadId, {
        messageId: MessageId.make("a"),
        activityId: "activity-1",
        cancelled: false,
        detail: "Provider unavailable.",
      });
      assert.deepEqual(h.state.hold?.causeKeys, [turnStartFailedCauseKey("activity-1")]);
      assert.equal(h.state.hold?.reason, "error");
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a"]);

      // Resume, send "b"; a Stop cancels its start: no hold, "c" goes next.
      h.state.hold = null;
      yield* h.drain.drainThread(threadId);
      h.state.startStates.set("b", "failed");
      yield* h.drain.onStartEnded(threadId, {
        messageId: MessageId.make("b"),
        activityId: "activity-2",
        cancelled: true,
        detail: null,
      });
      assert.equal(h.state.hold, null);
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a", "b", "c"]);
      // A start this process did not send is not the queue's.
      yield* h.drain.onStartEnded(threadId, {
        messageId: MessageId.make("other"),
        activityId: "activity-3",
        cancelled: false,
        detail: null,
      });
      assert.equal(h.state.hold, null);
    }),
  );

  it.effect("a refused head is retried under fresh ids, then holds the queue", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a")]);
      h.state.refuse = "Thread is busy.";
      for (let pass = 0; pass < MAX_QUEUE_DISPATCH_ATTEMPTS; pass += 1) {
        yield* h.drain.drainThread(threadId);
      }
      assert.deepEqual(
        h.dispatched.map((command) => command.commandId),
        [
          "queue-drain:thread-1:a:1:42:1",
          "queue-drain:thread-1:a:1:42:2",
          "queue-drain:thread-1:a:1:42:3",
          "queue-refused-hold:thread-1:42:4",
        ],
      );
      assert.equal(h.state.hold?.reason, "error");
      assert.deepEqual(h.state.hold?.causeKeys, ["dispatch-refused:a:1"]);
    }),
  );

  it.effect("after a refused hold, Resume sends the head again under ids never used", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a")]);
      h.state.refuse = "Thread is busy.";
      for (let pass = 0; pass < MAX_QUEUE_DISPATCH_ATTEMPTS; pass += 1) {
        yield* h.drain.drainThread(threadId);
      }
      // Resume, refused again: a new hold is recorded (its id is new too).
      h.state.hold = null;
      for (let pass = 0; pass < MAX_QUEUE_DISPATCH_ATTEMPTS; pass += 1) {
        yield* h.drain.drainThread(threadId);
      }
      assert.equal((h.state.hold as FollowUpQueueHold | null)?.reason, "error");
      // Resume once more and the thread is idle: the head goes out.
      h.state.hold = null;
      h.state.refuse = null;
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.state.entries, []);
      const ids = h.dispatched.map((command) => command.commandId);
      assert.equal(new Set(ids).size, ids.length);

      // A restarted process (a new start id, the same receipts) is never answered from them.
      const restarted = yield* harness([entry("a", { revision: 2 })], [], {
        receipts: h.receipts,
        bootId: "43",
      });
      restarted.state.refuse = "Thread is busy.";
      yield* restarted.drain.drainThread(threadId);
      restarted.state.refuse = null;
      yield* restarted.drain.drainThread(threadId);
      assert.deepEqual(restarted.state.entries, []);
    }),
  );

  it.effect("counts refusals for the current head only", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a"), entry("b")]);
      h.state.refuse = "Thread is busy.";
      yield* h.drain.drainThread(threadId);
      yield* h.drain.drainThread(threadId);
      // "a" is removed: "b" starts over, and nothing is kept for "a".
      h.state.entries = [entry("b")];
      yield* h.drain.drainThread(threadId);
      assert.equal(h.drain.refusalCount(), 1);
      assert.equal(h.state.hold, null);
      h.state.entries = [];
      yield* h.drain.drainThread(threadId);
      assert.equal(h.drain.refusalCount(), 0);
    }),
  );

  it.effect("an entry the person did not queue never raises the thread's runtime mode", () =>
    Effect.gen(function* () {
      const h = yield* harness([
        entry("agent", { author: "agent", runtimeMode: "full-access" }),
        entry("user", { author: "user", runtimeMode: "full-access" }),
      ]);
      h.state.threadRuntimeMode = "approval-required";
      yield* h.drain.drainThread(threadId);
      h.state.startStates.set("agent", "bound");
      yield* h.drain.drainThread(threadId);
      const modes = h.dispatched.flatMap((command) =>
        command.type === "thread.turn.start" ? [command.runtimeMode] : [],
      );
      // The agent's entry runs at the thread's lower mode; the person's own at its own.
      assert.deepEqual(modes, ["approval-required", "full-access"]);
      // An entry queued with a lower mode than the thread's keeps its own.
      assert.equal(
        queueDispatchRuntimeMode(
          { author: "automation", runtimeMode: "approval-required" },
          "full-access",
          runtimeModePrivilegeRank,
        ),
        "approval-required",
      );
    }),
  );

  it("sends an agent's entry with the chat's current model and modes, a person's with its own", () => {
    const chat = {
      modelSelection: { instanceId: "claude", model: "chat-model" },
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      tokenMode: "aggressive",
    } as const;
    const queuedWith = {
      modelSelection: { instanceId: "codex", model: "queued-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      tokenMode: "off",
    } as const;
    const agent = queueDispatchModes(
      entry("agent", { author: "agent", ...queuedWith } as Partial<QueuedFollowUp>),
      chat as never,
      runtimeModePrivilegeRank,
    );
    // The chat's own model and modes, so the chat is never switched back; never above the
    // runtime mode the entry was queued with.
    assert.deepEqual(agent as unknown, { ...chat, runtimeMode: "auto-accept-edits" });
    const lowerQueued = queueDispatchModes(
      entry("agent", { author: "automation", runtimeMode: "approval-required" }),
      chat as never,
      runtimeModePrivilegeRank,
    );
    assert.equal(lowerQueued.runtimeMode, "approval-required");
    const person = queueDispatchModes(
      entry("user", { author: "user", ...queuedWith } as Partial<QueuedFollowUp>),
      chat as never,
      runtimeModePrivilegeRank,
    );
    assert.deepEqual(person as unknown, queuedWith);
  });

  it.effect("sends nothing for a thread in Trash", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a")]);
      h.state.trashedAt = "2026-10-24T10:00:00.000Z";
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.dispatched, []);
    }),
  );

  it.effect("a start that neither binds nor fails for long holds the queue as stalled", () =>
    Effect.gen(function* () {
      const h = yield* harness([entry("a"), entry("b")]);
      yield* h.drain.drainThread(threadId);
      yield* TestClock.adjust(Duration.millis(QUEUE_DISPATCH_STALL_MS));
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a"]);
      assert.equal(h.state.hold?.reason, "stalled");
      assert.deepEqual(h.state.hold?.causeKeys, ["stalled:a"]);
      // Resumed by the user: the queue stops waiting for "a".
      h.state.hold = null;
      yield* h.drain.drainThread(threadId);
      assert.deepEqual(h.sent(), ["a", "b"]);
    }),
  );
});

describe("sweptThreadIds", () => {
  it("passes over unheld queues with an entry only", () => {
    const thread = (id: string, followUpQueue?: OrchestrationThread["followUpQueue"]) =>
      ({
        id: ThreadId.make(id),
        ...(followUpQueue ? { followUpQueue } : {}),
      }) as OrchestrationThread;
    const hold: FollowUpQueueHold = {
      reason: "paused",
      detail: null,
      causeKeys: ["x"],
      heldAt: "t",
    };
    expect(
      sweptThreadIds([
        thread("waiting", { entries: [entry("a")], hold: null }),
        thread("held", { entries: [entry("a")], hold }),
        thread("none"),
      ] as unknown as OrchestrationReadModel["threads"]),
    ).toEqual(["waiting"]);
  });
});

describe("queueStartEndedOf", () => {
  const activity = (kind: string, payload: unknown): OrchestrationEvent =>
    ({
      type: "thread.activity-appended",
      payload: {
        threadId,
        activity: {
          id: EventId.make("activity-1"),
          tone: "error",
          kind,
          summary: "Provider turn start failed",
          payload,
          turnId: null,
          createdAt: "2026-10-24T10:00:00.000Z",
        },
      },
    }) as unknown as OrchestrationEvent;

  it("reads failed and cancelled starts of a message, nothing else", () => {
    assert.deepEqual(
      queueStartEndedOf(activity("provider.turn.start.failed", { messageId: "a", detail: "x" })),
      { messageId: MessageId.make("a"), activityId: "activity-1", cancelled: false, detail: "x" },
    );
    assert.equal(
      queueStartEndedOf(activity("provider.turn.start.cancelled", { messageId: "a" }))?.cancelled,
      true,
    );
    assert.equal(queueStartEndedOf(activity("tool.started", { messageId: "a" })), null);
    assert.equal(queueStartEndedOf(activity("provider.turn.start.failed", {})), null);
  });
});
