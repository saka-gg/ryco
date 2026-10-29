import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationEvent,
  OrchestrationThreadShell,
  ThreadUsageLimit,
  GOAL_CONTINUATION_MESSAGE_ID_PREFIX as RESERVED_GOAL_CONTINUATION_MESSAGE_ID_PREFIX,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  GOAL_CONTINUATION_GRACE_MS,
  GOAL_CONTINUATION_MAX_CHAIN,
  GOAL_CONTINUATION_MESSAGE_ID_PREFIX,
} from "./goalContinuation.ts";
import { makeGoalContinuation } from "./goalContinuationRuntime.ts";
import type { ServerWakeFenceShape, ServerWakeHold } from "./Services/ServerWakeFence.ts";

const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const shell = (
  overrides: Partial<OrchestrationThreadShell> = {},
  turn: { readonly id?: string; readonly state?: string; readonly endedAtMs?: number } = {},
): OrchestrationThreadShell => ({
  ...Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: "thread-1",
    projectId: "project-1",
    title: "Goal chat",
    modelSelection: { instanceId: "claude", model: "fixture" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: turn.id ?? "turn-1",
      state: turn.state ?? "completed",
      requestedAt: iso(T0 - 60_000),
      startedAt: iso(T0 - 60_000),
      completedAt: iso(turn.endedAtMs ?? T0),
      assistantMessageId: null,
    },
    createdAt: iso(T0 - 120_000),
    updatedAt: iso(T0),
    archivedAt: null,
    session: {
      threadId: "thread-1",
      status: "ready",
      providerName: "claudeAgent",
      providerInstanceId: "claude",
      runtimeSessionId: "runtime-1",
      runtimeMode: "auto-accept-edits",
      activeTurnId: null,
      lastError: null,
      updatedAt: iso(T0),
    },
    goal: {
      objective: "Ship the release notes",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: iso(T0 - 120_000),
      updatedAt: iso(T0 - 120_000),
      synchronization: { requestId: "goal-reminder", state: "unsupported", action: "set" },
    },
    latestUserMessageAt: iso(T0 - 60_000),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }),
  ...overrides,
});

let eventCount = 0;
const event = (
  type: string,
  payload: Record<string, unknown> = {},
  commandId: string | null = "client-command",
) =>
  ({
    type,
    eventId: `event-${(eventCount += 1)}`,
    commandId,
    aggregateKind: "thread",
    aggregateId: "thread-1",
    payload: { threadId: "thread-1", ...payload },
  }) as unknown as OrchestrationEvent;

const sessionSet = event("thread.session-set");

const harness = (
  initial: OrchestrationThreadShell,
  options: {
    readonly agentControlEnabled?: boolean;
    readonly apply?: (command: ClientOrchestrationCommand) => Effect.Effect<unknown, never>;
  } = {},
) => {
  let current: OrchestrationThreadShell | null = initial;
  let hold: ServerWakeHold | null = null;
  let cold = { cold: false, budgetFull: false };
  let reverting = false;
  let wakeStart: "bound" | "failed" | "pending" | "absent" = "pending";
  let reads = 0;
  const applied: ClientOrchestrationCommand[] = [];
  const dispatched: OrchestrationCommand[] = [];
  const fenceCalls: string[] = [];
  const fence: ServerWakeFenceShape = {
    holdReason: () => Effect.sync(() => hold),
    reverting: () => Effect.sync(() => reverting),
    coldStart: () => Effect.sync(() => cold),
    reserveColdSlot: (_threadId, messageId) =>
      Effect.sync(() => {
        fenceCalls.push(`reserve:${messageId}`);
        return true;
      }),
    noteColdWake: (_threadId, messageId) =>
      Effect.sync(() => {
        fenceCalls.push(`note:${messageId}`);
      }),
    releaseColdSlot: (_threadId, messageId) =>
      Effect.sync(() => {
        fenceCalls.push(`release:${messageId}`);
      }),
    releaseColdSlots: () => Effect.void,
    wakeStartState: () => Effect.sync(() => wakeStart),
    latestUserMessageId: () => Effect.succeed(null),
  };
  const continuation = makeGoalContinuation({
    readShell: () =>
      Effect.sync(() => {
        reads += 1;
        return Option.fromNullishOr(current);
      }),
    fence,
    apply: (command) =>
      Effect.suspend(() => {
        applied.push(command);
        return options.apply?.(command) ?? Effect.succeed({ sequence: applied.length });
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    agentControlEnabled: Effect.succeed(options.agentControlEnabled ?? true),
    observedSinceMs: T0 - 1_000,
  });
  /** Feeds an event and runs one pass at `nowMs`. */
  const pass = (nowMs: number, input: OrchestrationEvent | null = sessionSet) =>
    Effect.gen(function* () {
      if (input !== null) continuation.observe(input);
      return yield* continuation.step(nowMs);
    });
  return {
    continuation,
    applied,
    dispatched,
    fenceCalls,
    pass,
    setShell: (next: OrchestrationThreadShell | null) => {
      current = next;
    },
    setHold: (next: ServerWakeHold | null) => {
      hold = next;
    },
    setCold: (next: { cold: boolean; budgetFull: boolean }) => {
      cold = next;
    },
    setReverting: (next: boolean) => {
      reverting = next;
    },
    setWakeStart: (next: typeof wakeStart) => {
      wakeStart = next;
    },
    reads: () => reads,
  };
};

const turnStarts = (commands: ReadonlyArray<ClientOrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.turn.start");

const goalSyncs = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) => (command.type === "thread.goal.sync" ? [command] : []));

describe("goal continuation", () => {
  it.effect("starts the next turn toward the goal after the grace, once per finished turn", () =>
    Effect.gen(function* () {
      const h = harness(shell());
      const delay = yield* h.pass(T0 + 1_000);
      assert.strictEqual(h.applied.length, 0);
      assert.strictEqual(delay, GOAL_CONTINUATION_GRACE_MS);

      yield* h.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      const [start] = turnStarts(h.applied);
      assert.ok(start?.type === "thread.turn.start");
      assert.strictEqual(start.commandId, "goal-continue:thread-1:turn-1");
      assert.strictEqual(start.message.messageId, "goal-continuation:thread-1:turn-1");
      assert.include(start.message.text, 'threadId "thread-1" and goalStatus "complete"');
      assert.strictEqual(start.delegationReturnGuard?.source, "goal-continuation");
      assert.strictEqual(start.runtimeMode, "auto-accept-edits");
      assert.deepStrictEqual(start.modelSelection, shell().modelSelection);

      // The shell still shows the finished turn until the new one starts: no second turn.
      yield* h.pass(T0 + 30_000);
      yield* h.pass(T0 + 60_000);
      assert.strictEqual(turnStarts(h.applied).length, 1);
      assert.strictEqual(h.continuation.candidates.size, 0);
    }),
  );

  it.effect("waits while the fence holds the thread; the grace starts when it lets go", () =>
    Effect.gen(function* () {
      const h = harness(shell());
      h.setHold("busy");
      yield* h.pass(T0 + 1_000);
      yield* h.pass(T0 + 20_000);
      assert.strictEqual(h.applied.length, 0);
      h.setHold(null);
      yield* h.pass(T0 + 21_000);
      yield* h.pass(T0 + 21_000 + GOAL_CONTINUATION_GRACE_MS - 1, null);
      assert.strictEqual(h.applied.length, 0);
      yield* h.pass(T0 + 21_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.strictEqual(turnStarts(h.applied).length, 1);
    }),
  );

  it.effect("needs Agent Control tools, so the agent can end the loop itself", () =>
    Effect.gen(function* () {
      const off = harness(shell(), { agentControlEnabled: false });
      yield* off.pass(T0 + 1_000);
      yield* off.pass(T0 + 10_000, null);
      assert.strictEqual(off.applied.length, 0);

      const base = shell();
      const unsupported = harness(
        shell({ session: { ...base.session!, providerName: "opencode" } }),
      );
      yield* unsupported.pass(T0 + 1_000);
      yield* unsupported.pass(T0 + 10_000, null);
      assert.strictEqual(unsupported.applied.length, 0);
    }),
  );

  it.effect(
    "leaves native goals, delegated tasks, plans and turns from before a restart alone",
    () =>
      Effect.gen(function* () {
        const base = shell();
        const cases: ReadonlyArray<OrchestrationThreadShell> = [
          shell({ goal: { ...base.goal!, synchronization: undefined } }),
          shell({ goal: { ...base.goal!, status: "paused" } }),
          shell({
            lineage: {
              parentThreadId: "parent" as never,
              rootThreadId: "parent" as never,
              relationship: "delegated",
            },
          }),
          shell({ interactionMode: "plan" }),
          shell({ hasActionableProposedPlan: true }),
          shell({}, { endedAtMs: T0 - 5_000 }),
          shell({}, { state: "interrupted" }),
          // Resumed after this turn ended: the goal waits for its next turn.
          shell({ goal: { ...base.goal!, updatedAt: iso(T0 + 500) } }),
        ];
        for (const candidate of cases) {
          const h = harness(candidate);
          yield* h.pass(T0 + 1_000);
          yield* h.pass(T0 + 10_000, null);
          assert.strictEqual(h.applied.length, 0);
          assert.strictEqual(h.dispatched.length, 0);
        }
      }),
  );

  it.effect("a person's Stop pauses the goal; an agent's interrupt does not", () =>
    Effect.gen(function* () {
      const h = harness(shell({}, { state: "interrupted" }));
      yield* h.pass(
        T0 + 1_000,
        event(
          "thread.turn-interrupt-requested",
          { turnId: "turn-1" },
          "agent-control:op:interrupt",
        ),
      );
      assert.strictEqual(h.dispatched.length, 0);

      const stop = event("thread.turn-interrupt-requested", { turnId: "turn-1" });
      yield* h.pass(T0 + 2_000, stop);
      const [sync] = goalSyncs(h.dispatched);
      assert.strictEqual(sync?.commandId, `goal-pause:thread-1:stop:${stop.eventId}`);
      assert.strictEqual(sync?.goal.status, "paused");
      assert.strictEqual(sync?.expectedRequestId, "goal-reminder");
      assert.strictEqual(sync?.goal.objective, "Ship the release notes");

      // Stop session during the grace pauses it too, so no cold start follows.
      const idle = harness(shell());
      yield* idle.pass(T0 + 1_000);
      yield* idle.pass(T0 + 2_000, event("thread.session-stop-requested"));
      yield* idle.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.strictEqual(idle.applied.length, 0);
      assert.strictEqual(goalSyncs(idle.dispatched).length, 1);
    }),
  );

  it.effect(
    "a failed turn pauses the goal after the grace; a usage limit leaves it to its resume",
    () =>
      Effect.gen(function* () {
        const failed = harness(shell({}, { state: "error" }));
        const delay = yield* failed.pass(T0 + 1_000);
        assert.strictEqual(delay, GOAL_CONTINUATION_GRACE_MS);
        assert.strictEqual(failed.dispatched.length, 0);
        yield* failed.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
        const [sync] = goalSyncs(failed.dispatched);
        assert.strictEqual(sync?.goal.status, "paused");
        assert.strictEqual(sync?.commandId, "goal-pause:thread-1:failed:turn-1");

        // The limit is recorded just after the turn's end: within the grace, so nothing pauses.
        const usageLimit = Schema.decodeUnknownSync(ThreadUsageLimit)({
          limitId: "usage-limit:thread-1:turn-1",
          provider: "claudeAgent",
          providerInstanceId: "claude",
          turnId: "turn-1",
          message: "Usage limit reached.",
          limitedAt: iso(T0),
          resetAt: null,
          autoResume: null,
          updatedAt: iso(T0),
        });
        const limited = harness(shell({}, { state: "error" }));
        yield* limited.pass(T0 + 1_000);
        limited.setShell(shell({ usageLimit }, { state: "error" }));
        yield* limited.pass(T0 + 1_100, sessionSet);
        yield* limited.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
        assert.strictEqual(limited.dispatched.length, 0);
        assert.strictEqual(limited.continuation.candidates.size, 0);

        // A goal resumed (or set) after the failure stays active.
        const base = shell();
        const resumed = harness(
          shell({ goal: { ...base.goal!, updatedAt: iso(T0 + 500) } }, { state: "error" }),
        );
        yield* resumed.pass(T0 + 1_000);
        yield* resumed.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
        assert.strictEqual(resumed.dispatched.length, 0);
      }),
  );

  it.effect("pauses after the automatic turn limit; a person's message starts a new count", () =>
    Effect.gen(function* () {
      const h = harness(shell());
      let nowMs = T0;
      const finishTurn = (index: number) => {
        nowMs += 60_000;
        h.setShell(shell({}, { id: `turn-${index}`, endedAtMs: nowMs }));
      };
      const runOne = Effect.gen(function* () {
        yield* h.pass(nowMs + 1_000);
        yield* h.pass(nowMs + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      });
      for (let index = 0; index < GOAL_CONTINUATION_MAX_CHAIN; index += 1) {
        finishTurn(index);
        yield* runOne;
      }
      assert.strictEqual(turnStarts(h.applied).length, GOAL_CONTINUATION_MAX_CHAIN);

      // A person's message in between starts the count again.
      h.continuation.observe(event("thread.turn-start-requested", { messageId: "from-person" }));
      finishTurn(GOAL_CONTINUATION_MAX_CHAIN);
      yield* runOne;
      assert.strictEqual(turnStarts(h.applied).length, GOAL_CONTINUATION_MAX_CHAIN + 1);

      // Server wakes (its own continuations, delegated results) do not.
      for (let index = 1; index < GOAL_CONTINUATION_MAX_CHAIN; index += 1) {
        h.continuation.observe(
          event("thread.turn-start-requested", {
            messageId: `delegation-result:${index}`,
            delegationReturnGuard: { latestUserMessageId: null },
          }),
        );
        finishTurn(GOAL_CONTINUATION_MAX_CHAIN + index);
        yield* runOne;
      }
      assert.strictEqual(turnStarts(h.applied).length, 2 * GOAL_CONTINUATION_MAX_CHAIN);
      finishTurn(3 * GOAL_CONTINUATION_MAX_CHAIN);
      yield* runOne;
      assert.strictEqual(turnStarts(h.applied).length, 2 * GOAL_CONTINUATION_MAX_CHAIN);
      const [sync] = goalSyncs(h.dispatched);
      assert.strictEqual(sync?.goal.status, "paused");
      const notice = h.dispatched.find((command) => command.type === "thread.activity.append");
      assert.ok(notice?.type === "thread.activity.append");
      assert.strictEqual(notice.activity.kind, "goal.paused");
    }),
  );

  it.effect("drops a rejected continuation, and pauses the goal after three failed ones", () =>
    Effect.gen(function* () {
      const rejected = harness(shell(), {
        apply: () =>
          Effect.fail({
            _tag: "OrchestrationDispatchCommandError",
            cause: { _tag: "OrchestrationCommandInvariantError" },
          } as never),
      });
      yield* rejected.pass(T0 + 1_000);
      yield* rejected.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.strictEqual(rejected.applied.length, 1);
      assert.strictEqual(rejected.continuation.candidates.size, 0);
      assert.strictEqual(rejected.dispatched.length, 0);
    }),
  );

  it.effect("backs off a failing dispatch, then pauses the goal", () =>
    Effect.gen(function* () {
      const h = harness(shell(), {
        apply: () => Effect.fail({ _tag: "OrchestrationEventStoreError" } as never),
      });
      yield* h.pass(T0 + 1_000);
      let nowMs = T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS;
      const delays: Array<number | null> = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const delay = yield* h.pass(nowMs, null);
        delays.push(delay);
        // Nothing is tried again before the backoff ends, not even on an event.
        if (delay !== null) assert.strictEqual(yield* h.pass(nowMs + 1), delay - 1);
        nowMs += delay ?? 0;
      }
      assert.deepStrictEqual(delays, [5_000, 20_000, null]);
      assert.strictEqual(h.applied.length, 3);
      const [sync] = goalSyncs(h.dispatched);
      assert.strictEqual(sync?.commandId, "goal-pause:thread-1:dispatch:turn-1");
    }),
  );

  it.effect("waits, without spinning, while the cold-start budget is full or a revert runs", () =>
    Effect.gen(function* () {
      const h = harness(shell());
      h.setCold({ cold: true, budgetFull: true });
      yield* h.pass(T0 + 1_000);
      const delay = yield* h.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.strictEqual(delay, 5_000);
      const reads = h.reads();
      assert.strictEqual(yield* h.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS + 10, null), 4_990);
      assert.strictEqual(h.reads(), reads);
    }),
  );

  it.effect("pauses the goal when an accepted continuation never starts", () =>
    Effect.gen(function* () {
      const h = harness(shell());
      yield* h.pass(T0 + 1_000);
      yield* h.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.strictEqual(turnStarts(h.applied).length, 1);
      yield* h.pass(T0 + 10_000);
      assert.strictEqual(h.dispatched.length, 0);
      h.setWakeStart("failed");
      yield* h.pass(T0 + 11_000, sessionSet);
      const [sync] = goalSyncs(h.dispatched);
      assert.strictEqual(sync?.commandId, "goal-pause:thread-1:start-failed:turn-1");
      assert.strictEqual(turnStarts(h.applied).length, 1);
    }),
  );

  it.effect("reads a thread without a goal once, until a goal update", () =>
    Effect.gen(function* () {
      const h = harness(shell({ goal: null }));
      yield* h.pass(T0 + 1_000);
      yield* h.pass(T0 + 2_000);
      yield* h.pass(T0 + 3_000, event("thread.turn-interrupt-requested", { turnId: "turn-1" }));
      assert.strictEqual(h.reads(), 1);
      h.setShell(shell());
      yield* h.pass(T0 + 4_000, event("thread.goal-updated", { origin: "client" }));
      assert.strictEqual(h.reads(), 2);
    }),
  );

  it.effect("takes a cold-start slot for a thread without a live session", () =>
    Effect.gen(function* () {
      const full = harness(shell());
      full.setCold({ cold: true, budgetFull: true });
      yield* full.pass(T0 + 1_000);
      yield* full.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.strictEqual(full.applied.length, 0);

      const h = harness(shell());
      h.setCold({ cold: true, budgetFull: false });
      yield* h.pass(T0 + 1_000);
      yield* h.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.deepStrictEqual(h.fenceCalls, [
        "reserve:goal-continuation:thread-1:turn-1",
        "note:goal-continuation:thread-1:turn-1",
      ]);

      const reverting = harness(shell());
      reverting.setCold({ cold: true, budgetFull: false });
      reverting.setReverting(true);
      yield* reverting.pass(T0 + 1_000);
      yield* reverting.pass(T0 + 1_000 + GOAL_CONTINUATION_GRACE_MS, null);
      assert.strictEqual(reverting.applied.length, 0);
      assert.deepStrictEqual(reverting.fenceCalls, [
        "reserve:goal-continuation:thread-1:turn-1",
        "release:goal-continuation:thread-1:turn-1",
      ]);
    }),
  );
});

it("mints its message ids under the prefix clients may not send", () => {
  assert.strictEqual(
    GOAL_CONTINUATION_MESSAGE_ID_PREFIX,
    RESERVED_GOAL_CONTINUATION_MESSAGE_ID_PREFIX,
  );
});
