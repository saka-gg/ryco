import {
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ThreadUsageLimit,
} from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { describe, expect, it } from "vite-plus/test";

import {
  makeQueueAppState,
  queueRef,
  steerFailed,
  turnStartCancelled,
  turnStartFailed,
  type ThreadFixture,
} from "../../../test/queueThreadFixtures.ts";
import { captureQueuedDispatchSnapshot } from "../session/dispatchAck.ts";
import { resolveQueueDrainStep, type QueueDrainInput, type QueueDrainStep } from "./drain.ts";
import {
  createInterruptQueueHold,
  releaseQueueHoldKeys,
  deriveQueueFailureCauses,
  removeQueueHoldCauses,
} from "./hold.ts";
import { readQueueThreadView } from "./threadView.ts";

const NOW = "2026-10-01T12:00:00.000Z";

function steerAttempt(commandId: string) {
  return { commandId, expectedTurnId: TurnId.make("turn-1"), startedAt: NOW, explicit: false };
}
const IDLE_THREAD: Omit<ThreadFixture, "id"> = {
  session: { status: "ready" },
  latestTurn: { turnId: "turn-1", state: "completed" },
  messageIds: ["m-0"],
};
const RUNNING_THREAD: Omit<ThreadFixture, "id"> = {
  session: { status: "running", activeTurnId: "turn-1" },
  latestTurn: { turnId: "turn-1", state: "running" },
  messageIds: ["m-0"],
};

function viewOf(fixture: Omit<ThreadFixture, "id">) {
  return readQueueThreadView(makeQueueAppState([{ id: "t", ...fixture }]), queueRef("t"));
}

function input(overrides: Partial<QueueDrainInput> = {}): QueueDrainInput {
  return {
    nowIso: NOW,
    queue: [{ id: "q-1" }, { id: "q-2" }],
    steerAttempts: {},
    hold: null,
    acknowledgedCauseKeys: [],
    headProviderInstanceId: "codex",
    view: viewOf(IDLE_THREAD),
    draft: false,
    environment: { shellLive: true, mutationReady: true },
    pendingDispatch: null,
    dispatchedMessageIds: new Set(),
    sender: "background",
    ...overrides,
  };
}

/** Applies bookkeeping steps the way the coordinator does, returning the trail. */
function drive(start: QueueDrainInput, maxSteps = 6): QueueDrainStep[] {
  const current: { -readonly [K in keyof QueueDrainInput]: QueueDrainInput[K] } = { ...start };
  const steps: QueueDrainStep[] = [];
  for (let index = 0; index < maxSteps; index += 1) {
    const step = resolveQueueDrainStep(current);
    steps.push(step);
    if (step.kind === "baseline" || step.kind === "acknowledge") {
      current.acknowledgedCauseKeys = (current.acknowledgedCauseKeys ?? []).concat(step.causeKeys);
    } else if (step.kind === "hold" || step.kind === "dispatch-failed") {
      current.hold = step.hold;
      current.pendingDispatch = null;
    } else if (step.kind === "dispatch-started") {
      current.pendingDispatch = null;
    } else {
      break;
    }
  }
  return steps;
}

const kinds = (steps: QueueDrainStep[]) =>
  steps.map((step) => (step.kind === "wait" ? `wait:${step.reason}` : step.kind));

describe("resolveQueueDrainStep", () => {
  it("is idle without a queue", () => {
    expect(resolveQueueDrainStep(input({ queue: [] }))).toEqual({ kind: "idle" });
  });

  it("holds a thread that went from running to error after enqueue", () => {
    // Baseline recorded while the turn was running: nothing to acknowledge.
    const baseline = resolveQueueDrainStep(
      input({ acknowledgedCauseKeys: undefined, view: viewOf(RUNNING_THREAD) }),
    );
    expect(baseline).toEqual({ kind: "baseline", causeKeys: [] });
    const errored = viewOf({
      session: { status: "error", lastError: "Usage limit reached" },
      latestTurn: { turnId: "turn-1", state: "error" },
      messageIds: ["m-0"],
    });
    expect(kinds(drive(input({ acknowledgedCauseKeys: [], view: errored })))).toEqual([
      "hold",
      "wait:held",
    ]);
    expect(resolveQueueDrainStep(input({ view: errored }))).toMatchObject({
      kind: "hold",
      hold: {
        reason: "error",
        detail: "Usage limit reached",
        causeKeys: ["error:turn-1:Usage limit reached"],
      },
    });
  });

  it("sends an offline message composed on an already-errored thread", () => {
    const orphaned = viewOf({
      session: {
        status: "error",
        lastError:
          "Provider session did not survive a server restart. Send a new message to continue.",
      },
      latestTurn: { turnId: "turn-1", state: "interrupted" },
      messageIds: ["m-0"],
    });
    expect(kinds(drive(input({ acknowledgedCauseKeys: undefined, view: orphaned })))).toEqual([
      "baseline",
      "send",
    ]);
  });

  it("baselines a Stop the user saw while its turn was still settling", () => {
    const stopping = viewOf({
      session: { status: "running", activeTurnId: "turn-1" },
      latestTurn: { turnId: "turn-1", state: "interrupted" },
      messageIds: ["m-0"],
    });
    expect(
      resolveQueueDrainStep(input({ acknowledgedCauseKeys: undefined, view: stopping })),
    ).toEqual({ kind: "baseline", causeKeys: ["interrupt:turn-1"] });
    const settled = viewOf({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-1", state: "interrupted" },
      messageIds: ["m-0"],
    });
    expect(
      kinds(drive(input({ acknowledgedCauseKeys: ["interrupt:turn-1"], view: settled }))),
    ).toEqual(["send"]);
    expect(kinds(drive(input({ acknowledgedCauseKeys: [], view: settled })))).toEqual([
      "hold",
      "wait:held",
    ]);
  });

  it("holds a restart-orphan error that arrives after enqueue", () => {
    const orphaned = viewOf({
      session: { status: "error", lastError: "Provider session did not survive a server restart." },
      latestTurn: { turnId: "turn-1", state: "completed" },
      messageIds: ["m-0"],
    });
    expect(kinds(drive(input({ acknowledgedCauseKeys: [], view: orphaned })))).toEqual([
      "hold",
      "wait:held",
    ]);
  });

  it("covers Stop then an error settle with a single Resume", () => {
    const stop = createInterruptQueueHold("turn-1", NOW);
    const settledWithError = viewOf({
      session: { status: "error", lastError: "aborted" },
      latestTurn: { turnId: "turn-1", state: "interrupted" },
      messageIds: ["m-0"],
    })!;
    const steps = drive(input({ hold: stop, view: settledWithError }));
    expect(kinds(steps)).toEqual(["hold", "wait:held"]);
    const merged = (steps[0] as Extract<QueueDrainStep, { kind: "hold" }>).hold;
    expect(merged.causeKeys).toEqual(["interrupt:turn-1", "error:turn-1:aborted"]);
    const acknowledged = releaseQueueHoldKeys(
      merged,
      deriveQueueFailureCauses(settledWithError, new Set()),
    );
    expect(
      kinds(
        drive(input({ hold: null, acknowledgedCauseKeys: acknowledged, view: settledWithError })),
      ),
    ).toEqual(["send"]);
  });

  it("waits on an archived thread or worktree", () => {
    expect(
      resolveQueueDrainStep(input({ view: viewOf({ ...IDLE_THREAD, archivedAt: NOW }) })),
    ).toEqual({ kind: "wait", reason: "archived" });
    expect(
      resolveQueueDrainStep(input({ view: viewOf({ ...IDLE_THREAD, worktreeArchivedAt: NOW }) })),
    ).toEqual({ kind: "wait", reason: "archived" });
  });

  it("waits on a cached environment before reconciling", () => {
    const projected = viewOf({ ...IDLE_THREAD, messageIds: ["q-1"] });
    expect(
      resolveQueueDrainStep(
        input({ view: projected, environment: { shellLive: false, mutationReady: false } }),
      ),
    ).toEqual({ kind: "wait", reason: "environment" });
    expect(resolveQueueDrainStep(input({ view: projected }))).toEqual({
      kind: "reconcile",
      removeIds: ["q-1"],
      endSteers: [],
    });
  });

  it("waits for thread detail before sending", () => {
    expect(
      resolveQueueDrainStep(input({ view: viewOf({ ...IDLE_THREAD, messageIds: undefined }) })),
    ).toEqual({ kind: "wait", reason: "detail" });
  });

  it("waits for the previous send's ack, then resolves started or failed", () => {
    const snapshot = captureQueuedDispatchSnapshot(viewOf(IDLE_THREAD), "q-0", NOW);
    expect(resolveQueueDrainStep(input({ pendingDispatch: snapshot }))).toEqual({
      kind: "wait",
      reason: "awaiting-ack",
    });
    expect(
      resolveQueueDrainStep(
        input({
          pendingDispatch: snapshot,
          view: viewOf({
            session: { status: "running", activeTurnId: "turn-2" },
            latestTurn: { turnId: "turn-2", state: "running" },
            messageIds: ["m-0"],
          }),
        }),
      ),
    ).toEqual({ kind: "dispatch-started", messageId: "q-0" });
    expect(
      resolveQueueDrainStep(
        input({
          pendingDispatch: snapshot,
          dispatchedMessageIds: new Set(["q-0"]),
          view: viewOf({
            ...IDLE_THREAD,
            activities: [turnStartFailed("a-1", "q-0", "Thread already has active turn")],
          }),
        }),
      ),
    ).toMatchObject({
      kind: "dispatch-failed",
      hold: {
        reason: "error",
        detail: "Thread already has active turn",
        causeKeys: ["start-failed:a-1"],
      },
    });
  });

  it("settles a send whose start a Stop cancelled without an error hold", () => {
    const snapshot = captureQueuedDispatchSnapshot(viewOf(IDLE_THREAD), "q-0", NOW);
    const steps = drive(
      input({
        pendingDispatch: snapshot,
        dispatchedMessageIds: new Set(["q-0"]),
        view: viewOf({
          session: { status: "stopped" },
          latestTurn: IDLE_THREAD.latestTurn,
          messageIds: ["m-0"],
          activities: [turnStartCancelled("c-1", "q-0")],
        }),
      }),
    );
    expect(steps[0]).toEqual({ kind: "dispatch-started", messageId: "q-0" });
    expect(steps.some((step) => step.kind === "hold" || step.kind === "dispatch-failed")).toBe(
      false,
    );
  });

  it("reconciles a projected sending head and ends a steer the provider rejected", () => {
    expect(
      resolveQueueDrainStep(
        input({
          queue: [{ id: "q-1", deliveryStatus: "sending" }, { id: "q-2" }],
          steerAttempts: { "q-2": steerAttempt("cmd-2") },
          view: viewOf({
            ...IDLE_THREAD,
            messageIds: ["q-1"],
            activities: [steerFailed("turn-steer-rejected:cmd-2", "q-2", "deferred")],
          }),
        }),
      ),
    ).toEqual({
      kind: "reconcile",
      removeIds: ["q-1"],
      endSteers: [
        {
          messageId: "q-2",
          attempt: steerAttempt("cmd-2"),
          reason: "deferred",
          error: "Steer rejected.",
          deliveryUncertain: false,
        },
      ],
    });
  });

  it("never ends a re-steer on a stale rejection of an earlier attempt", () => {
    expect(
      resolveQueueDrainStep(
        input({
          queue: [{ id: "q-1" }],
          steerAttempts: { "q-1": steerAttempt("cmd-new") },
          view: viewOf({
            ...RUNNING_THREAD,
            activities: [steerFailed("turn-steer-rejected:cmd-old", "q-1", "deferred")],
          }),
        }),
      ),
    ).toEqual({ kind: "wait", reason: "busy" });
  });

  it("sends a local draft with no thread view through the foreground sender", () => {
    expect(resolveQueueDrainStep(input({ view: null, draft: true, sender: "foreground" }))).toEqual(
      { kind: "send", messageId: "q-1", sender: "foreground" },
    );
    expect(
      resolveQueueDrainStep(
        input({ view: null, draft: true, environment: { shellLive: true, mutationReady: false } }),
      ),
    ).toEqual({ kind: "wait", reason: "environment" });
    expect(
      resolveQueueDrainStep(
        input({ view: null, draft: true, hold: createInterruptQueueHold(null, NOW) }),
      ),
    ).toEqual({ kind: "wait", reason: "held" });
  });

  it("acknowledges a failure on another provider, then sends", () => {
    const errored = viewOf({
      session: { status: "error", lastError: "boom", providerInstanceId: "claude" },
      latestTurn: { turnId: "turn-1", state: "error" },
      messageIds: ["m-0"],
    });
    const steps = drive(input({ view: errored, headProviderInstanceId: "codex" }));
    expect(kinds(steps)).toEqual(["acknowledge", "send"]);
    expect(steps[0]).toEqual({ kind: "acknowledge", causeKeys: ["error:turn-1:boom"] });
  });

  it.each([
    ["a missing shell on a live environment", { view: null }, "thread-gone"],
    ["a busy thread", { view: viewOf(RUNNING_THREAD) }, "wait:busy"],
    [
      "a pending approval",
      { view: viewOf({ ...IDLE_THREAD, summary: { hasPendingApprovals: true } }) },
      "wait:busy",
    ],
    [
      "a disconnected environment",
      { environment: { shellLive: true, mutationReady: false } },
      "wait:environment",
    ],
    ["no sender", { sender: null }, "wait:no-sender"],
    [
      "a failed head",
      { queue: [{ id: "q-1", deliveryStatus: "failed" as const }] },
      "wait:failed-head",
    ],
    [
      "a sending head",
      { queue: [{ id: "q-1", deliveryStatus: "sending" as const }] },
      "wait:in-flight",
    ],
    ["a steering head", { steerAttempts: { "q-1": steerAttempt("cmd-1") } }, "wait:steering"],
    ["an idle thread", {}, "send"],
  ] as const)("resolves %s", (_label, overrides, expected) => {
    expect(kinds([resolveQueueDrainStep(input(overrides as Partial<QueueDrainInput>))])).toEqual([
      expected,
    ]);
  });
});

describe("usage-limit holds", () => {
  const RESET = "2026-10-01T15:00:00.000Z";
  const RESET_MS = Date.parse(RESET);
  const at = (offsetMs: number) => new Date(RESET_MS + offsetMs).toISOString();
  const limit: ThreadUsageLimit = {
    limitId: "usage-limit:t:turn-1",
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    turnId: TurnId.make("turn-1"),
    message: "You've hit your usage limit.",
    limitedAt: "2026-10-01T10:00:00.000Z",
    resetAt: RESET,
    autoResume: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
  };
  const LIMITED: Omit<ThreadFixture, "id"> = {
    session: { status: "error", lastError: "You've hit your usage limit." },
    latestTurn: { turnId: "turn-1", state: "error" },
    messageIds: ["m-0"],
    usageLimit: limit,
  };
  const RESUMED_RUNNING: Omit<ThreadFixture, "id"> = {
    session: { status: "running", activeTurnId: "turn-2" },
    latestTurn: { turnId: "turn-2", state: "running" },
    messageIds: ["m-0", "resume"],
    usageLimit: null,
  };
  const RESUMED_DONE: Omit<ThreadFixture, "id"> = {
    session: { status: "ready" },
    latestTurn: { turnId: "turn-2", state: "completed" },
    messageIds: ["m-0", "resume"],
    usageLimit: null,
  };

  type DrainState = { -readonly [K in keyof QueueDrainInput]: QueueDrainInput[K] };

  /** Applies bookkeeping steps, including releases, until the drain waits or sends. */
  function settle(state: DrainState): string {
    for (let index = 0; index < 8; index += 1) {
      const step = resolveQueueDrainStep(state);
      if (step.kind === "baseline" || step.kind === "acknowledge") {
        state.acknowledgedCauseKeys = (state.acknowledgedCauseKeys ?? []).concat(step.causeKeys);
      } else if (step.kind === "hold") {
        state.hold = step.hold;
      } else if (step.kind === "release") {
        state.acknowledgedCauseKeys = (state.acknowledgedCauseKeys ?? []).concat(step.causeKeys);
        state.hold = state.hold ? removeQueueHoldCauses(state.hold, step.causeKeys) : null;
      } else {
        return step.kind === "wait" ? `wait:${step.reason}` : step.kind;
      }
    }
    throw new Error("drain did not settle");
  }

  /** Queued while the limited turn ran, then the limit landed. */
  function limitedQueue(nowIso: string): DrainState {
    const state: DrainState = { ...input({ view: viewOf(RUNNING_THREAD), nowIso }) };
    expect(settle(state)).toBe("wait:busy");
    state.view = viewOf(LIMITED);
    return state;
  }

  it("holds a limited thread's queue with the limit as the reason", () => {
    const state = limitedQueue(at(-3_600_000));
    expect(settle(state)).toBe("wait:held");
    expect(state.hold).toMatchObject({
      reason: "limit",
      detail: "You've hit your usage limit.",
      causeKeys: expect.arrayContaining(["limit:turn-1"]),
    });
  });

  it("stays held while a resumed turn runs and drains when it completes", () => {
    const state = limitedQueue(at(-3_600_000));
    expect(settle(state)).toBe("wait:held");
    state.nowIso = at(30_000);
    state.view = viewOf(RESUMED_RUNNING);
    expect(settle(state)).toBe("wait:busy");
    expect(state.hold).toBeNull();
    state.view = viewOf(RESUMED_DONE);
    expect(settle(state)).toBe("send");
  });

  it("releases an unarmed hold two minutes after the reset", () => {
    const state = limitedQueue(at(-3_600_000));
    expect(settle(state)).toBe("wait:held");
    state.nowIso = at(60_000);
    expect(settle(state)).toBe("wait:held");
    state.nowIso = at(2 * 60_000);
    expect(settle(state)).toBe("send");
    expect(state.hold).toBeNull();
  });

  it("keeps holding for a newer turn's own error after the limit is released", () => {
    const state = limitedQueue(at(-3_600_000));
    expect(settle(state)).toBe("wait:held");
    state.nowIso = at(30_000);
    state.view = viewOf({
      session: { status: "error", lastError: "Crashed" },
      latestTurn: { turnId: "turn-2", state: "error" },
      messageIds: ["m-0", "resume"],
      usageLimit: null,
    });
    expect(settle(state)).toBe("wait:held");
    expect(state.hold).toMatchObject({ reason: "error", causeKeys: ["error:turn-2:Crashed"] });
  });

  it("never holds for a limit on an instance the thread no longer targets", () => {
    const state = limitedQueue(at(-3_600_000));
    state.view = viewOf({ ...LIMITED, modelInstanceId: "claudeAgent" });
    state.headProviderInstanceId = "claudeAgent";
    expect(settle(state)).toBe("send");
  });
});

describe("restart holds", () => {
  type DrainState = { -readonly [K in keyof QueueDrainInput]: QueueDrainInput[K] };
  /** Applies bookkeeping steps, including releases, until the drain waits or sends. */
  function settle(state: DrainState): string {
    for (let index = 0; index < 8; index += 1) {
      const step = resolveQueueDrainStep(state);
      if (step.kind === "baseline" || step.kind === "acknowledge") {
        state.acknowledgedCauseKeys = (state.acknowledgedCauseKeys ?? []).concat(step.causeKeys);
      } else if (step.kind === "hold") {
        state.hold = step.hold;
      } else if (step.kind === "release") {
        state.acknowledgedCauseKeys = (state.acknowledgedCauseKeys ?? []).concat(step.causeKeys);
        state.hold = state.hold ? removeQueueHoldCauses(state.hold, step.causeKeys) : null;
      } else {
        return step.kind === "wait" ? `wait:${step.reason}` : step.kind;
      }
    }
    throw new Error("drain did not settle");
  }

  /** What startup reconciliation leaves on a turn the restart cut off. */
  const RECONCILED: Omit<ThreadFixture, "id"> = {
    session: { status: "error", lastError: ORPHANED_PROVIDER_SESSION_ERROR },
    latestTurn: { turnId: "turn-1", state: "interrupted" },
    messageIds: ["m-0"],
  };

  /** Queued while the turn ran, then the server restarted. */
  function restartedQueue(overrides: Partial<QueueDrainInput> = {}): DrainState {
    const state: DrainState = { ...input({ view: viewOf(RUNNING_THREAD), ...overrides }) };
    expect(settle(state)).toBe("wait:busy");
    state.view = viewOf(RECONCILED);
    return state;
  }

  it("holds after a restart until the continuation takes over, then drains when it completes", () => {
    const state = restartedQueue();
    // (a) The released session holds, as an error rather than as a Stop.
    expect(settle(state)).toBe("wait:held");
    expect(state.hold).toMatchObject({
      reason: "error",
      detail: ORPHANED_PROVIDER_SESSION_ERROR,
      causeKeys: [`error:turn-1:${ORPHANED_PROVIDER_SESSION_ERROR}`],
    });
    // (b) The continuation message is accepted; its turn has not started yet.
    state.view = viewOf({ ...RECONCILED, messageIds: ["m-0", "restart-continuation"] });
    expect(settle(state)).toBe("wait:held");
    // (c) The continuation turn runs.
    state.view = viewOf({
      session: { status: "running", activeTurnId: "turn-2" },
      latestTurn: { turnId: "turn-2", state: "running" },
      messageIds: ["m-0", "restart-continuation"],
    });
    expect(settle(state)).toBe("wait:busy");
    expect(state.hold).toBeNull();
    // (d) It completed normally: the queue drains.
    state.view = viewOf({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "restart-continuation", "assistant-2"],
    });
    expect(settle(state)).toBe("send");
  });

  it("holds again when the continuation itself fails", () => {
    const state = restartedQueue();
    expect(settle(state)).toBe("wait:held");
    state.view = viewOf({
      session: { status: "error", lastError: "Crashed" },
      latestTurn: { turnId: "turn-2", state: "error" },
      messageIds: ["m-0", "restart-continuation"],
    });
    expect(settle(state)).toBe("wait:held");
    expect(state.hold).toMatchObject({ causeKeys: ["error:turn-2:Crashed"] });
  });

  it("holds a message queued for another instance until the continuation takes over", () => {
    // The restarted session ran on codex; the queued message targets another instance.
    const state = restartedQueue({ headProviderInstanceId: "claudeAgent" });
    expect(settle(state)).toBe("wait:held");
    expect(state.hold).toMatchObject({
      reason: "error",
      causeKeys: [`error:turn-1:${ORPHANED_PROVIDER_SESSION_ERROR}`],
    });
    state.view = viewOf({ ...RECONCILED, messageIds: ["m-0", "restart-continuation"] });
    expect(settle(state)).toBe("wait:held");
    state.view = viewOf({
      session: { status: "running", activeTurnId: "turn-2" },
      latestTurn: { turnId: "turn-2", state: "running" },
      messageIds: ["m-0", "restart-continuation"],
    });
    expect(settle(state)).toBe("wait:busy");
    expect(state.hold).toBeNull();
    state.view = viewOf({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "restart-continuation", "assistant-2"],
    });
    expect(settle(state)).toBe("send");
  });

  /** The restarted turn's session left `error` without a new turn (e.g. a session stop). */
  const STOPPED_AFTER_RESTART: Omit<ThreadFixture, "id"> = {
    session: { status: "stopped", lastError: ORPHANED_PROVIDER_SESSION_ERROR },
    latestTurn: { turnId: "turn-1", state: "interrupted" },
    messageIds: ["m-0"],
  };

  it("does not read the restarted turn as a Stop after Resume once its session stops", () => {
    const state = restartedQueue();
    expect(settle(state)).toBe("wait:held");
    // Resume acknowledges the hold and every current cause, the restarted turn's included.
    state.acknowledgedCauseKeys = (state.acknowledgedCauseKeys ?? []).concat(
      releaseQueueHoldKeys(
        state.hold,
        deriveQueueFailureCauses(state.view!, new Set(), { includeUnsettled: true }),
      ),
    );
    state.hold = null;
    state.view = viewOf(STOPPED_AFTER_RESTART);
    expect(settle(state)).toBe("send");
  });

  it("keeps a restart hold an error hold when its session stops, and releases it later", () => {
    const state = restartedQueue();
    expect(settle(state)).toBe("wait:held");
    state.view = viewOf(STOPPED_AFTER_RESTART);
    expect(settle(state)).toBe("wait:held");
    expect(state.hold).toMatchObject({
      reason: "error",
      causeKeys: [`error:turn-1:${ORPHANED_PROVIDER_SESSION_ERROR}`],
    });
    // The user's own message runs and completes: nothing is left that reads as a Stop.
    state.view = viewOf({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "direct-send", "assistant-2"],
    });
    expect(settle(state)).toBe("send");
  });

  it("baselines the restarted turn so a later session stop does not hold", () => {
    const state: DrainState = {
      ...input({ acknowledgedCauseKeys: undefined, view: viewOf(RECONCILED) }),
    };
    expect(resolveQueueDrainStep(state)).toEqual({
      kind: "baseline",
      causeKeys: [`error:turn-1:${ORPHANED_PROVIDER_SESSION_ERROR}`, "interrupt:turn-1"],
    });
    expect(settle(state)).toBe("send");
    state.view = viewOf(STOPPED_AFTER_RESTART);
    expect(settle(state)).toBe("send");
  });

  // Known limit: the projection records no Stop, so another client's Stop the provider had
  // not acknowledged before the restart reads exactly like the restart on this client.
  it("cannot tell another client's unacknowledged Stop from the restart", () => {
    const state = restartedQueue();
    expect(settle(state)).toBe("wait:held");
    expect(state.hold?.reason).toBe("error");
    state.view = viewOf({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "direct-send", "assistant-2"],
    });
    expect(settle(state)).toBe("send");
  });

  it("keeps a Stop recorded before the restart held until Resume", () => {
    const state = restartedQueue();
    state.hold = createInterruptQueueHold("turn-1", NOW);
    expect(settle(state)).toBe("wait:held");
    state.view = viewOf({
      session: { status: "ready" },
      latestTurn: { turnId: "turn-2", state: "completed" },
      messageIds: ["m-0", "direct-send", "assistant-2"],
    });
    expect(settle(state)).toBe("wait:held");
    expect(state.hold?.causeKeys).toEqual(["interrupt:turn-1"]);
  });
});
