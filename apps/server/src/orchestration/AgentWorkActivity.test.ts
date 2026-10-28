import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationThread,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger, PubSub, Stream } from "effect";
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
  hasLiveBackgroundWork,
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
  options: { session?: OrchestrationSession | null; deletedAt?: string | null } = {},
): OrchestrationThread =>
  ({
    id,
    deletedAt: options.deletedAt ?? null,
    session: options.session ?? null,
  }) as unknown as OrchestrationThread;

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
