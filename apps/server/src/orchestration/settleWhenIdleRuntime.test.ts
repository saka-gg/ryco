import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThreadShell,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { settleWhenIdleReady } from "./Layers/SettleWhenIdle.ts";
import {
  makeSettleWhenIdle,
  SETTLE_WHEN_IDLE_SWEEP_MS,
  type SettleWhenIdleCommand,
} from "./settleWhenIdleRuntime.ts";

const THREAD = "thread-filed" as ThreadId;
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD,
    archivedAt: null,
    settleWhenIdleAt: "2026-10-31T11:00:00.000Z",
    updatedAt: "2026-10-31T11:00:00.000Z",
    latestUserMessageAt: "2026-10-31T10:59:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: { status: "ready", updatedAt: "2026-10-31T11:30:00.000Z" },
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-10-31T10:59:00.000Z",
      startedAt: "2026-10-31T10:59:01.000Z",
      completedAt: "2026-10-31T11:30:00.000Z",
      assistantMessageId: null,
    },
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

const running = () =>
  shell({
    session: { status: "running", updatedAt: "2026-10-31T11:00:00.000Z" },
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-10-31T10:59:00.000Z",
      startedAt: "2026-10-31T10:59:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
  } as unknown as Partial<OrchestrationThreadShell>);

describe("settleWhenIdleReady", () => {
  it("is ready once the turn, requests, queue and background work are done", () => {
    expect(settleWhenIdleReady(shell(), NOW)).toBe(true);
    // A monitor left running does not hold the filing back.
    expect(settleWhenIdleReady(shell({ backgroundLiveness: "monitoring" }), NOW)).toBe(true);
  });

  it("waits while anything is still going or waits on the person", () => {
    expect(settleWhenIdleReady(running(), NOW)).toBe(false);
    expect(settleWhenIdleReady(shell({ backgroundLiveness: "working" }), NOW)).toBe(false);
    expect(settleWhenIdleReady(shell({ hasPendingApprovals: true }), NOW)).toBe(false);
    expect(settleWhenIdleReady(shell({ hasPendingUserInput: true }), NOW)).toBe(false);
    expect(
      settleWhenIdleReady(
        shell({
          followUpQueueSummary: { count: 1, hold: null, headStatus: "queued", headPreview: "x" },
        }),
        NOW,
      ),
    ).toBe(false);
    expect(settleWhenIdleReady(shell({ settleWhenIdleAt: null }), NOW)).toBe(false);
  });
});

describe("settle when idle runtime", () => {
  function harness(initial: OrchestrationThreadShell) {
    let current = initial;
    const sent: Array<SettleWhenIdleCommand> = [];
    const runtime = makeSettleWhenIdle({
      readModel: Effect.sync(
        () =>
          ({
            threads: [{ id: THREAD, archivedAt: null, settleWhenIdleAt: current.settleWhenIdleAt }],
          }) as unknown as OrchestrationReadModel,
      ),
      readShell: () => Effect.sync(() => Option.some(current)),
      isIdle: settleWhenIdleReady,
      dispatch: (command) => Effect.sync(() => sent.push(command)),
      bootId: "boot",
    });
    return {
      runtime,
      sent,
      set: (next: OrchestrationThreadShell) => {
        current = next;
      },
    };
  }

  const event = (type: OrchestrationEvent["type"]) =>
    ({ type, aggregateKind: "thread", aggregateId: THREAD }) as unknown as OrchestrationEvent;

  it("finds a filing from the read model and settles the thread once its turn ends", async () => {
    const { runtime, sent, set } = harness(running());
    const next = await Effect.runPromise(runtime.step(NOW));
    expect(sent).toEqual([]);
    expect(next).toBe(SETTLE_WHEN_IDLE_SWEEP_MS);

    set(shell());
    expect(runtime.observe(event("thread.session-set"))).toBe(true);
    await Effect.runPromise(runtime.step(NOW + 1_000));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "thread.settle-when-idle", threadId: THREAD });

    // The same state is not sent again, by an event or by the sweep.
    runtime.observe(event("thread.activity-appended"));
    await Effect.runPromise(runtime.step(NOW + 2_000));
    await Effect.runPromise(runtime.step(NOW + SETTLE_WHEN_IDLE_SWEEP_MS + 1));
    expect(sent).toHaveLength(1);
  });

  it("stops following a thread once the filing ends", async () => {
    const { runtime, sent, set } = harness(running());
    await Effect.runPromise(runtime.step(NOW));
    expect(runtime.observe(event("thread.unsettled"))).toBe(false);
    set(shell());
    expect(runtime.observe(event("thread.session-set"))).toBe(false);
    await Effect.runPromise(runtime.step(NOW + 1_000));
    expect(sent).toEqual([]);
  });
});
