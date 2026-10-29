import {
  CommandId,
  CorrelationId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { DEVICE_IDLE_SHUTDOWN_MS, DeviceManager } from "../DeviceManager.ts";
import { FakeDeviceBackend } from "../FakeDeviceBackend.ts";
import { DeviceService } from "../Services/DeviceService.ts";
import { applyDeviceThreadEvent, DeviceThreadLifecycleLive } from "./DeviceThreadLifecycle.ts";

const now = "2026-10-24T00:00:00.000Z";
const threadId = ThreadId.make("thread-device");
const DEVICE = "FAKE-0001";

const base = (sequence: number) => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: now,
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`command-${sequence}`),
  metadata: {},
});

const sessionSet = (sequence: number, activeTurnId: string | null) =>
  ({
    ...base(sequence),
    type: "thread.session-set",
    payload: {
      threadId,
      session: {
        threadId,
        status: activeTurnId === null ? "ready" : "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
        lastError: null,
        updatedAt: now,
      },
    },
  }) satisfies OrchestrationEvent;

const removal = (
  sequence: number,
  type: "thread.deleted" | "thread.trashed" | "thread.archived",
): OrchestrationEvent => {
  switch (type) {
    case "thread.deleted":
      return { ...base(sequence), type, payload: { threadId, deletedAt: now } };
    case "thread.trashed":
      return { ...base(sequence), type, payload: { threadId, trashedAt: now, updatedAt: now } };
    case "thread.archived":
      return { ...base(sequence), type, payload: { threadId, archivedAt: now, updatedAt: now } };
  }
};

function spyTarget() {
  return {
    observeThreadTurn: vi.fn<(threadId: string, activeTurnId: string | null) => void>(),
    handleThreadRemoved: vi.fn<(threadId: string) => Promise<void>>(async () => undefined),
  };
}

describe("applyDeviceThreadEvent", () => {
  it("reports the projection's running turn, and its end", () => {
    const target = spyTarget();

    applyDeviceThreadEvent(target, sessionSet(1, "turn-1"));
    applyDeviceThreadEvent(target, sessionSet(2, null));

    expect(target.observeThreadTurn.mock.calls).toEqual([
      [threadId, "turn-1"],
      [threadId, null],
    ]);
    expect(target.handleThreadRemoved).not.toHaveBeenCalled();
  });

  it.each(["thread.deleted", "thread.trashed", "thread.archived"] as const)(
    "treats %s as the thread's removal",
    (type) => {
      const target = spyTarget();

      applyDeviceThreadEvent(target, removal(1, type));

      expect(target.handleThreadRemoved.mock.calls).toEqual([[threadId]]);
      expect(target.observeThreadTurn).not.toHaveBeenCalled();
    },
  );

  it("ignores every other event", () => {
    const target = spyTarget();

    applyDeviceThreadEvent(target, {
      ...base(1),
      type: "thread.unarchived",
      payload: { threadId, updatedAt: now },
    });

    expect(target.observeThreadTurn).not.toHaveBeenCalled();
    expect(target.handleThreadRemoved).not.toHaveBeenCalled();
  });

  it("never throws out of a failing target", async () => {
    const throwing = {
      observeThreadTurn: () => {
        throw new Error("boom");
      },
      handleThreadRemoved: () => Promise.reject(new Error("boom")),
    };

    expect(() => applyDeviceThreadEvent(throwing, sessionSet(1, "turn-1"))).not.toThrow();
    expect(() => applyDeviceThreadEvent(throwing, removal(2, "thread.deleted"))).not.toThrow();
    // The rejected removal is swallowed rather than reported as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("DeviceThreadLifecycleLive", () => {
  /** A manager whose idle timers are captured instead of scheduled. */
  function makeManager() {
    const timers = new Map<number, { readonly handler: () => void; readonly ms: number }>();
    let nextTimer = 0;
    const manager = new DeviceManager({
      backend: new FakeDeviceBackend(),
      attachDeadlineMs: 0,
      setTimeout: (handler, ms) => {
        nextTimer += 1;
        timers.set(nextTimer, { handler, ms });
        return nextTimer as unknown as NodeJS.Timeout;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as unknown as number);
      },
    });
    const idleTimers = () =>
      [...timers.values()].filter((timer) => timer.ms === DEVICE_IDLE_SHUTDOWN_MS);
    return { manager, idleTimers };
  }

  const engineLayer = (events: PubSub.PubSub<OrchestrationEvent>) =>
    // Only the hot stream: the layer must not depend on `subscribeDomainEvents`.
    Layer.succeed(OrchestrationEngineService, {
      streamDomainEvents: Stream.fromPubSub(events),
    } as unknown as OrchestrationEngineShape);

  it("ends an agent's device hold when the projection reports the turn over", async () => {
    const { manager, idleTimers } = makeManager();
    const observed = vi.spyOn(manager, "observeThreadTurn");
    const removed = vi.spyOn(manager, "handleThreadRemoved");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          yield* Layer.build(
            DeviceThreadLifecycleLive.pipe(
              Layer.provide(engineLayer(events)),
              Layer.provide(Layer.succeed(DeviceService, { supported: true, manager })),
            ),
          );
          /** Publish until the consumer, forked during the build, has seen it. */
          const deliver = (event: OrchestrationEvent, seen: () => boolean) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 200 && !seen(); attempt += 1) {
                yield* PubSub.publish(events, event);
                yield* Effect.sleep("2 millis");
              }
              expect(seen()).toBe(true);
            });

          yield* deliver(sessionSet(1, "turn-1"), () => observed.mock.calls.length > 0);
          yield* Effect.promise(() =>
            manager.holdForAgentTurn(threadId, DEVICE, () => manager.boot(DEVICE)),
          );
          expect(idleTimers()).toHaveLength(0);

          yield* deliver(sessionSet(2, null), () => idleTimers().length > 0);
          expect(idleTimers()).toHaveLength(1);

          yield* deliver(removal(3, "thread.archived"), () => removed.mock.calls.length > 0);
          expect(removed.mock.calls[0]).toEqual([threadId]);
        }),
      ),
    );
    await manager.dispose();
  });

  it("does not subscribe on a node with no device workspace", async () => {
    let read = false;
    const engine = {
      get streamDomainEvents() {
        read = true;
        return Stream.empty;
      },
    } as unknown as OrchestrationEngineShape;
    const manager = new DeviceManager({ backend: new FakeDeviceBackend() });

    await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          DeviceThreadLifecycleLive.pipe(
            Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
            Layer.provide(Layer.succeed(DeviceService, { supported: false, manager })),
          ),
        ),
      ),
    );

    expect(read).toBe(false);
    await manager.dispose();
  });
});
