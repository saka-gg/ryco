import { describe, expect, it } from "vite-plus/test";

import {
  makeQueueAppState,
  queueRef,
  steerFailed,
  turnStartFailed,
  type ThreadFixture,
} from "../../../test/queueThreadFixtures.ts";
import { captureQueuedDispatchSnapshot } from "../session/dispatchAck.ts";
import { resolveQueueDrainStep, type QueueDrainInput, type QueueDrainStep } from "./drain.ts";
import {
  createInterruptQueueHold,
  releaseQueueHoldKeys,
  deriveQueueFailureCauses,
} from "./hold.ts";
import { readQueueThreadView } from "./threadView.ts";

const NOW = "2026-10-01T12:00:00.000Z";
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
    steeringIds: [],
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
      endSteerIds: [],
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

  it("reconciles a projected sending head and ends a steer the provider rejected", () => {
    expect(
      resolveQueueDrainStep(
        input({
          queue: [{ id: "q-1", deliveryStatus: "sending" }, { id: "q-2" }],
          steeringIds: ["q-2"],
          view: viewOf({
            ...IDLE_THREAD,
            messageIds: ["q-1"],
            activities: [steerFailed("a", "q-2")],
          }),
        }),
      ),
    ).toEqual({ kind: "reconcile", removeIds: ["q-1"], endSteerIds: ["q-2"] });
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
    ["a steering head", { steeringIds: ["q-1"] }, "wait:steering"],
    ["an idle thread", {}, "send"],
  ] as const)("resolves %s", (_label, overrides, expected) => {
    expect(kinds([resolveQueueDrainStep(input(overrides as Partial<QueueDrainInput>))])).toEqual([
      expected,
    ]);
  });
});
