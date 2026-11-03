import { PassThrough } from "node:stream";

import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationThread,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import { Effect, Exit, Layer, PubSub, Scope, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import {
  agentWorkHoldConsumers,
  DesktopAgentWorkFramesLive,
  makeAgentWorkHoldLayer,
  ProviderBusyMarkerLive,
} from "./agentWorkHold.ts";
import {
  attachDesktopLifecycleChannel,
  detachDesktopLifecycleChannelForTests,
} from "./desktopLifecycle.ts";
import {
  AGENT_WORK_RELEASE_DEBOUNCE_MS,
  AgentWorkActivity,
  AgentWorkActivityLive,
  type AgentWorkState,
} from "./orchestration/AgentWorkActivity.ts";
import type { ProviderInstallLockRuntime } from "./provider/providerInstallLock.ts";
import { ProviderInstallLock } from "./provider/Services/ProviderInstallLock.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./orchestration/ThreadBackgroundLiveness.ts";

afterEach(() => {
  detachDesktopLifecycleChannelForTests();
});

const settle = Effect.gen(function* () {
  for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

/** Attaches a desktop pipe and returns the `agent-work` frames written to it. */
function desktopPipe() {
  const pipe = new PassThrough();
  const lines: string[] = [];
  let buffer = "";
  pipe.setEncoding("utf8");
  pipe.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  attachDesktopLifecycleChannel(pipe);
  return {
    frames: () =>
      lines
        .map((line) => JSON.parse(line) as { type: string; working?: boolean; keepAwake?: boolean })
        .filter((frame) => frame.type === "agent-work"),
  };
}

describe("DesktopAgentWorkFramesLive", () => {
  it.effect("writes the first state and every distinct change, nothing else", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pipe = desktopPipe();
        const ref = yield* SubscriptionRef.make<AgentWorkState>({
          working: false,
          keepAwake: false,
        });
        yield* Layer.build(
          DesktopAgentWorkFramesLive.pipe(
            Layer.provide(
              Layer.succeed(AgentWorkActivity, {
                current: SubscriptionRef.get(ref),
                changes: SubscriptionRef.changes(ref),
                interruptible: Effect.succeed(false),
                restartInterruptible: Effect.succeed(false),
              }),
            ),
          ),
        );
        yield* settle;
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        assert.deepStrictEqual(pipe.frames(), [
          { type: "agent-work", working: false, keepAwake: false },
        ]);

        yield* SubscriptionRef.set(ref, { working: false, keepAwake: false });
        yield* SubscriptionRef.set(ref, { working: false, keepAwake: false });
        yield* SubscriptionRef.set(ref, { working: true, keepAwake: true });
        yield* settle;
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        assert.deepStrictEqual(pipe.frames(), [
          { type: "agent-work", working: false, keepAwake: false },
          { type: "agent-work", working: true, keepAwake: true },
        ]);
      }),
    ),
  );
});

describe("makeAgentWorkHoldLayer", () => {
  it("builds nothing for a headless node that does not hold the machine awake while working", () => {
    assert.strictEqual(makeAgentWorkHoldLayer({ mode: "web" }), Layer.empty);
    assert.strictEqual(
      makeAgentWorkHoldLayer({ mode: "web", keepAwakeWhileWorking: false }),
      Layer.empty,
    );
    // --prevent-sleep already holds it for the whole run.
    assert.strictEqual(
      makeAgentWorkHoldLayer({ mode: "web", preventSleep: true, keepAwakeWhileWorking: true }),
      Layer.empty,
    );
  });

  it("holds a headless node awake itself, and leaves a desktop backend's hold to Desktop", () => {
    assert.deepStrictEqual(agentWorkHoldConsumers({ mode: "web", keepAwakeWhileWorking: true }), {
      desktopFrames: false,
      headlessHold: true,
    });
    assert.deepStrictEqual(
      agentWorkHoldConsumers({ mode: "web", preventSleep: false, keepAwakeWhileWorking: true }),
      { desktopFrames: false, headlessHold: true },
    );
    // Headless flags never start the headless hold in desktop mode.
    assert.deepStrictEqual(
      agentWorkHoldConsumers({ mode: "desktop", preventSleep: false, keepAwakeWhileWorking: true }),
      { desktopFrames: true, headlessHold: false },
    );
    assert.deepStrictEqual(agentWorkHoldConsumers({ mode: "desktop" }), {
      desktopFrames: true,
      headlessHold: false,
    });
  });

  it.effect("reports a chain of turns as one hold: one rise and one fall of keepAwake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pipe = desktopPipe();
        let threads: ReadonlyArray<OrchestrationThread> = [];
        const bus = yield* PubSub.bounded<OrchestrationEvent>(64);
        const engine = {
          getReadModel: () => Effect.sync(() => ({ threads })),
          subscribeDomainEvents: Effect.map(PubSub.subscribe(bus), Stream.fromSubscription),
        } as unknown as OrchestrationEngineShape;
        yield* Layer.build(
          makeAgentWorkHoldLayer({ mode: "desktop" }).pipe(
            Layer.provide(AgentWorkActivityLive),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(OrchestrationEngineService, engine),
                ThreadBackgroundLiveness.layer,
              ),
            ),
          ),
        );
        const setTurn = (active: boolean) =>
          Effect.gen(function* () {
            threads = [
              {
                id: "thread",
                deletedAt: null,
                session: {
                  status: active ? "running" : "ready",
                  activeTurnId: active ? "turn" : null,
                  runtimeSessionId: "runtime-1",
                } as unknown as OrchestrationSession,
              } as unknown as OrchestrationThread,
            ];
            yield* PubSub.publish(bus, { type: "thread.session-set" } as OrchestrationEvent);
            yield* settle;
          });
        yield* settle;
        // Three 10-second turns, 10 seconds apart.
        for (let turn = 0; turn < 3; turn += 1) {
          yield* setTurn(true);
          yield* TestClock.adjust("10 seconds");
          yield* setTurn(false);
          if (turn < 2) yield* TestClock.adjust("10 seconds");
        }
        yield* TestClock.adjust(`${AGENT_WORK_RELEASE_DEBOUNCE_MS} millis`);
        yield* settle;
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        const frames = pipe.frames();
        const keepAwake = frames.map((frame) => frame.keepAwake);
        const edges = keepAwake.filter(
          (value, index) => index > 0 && value !== keepAwake[index - 1],
        );
        assert.deepStrictEqual(edges, [true, false]);
        // The first report, three starts and three stops of `working`, and the end of the tail.
        assert.strictEqual(frames.length, 8);
        assert.deepStrictEqual(frames.at(-1), {
          type: "agent-work",
          working: false,
          keepAwake: false,
        });
      }),
    ),
  );
});

describe("ProviderBusyMarkerLive", () => {
  it.effect("keeps this process's busy marker while agents work or their tail lasts", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<AgentWorkState>({
        working: false,
        keepAwake: false,
      });
      const marks: Array<string> = [];
      // The lock's marker, as `holdBusy` keeps it: written, then removed once interrupted.
      const holdBusy = Effect.acquireUseRelease(
        Effect.sync(() => marks.push("marked")),
        () => Effect.never,
        () => Effect.sync(() => marks.push("removed")),
      );
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        ProviderBusyMarkerLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AgentWorkActivity, {
                current: SubscriptionRef.get(ref),
                changes: SubscriptionRef.changes(ref),
                interruptible: Effect.succeed(false),
                restartInterruptible: Effect.succeed(false),
              }),
              Layer.succeed(ProviderInstallLock, {
                lock: Effect.succeed({ holdBusy } as unknown as ProviderInstallLockRuntime),
                beforeLaunch: () => Effect.void,
              }),
            ),
          ),
        ),
        scope,
      );
      yield* settle;
      // Idle at first: nothing on disk.
      assert.deepStrictEqual(marks, []);

      yield* SubscriptionRef.set(ref, { working: true, keepAwake: true });
      yield* settle;
      // A turn ends, the tail goes on: still one marker.
      yield* SubscriptionRef.set(ref, { working: false, keepAwake: true });
      yield* settle;
      assert.deepStrictEqual(marks, ["marked"]);
      yield* SubscriptionRef.set(ref, { working: false, keepAwake: false });
      yield* settle;
      assert.deepStrictEqual(marks, ["marked", "removed"]);

      // A server that stops while its agents work removes it too.
      yield* SubscriptionRef.set(ref, { working: true, keepAwake: true });
      yield* settle;
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(marks, ["marked", "removed", "marked", "removed"]);
    }),
  );
});
