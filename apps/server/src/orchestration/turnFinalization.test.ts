import {
  EventId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  TURN_FINALIZATION_REASON,
  fallbackReleasedTurnState,
  resolveReleasedTurn,
  runtimeTerminalTurnState,
} from "./turnFinalization.ts";

const threadId = ThreadId.make("thread-finalize");
const turnX = TurnId.make("turn-x");
const turnY = TurnId.make("turn-y");
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";

function session(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId,
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: T2,
    ...overrides,
  };
}

function latestTurn(overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn {
  return {
    turnId: turnX,
    state: "running",
    requestedAt: T0,
    startedAt: T1,
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  };
}

function terminalEvent(
  input:
    | { readonly type: "turn.completed"; readonly state: string }
    | { readonly type: "turn.aborted" },
): Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }> {
  const base = {
    eventId: EventId.make("event-terminal"),
    provider: "codex",
    threadId,
    runtimeSessionId: RuntimeSessionId.make("runtime-1"),
    turnId: turnX,
    createdAt: T2,
  } as const;
  return (
    input.type === "turn.aborted"
      ? { ...base, type: "turn.aborted", payload: { reason: "stopped" } }
      : { ...base, type: "turn.completed", payload: { state: input.state } }
  ) as Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>;
}

describe("runtimeTerminalTurnState", () => {
  it.each([
    [{ type: "turn.completed", state: "completed" } as const, "completed"],
    [{ type: "turn.completed", state: "failed" } as const, "error"],
    [{ type: "turn.completed", state: "interrupted" } as const, "interrupted"],
    [{ type: "turn.completed", state: "cancelled" } as const, "interrupted"],
    [{ type: "turn.aborted" } as const, "interrupted"],
  ])("maps %j to %s", (input, expected) => {
    expect(runtimeTerminalTurnState(terminalEvent(input))).toBe(expected);
  });
});

describe("fallbackReleasedTurnState", () => {
  it("labels an error session as error", () => {
    expect(fallbackReleasedTurnState({ status: "error" })).toBe("error");
  });

  it.each(["ready", "stopped", "idle", "starting", "interrupted"] as const)(
    "labels a %s session as interrupted, never completed",
    (status) => {
      expect(fallbackReleasedTurnState({ status })).toBe("interrupted");
    },
  );
});

describe("resolveReleasedTurn", () => {
  it("releases nothing without a candidate turn", () => {
    expect(
      resolveReleasedTurn({
        thread: { session: session(), latestTurn: latestTurn({ state: "completed" }) },
        nextSession: session(),
        outcome: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveReleasedTurn({
        thread: { session: null, latestTurn: null },
        nextSession: session(),
        outcome: {
          state: "completed",
          reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
        },
      }),
    ).toBeUndefined();
  });

  it("releases nothing while the same active turn is kept", () => {
    expect(
      resolveReleasedTurn({
        thread: {
          session: session({ status: "running", activeTurnId: turnX }),
          latestTurn: latestTurn(),
        },
        nextSession: session({ status: "error", activeTurnId: turnX }),
        outcome: undefined,
      }),
    ).toBeUndefined();
  });

  it("applies a turn-less hint to the released turn", () => {
    expect(
      resolveReleasedTurn({
        thread: {
          session: session({ status: "running", activeTurnId: turnX }),
          latestTurn: latestTurn(),
        },
        nextSession: session({ status: "ready" }),
        outcome: {
          state: "interrupted",
          reason: TURN_FINALIZATION_REASON.sessionReplaced,
          completedAt: T3,
        },
      }),
    ).toEqual({
      turnId: turnX,
      state: "interrupted",
      reason: TURN_FINALIZATION_REASON.sessionReplaced,
      completedAt: T3,
    });
  });

  it("ignores a hint for another turn and falls back", () => {
    expect(
      resolveReleasedTurn({
        thread: {
          session: session({ status: "running", activeTurnId: turnX }),
          latestTurn: latestTurn(),
        },
        nextSession: session({ status: "ready", updatedAt: T3 }),
        outcome: {
          turnId: turnY,
          state: "completed",
          reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
          completedAt: T2,
        },
      }),
    ).toEqual({
      turnId: turnX,
      state: "interrupted",
      reason: TURN_FINALIZATION_REASON.sessionReleased,
      completedAt: T3,
    });
  });

  it("takes a running latest turn as the candidate when no turn is active", () => {
    expect(
      resolveReleasedTurn({
        thread: { session: session({ status: "error" }), latestTurn: latestTurn() },
        nextSession: session({ status: "error", updatedAt: T3 }),
        outcome: undefined,
      }),
    ).toEqual({
      turnId: turnX,
      state: "error",
      reason: TURN_FINALIZATION_REASON.sessionReleased,
      completedAt: T3,
    });
  });

  it("takes the active turn as the candidate while latestTurn already says completed", () => {
    expect(
      resolveReleasedTurn({
        thread: {
          session: session({ status: "running", activeTurnId: turnX }),
          latestTurn: latestTurn({ state: "completed", completedAt: T2 }),
        },
        nextSession: session({ status: "error", updatedAt: T3 }),
        outcome: {
          turnId: turnX,
          state: "error",
          reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
          completedAt: T3,
        },
      }),
    ).toEqual({
      turnId: turnX,
      state: "error",
      reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
      completedAt: T3,
    });
  });

  it("releases X as interrupted when a new active turn Y starts", () => {
    expect(
      resolveReleasedTurn({
        thread: {
          session: session({ status: "running", activeTurnId: turnX }),
          latestTurn: latestTurn(),
        },
        nextSession: session({ status: "running", activeTurnId: turnY, updatedAt: T3 }),
        outcome: undefined,
      }),
    ).toEqual({
      turnId: turnX,
      state: "interrupted",
      reason: TURN_FINALIZATION_REASON.sessionReleased,
      completedAt: T3,
    });
  });

  it("clamps completedAt to the turn's start when the session timestamp is earlier", () => {
    const released = resolveReleasedTurn({
      thread: {
        session: session({ status: "ready" }),
        latestTurn: latestTurn({ requestedAt: T0, startedAt: T2 }),
      },
      nextSession: session({ status: "ready", updatedAt: T1 }),
      outcome: undefined,
    });
    expect(released?.completedAt).toBe(T2);
  });
});
