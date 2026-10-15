import { CommandId, EventId, type OrchestrationEvent, ThreadId, TurnId } from "@ryco/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  decideHistoryRecovery,
  HISTORY_RECOVERY_FAILURE_BACKOFF_MAX_MS,
  HISTORY_RECOVERY_SETTLED_SPACING_MS,
  HISTORY_RECOVERY_SUBSCRIBE_SPACING_MS,
  historyRecoverySpacingMs,
  settlesThreadSession,
  type ThreadStreamItemLike,
  makeThreadHistoryRecoveryRegistry,
  type ThreadHistoryRecoveryControl,
  withThreadHistoryRecovery,
} from "./historyRecoveryPolicy.ts";
import type { HistoryRecoveryTrigger } from "./Services/ProviderRuntimeIngestion.ts";
import { make as makeThreadViewers } from "./ThreadViewers.ts";

const sessionSet = (
  status: "running" | "ready" | "stopped" | "error",
  activeTurnId: TurnId | null,
) =>
  ({
    type: "thread.session-set",
    sequence: 1,
    eventId: EventId.make("event-1"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-10-12T00:00:00.000Z",
    commandId: CommandId.make("command-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId,
        lastError: null,
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    },
  }) as unknown as OrchestrationEvent;

describe("historyRecoverySpacingMs", () => {
  it("spaces a reopened thread longer than a settled session", () => {
    expect(historyRecoverySpacingMs({ attemptedAt: 0, failures: 0 }, "subscribe")).toBe(
      HISTORY_RECOVERY_SUBSCRIBE_SPACING_MS,
    );
    expect(historyRecoverySpacingMs({ attemptedAt: 0, failures: 0 }, "session-settled")).toBe(
      HISTORY_RECOVERY_SETTLED_SPACING_MS,
    );
  });

  it("backs off a failing thread, doubling up to the cap, whatever the trigger", () => {
    const spacing = (failures: number) =>
      historyRecoverySpacingMs({ attemptedAt: 0, failures }, "session-settled");
    expect(spacing(1)).toBe(30_000);
    expect(spacing(2)).toBe(60_000);
    expect(spacing(3)).toBe(120_000);
    expect(spacing(20)).toBe(HISTORY_RECOVERY_FAILURE_BACKOFF_MAX_MS);
    expect(historyRecoverySpacingMs({ attemptedAt: 0, failures: 1 }, "subscribe")).toBe(30_000);
  });
});

describe("decideHistoryRecovery", () => {
  const decide = (
    trigger: HistoryRecoveryTrigger,
    state: { attemptedAt: number; failures: number } | undefined,
    nowMs: number,
    inFlight = false,
  ) => decideHistoryRecovery({ state, trigger, inFlight, nowMs });

  it("reads a thread it never read, and once its spacing has passed", () => {
    expect(decide("subscribe", undefined, 0)).toEqual({ kind: "read" });
    expect(decide("liveness", undefined, 0)).toEqual({ kind: "read" });
    const settled = { attemptedAt: 0, failures: 0 };
    expect(decide("session-settled", settled, HISTORY_RECOVERY_SETTLED_SPACING_MS)).toEqual({
      kind: "read",
    });
    expect(decide("liveness", settled, HISTORY_RECOVERY_SETTLED_SPACING_MS)).toEqual({
      kind: "read",
    });
  });

  it("defers a settle inside the spacing to one trailing read, never dropping it", () => {
    expect(decide("session-settled", { attemptedAt: 0, failures: 0 }, 10_000)).toEqual({
      kind: "trail",
      afterMs: HISTORY_RECOVERY_SETTLED_SPACING_MS - 10_000,
    });
    // A read in flight may have started before the turn ended.
    expect(decide("session-settled", undefined, 0, true)).toEqual({
      kind: "trail",
      afterMs: HISTORY_RECOVERY_SETTLED_SPACING_MS,
    });
  });

  it("lets a trailing read skip a settle a later read covered, and a backed-off thread", () => {
    const trail = (
      state: { attemptedAt: number; startedAt?: number; failures: number } | undefined,
      nowMs: number,
      inFlight = false,
    ) =>
      decideHistoryRecovery({
        state,
        trigger: "session-settled",
        inFlight,
        nowMs,
        trailingSinceMs: 10,
      });
    expect(trail(undefined, 40)).toEqual({ kind: "read" });
    expect(trail({ attemptedAt: 0, failures: 0 }, 40, true)).toEqual({ kind: "skip" });
    // A read that began after the settle was deferred saw it.
    expect(trail({ attemptedAt: 15, startedAt: 12, failures: 0 }, 40)).toEqual({ kind: "skip" });
    // One that was already running when the turn ended may not have, even if it ended later.
    expect(trail({ attemptedAt: 15, startedAt: 5, failures: 0 }, 40)).toEqual({ kind: "read" });
    // A failure in the meantime backs off the trailing read too.
    const failed = { attemptedAt: 15, startedAt: 5, failures: 1 };
    expect(trail(failed, 15 + HISTORY_RECOVERY_SETTLED_SPACING_MS - 1)).toEqual({ kind: "skip" });
    expect(trail(failed, 15 + HISTORY_RECOVERY_SETTLED_SPACING_MS)).toEqual({ kind: "read" });
  });

  it("skips spaced-out opens and liveness checks, and anything a failure backs off", () => {
    expect(decide("subscribe", { attemptedAt: 0, failures: 0 }, 10_000)).toEqual({
      kind: "skip",
    });
    expect(decide("liveness", { attemptedAt: 0, failures: 0 }, 10_000)).toEqual({ kind: "skip" });
    expect(decide("subscribe", undefined, 0, true)).toEqual({ kind: "skip" });
    expect(decide("session-settled", { attemptedAt: 0, failures: 1 }, 10_000)).toEqual({
      kind: "skip",
    });
  });
});

describe("settlesThreadSession", () => {
  it("recognizes a turn ending and a session stopping or failing", () => {
    expect(settlesThreadSession(sessionSet("ready", null))).toBe(true);
    expect(settlesThreadSession(sessionSet("stopped", null))).toBe(true);
    expect(settlesThreadSession(sessionSet("error", null))).toBe(true);
  });

  it("ignores a running session and other events", () => {
    expect(settlesThreadSession(sessionSet("running", TurnId.make("turn-1")))).toBe(false);
    expect(settlesThreadSession(sessionSet("ready", TurnId.make("turn-1")))).toBe(false);
    expect(settlesThreadSession(undefined)).toBe(false);
  });
});

describe("withThreadHistoryRecovery", () => {
  it("reads on open and on a settled session, passing the stream's arrays through whole", async () => {
    const triggers: Array<HistoryRecoveryTrigger> = [];
    const reconcile = (_threadId: ThreadId, trigger: HistoryRecoveryTrigger) =>
      Effect.sync(() => {
        triggers.push(trigger);
      });
    const snapshot: ThreadStreamItemLike = { kind: "snapshot" };
    const running: ThreadStreamItemLike = {
      kind: "event",
      event: sessionSet("running", TurnId.make("turn-1")),
    };
    const settled: ThreadStreamItemLike = { kind: "event", event: sessionSet("ready", null) };
    const source = Stream.fromArrays([snapshot], [running, settled, running], [running]).pipe(
      // A late array keeps the subscription open while the forked reads run.
      Stream.concat(Stream.fromEffect(Effect.sleep("20 millis").pipe(Effect.as(snapshot)))),
    );

    const arrays = await Effect.runPromise(
      withThreadHistoryRecovery(ThreadId.make("thread-1"), source, reconcile).pipe(
        Stream.chunks,
        Stream.runCollect,
      ),
    );

    expect(Array.from(arrays, (items) => items.length)).toEqual([1, 3, 1, 1]);
    expect(triggers).toEqual(["subscribe", "session-settled"]);
  });

  it("never reads from a passive subscription until it is turned active", async () => {
    const triggers: Array<HistoryRecoveryTrigger> = [];
    const reconcile = (_threadId: ThreadId, trigger: HistoryRecoveryTrigger) =>
      Effect.sync(() => {
        triggers.push(trigger);
      });
    const settled: ThreadStreamItemLike = { kind: "event", event: sessionSet("ready", null) };
    let control: ThreadHistoryRecoveryControl | null = null;
    const observed: Array<ReadonlyArray<HistoryRecoveryTrigger>> = [];
    const source = Stream.fromArrays([{ kind: "snapshot" }], [settled]).pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.gen(function* () {
            // A prewarm's settled session read nothing; the view attaching turns it active.
            observed.push([...triggers]);
            yield* control!.setMode("active");
            yield* Effect.sleep("5 millis");
            observed.push([...triggers]);
            yield* control!.setMode("active");
            return settled;
          }),
        ),
      ),
      Stream.concat(
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis");
            observed.push([...triggers]);
            yield* control!.setMode("passive");
            return settled;
          }),
        ),
      ),
      Stream.concat(Stream.fromEffect(Effect.sleep("10 millis").pipe(Effect.as(settled)))),
    );

    await Effect.runPromise(
      withThreadHistoryRecovery(ThreadId.make("thread-1"), source, reconcile, {
        mode: "passive",
        register: (next) =>
          Effect.sync(() => {
            control = next;
          }),
      }).pipe(Stream.runDrain),
    );

    expect(observed).toEqual([[], ["subscribe"], ["subscribe", "session-settled"]]);
    // Turned passive again, the last settled session reads nothing.
    expect(triggers).toEqual(["subscribe", "session-settled"]);
  });
});

describe("withThreadHistoryRecovery viewers", () => {
  it("counts a subscription as a viewer only while it is active, and never after it ends", async () => {
    const viewers = makeThreadViewers();
    const threadId = ThreadId.make("thread-1");
    let control: ThreadHistoryRecoveryControl | null = null;
    const observed: Array<boolean> = [];
    const source = Stream.fromArrays([{ kind: "snapshot" } as ThreadStreamItemLike]).pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.gen(function* () {
            observed.push(viewers.isViewed(threadId));
            yield* control!.setMode("active");
            yield* control!.setMode("active");
            observed.push(viewers.isViewed(threadId));
            yield* control!.setMode("passive");
            observed.push(viewers.isViewed(threadId));
            yield* control!.setMode("active");
            observed.push(viewers.isViewed(threadId));
            return { kind: "snapshot" } as ThreadStreamItemLike;
          }),
        ),
      ),
    );

    await Effect.runPromise(
      withThreadHistoryRecovery(threadId, source, () => Effect.void, {
        mode: "passive",
        viewers,
        register: (next) =>
          Effect.sync(() => {
            control = next;
          }),
      }).pipe(Stream.runDrain),
    );

    expect(observed).toEqual([false, true, false, true]);
    expect(viewers.isViewed(threadId)).toBe(false);
  });

  it("keeps a thread viewed while any of its active subscriptions is open", async () => {
    const viewers = makeThreadViewers();
    const threadId = ThreadId.make("thread-1");
    const observed: Array<boolean> = [];
    const inner = withThreadHistoryRecovery(
      threadId,
      Stream.fromEffect(Effect.sync(() => ({ kind: "snapshot" }) as ThreadStreamItemLike)),
      () => Effect.void,
      { viewers },
    );
    const outer = withThreadHistoryRecovery(
      threadId,
      inner.pipe(
        Stream.runDrain,
        Effect.andThen(Effect.sync(() => observed.push(viewers.isViewed(threadId)))),
        Effect.as({ kind: "snapshot" } as ThreadStreamItemLike),
        Stream.fromEffect,
      ),
      () => Effect.void,
      { viewers },
    );
    await Effect.runPromise(Stream.runDrain(outer));
    expect(observed).toEqual([true]);
    expect(viewers.isViewed(threadId)).toBe(false);
  });
});

describe("makeThreadHistoryRecoveryRegistry", () => {
  const recordingControl = () => {
    const modes: Array<"active" | "passive"> = [];
    const control: ThreadHistoryRecoveryControl = {
      setMode: (mode) =>
        Effect.sync(() => {
          modes.push(mode);
        }),
    };
    return { control, modes };
  };

  it("reaches every live subscription of the thread and forgets released ones", async () => {
    const registry = makeThreadHistoryRecoveryRegistry();
    const thread = ThreadId.make("thread-1");
    const first = recordingControl();
    const second = recordingControl();
    const other = recordingControl();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registry.register(thread)(first.control);
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* registry.register(thread)(second.control);
              yield* registry.register(ThreadId.make("thread-2"))(other.control);
              yield* registry.setMode(thread, "active");
            }),
          );
          // The second subscription ended with its scope.
          yield* registry.setMode(thread, "passive");
        }),
      ),
    );

    expect(first.modes).toEqual(["active", "passive"]);
    expect(second.modes).toEqual(["active"]);
    expect(other.modes).toEqual([]);
  });

  it("hands a change that arrived after the request to the subscription it overtook", async () => {
    const registry = makeThreadHistoryRecoveryRegistry();
    const thread = ThreadId.make("thread-1");
    const overtaken = recordingControl();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The request arrives, the view's change follows, and only then does
          // the subscription's stream start and register.
          const register = registry.register(thread);
          yield* registry.setMode(thread, "active");
          yield* register(overtaken.control);
        }),
      ),
    );

    expect(overtaken.modes).toEqual(["active"]);
  });

  it("never lets a change older than the request override the mode it carries", async () => {
    const registry = makeThreadHistoryRecoveryRegistry();
    const thread = ThreadId.make("thread-1");
    const ended = recordingControl();
    const reopened = recordingControl();

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.scoped(registry.register(thread)(ended.control));
        // The view closed: its passive change lands after the subscription ended.
        yield* registry.setMode(thread, "passive");
        // Reopening the thread subscribes again, asking for "active" itself.
        yield* Effect.scoped(registry.register(thread)(reopened.control));
      }),
    );

    expect(ended.modes).toEqual([]);
    expect(reopened.modes).toEqual([]);
  });
});
