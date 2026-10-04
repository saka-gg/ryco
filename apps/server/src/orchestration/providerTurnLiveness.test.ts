import {
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyTurnLiveness,
  type TurnLivenessVerdict,
  unresponsiveTurnDetail,
} from "./providerTurnLiveness.ts";

const threadId = ThreadId.make("thread-1");
const runtime = RuntimeSessionId.make("runtime-1");
const turnId = TurnId.make("turn-1");
const SWEEP = 60_000;
const UNRESPONSIVE = 15 * 60_000;

const runningSession: OrchestrationSession = {
  threadId,
  status: "running",
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: runtime,
  runtimeMode: "full-access",
  activeTurnId: turnId,
  lastError: null,
  updatedAt: "2026-10-04T00:00:00.000Z",
};

type Input = Parameters<typeof classifyTurnLiveness>[0];

const classify = (overrides: Partial<Input>): TurnLivenessVerdict =>
  classifyTurnLiveness({
    session: runningSession,
    hasPendingRequest: false,
    backgroundLiveness: null,
    liveRuntimeSessionId: runtime,
    activity: { threadId, runtimeSessionId: runtime, lastActivityAtMs: 0 },
    previous: null,
    alreadyWarned: false,
    nowMs: 1_000,
    sweepIntervalMs: SWEEP,
    unresponsiveAfterMs: UNRESPONSIVE,
    ...overrides,
  });

describe("classifyTurnLiveness", () => {
  it("1. ignores sessions that are not running a known turn", () => {
    expect(classify({ session: null }).kind).toBe("not-applicable");
    expect(classify({ session: { ...runningSession, status: "ready" } }).kind).toBe(
      "not-applicable",
    );
    expect(classify({ session: { ...runningSession, activeTurnId: null } }).kind).toBe(
      "not-applicable",
    );
    const { runtimeSessionId: _omitted, ...legacy } = runningSession;
    expect(classify({ session: legacy }).kind).toBe("not-applicable");
  });

  it("2. ignores a missing or foreign activity record", () => {
    expect(classify({ activity: null }).kind).toBe("not-applicable");
    expect(
      classify({
        activity: {
          threadId,
          runtimeSessionId: RuntimeSessionId.make("runtime-other"),
          lastActivityAtMs: 0,
        },
      }).kind,
    ).toBe("not-applicable");
  });

  it("3. needs two silent sweeps without a live runtime to call a turn lost", () => {
    const silent = { liveRuntimeSessionId: null, nowMs: SWEEP } as const;
    // Recent events: the runtime may still be finishing.
    expect(classify({ liveRuntimeSessionId: null, nowMs: SWEEP - 1 }).kind).toBe("healthy");
    const first = classify(silent);
    expect(first).toEqual({ kind: "suspect-lost", runtimeSessionId: runtime, turnId });
    expect(classify({ ...silent, previous: first })).toEqual({
      kind: "lost",
      runtimeSessionId: runtime,
      turnId,
    });
    // Re-checking a lost verdict keeps it.
    expect(
      classify({ ...silent, previous: { kind: "lost", runtimeSessionId: runtime, turnId } }),
    ).toEqual({ kind: "lost", runtimeSessionId: runtime, turnId });
    // A suspicion about another turn does not count.
    expect(
      classify({
        ...silent,
        previous: { kind: "suspect-lost", runtimeSessionId: runtime, turnId: TurnId.make("old") },
      }).kind,
    ).toBe("suspect-lost");
  });

  it("4. leaves a turn alone while another runtime is live", () => {
    expect(
      classify({
        liveRuntimeSessionId: RuntimeSessionId.make("runtime-2"),
        nowMs: UNRESPONSIVE * 2,
      }).kind,
    ).toBe("not-applicable");
  });

  it("5. never calls a turn waiting on the user or on background work unresponsive", () => {
    expect(classify({ hasPendingRequest: true, nowMs: UNRESPONSIVE * 2 }).kind).toBe("healthy");
    expect(classify({ backgroundLiveness: "working", nowMs: UNRESPONSIVE * 2 }).kind).toBe(
      "healthy",
    );
    expect(classify({ backgroundLiveness: "monitoring", nowMs: UNRESPONSIVE * 2 }).kind).toBe(
      "healthy",
    );
  });

  it("6. reports a silent live turn once", () => {
    expect(classify({ nowMs: UNRESPONSIVE })).toEqual({
      kind: "unresponsive",
      runtimeSessionId: runtime,
      turnId,
      silentForMs: UNRESPONSIVE,
      lastActivityAtMs: 0,
    });
    expect(classify({ nowMs: UNRESPONSIVE, alreadyWarned: true }).kind).toBe("healthy");
  });

  it("7. otherwise the turn is healthy", () => {
    expect(classify({ nowMs: UNRESPONSIVE - 1 }).kind).toBe("healthy");
  });

  it("describes the silence in whole minutes", () => {
    expect(unresponsiveTurnDetail(15 * 60_000)).toBe(
      "No provider activity for 15 minutes. It may be running a long silent command, or it may be stuck. Stop the turn if it does not recover.",
    );
    expect(unresponsiveTurnDetail(10)).toContain("for 1 minute.");
  });
});
