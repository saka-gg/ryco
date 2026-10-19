import {
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type OrchestrationGetThreadWindowInput,
  type OrchestrationSubscribeThreadWindowInput,
  type OrchestrationThreadHistoryRecoveryMode,
  type OrchestrationThreadWindowSnapshot,
} from "@ryco/contracts";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { expect } from "vite-plus/test";

import {
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
} from "../orchestration/threadHistoryCursor.ts";
import type { WsRpcContext } from "./context.ts";
import {
  fitThreadWindowToByteBudget,
  makeOrchestrationHandlers,
  THREAD_WINDOW_MAX_ENCODED_BYTES,
} from "./orchestrationRpc.ts";

const limits = { messages: 50, proposedPlans: 10, activities: 50, checkpoints: 10 };

const timestamp = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

type WindowOptions = {
  readonly messages?: number;
  readonly activities?: number;
  readonly textBytes?: number;
  readonly checkpoint?: boolean;
};

const makeWindow = (threadId: ThreadId, options: WindowOptions = {}) => {
  const messages = Array.from({ length: options.messages ?? 1 }, (_, index) => ({
    id: MessageId.make(`${threadId}-message-${index}`),
    role: "assistant",
    text: "m".repeat(options.textBytes ?? 16),
    turnId: null,
    streaming: false,
    createdAt: timestamp(index * 2),
    updatedAt: timestamp(index * 2),
  }));
  const activities: Array<Record<string, unknown>> = Array.from(
    { length: options.activities ?? 0 },
    (_, index) => ({
      id: EventId.make(`${threadId}-activity-${index}`),
      tone: "info",
      kind: "tool.completed",
      summary: "activity",
      payload: { output: "a".repeat(options.textBytes ?? 16) },
      turnId: null,
      sequence: index,
      createdAt: timestamp(index * 2 + 1),
    }),
  );
  if (options.checkpoint) {
    activities.push({
      id: EventId.make("~background-work:checkpoint"),
      tone: "info",
      kind: "background-work.checkpoint",
      summary: "Retained background work",
      payload: { version: 1 },
      turnId: null,
      createdAt: timestamp(1_000),
    });
  }
  const cursorOf = (collection: "messages" | "activities", index: number) =>
    collection === "messages"
      ? encodeThreadHistoryCursor({
          threadId,
          collection,
          order: { createdAt: messages[index]!.createdAt, id: messages[index]!.id },
        })
      : encodeThreadHistoryCursor({
          threadId,
          collection,
          order: {
            sequence: index,
            createdAt: activities[index]!.createdAt as string,
            id: activities[index]!.id as string,
          },
        });
  const pageInfo = (collection: "messages" | "activities", count: number) => ({
    oldestCursor: count === 0 ? null : cursorOf(collection, 0),
    newestCursor: count === 0 ? null : cursorOf(collection, count - 1),
    hasMoreBefore: false,
  });
  const empty = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
  return {
    snapshotSequence: 1,
    thread: { id: threadId, messages, activities, proposedPlans: [], checkpoints: [] },
    history: {
      messages: pageInfo("messages", messages.length),
      proposedPlans: empty,
      activities: pageInfo("activities", options.activities ?? 0),
      checkpoints: empty,
    },
  } as unknown as OrchestrationThreadWindowSnapshot;
};

const makeHandlers = (
  getThreadWindow: (input: OrchestrationGetThreadWindowInput) => Effect.Effect<unknown>,
) => {
  const ctx = {
    projectionSnapshotQuery: { getThreadWindow },
    providerRuntimeIngestion: Option.none(),
    threadViewers: Option.none(),
    recordThreadSnapshotDurationMs: () => Effect.void,
    makeReplayableThreadStream: (snapshot: Effect.Effect<unknown>) =>
      Stream.unwrap(
        snapshot.pipe(Effect.map((loaded) => Stream.make({ kind: "snapshot", loaded }))),
      ),
  } as unknown as WsRpcContext;
  const handlers = makeOrchestrationHandlers(ctx);
  return {
    subscribe: handlers[ORCHESTRATION_WS_METHODS.subscribeThreadWindow] as unknown as (
      input: OrchestrationSubscribeThreadWindowInput,
    ) => Stream.Stream<{
      readonly kind: "snapshot";
      readonly loaded: OrchestrationThreadWindowSnapshot;
    }>,
    getWindow: handlers[ORCHESTRATION_WS_METHODS.getThreadWindow] as unknown as (
      input: OrchestrationGetThreadWindowInput,
    ) => Effect.Effect<OrchestrationThreadWindowSnapshot>,
  };
};

const subscribeInput = (
  id: string,
  historyRecovery: OrchestrationThreadHistoryRecoveryMode | undefined,
): OrchestrationSubscribeThreadWindowInput => ({
  threadId: ThreadId.make(id),
  limits,
  resumeFromSequence: undefined,
  ...(historyRecovery === undefined ? {} : { historyRecovery }),
});

const waitFor = (label: string, predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 500; turn += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    throw new Error(`timed out waiting for ${label}`);
  });

/** A window query whose loads stay open until their thread's gate is released. */
const makeGatedQuery = (threadIds: ReadonlyArray<string>) => {
  const gates = new Map(threadIds.map((id) => [id, Deferred.makeUnsafe<void>()] as const));
  const started: Array<string> = [];
  let inFlight = 0;
  let passiveInFlight = 0;
  let maxPassiveInFlight = 0;
  const query = (input: OrchestrationGetThreadWindowInput) =>
    Effect.gen(function* () {
      const id = String(input.threadId);
      const passive = id.startsWith("passive");
      started.push(id);
      inFlight += 1;
      if (passive) {
        passiveInFlight += 1;
        maxPassiveInFlight = Math.max(maxPassiveInFlight, passiveInFlight);
      }
      yield* Deferred.await(gates.get(id)!).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inFlight -= 1;
            if (passive) passiveInFlight -= 1;
          }),
        ),
      );
      return makeWindow(input.threadId);
    });
  return {
    query,
    started,
    release: (id: string) => Deferred.succeed(gates.get(id)!, undefined),
    inFlight: () => inFlight,
    maxPassiveInFlight: () => maxPassiveInFlight,
  };
};

const runFirstSnapshot = (
  subscribe: ReturnType<typeof makeHandlers>["subscribe"],
  input: OrchestrationSubscribeThreadWindowInput,
  completed: Array<string>,
) =>
  subscribe(input).pipe(
    Stream.runHead,
    Effect.tap(() => Effect.sync(() => completed.push(input.threadId))),
    Effect.forkChild,
  );

it.effect("loads an active window ahead of queued passive windows", () =>
  Effect.gen(function* () {
    const passiveIds = ["passive-1", "passive-2", "passive-3", "passive-4", "passive-5"];
    const gated = makeGatedQuery([...passiveIds, "active-1"]);
    const { subscribe } = makeHandlers(gated.query);
    const completed: Array<string> = [];

    const passiveFibers = [];
    for (const id of passiveIds) {
      passiveFibers.push(
        yield* runFirstSnapshot(subscribe, subscribeInput(id, "passive"), completed),
      );
    }
    yield* waitFor("two passive loads", () => gated.started.length === 2);
    yield* Effect.yieldNow;
    expect(gated.started).toEqual(["passive-1", "passive-2"]);

    // The routed thread's window starts at once even though both passive slots
    // are taken and three more passive requests are queued.
    const activeFiber = yield* runFirstSnapshot(
      subscribe,
      subscribeInput("active-1", undefined),
      completed,
    );
    yield* waitFor("active load", () => gated.started.includes("active-1"));
    expect(gated.started).toEqual(["passive-1", "passive-2", "active-1"]);

    yield* gated.release("active-1");
    yield* Fiber.join(activeFiber);
    expect(completed).toEqual(["active-1"]);

    // Queued passive loads wait for the active one, then take freed slots in
    // arrival order, never more than two at a time.
    yield* gated.release("passive-1");
    yield* waitFor("third passive load", () => gated.started.includes("passive-3"));
    expect(gated.started.slice(3)).toEqual(["passive-3"]);
    for (const id of passiveIds) yield* gated.release(id);
    for (const fiber of passiveFibers) yield* Fiber.join(fiber);

    expect(gated.started).toEqual([
      "passive-1",
      "passive-2",
      "active-1",
      "passive-3",
      "passive-4",
      "passive-5",
    ]);
    expect(completed[0]).toBe("active-1");
    expect([...completed].toSorted()).toEqual(["active-1", ...passiveIds]);
    expect(gated.maxPassiveInFlight()).toBe(2);
    expect(gated.inFlight()).toBe(0);
  }),
);

it.effect("holds queued passive loads back while an active load runs", () =>
  Effect.gen(function* () {
    const gated = makeGatedQuery(["passive-1", "passive-2", "passive-3", "active-1"]);
    const { subscribe } = makeHandlers(gated.query);
    const completed: Array<string> = [];

    const first = yield* runFirstSnapshot(
      subscribe,
      subscribeInput("passive-1", "passive"),
      completed,
    );
    yield* waitFor("first passive load", () => gated.started.length === 1);
    const active = yield* runFirstSnapshot(
      subscribe,
      subscribeInput("active-1", "active"),
      completed,
    );
    yield* waitFor("active load", () => gated.started.length === 2);

    // A free passive slot does not start a passive load while the active one runs.
    const later = [
      yield* runFirstSnapshot(subscribe, subscribeInput("passive-2", "passive"), completed),
      yield* runFirstSnapshot(subscribe, subscribeInput("passive-3", "passive"), completed),
    ];
    for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
    expect(gated.started).toEqual(["passive-1", "active-1"]);

    yield* gated.release("active-1");
    yield* Fiber.join(active);
    yield* waitFor("held passive load", () => gated.started.length === 3);
    expect(gated.started.slice(2)).toEqual(["passive-2"]);

    yield* gated.release("passive-1");
    yield* waitFor("last passive load", () => gated.started.length === 4);
    expect(gated.started.slice(3)).toEqual(["passive-3"]);

    for (const id of ["passive-2", "passive-3"]) yield* gated.release(id);
    for (const fiber of [first, ...later]) yield* Fiber.join(fiber);
  }),
);

it.effect("frees a passive slot when a queued passive subscription goes away", () =>
  Effect.gen(function* () {
    const gated = makeGatedQuery(["passive-1", "passive-2", "passive-3", "passive-4"]);
    const { subscribe } = makeHandlers(gated.query);
    const completed: Array<string> = [];

    const fibers = [];
    for (const id of ["passive-1", "passive-2", "passive-3", "passive-4"]) {
      fibers.push(yield* runFirstSnapshot(subscribe, subscribeInput(id, "passive"), completed));
    }
    yield* waitFor("two passive loads", () => gated.started.length === 2);

    // passive-3 is still queued when its subscription ends.
    yield* Fiber.interrupt(fibers[2]!);
    yield* gated.release("passive-1");
    yield* waitFor("passive-4 load", () => gated.started.includes("passive-4"));
    expect(gated.started).toEqual(["passive-1", "passive-2", "passive-4"]);

    yield* gated.release("passive-2");
    yield* gated.release("passive-4");
    yield* Fiber.join(fibers[0]!);
    yield* Fiber.join(fibers[1]!);
    yield* Fiber.join(fibers[3]!);
    expect(gated.maxPassiveInFlight()).toBe(2);
  }),
);

it.effect("clamps an oversized window under the byte budget and keeps the newest message", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("oversized-thread");
    const oversized = makeWindow(threadId, {
      messages: 40,
      activities: 40,
      textBytes: 60_000,
      checkpoint: true,
    });
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(
      THREAD_WINDOW_MAX_ENCODED_BYTES,
    );
    const { subscribe, getWindow } = makeHandlers(() => Effect.succeed(oversized));

    const viaGet = yield* getWindow({ threadId, limits });
    const viaSubscription = yield* subscribe(subscribeInput(threadId, "active")).pipe(
      Stream.runHead,
      Effect.map((head) => (Option.isSome(head) ? head.value.loaded : undefined)),
    );

    for (const window of [viaGet, viaSubscription]) {
      expect(window).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(window))).toBeLessThanOrEqual(
        THREAD_WINDOW_MAX_ENCODED_BYTES,
      );
      const { messages, activities } = window!.thread;
      expect(messages.at(-1)?.id).toBe(oversized.thread.messages.at(-1)?.id);
      expect(messages.length).toBeLessThan(oversized.thread.messages.length);
      expect(window!.history.messages.hasMoreBefore).toBe(true);
      expect(window!.history.activities.hasMoreBefore).toBe(true);
      expect(window!.history.messages.newestCursor).toBe(oversized.history.messages.newestCursor);
      expect(activities.at(-1)?.kind).toBe("background-work.checkpoint");
    }
  }),
);

it.effect("leaves a window within the budget untouched", () =>
  Effect.gen(function* () {
    const window = makeWindow(ThreadId.make("small-thread"), {
      messages: 5,
      activities: 5,
      checkpoint: true,
    });
    const { getWindow } = makeHandlers(() => Effect.succeed(window));
    expect(yield* getWindow({ threadId: window.thread.id, limits })).toBe(window);
  }),
);

it("drops the oldest items across messages and activities and repoints the cursors", () => {
  const threadId = ThreadId.make("trimmed-thread");
  const window = makeWindow(threadId, { messages: 10, activities: 10, textBytes: 1_000 });
  const budget = Math.floor(Buffer.byteLength(JSON.stringify(window)) / 2);

  const fitted = fitThreadWindowToByteBudget(window, budget);

  expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(budget);
  const { messages, activities } = fitted.thread;
  // What stays is a suffix of each collection and of the interleaved timeline.
  expect(messages).toEqual(window.thread.messages.slice(-messages.length));
  expect(activities).toEqual(window.thread.activities.slice(-activities.length));
  expect(messages.length + activities.length).toBeLessThan(20);
  const oldestKept = [messages[0]!.createdAt, activities[0]!.createdAt].toSorted()[0]!;
  const newestDropped = [
    ...window.thread.messages.slice(0, -messages.length),
    ...window.thread.activities.slice(0, -activities.length),
  ]
    .map((item) => item.createdAt)
    .toSorted()
    .at(-1)!;
  expect(newestDropped < oldestKept).toBe(true);

  expect(
    decodeThreadHistoryCursor(fitted.history.messages.oldestCursor!, {
      threadId,
      collection: "messages",
    }),
  ).toEqual({
    ok: true,
    order: { createdAt: messages[0]!.createdAt, id: messages[0]!.id },
  });
  expect(
    decodeThreadHistoryCursor(fitted.history.activities.oldestCursor!, {
      threadId,
      collection: "activities",
    }),
  ).toEqual({
    ok: true,
    order: {
      sequence: activities[0]!.sequence,
      createdAt: activities[0]!.createdAt,
      id: activities[0]!.id,
    },
  });
  expect(fitted.history.messages.hasMoreBefore).toBe(true);
  expect(fitted.history.activities.hasMoreBefore).toBe(true);
});

it("opens a window whose newest message alone exceeds the budget", () => {
  const window = makeWindow(ThreadId.make("huge-thread"), {
    messages: 3,
    activities: 2,
    textBytes: 10_000,
  });

  const fitted = fitThreadWindowToByteBudget(window, 100);

  expect(fitted.thread.messages.map((message) => message.id)).toEqual([
    window.thread.messages.at(-1)!.id,
  ]);
  expect(fitted.thread.activities).toHaveLength(1);
  expect(fitted.history.messages.hasMoreBefore).toBe(true);
});
