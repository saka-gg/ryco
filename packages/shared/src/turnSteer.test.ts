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
    ).toEqual({
      messageId: "message-1",
      reason: "deferred",
      error: "The turn finished.",
      deliveryUncertain: false,
    });
  });

  it("reads a rejection the provider may have received as delivery-uncertain", () => {
    expect(
      readTurnSteerRejectionActivity({
        kind: TURN_STEER_FAILED_ACTIVITY_KIND,
        payload: {
          messageId: "message-1",
          error: "Ryco restarted while delivering this steer message.",
          reason: "failed",
          deliveryUncertain: true,
        },
      }),
    ).toEqual({
      messageId: "message-1",
      reason: "failed",
      error: "Ryco restarted while delivering this steer message.",
      deliveryUncertain: true,
    });
  });

  it("reads a legacy row without a reason as failed", () => {
    expect(
      readTurnSteerRejectionActivity({
        kind: TURN_STEER_FAILED_ACTIVITY_KIND,
        payload: { messageId: "message-1", error: "Provider exploded." },
      }),
    ).toEqual({
      messageId: "message-1",
      reason: "failed",
      error: "Provider exploded.",
      deliveryUncertain: false,
    });
  });

  it("tolerates a malformed payload", () => {
    expect(
      readTurnSteerRejectionActivity({ kind: TURN_STEER_FAILED_ACTIVITY_KIND, payload: null }),
    ).toEqual({
      messageId: null,
      reason: "failed",
      error: "Provider rejected turn steering.",
      deliveryUncertain: false,
    });
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
