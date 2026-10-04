import { TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeQueueAppState,
  queueRef,
  turnStartFailed,
  type ThreadFixture,
} from "../../../test/queueThreadFixtures.ts";
import { readQueueThreadView } from "../message-queue/threadView.ts";
import { getThreadFromEnvironmentState } from "../threads/threadDerivation.ts";
import {
  captureQueuedDispatchSnapshot,
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  resolveQueuedDispatchAck,
} from "./dispatchAck.ts";
import { derivePhase } from "./session-logic.ts";

const NOW = "2026-10-01T12:00:00.000Z";

function stateOf(fixture: Omit<ThreadFixture, "id">) {
  return makeQueueAppState([{ id: "t", messageIds: [], ...fixture }]);
}
function viewOf(fixture: Omit<ThreadFixture, "id">) {
  return readQueueThreadView(stateOf(fixture), queueRef("t"))!;
}
function threadOf(fixture: Omit<ThreadFixture, "id">) {
  const state = stateOf(fixture);
  return getThreadFromEnvironmentState(
    state.environmentStateById[queueRef("t").environmentId]!,
    queueRef("t").threadId,
  )!;
}

const SETTLED = {
  session: { status: "ready" as const },
  latestTurn: { turnId: "turn-1", state: "completed" as const },
};

describe("resolveQueuedDispatchAck", () => {
  it("stays pending through the startSession bind that the UI gate already treats as an ack", () => {
    const snapshot = captureQueuedDispatchSnapshot(viewOf(SETTLED), "queued-1", NOW);
    // startSession's bind: session-set with the provider status and no active
    // turn, *before* turn.started.
    const bind = {
      session: { status: "ready" as const, updatedAt: "2026-10-01T12:00:01.000Z" },
      latestTurn: SETTLED.latestTurn,
    };
    expect(resolveQueuedDispatchAck({ snapshot, view: viewOf(bind) })).toEqual({
      kind: "pending",
    });

    // The loose UI gate releases on exactly this event; a second queued
    // `thread.turn.start` sent now is accepted and then orphaned.
    const before = threadOf(SETTLED);
    const afterBind = threadOf(bind);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: createLocalDispatchSnapshot(before),
        phase: derivePhase(afterBind.session),
        latestTurn: afterBind.latestTurn,
        session: afterBind.session,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);

    const started = {
      session: { status: "running" as const, activeTurnId: "turn-2" },
      latestTurn: { turnId: "turn-2", state: "running" as const },
    };
    expect(resolveQueuedDispatchAck({ snapshot, view: viewOf(started) })).toEqual({
      kind: "started",
      turnId: TurnId.make("turn-2"),
    });
  });

  it("does not acknowledge a /compact turn that settled before the snapshot", () => {
    const afterCompact = {
      session: { status: "ready" as const },
      latestTurn: { turnId: "compact-turn", state: "completed" as const },
    };
    const snapshot = captureQueuedDispatchSnapshot(viewOf(afterCompact), "queued-1", NOW);
    expect(resolveQueuedDispatchAck({ snapshot, view: viewOf(afterCompact) }).kind).toBe("pending");
  });

  it("fails on a start failure for the dispatched message only", () => {
    const snapshot = captureQueuedDispatchSnapshot(viewOf(SETTLED), "queued-1", NOW);
    expect(
      resolveQueuedDispatchAck({
        snapshot,
        view: viewOf({ ...SETTLED, activities: [turnStartFailed("a-1", "other")] }),
      }).kind,
    ).toBe("pending");
    expect(
      resolveQueuedDispatchAck({
        snapshot,
        view: viewOf({
          ...SETTLED,
          activities: [turnStartFailed("a-2", "queued-1", "Thread already has active turn")],
        }),
      }),
    ).toEqual({
      kind: "failed",
      causeKey: "start-failed:a-2",
      detail: "Thread already has active turn",
    });
  });

  it("acknowledges a new running turn", () => {
    const snapshot = captureQueuedDispatchSnapshot(viewOf(SETTLED), "queued-1", NOW);
    expect(
      resolveQueuedDispatchAck({
        snapshot,
        view: viewOf({
          session: { status: "running", activeTurnId: "turn-2" },
          latestTurn: SETTLED.latestTurn,
        }),
      }).kind,
    ).toBe("started");
  });

  it("acknowledges a turn that started and settled inside one applied batch", () => {
    const snapshot = captureQueuedDispatchSnapshot(viewOf(SETTLED), "queued-1", NOW);
    expect(
      resolveQueuedDispatchAck({
        snapshot,
        view: viewOf({
          session: { status: "ready" },
          latestTurn: { turnId: "turn-2", state: "completed" },
        }),
      }),
    ).toEqual({ kind: "started", turnId: TurnId.make("turn-2") });
  });

  it("ignores session churn: lastError, status and updatedAt", () => {
    const snapshot = captureQueuedDispatchSnapshot(viewOf(SETTLED), "queued-1", NOW);
    for (const session of [
      { status: "error" as const, lastError: "boom" },
      { status: "stopped" as const, lastError: "boom" },
      { status: "starting" as const, updatedAt: "2026-10-01T12:00:05.000Z" },
    ]) {
      expect(
        resolveQueuedDispatchAck({
          snapshot,
          view: viewOf({ session, latestTurn: SETTLED.latestTurn }),
        }).kind,
      ).toBe("pending");
    }
  });
});

describe("local-dispatch UI gate (moved)", () => {
  it("still releases the composer on any server reaction", () => {
    const before = threadOf(SETTLED);
    const afterError = threadOf({
      session: { status: "error", lastError: "boom", updatedAt: "2026-10-01T12:00:02.000Z" },
      latestTurn: SETTLED.latestTurn,
    });
    const localDispatch = createLocalDispatchSnapshot(before);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: derivePhase(before.session),
        latestTurn: before.latestTurn,
        session: before.session,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: derivePhase(afterError.session),
        latestTurn: afterError.latestTurn,
        session: afterError.session,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});
