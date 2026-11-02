import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationThread,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Logger, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  ServerRuntimeStartup,
  ServerRuntimeStartupError,
  type ServerRuntimeStartupShape,
} from "../serverRuntimeStartup.ts";
import {
  AGENT_WORK_RECONCILE_INTERVAL_MS,
  AGENT_WORK_RELEASE_DEBOUNCE_MS,
  type AgentWorkState,
  hasInterruptibleWork,
  hasLiveBackgroundWork,
  hasRestartContinuationCandidate,
  hasRunningTurn,
  isAgentWorkTrigger,
  isTurnRunning,
  makeAgentWorkActivity,
  stepAgentWork,
} from "./AgentWorkActivity.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { restartCandidateShape } from "./restartContinuationPolicy.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

const session = (
  status: OrchestrationSession["status"],
  activeTurnId: string | null,
  runtimeSessionId: string | undefined = "runtime-1",
): OrchestrationSession =>
  ({
    threadId: "thread",
    status,
    providerName: "codex",
    runtimeSessionId,
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: "2026-10-24T10:00:00.000Z",
  }) as unknown as OrchestrationSession;

const thread = (
  id: string,
  options: {
    session?: OrchestrationSession | null;
    deletedAt?: string | null;
    archivedAt?: string | null;
    activities?: ReadonlyArray<unknown>;
    latestTurn?: { turnId: string; state: string } | null;
  } = {},
): OrchestrationThread =>
  ({
    id,
    deletedAt: options.deletedAt ?? null,
    archivedAt: options.archivedAt ?? null,
    session: options.session ?? null,
    activities: options.activities ?? [],
    latestTurn: options.latestTurn ?? null,
    messages: [],
  }) as unknown as OrchestrationThread;

/** A request the provider raised, as the thread's activity log records it. */
const requested = (
  kind: "approval.requested" | "user-input.requested",
  requestId: string,
  payload: Record<string, unknown> = {},
) => ({
  id: `activity-${requestId}`,
  kind,
  tone: "info",
  summary: kind,
  turnId: "turn-1",
  payload: { requestId, ...payload },
  createdAt: "2026-10-24T10:00:00.000Z",
});

const running = (id = "thread", runtimeSessionId?: string) =>
  thread(id, { session: session("running", "turn-1", runtimeSessionId) });
const idle = (id = "thread", runtimeSessionId?: string) =>
  thread(id, { session: session("ready", null, runtimeSessionId) });

const event = (type: string) => ({ type }) as unknown as OrchestrationEvent;

const startTask = (
  liveness: ThreadBackgroundLiveness.ThreadBackgroundLivenessService["Service"],
  threadId = "thread",
  runtimeSessionId: string | null = "runtime-1",
) =>
  liveness.recordTaskLiveness({
    threadId,
    taskId: "subagent-1",
    taskType: "subagent",
    status: undefined,
    kind: "started",
    runtimeSessionId,
  });

const settle = Effect.gen(function* () {
  for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

/**
 * The real tracker over a fake engine: an in-memory model, a bounded bus, the real liveness
 * registry, and a startup gate the test opens.
 */
const makeHarness = (options: { busCapacity?: number; startup?: boolean } = {}) =>
  Effect.gen(function* () {
    const state = { threads: [] as ReadonlyArray<OrchestrationThread>, reads: 0, failReads: 0 };
    const bus = yield* PubSub.bounded<OrchestrationEvent>(options.busCapacity ?? 4_096);
    const gate = yield* Deferred.make<void, ServerRuntimeStartupError>();
    const liveness = ThreadBackgroundLiveness.make();
    const engine = {
      getReadModel: () =>
        Effect.sync(() => {
          state.reads += 1;
          if (state.failReads > 0) {
            state.failReads -= 1;
            throw new Error("read model exploded");
          }
          return { threads: state.threads };
        }),
      subscribeDomainEvents: Effect.map(PubSub.subscribe(bus), Stream.fromSubscription),
    } as unknown as OrchestrationEngineShape;
    const startup = {
      awaitCommandReady: Deferred.await(gate),
      markHttpServing: Effect.void,
      enqueueCommand: (effect) => effect,
    } satisfies ServerRuntimeStartupShape;
    const build = makeAgentWorkActivity.pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ThreadBackgroundLiveness.ThreadBackgroundLivenessService, liveness),
    );
    const activity = yield* options.startup === false
      ? build
      : build.pipe(Effect.provideService(ServerRuntimeStartup, startup));
    const emitted: AgentWorkState[] = [];
    yield* activity.changes.pipe(
      Stream.runForEach((value) => Effect.sync(() => emitted.push(value))),
      Effect.forkScoped,
    );
    yield* settle;
    return {
      activity,
      liveness,
      state,
      emitted,
      keepAwakeTrail: () => emitted.map((value) => value.keepAwake),
      setThreads: (threads: ReadonlyArray<OrchestrationThread>) => {
        state.threads = threads;
      },
      publish: (type: string) => PubSub.publish(bus, event(type)).pipe(Effect.andThen(settle)),
      openGate: Deferred.succeed(gate, undefined).pipe(Effect.andThen(settle)),
      failGate: Deferred.fail(gate, new ServerRuntimeStartupError({ message: "boom" })).pipe(
        Effect.andThen(settle),
      ),
      advance: (ms: number) => TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(settle)),
      bus,
    };
  });

describe("agent work predicates", () => {
  it("counts running turns, waiting ones included, on threads that are not deleted", () => {
    assert.isTrue(isTurnRunning(session("running", "turn-1")));
    assert.isFalse(isTurnRunning(session("running", null)));
    assert.isFalse(isTurnRunning(session("ready", null)));
    assert.isFalse(isTurnRunning(null));

    assert.isTrue(hasRunningTurn({ threads: [idle("a"), running("b")] }));
    assert.isFalse(hasRunningTurn({ threads: [idle("a"), thread("b")] }));
    assert.isFalse(
      hasRunningTurn({
        threads: [
          thread("trashed", {
            session: session("running", "turn-1"),
            deletedAt: "2026-10-24T10:00:00.000Z",
          }),
        ],
      }),
    );
  });

  it("counts background work only for a live thread whose current runtime reported it", () => {
    const liveness = ThreadBackgroundLiveness.make();
    startTask(liveness, "thread", "runtime-1");
    assert.isTrue(hasLiveBackgroundWork({ threads: [idle("thread", "runtime-1")] }, liveness));
    // Trashed: the provider was stopped, but its exit is never ingested for a hidden thread.
    assert.isFalse(
      hasLiveBackgroundWork(
        {
          threads: [
            thread("thread", {
              session: session("ready", null, "runtime-1"),
              deletedAt: "2026-10-24T10:00:00.000Z",
            }),
          ],
        },
        liveness,
      ),
    );
    // Replaced runtime: its tasks died with it.
    assert.isFalse(hasLiveBackgroundWork({ threads: [idle("thread", "runtime-2")] }, liveness));
    // No session, or a thread the model does not know.
    assert.isFalse(hasLiveBackgroundWork({ threads: [thread("thread")] }, liveness));
    assert.isFalse(hasLiveBackgroundWork({ threads: [idle("other")] }, liveness));
  });

  it("counts what an update would interrupt beyond running turns: the client's INTERRUPTIBLE", () => {
    const waiting = session("ready", null);
    // Connecting: the provider session is starting.
    assert.isTrue(
      hasInterruptibleWork({ threads: [thread("a", { session: session("starting", null) })] }),
    );
    // Waiting on an approval or a question, whatever the session says.
    assert.isTrue(
      hasInterruptibleWork({
        threads: [
          thread("a", { session: waiting, activities: [requested("approval.requested", "r1")] }),
        ],
      }),
    );
    assert.isTrue(
      hasInterruptibleWork({
        threads: [thread("a", { activities: [requested("user-input.requested", "r2")] })],
      }),
    );
    // A question that does not block the turn, and an answered approval, wait on nobody.
    assert.isFalse(
      hasInterruptibleWork({
        threads: [
          thread("a", {
            activities: [requested("user-input.requested", "r3", { nonBlocking: true })],
          }),
          thread("b", {
            activities: [
              requested("approval.requested", "r4"),
              {
                ...requested("approval.requested", "r4"),
                id: "resolved",
                kind: "approval.resolved",
              },
            ],
          }),
        ],
      }),
    );
    // Idle, archived and deleted threads never count, as on the client.
    assert.isFalse(hasInterruptibleWork({ threads: [idle("a"), thread("b")] }));
    assert.isFalse(
      hasInterruptibleWork({
        threads: [
          thread("archived", {
            session: session("starting", null),
            archivedAt: "2026-10-24T10:00:00.000Z",
          }),
          thread("deleted", {
            activities: [requested("approval.requested", "r5")],
            deletedAt: "2026-10-24T10:00:00.000Z",
          }),
        ],
      }),
    );
  });

  describe("a restart nobody asked for", () => {
    const completed = { turnId: "turn-1", state: "completed" };
    /** Background tasks of `runtimeSessionId`, as a checkpoint in the thread's activity log. */
    const backgroundCheckpoint = (runtimeSessionId: string) => ({
      kind: "background-work.checkpoint",
      payload: {
        version: 1,
        runtimeSessionId,
        ended: false,
        tasks: [
          {
            id: "watch-1",
            title: "watch the build",
            status: "running",
            runtimeSessionId,
            startedAt: "2026-10-24T10:00:00.000Z",
            updatedAt: "2026-10-24T10:00:00.000Z",
          },
        ],
      },
      createdAt: "2026-10-24T10:00:00.000Z",
    });
    /** What would close the restart window: the same predicates `restartInterruptible` reads. */
    const restartWaitsFor = (
      threads: ReadonlyArray<OrchestrationThread>,
      liveness: ThreadBackgroundLiveness.ThreadBackgroundLivenessService["Service"],
    ) =>
      hasRunningTurn({ threads }) ||
      hasLiveBackgroundWork({ threads }, liveness) ||
      hasInterruptibleWork({ threads }) ||
      hasRestartContinuationCandidate({ threads }, new Set(liveness.listLiveThreadIds()));
    /**
     * What the next start's capture (`RestartContinuation`) makes of the thread: no session is
     * live yet, and the shutdown hint names the threads the liveness registry holds.
     */
    const continuedAfterRestart = (
      candidate: OrchestrationThread,
      liveness: ThreadBackgroundLiveness.ThreadBackgroundLivenessService["Service"],
    ) => {
      const hint = liveness.listLiveThreadIds().includes(candidate.id)
        ? { hasBackgroundWork: true, recordedAt: "2026-10-24T10:00:00.000Z" }
        : undefined;
      return restartCandidateShape(candidate, new Set(), hint);
    };

    it("leaves RestartContinuation nothing to continue in any state the window admits", () => {
      const liveness = ThreadBackgroundLiveness.make();
      // Tasks of a replaced runtime stay in the registry; capture finds none for the new one.
      startTask(liveness, "replaced", "runtime-1");
      const admitted = [
        thread("settled", { session: session("ready", null), latestTurn: completed }),
        thread("stopped", { session: session("stopped", null), latestTurn: completed }),
        thread("failed", {
          session: session("error", null),
          latestTurn: { turnId: "turn-1", state: "error" },
        }),
        thread("never-ran"),
        thread("replaced", { session: session("ready", null, "runtime-2"), latestTurn: completed }),
        // Trashed with its session left running: its provider was stopped.
        thread("trashed", {
          session: session("running", "turn-1"),
          latestTurn: { turnId: "turn-1", state: "running" },
          deletedAt: "2026-10-24T10:00:00.000Z",
        }),
      ];
      for (const candidate of admitted) {
        assert.isFalse(restartWaitsFor([candidate], liveness), candidate.id);
        const shape = continuedAfterRestart(candidate, liveness);
        // A background-only candidate without tasks of its runtime is dropped at capture.
        assert.isTrue(
          shape === null || (shape.kind === "background-only" && candidate.id === "replaced"),
          candidate.id,
        );
      }
    });

    it("waits for every thread the next start would continue, beyond what an install waits for", () => {
      const liveness = ThreadBackgroundLiveness.make();
      startTask(liveness, "background", "runtime-1");
      const continued = [
        // An active turn whose session no longer says running.
        thread("active-turn", {
          session: session("ready", "turn-1"),
          latestTurn: completed,
        }),
        // Background tasks of the current runtime that the registry lost track of.
        thread("background", {
          session: session("ready", null, "runtime-2"),
          latestTurn: completed,
          activities: [backgroundCheckpoint("runtime-2")],
        }),
      ];
      for (const candidate of continued) {
        // An install would not wait for these, a restart must.
        assert.isFalse(hasRunningTurn({ threads: [candidate] }), candidate.id);
        assert.isFalse(hasLiveBackgroundWork({ threads: [candidate] }, liveness), candidate.id);
        assert.isFalse(hasInterruptibleWork({ threads: [candidate] }), candidate.id);
        assert.isNotNull(continuedAfterRestart(candidate, liveness), candidate.id);
        assert.isTrue(restartWaitsFor([candidate], liveness), candidate.id);
      }
    });
  });

  it("wakes only on the events that change sessions or deletion", () => {
    for (const type of [
      "thread.session-set",
      "thread.deleted",
      "thread.trashed",
      "thread.untrashed",
    ]) {
      assert.isTrue(isAgentWorkTrigger(event(type)), type);
    }
    for (const type of ["thread.message-sent", "thread.activity-appended", "thread.created"]) {
      assert.isFalse(isAgentWorkTrigger(event(type)), type);
    }
  });

  it("steps the release tail from the recompute that first sees work stopped", () => {
    const tail = AGENT_WORK_RELEASE_DEBOUNCE_MS;
    const none = { working: false, releaseAtMs: null };
    assert.deepStrictEqual(stepAgentWork({ working: true, nowMs: 1_000, previous: none }), {
      state: { working: true, keepAwake: true },
      releaseAtMs: null,
      wakeInMs: null,
    });
    assert.deepStrictEqual(stepAgentWork({ working: false, nowMs: 1_000, previous: none }), {
      state: { working: false, keepAwake: false },
      releaseAtMs: null,
      wakeInMs: null,
    });
    // Falling edge: the full tail, whenever work was last seen before.
    assert.deepStrictEqual(
      stepAgentWork({
        working: false,
        nowMs: 90_000,
        previous: { working: true, releaseAtMs: null },
      }),
      {
        state: { working: false, keepAwake: true },
        releaseAtMs: 90_000 + tail,
        wakeInMs: tail,
      },
    );
    // Inside the tail.
    assert.deepStrictEqual(
      stepAgentWork({
        working: false,
        nowMs: 100_000,
        previous: { working: false, releaseAtMs: 90_000 + tail },
      }),
      {
        state: { working: false, keepAwake: true },
        releaseAtMs: 90_000 + tail,
        wakeInMs: tail - 10_000,
      },
    );
    // At and after its end (a forward clock jump over a system sleep releases at once).
    for (const nowMs of [90_000 + tail, 90_000 + tail * 50]) {
      assert.deepStrictEqual(
        stepAgentWork({
          working: false,
          nowMs,
          previous: { working: false, releaseAtMs: 90_000 + tail },
        }),
        { state: { working: false, keepAwake: false }, releaseAtMs: null, wakeInMs: null },
      );
    }
    // A clock that jumped back an hour never stretches the tail past its length.
    assert.deepStrictEqual(
      stepAgentWork({
        working: false,
        nowMs: 100_000 - 3_600_000,
        previous: { working: false, releaseAtMs: 90_000 + tail },
      }),
      {
        state: { working: false, keepAwake: true },
        releaseAtMs: 100_000 - 3_600_000 + tail,
        wakeInMs: tail,
      },
    );
  });
});

describe("AgentWorkActivity", () => {
  it.effect("is interruptible until the first report and while work or its tail lasts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        // Before the startup command gate opens nothing is known: never interrupt.
        assert.isTrue(yield* harness.activity.interruptible);
        yield* harness.openGate;
        assert.isFalse(yield* harness.activity.interruptible);

        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        assert.isTrue(yield* harness.activity.interruptible);
        harness.setThreads([idle()]);
        yield* harness.publish("thread.session-set");
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS - 1);
        assert.isTrue(yield* harness.activity.interruptible);
        yield* harness.advance(1);
        assert.isFalse(yield* harness.activity.interruptible);

        // A session starting needs no domain event to count: it is read at the call.
        harness.setThreads([thread("thread", { session: session("starting", null) })]);
        assert.isTrue(yield* harness.activity.interruptible);
      }),
    ),
  );

  it.effect("waits before a restart for a thread the next start would continue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        assert.isTrue(yield* harness.activity.restartInterruptible);
        yield* harness.openGate;
        assert.isFalse(yield* harness.activity.restartInterruptible);
        harness.setThreads([
          thread("thread", {
            session: session("ready", "turn-1"),
            latestTurn: { turnId: "turn-1", state: "completed" },
          }),
        ]);
        assert.isFalse(yield* harness.activity.interruptible);
        assert.isTrue(yield* harness.activity.restartInterruptible);
        // Whatever `interruptible` waits for, a restart waits for too.
        harness.setThreads([running()]);
        assert.isTrue(yield* harness.activity.restartInterruptible);
        harness.state.failReads = 1;
        harness.setThreads([idle()]);
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS);
        harness.state.failReads = 1;
        assert.isTrue(yield* harness.activity.restartInterruptible);
      }),
    ),
  );

  it.effect("reads a turn that just started at the call, before any report says so", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.openGate;
        // No domain event yet: the tracker has not recomputed, and still reports idle.
        harness.setThreads([running()]);
        assert.isFalse((yield* harness.activity.current).working);
        assert.isTrue(yield* harness.activity.interruptible);
      }),
    ),
  );

  it.effect("keeps the tail after work on the monotonic clock, whatever the wall clock does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.openGate;
        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        harness.setThreads([idle()]);
        yield* harness.publish("thread.session-set");
        // The wall clock moves back an hour (a clock correction): the tail still ends 2 minutes
        // after the work did.
        yield* TestClock.setTime((yield* Clock.currentTimeMillis) - 3_600_000);
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS - 1);
        assert.isTrue(yield* harness.activity.interruptible);
        yield* harness.advance(1);
        assert.isFalse(yield* harness.activity.interruptible);
      }),
    ),
  );

  it.effect("counts a failed recompute or a failed read as something to interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.openGate;
        harness.setThreads([idle()]);
        harness.state.failReads = 1;
        yield* harness.publish("thread.session-set");
        // The recompute failed and reports idle; the window must not trust that for 2 minutes.
        assert.isFalse((yield* harness.activity.current).keepAwake);
        assert.isTrue(yield* harness.activity.interruptible);
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS);
        assert.isFalse(yield* harness.activity.interruptible);
        // A read that fails at the call cannot tell either.
        harness.state.failReads = 1;
        assert.isTrue(yield* harness.activity.interruptible);
      }),
    ),
  );

  it.effect("reports nothing until the startup command gate opens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        yield* harness.advance(AGENT_WORK_RECONCILE_INTERVAL_MS * 3);
        assert.deepStrictEqual(harness.emitted, []);
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: false,
          keepAwake: false,
        });
        assert.strictEqual(harness.state.reads, 0);

        yield* harness.openGate;
        assert.deepStrictEqual(harness.emitted, [{ working: true, keepAwake: true }]);
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: true,
          keepAwake: true,
        });
      }),
    ),
  );

  it.effect("loses no transition across the seed and holds the tail for exactly two minutes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        yield* harness.openGate;
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: true,
          keepAwake: true,
        });

        harness.setThreads([idle()]);
        yield* harness.publish("thread.session-set");
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: false,
          keepAwake: true,
        });
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS - 1);
        assert.isTrue((yield* harness.activity.current).keepAwake);
        yield* harness.advance(1);
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: false,
          keepAwake: false,
        });
        assert.deepStrictEqual(harness.keepAwakeTrail(), [true, true, false]);
      }),
    ),
  );

  it.effect("starts the tail when work stops, however long it ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ startup: false });
        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        // One reconcile runs during the turn, at 60 s.
        yield* harness.advance(90_000);
        harness.setThreads([idle()]);
        yield* harness.publish("thread.session-set");
        // 210 s after the start: the tail runs 120 s from the stop at 90 s, not from the
        // reconcile at 60 s.
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS - 1);
        assert.isTrue((yield* harness.activity.current).keepAwake);
        yield* harness.advance(1);
        assert.isFalse((yield* harness.activity.current).keepAwake);
      }),
    ),
  );

  it.effect("keeps one hold across turns chained inside the tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ startup: false });
        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        yield* harness.advance(10_000);
        harness.setThreads([idle()]);
        yield* harness.publish("thread.session-set");
        yield* harness.advance(60_000);
        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        yield* harness.advance(30_000);
        harness.setThreads([idle()]);
        yield* harness.publish("thread.session-set");
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS - 1);
        assert.isTrue((yield* harness.activity.current).keepAwake);
        yield* harness.advance(1);
        assert.isFalse((yield* harness.activity.current).keepAwake);
        assert.deepStrictEqual(harness.emitted, [
          // The first report, made before the model had a thread.
          { working: false, keepAwake: false },
          { working: true, keepAwake: true },
          { working: false, keepAwake: true },
          { working: true, keepAwake: true },
          { working: false, keepAwake: true },
          { working: false, keepAwake: false },
        ]);
      }),
    ),
  );

  it.effect("counts background work that outlives its turn, with no domain event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ startup: false });
        harness.setThreads([idle()]);
        yield* harness.advance(0);
        assert.isFalse((yield* harness.activity.current).working);

        startTask(harness.liveness);
        yield* settle;
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: true,
          keepAwake: true,
        });

        harness.liveness.clearThreadLiveness("thread");
        yield* settle;
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: false,
          keepAwake: true,
        });
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS);
        assert.isFalse((yield* harness.activity.current).keepAwake);
      }),
    ),
  );

  it.effect("stops counting a thread's background work as soon as it is trashed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ startup: false });
        harness.setThreads([idle()]);
        startTask(harness.liveness);
        yield* settle;
        assert.isTrue((yield* harness.activity.current).working);

        // Trash stops the provider, but its exit is dropped for the hidden thread, so the
        // registry keeps the task. The trash event itself triggers the recompute.
        harness.setThreads([
          thread("thread", {
            session: session("ready", null),
            deletedAt: "2026-10-24T10:00:00.000Z",
          }),
        ]);
        yield* harness.publish("thread.trashed");
        assert.isFalse((yield* harness.activity.current).working);
        yield* harness.advance(AGENT_WORK_RELEASE_DEBOUNCE_MS);
        assert.isFalse((yield* harness.activity.current).keepAwake);
        assert.deepStrictEqual(harness.liveness.listLiveThreadIds(), ["thread"]);
      }),
    ),
  );

  it.effect("ignores tasks of a replaced runtime and of a thread without a session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ startup: false });
        startTask(harness.liveness, "thread", "runtime-1");
        harness.setThreads([idle("thread", "runtime-2")]);
        yield* harness.publish("thread.session-set");
        assert.isFalse((yield* harness.activity.current).working);
        harness.setThreads([thread("thread")]);
        yield* harness.publish("thread.session-set");
        assert.isFalse((yield* harness.activity.current).working);
        assert.deepStrictEqual(harness.emitted, [{ working: false, keepAwake: false }]);
      }),
    ),
  );

  it.effect("corrects a change no trigger reported at the next reconcile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ startup: false });
        harness.setThreads([running()]);
        yield* harness.advance(AGENT_WORK_RECONCILE_INTERVAL_MS - 1);
        assert.isFalse((yield* harness.activity.current).working);
        yield* harness.advance(1);
        assert.isTrue((yield* harness.activity.current).working);
      }),
    ),
  );

  it.effect("reports idle while a recompute fails, then recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ startup: false });
        harness.setThreads([running()]);
        yield* harness.publish("thread.session-set");
        assert.isTrue((yield* harness.activity.current).working);

        harness.state.failReads = 1;
        yield* harness.publish("thread.session-set");
        assert.deepStrictEqual(yield* harness.activity.current, {
          working: false,
          keepAwake: false,
        });
        yield* harness.advance(5_000);
        assert.isTrue((yield* harness.activity.current).working);
      }),
    ),
  );

  it.effect("never reports work when startup failed", () => {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        harness.setThreads([running()]);
        yield* harness.failGate;
        yield* harness.publish("thread.session-set");
        yield* harness.advance(AGENT_WORK_RECONCILE_INTERVAL_MS * 2);
        assert.deepStrictEqual(harness.emitted, []);
        assert.isFalse((yield* harness.activity.current).working);
        assert.strictEqual(harness.state.reads, 0);
        assert.strictEqual(warnings.length, 1);
        assert.include(warnings[0], "startup failed");
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.live("drains the bus while startup is pending, so it never blocks the engine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A tracker that waited for startup before draining would fill this bus after 16
        // events and block the publisher (the engine's only command worker) for good.
        const harness = yield* makeHarness({ busCapacity: 16 });
        const startedAt = performance.now();
        const publisher = yield* Effect.forkChild(
          Effect.gen(function* () {
            for (let index = 0; index < 1_000; index += 1) {
              yield* PubSub.publish(harness.bus, event("thread.session-set"));
            }
          }).pipe(Effect.timeout("1 second")),
        );
        yield* Fiber.join(publisher);
        const elapsedMs = performance.now() - startedAt;
        assert.isBelow(elapsedMs, 1_000);
        assert.strictEqual(harness.state.reads, 0);
        yield* Effect.logInfo(`agent work: 1000 events published in ${elapsedMs.toFixed(1)} ms`);
      }),
    ),
  );
});
