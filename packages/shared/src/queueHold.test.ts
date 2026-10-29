import { FollowUpQueueHoldInput } from "@ryco/contracts/orchestration";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  createInterruptQueueHold,
  deriveQueueFailureCauses,
  describeQueueHold,
  isQueueFailureCauseExempt,
  mergeQueueHold,
  pausedCauseKey,
  queueHoldInputOf,
  queueHoldReasonForCauseKey,
  removeQueueHoldCauses,
  restartCauseKey,
  sessionErrorCauseKey,
  trashedCauseKey,
  turnStartFailedCauseKey,
  type QueueHoldThreadView,
} from "./queueHold.ts";

const at = "2026-10-24T10:00:00.000Z";

describe("queue hold rules shared with the server queue", () => {
  it("names the causes the server records", () => {
    expect(sessionErrorCauseKey("turn-1", "boom")).toBe("error:turn-1:boom");
    expect(sessionErrorCauseKey(null, null)).toBe("error:session:");
    expect(turnStartFailedCauseKey("activity-1")).toBe("start-failed:activity-1");
    expect(queueHoldReasonForCauseKey(restartCauseKey("7"))).toBe("restart");
    expect(queueHoldReasonForCauseKey(pausedCauseKey(at))).toBe("paused");
  });

  it("ranks a restart above a Stop and a pause, and below an error", () => {
    const stopped = mergeQueueHold(
      null,
      { reason: "interrupted", causeKeys: ["interrupt:t"], detail: null },
      at,
    );
    const restarted = mergeQueueHold(
      stopped,
      { reason: "restart", causeKeys: ["restart:1"], detail: "Ryco restarted." },
      at,
    );
    expect(restarted).toEqual({
      reason: "restart",
      detail: "Ryco restarted.",
      causeKeys: ["interrupt:t", "restart:1"],
      heldAt: at,
    });
    expect(
      mergeQueueHold(restarted, { reason: "paused", causeKeys: ["paused:x"], detail: null }, at)
        .reason,
    ).toBe("restart");
    expect(
      mergeQueueHold(restarted, { reason: "error", causeKeys: ["error:t:x"], detail: "x" }, at)
        .reason,
    ).toBe("error");
    expect(removeQueueHoldCauses(restarted, ["restart:1"])).toEqual({
      reason: "interrupted",
      detail: null,
      causeKeys: ["interrupt:t"],
      heldAt: at,
    });
  });

  it("exempts another instance's failure, never a Stop or a cause without an instance", () => {
    expect(isQueueFailureCauseExempt({ reason: "error", providerInstanceId: "a" }, "b")).toBe(true);
    expect(isQueueFailureCauseExempt({ reason: "limit", providerInstanceId: "a" }, "a")).toBe(
      false,
    );
    expect(isQueueFailureCauseExempt({ reason: "interrupted", providerInstanceId: "a" }, "b")).toBe(
      false,
    );
    expect(isQueueFailureCauseExempt({ reason: "error", providerInstanceId: null }, "b")).toBe(
      false,
    );
  });

  it("has copy for the server's own reasons", () => {
    expect(
      describeQueueHold({ reason: "restart", detail: "d", causeKeys: ["restart:1"], heldAt: at }),
    ).toEqual({ title: "Paused after Ryco restarted", detail: "d" });
    expect(
      describeQueueHold({ reason: "paused", detail: "x", causeKeys: ["paused:1"], heldAt: at }),
    ).toEqual({ title: "Paused", detail: null });
  });
});

describe("holds a device hands to the node", () => {
  const decodeInput = Schema.decodeUnknownSync(FollowUpQueueHoldInput);
  const longError = (tail: string) => `${"Provider exploded. ".repeat(300)}${tail}`;

  it("keeps a long provider error's cause key short, stable and distinct", () => {
    const key = sessionErrorCauseKey("turn-1", longError("a"));
    expect(key.length).toBeLessThanOrEqual(220);
    expect(key).toBe(sessionErrorCauseKey("turn-1", longError("a")));
    expect(key).not.toBe(sessionErrorCauseKey("turn-1", longError("b")));
    // The client's derived cause uses the same builder, so client and server keys agree.
    const view: QueueHoldThreadView = {
      detailLoaded: true,
      session: {
        status: "error",
        lastError: longError("a"),
        providerInstanceId: "codex",
        activeTurnId: null,
      },
      latestTurn: { turnId: "turn-1" as never, state: "error" },
      latestTurnPlaceholderCheckpoint: false,
      turnStartFailures: [],
    };
    expect(deriveQueueFailureCauses(view, new Set()).map((cause) => cause.causeKey)).toContain(key);
  });

  it("turns any derived hold into one the server accepts", () => {
    const error = longError("c");
    const derived = mergeQueueHold(
      createInterruptQueueHold("turn-0", at),
      { reason: "error", causeKeys: [sessionErrorCauseKey("turn-1", error)], detail: error },
      at,
    );
    const input = queueHoldInputOf({
      ...derived,
      causeKeys: [
        ...derived.causeKeys,
        `legacy:${"x".repeat(2_000)}`,
        "  ",
        ...Array.from({ length: 40 }, (_, index) => `interrupt:turn-${index}`),
      ],
    });
    expect(input).not.toBeNull();
    expect(decodeInput(input)).toEqual(input);
    expect(input!.detail!.length).toBe(1_000);
    expect(input!.causeKeys).toHaveLength(32);
    expect(queueHoldInputOf({ reason: "paused", detail: null, causeKeys: [" "] })).toBeNull();
  });

  it("reads a Trash cause as a pause", () => {
    expect(queueHoldReasonForCauseKey(trashedCauseKey(at))).toBe("paused");
  });
});
