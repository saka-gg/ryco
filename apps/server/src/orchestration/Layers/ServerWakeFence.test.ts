import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CommandId,
  MessageId,
  OrchestrationThreadShell,
  ThreadId,
  ThreadUsageLimit,
} from "@ryco/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { makeCheckpointRevertActivity } from "../checkpointRevertPolicy.ts";
import { COLD_WAKE_GRACE_MS, MAX_COLD_WAKES_IN_FLIGHT } from "../serverWake.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { makeServerWakeFence } from "./ServerWakeFence.ts";

const now = "2026-10-24T10:00:00.000Z";
const T0 = Date.parse(now);
const GRACE = 2 * 60 * 1_000;

const shell = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  ...Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id,
    projectId: "project-1",
    title: id,
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: `${id}-turn`,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: {
      threadId: id,
      status: "ready",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeSessionId: `${id}-runtime`,
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }),
  ...overrides,
});
const withSession = (
  thread: OrchestrationThreadShell,
  session: Partial<NonNullable<OrchestrationThreadShell["session"]>>,
): OrchestrationThreadShell => ({ ...thread, session: { ...thread.session!, ...session } });

const usageLimit = (instanceId: string) =>
  Schema.decodeUnknownSync(ThreadUsageLimit)({
    limitId: "usage-limit:thread:turn",
    provider: "codex",
    providerInstanceId: instanceId,
    turnId: "thread-turn",
    message: "Usage limit reached.",
    limitedAt: now,
    resetAt: null,
    autoResume: null,
    updatedAt: now,
  });

/** Each test gets its own empty database. */
const test = <E>(name: string, body: () => Effect.Effect<void, E, SqlClient.SqlClient>) =>
  it.effect(name, () => body().pipe(Effect.provide(SqlitePersistenceMemory)));

/** One fence on fakes: live sessions per thread, the newest revert per thread. */
const setup = (options: { readonly revertJournal?: boolean } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const live = new Set<string>();
    const failingSessionReads = new Set<string>();
    const reverts = new Map<string, ReturnType<typeof makeCheckpointRevertActivity>>();
    const fence = yield* makeServerWakeFence.pipe(
      Effect.provideService(ProviderService, {
        getSession: (threadId: ThreadId) =>
          failingSessionReads.has(threadId)
            ? Effect.fail(new Error("fixture session read"))
            : Effect.succeed(
                live.has(threadId)
                  ? Option.some({ threadId, runtimeSessionId: `${threadId}-runtime` })
                  : Option.none(),
              ),
      } as never),
      // The journal read is optional on the service; hand-written fakes may lack it.
      Effect.provideService(
        ProjectionSnapshotQuery,
        (options.revertJournal === false
          ? {}
          : {
              getLatestCheckpointRevert: (threadId: ThreadId) =>
                Effect.sync(() => {
                  const activity = reverts.get(threadId);
                  return activity === undefined
                    ? null
                    : { activity, payload: activity.payload as never };
                }),
            }) as never,
      ),
    );
    const pendingStart = (threadId: string, messageId: string) =>
      sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES (${threadId}, NULL, ${messageId}, 'pending', ${now}, '[]')`;
    const startEnded = (
      threadId: string,
      messageId: string,
      kind: "provider.turn.start.failed" | "provider.turn.start.cancelled",
    ) =>
      sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES (${`${kind}:${messageId}`}, ${threadId}, 'error', ${kind}, 'Ended', ${JSON.stringify({ messageId })}, ${now})`;
    const bind = (threadId: string, messageId: string) =>
      sql`UPDATE projection_turns SET turn_id = ${`${messageId}-turn`}
        WHERE thread_id = ${threadId} AND pending_message_id = ${messageId}`;
    /** How many more cold slots can be taken right now (reserves and gives them back). */
    const freeSlots = Effect.gen(function* () {
      let free = 0;
      for (let index = 0; index <= MAX_COLD_WAKES_IN_FLIGHT; index += 1) {
        const threadId = ThreadId.make(`probe-${index}`);
        const messageId = MessageId.make(`probe-${index}`);
        if (!(yield* fence.reserveColdSlot(threadId, messageId, T0))) break;
        free += 1;
      }
      for (let index = 0; index < free; index += 1)
        yield* fence.releaseColdSlot(
          ThreadId.make(`probe-${index}`),
          MessageId.make(`probe-${index}`),
        );
      return free;
    });
    return {
      fence,
      sql,
      live,
      failingSessionReads,
      reverts,
      pendingStart,
      startEnded,
      bind,
      freeSlots,
    };
  });

const thread = ThreadId.make("thread");
const message = (id: string) => MessageId.make(id);

// ── holds ────────────────────────────────────────────────────────────────

describe("ServerWakeFence holds", () => {
  test("a follow-up queue that waits to send goes first; a held one blocks nothing", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const idle = shell("thread");
      assert.equal(yield* h.fence.holdReason(idle, T0), null);
      const waiting = shell("thread", {
        followUpQueueSummary: { count: 2, hold: null, headStatus: "queued", headPreview: "next" },
      });
      // Delegated results and pull request updates wait behind the user's follow-ups...
      assert.equal(yield* h.fence.holdReason(waiting, T0), "busy");
      assert.equal(yield* h.fence.holdReason(waiting, T0, "pull-request-watch"), "busy");
      // ...which the queue itself sends at this idle edge.
      assert.equal(yield* h.fence.holdReason(waiting, T0, "follow-up-queue"), null);
      const held = shell("thread", {
        followUpQueueSummary: {
          count: 2,
          hold: { reason: "paused", detail: null, causeKeys: ["paused:x"], heldAt: now },
          headStatus: "queued",
          headPreview: "next",
        },
      });
      assert.equal(yield* h.fence.holdReason(held, T0), null);
      // A head that waits for Retry sends nothing, so it blocks nothing either.
      const failedHead = shell("thread", {
        followUpQueueSummary: { count: 1, hold: null, headStatus: "failed", headPreview: "x" },
      });
      assert.equal(yield* h.fence.holdReason(failedHead, T0), null);
      // A goal's next turn waits for every queued follow-up, held or waiting for Retry too.
      assert.equal(yield* h.fence.holdReason(idle, T0, "goal-continuation"), null);
      assert.equal(yield* h.fence.holdReason(waiting, T0, "goal-continuation"), "busy");
      assert.equal(yield* h.fence.holdReason(held, T0, "goal-continuation"), "busy");
      assert.equal(yield* h.fence.holdReason(failedHead, T0, "goal-continuation"), "busy");
      // The queue's own pass still waits for an idle thread.
      assert.equal(
        yield* h.fence.holdReason(
          withSession(waiting, { status: "running" }),
          T0,
          "follow-up-queue",
        ),
        "busy",
      );
    }));

  test("holds a usage-limited thread first, even while it is busy with a pending start", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.pendingStart("thread", "queued");
      const busyAndLimited = withSession(shell("thread", { usageLimit: usageLimit("codex") }), {
        status: "running",
      });
      assert.equal(yield* h.fence.holdReason(busyAndLimited, T0), "usage-limited");
      // A limit on another provider instance does not apply to this thread's next turn.
      assert.equal(
        yield* h.fence.holdReason(shell("idle", { usageLimit: usageLimit("other") }), T0),
        null,
      );
    }));

  const blocked: ReadonlyArray<readonly [string, OrchestrationThreadShell]> = [
    ["archived", shell("thread", { archivedAt: now })],
    ["pending approval", shell("thread", { hasPendingApprovals: true })],
    ["pending user input", shell("thread", { hasPendingUserInput: true })],
    ["session starting", withSession(shell("thread"), { status: "starting" })],
    ["session running", withSession(shell("thread"), { status: "running" })],
    [
      "latest turn running",
      shell("thread", {
        latestTurn: { ...shell("thread").latestTurn!, state: "running", completedAt: null },
      }),
    ],
    ["background work", shell("thread", { backgroundLiveness: "working" })],
    [
      "queued user turn",
      shell("thread", { latestUserMessageAt: new Date(T0 + 1_000).toISOString() }),
    ],
  ];
  for (const [reason, blockedShell] of blocked)
    test(`holds a busy thread: ${reason}`, () =>
      Effect.gen(function* () {
        const h = yield* setup();
        assert.equal(yield* h.fence.holdReason(blockedShell, T0 + 2_000), "busy");
      }));

  test("lets an idle thread take a wake, with a stopped session or monitoring work", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.equal(yield* h.fence.holdReason(shell("thread"), T0), null);
      assert.equal(
        yield* h.fence.holdReason(withSession(shell("thread"), { status: "stopped" }), T0),
        null,
      );
      assert.equal(yield* h.fence.holdReason(shell("thread", { session: null }), T0), null);
      assert.equal(
        yield* h.fence.holdReason(shell("thread", { backgroundLiveness: "monitoring" }), T0),
        null,
      );
    }));

  test("blocks on a pending start for two minutes of process time from its first sighting", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const idle = shell("thread");
      assert.equal(yield* h.fence.holdReason(idle, T0), null);
      // A pending start of unknown age (one a restart left behind, say): first seen now.
      yield* h.pendingStart("thread", "stale-start");
      const firstSeen = T0 + 600_000;
      assert.equal(yield* h.fence.holdReason(idle, firstSeen), "busy");
      assert.equal(yield* h.fence.holdReason(idle, firstSeen + GRACE - 1), "busy");
      assert.equal(yield* h.fence.holdReason(idle, firstSeen + GRACE), null);
      // A newer pending start is a new sighting.
      yield* h.pendingStart("thread", "newer-start");
      assert.equal(yield* h.fence.holdReason(idle, firstSeen + GRACE + 1), "busy");
      // A start that failed (or a Stop cancelled) never blocks.
      yield* h.startEnded("thread", "newer-start", "provider.turn.start.failed");
      assert.equal(yield* h.fence.holdReason(idle, firstSeen + GRACE + 2), null);
    }));

  test("keeps the first sighting of a pending start whichever caller saw it", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.pendingStart("thread", "queued");
      // The delegated-result scan sees it first; a pull request pass asks a minute later.
      assert.equal(yield* h.fence.holdReason(shell("thread"), T0), "busy");
      assert.equal(yield* h.fence.holdReason(shell("thread"), T0 + 60_000), "busy");
      // Two minutes after the first sighting, not after the second caller's.
      assert.equal(yield* h.fence.holdReason(shell("thread"), T0 + GRACE), null);
    }));

  test("waits while a checkpoint revert is pending, and only then", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.isFalse(yield* h.fence.reverting(thread, T0));
      h.reverts.set(
        thread,
        makeCheckpointRevertActivity({
          revertRequestId: CommandId.make("revert-1"),
          turnCount: 1,
          status: "rolling-back",
          createdAt: now,
        }),
      );
      assert.isTrue(yield* h.fence.reverting(thread, T0 + 1_000));
      h.reverts.set(
        thread,
        makeCheckpointRevertActivity({
          revertRequestId: CommandId.make("revert-1"),
          turnCount: 1,
          status: "completed",
          createdAt: now,
        }),
      );
      assert.isFalse(yield* h.fence.reverting(thread, T0 + 2_000));
      const withoutJournal = yield* setup({ revertJournal: false });
      assert.isFalse(yield* withoutJournal.fence.reverting(thread, T0));
    }));
});

// ── cold-start budget ────────────────────────────────────────────────────

describe("ServerWakeFence cold-start budget", () => {
  test("counts a thread without a live session, or whose session read fails, as cold", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.live.add("warm");
      h.failingSessionReads.add("unknown");
      assert.deepStrictEqual(yield* h.fence.coldStart(ThreadId.make("warm"), T0), {
        cold: false,
        budgetFull: false,
      });
      assert.isTrue((yield* h.fence.coldStart(ThreadId.make("cold"), T0)).cold);
      assert.isTrue((yield* h.fence.coldStart(ThreadId.make("unknown"), T0)).cold);
    }));

  test("shares one budget of four between callers", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      // Delegated results take three slots, a pull request update the fourth.
      for (const id of ["return-1", "return-2", "return-3"])
        assert.isTrue(yield* h.fence.reserveColdSlot(ThreadId.make(id), message(id), T0));
      assert.isTrue(yield* h.fence.reserveColdSlot(ThreadId.make("watch"), message("watch"), T0));
      assert.isTrue((yield* h.fence.coldStart(ThreadId.make("next"), T0)).budgetFull);
      assert.isFalse(yield* h.fence.reserveColdSlot(ThreadId.make("next"), message("next"), T0));
    }));

  test("gives the last slot to exactly one of two callers that both saw it free", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      for (const id of ["a", "b", "c"])
        yield* h.fence.noteColdWake(ThreadId.make(id), message(id), T0);
      // Both peeked a free budget before either took the slot (the check-then-act race).
      assert.isFalse((yield* h.fence.coldStart(ThreadId.make("return"), T0)).budgetFull);
      assert.isFalse((yield* h.fence.coldStart(ThreadId.make("watch"), T0)).budgetFull);
      const taken = yield* Effect.all(
        [
          h.fence.reserveColdSlot(ThreadId.make("return"), message("return"), T0),
          h.fence.reserveColdSlot(ThreadId.make("watch"), message("watch"), T0),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(taken.toSorted(), [false, true]);
      assert.equal(yield* h.freeSlots, 0);
    }));

  test("gives back a reservation whose wake was not accepted, never an accepted one", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const rejected = ThreadId.make("rejected");
      const accepted = ThreadId.make("accepted");
      assert.isTrue(yield* h.fence.reserveColdSlot(rejected, message("rejected-wake"), T0));
      assert.isTrue(yield* h.fence.reserveColdSlot(accepted, message("accepted-wake"), T0));
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 2);
      yield* h.fence.noteColdWake(accepted, message("accepted-wake"), T0);
      // Another wake's id never gives a slot back.
      yield* h.fence.releaseColdSlot(rejected, message("other-wake"));
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 2);
      yield* h.fence.releaseColdSlot(rejected, message("rejected-wake"));
      yield* h.fence.releaseColdSlot(accepted, message("accepted-wake"));
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 1);
    }));

  test("keeps a thread's accepted slot when its next reservation is given back", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.fence.noteColdWake(thread, message("first-wake"), T0);
      assert.isTrue(yield* h.fence.reserveColdSlot(thread, message("second-wake"), T0));
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 1);
      yield* h.fence.releaseColdSlot(thread, message("second-wake"));
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 1);
      // The first wake binds: its slot (the thread's only one) is released.
      yield* h.pendingStart("thread", "first-wake");
      yield* h.bind("thread", "first-wake");
      yield* h.fence.releaseColdSlots(T0 + 1_000);
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT);
    }));

  test("keeps each wake source's reservation on a thread until it gives its own back", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      // A pull request update and a delegated result both prepare a cold wake for the thread.
      assert.isTrue(yield* h.fence.reserveColdSlot(thread, message("watch-wake"), T0));
      assert.isTrue(yield* h.fence.reserveColdSlot(thread, message("return-wake"), T0));
      // One slot for the thread, not two.
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 1);
      // The pull request update is rejected; the delegated result still goes ahead cold.
      yield* h.fence.releaseColdSlot(thread, message("watch-wake"));
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 1);
      // It is accepted: its slot stays until its start binds or fails.
      yield* h.fence.noteColdWake(thread, message("return-wake"), T0);
      yield* h.fence.releaseColdSlot(thread, message("return-wake"));
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 1);
    }));

  test("frees ended slots on its own once the budget is full", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      for (const id of ["a", "b", "c", "d"]) {
        yield* h.pendingStart(id, `${id}-wake`);
        yield* h.fence.noteColdWake(ThreadId.make(id), message(`${id}-wake`), T0);
      }
      // No caller ran a release pass since the start of "a" bound.
      yield* h.bind("a", "a-wake");
      const later = T0 + 1_000;
      assert.isFalse((yield* h.fence.coldStart(ThreadId.make("next"), later)).budgetFull);
      assert.isTrue(yield* h.fence.reserveColdSlot(ThreadId.make("next"), message("next"), later));
      // Full again and nothing else ended: the budget holds.
      assert.isFalse(
        yield* h.fence.reserveColdSlot(ThreadId.make("last"), message("last"), later + 2_000),
      );
    }));

  test("drops a reservation its caller never gave back after 120 s", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.isTrue(yield* h.fence.reserveColdSlot(thread, message("lost-wake"), T0));
      yield* h.fence.releaseColdSlots(T0 + COLD_WAKE_GRACE_MS - 1);
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT - 1);
      yield* h.fence.releaseColdSlots(T0 + COLD_WAKE_GRACE_MS);
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT);
    }));

  test("releases a slot when its start binds, when it fails, and after 120 s", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      for (const id of ["bound", "failed", "cancelled", "pending"]) {
        yield* h.pendingStart(id, `${id}-wake`);
        yield* h.fence.noteColdWake(ThreadId.make(id), message(`${id}-wake`), T0);
      }
      assert.equal(yield* h.freeSlots, 0);
      yield* h.bind("bound", "bound-wake");
      yield* h.startEnded("failed", "failed-wake", "provider.turn.start.failed");
      yield* h.startEnded("cancelled", "cancelled-wake", "provider.turn.start.cancelled");
      yield* h.fence.releaseColdSlots(T0 + 1_000);
      assert.equal(yield* h.freeSlots, 3);
      yield* h.fence.releaseColdSlots(T0 + COLD_WAKE_GRACE_MS - 1);
      assert.equal(yield* h.freeSlots, 3);
      yield* h.fence.releaseColdSlots(T0 + COLD_WAKE_GRACE_MS);
      assert.equal(yield* h.freeSlots, MAX_COLD_WAKES_IN_FLIGHT);
    }));
});

// ── reads ────────────────────────────────────────────────────────────────

describe("ServerWakeFence reads", () => {
  test("reads a wake's start state and the latest user message the guard pins", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.equal(yield* h.fence.wakeStartState(thread, message("wake")), "absent");
      yield* h.pendingStart("thread", "wake");
      assert.equal(yield* h.fence.wakeStartState(thread, message("wake")), "pending");
      yield* h.bind("thread", "wake");
      assert.equal(yield* h.fence.wakeStartState(thread, message("wake")), "bound");
      assert.isNull(yield* h.fence.latestUserMessageId(thread));
      for (const [id, createdAt] of [
        ["older", now],
        ["newer", new Date(T0 + 1_000).toISOString()],
      ] as const)
        yield* h.sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${id}, 'thread', NULL, 'user', ${id}, 0, ${createdAt}, ${createdAt})`;
      assert.equal(yield* h.fence.latestUserMessageId(thread), "newer");
    }));
});
