import { describe, expect, it } from "vite-plus/test";

import {
  readTurnSteerRejectionActivity,
  TURN_STEER_FAILED_ACTIVITY_KIND,
  turnSteerRejectionActivityId,
} from "./turnSteer.ts";

describe("turnSteerRejectionActivityId", () => {
  it("derives one activity id per steer request", () => {
    expect(turnSteerRejectionActivityId("cmd-1")).toBe("turn-steer-rejected:cmd-1");
  });
});

describe("readTurnSteerRejectionActivity", () => {
  it("reads the reason and error of a rejection row", () => {
    expect(
      readTurnSteerRejectionActivity({
        kind: TURN_STEER_FAILED_ACTIVITY_KIND,
        payload: {
          messageId: "message-1",
          expectedTurnId: "turn-1",
          error: "The turn finished.",
          reason: "deferred",
        },
      }),
    ).toEqual({ messageId: "message-1", reason: "deferred", error: "The turn finished." });
  });

  it("reads a legacy row without a reason as failed", () => {
    expect(
      readTurnSteerRejectionActivity({
        kind: TURN_STEER_FAILED_ACTIVITY_KIND,
        payload: { messageId: "message-1", error: "Provider exploded." },
      }),
    ).toEqual({ messageId: "message-1", reason: "failed", error: "Provider exploded." });
  });

  it("tolerates a malformed payload", () => {
    expect(
      readTurnSteerRejectionActivity({ kind: TURN_STEER_FAILED_ACTIVITY_KIND, payload: null }),
    ).toEqual({ messageId: null, reason: "failed", error: "Provider rejected turn steering." });
  });

  it("returns null for other activity kinds", () => {
    expect(
      readTurnSteerRejectionActivity({
        kind: "provider.turn.start.failed",
        payload: { messageId: "message-1", reason: "deferred", error: "x" },
      }),
    ).toBeNull();
  });
});
