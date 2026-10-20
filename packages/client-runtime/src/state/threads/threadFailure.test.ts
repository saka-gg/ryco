import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { describe, expect, it } from "vite-plus/test";

import {
  isThreadFailed,
  RESTART_INTERRUPTION_NOTICE,
  restartInterruptionNotice,
  sessionFailureDetail,
} from "./threadFailure.ts";

const released = { status: "error", lastError: ORPHANED_PROVIDER_SESSION_ERROR };
const failed = { status: "error", lastError: "Provider exited (code 1)" };

describe("isThreadFailed", () => {
  it("counts a session or turn error as a failure", () => {
    expect(isThreadFailed({ session: failed, latestTurn: null })).toBe(true);
    expect(isThreadFailed({ session: { status: "error" }, latestTurn: null })).toBe(true);
    expect(isThreadFailed({ session: null, latestTurn: { state: "error" } })).toBe(true);
  });

  it("does not count a restart release or a quiet session as a failure", () => {
    expect(isThreadFailed({ session: released, latestTurn: { state: "interrupted" } })).toBe(false);
    expect(isThreadFailed({ session: released, latestTurn: null })).toBe(false);
    expect(isThreadFailed({ session: { status: "ready" }, latestTurn: null })).toBe(false);
    expect(isThreadFailed({ session: null, latestTurn: null })).toBe(false);
  });

  it("still counts a turn that failed before the restart released its session", () => {
    expect(isThreadFailed({ session: released, latestTurn: { state: "error" } })).toBe(true);
  });
});

describe("sessionFailureDetail", () => {
  it("reports the provider error and drops the restart marker", () => {
    expect(sessionFailureDetail(failed)).toBe("Provider exited (code 1)");
    expect(sessionFailureDetail({ status: "ready", lastError: "Send failed" })).toBe("Send failed");
    expect(sessionFailureDetail(released)).toBeNull();
    expect(sessionFailureDetail({ status: "ready" })).toBeNull();
    expect(sessionFailureDetail(null)).toBeNull();
  });
});

describe("restartInterruptionNotice", () => {
  const interruptedTurn = { turnId: "turn-1" };

  it("explains a restart release the node left without a notice", () => {
    expect(
      restartInterruptionNotice({ session: released, latestTurn: interruptedTurn, activities: [] }),
    ).toBe(RESTART_INTERRUPTION_NOTICE);
    expect(restartInterruptionNotice({ session: released, latestTurn: null, activities: [] })).toBe(
      RESTART_INTERRUPTION_NOTICE,
    );
  });

  it("stays quiet when the node already explained the interrupted turn", () => {
    expect(
      restartInterruptionNotice({
        session: released,
        latestTurn: interruptedTurn,
        activities: [{ kind: "restart.continuation-skipped", turnId: "turn-1" }],
      }),
    ).toBeNull();
  });

  it("does not take an older turn's notice or other activities as the explanation", () => {
    expect(
      restartInterruptionNotice({
        session: released,
        latestTurn: interruptedTurn,
        activities: [
          { kind: "restart.continuation-skipped", turnId: "turn-0" },
          { kind: "restart.background-work-stopped", turnId: "turn-1" },
        ],
      }),
    ).toBe(RESTART_INTERRUPTION_NOTICE);
  });

  it("is null for a thread a restart did not release", () => {
    for (const session of [failed, { status: "ready" }, null]) {
      expect(
        restartInterruptionNotice({ session, latestTurn: interruptedTurn, activities: [] }),
      ).toBeNull();
    }
  });
});
