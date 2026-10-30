import { EnvironmentId } from "@ryco/contracts";
import { PushRpcError } from "@ryco/contracts/push";
import { describe, expect, it } from "vite-plus/test";

import { HostedHubApiError } from "../../authorization/api.ts";
import {
  environmentPushStateFromError,
  environmentPushStateFromStatus,
  hubRegistrationFailure,
  initialBackgroundAlertsSnapshot,
  isBackgroundPushConfirmed,
  type BackgroundAlertsSnapshot,
  type EnvironmentPushState,
} from "./backgroundAlertsModel.ts";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");

const registered = (
  overrides: Partial<Extract<EnvironmentPushState, { status: "registered" }>> = {},
): EnvironmentPushState => ({
  status: "registered",
  kinds: ["approval", "completed"],
  hubDelivery: "available",
  ...overrides,
});

function snapshot(overrides: Partial<BackgroundAlertsSnapshot> = {}): BackgroundAlertsSnapshot {
  return {
    ...initialBackgroundAlertsSnapshot("supported"),
    enabled: true,
    hub: "registered",
    device: "ready",
    ...overrides,
  };
}

describe("what a node's answer means", () => {
  it("reads the node's status", () => {
    expect(
      environmentPushStateFromStatus({
        eligible: true,
        registered: true,
        keyId: "DEQhCHjLCTVmDnk--WkGOQ" as never,
        kinds: ["completed"],
        hubDelivery: "hub-unsupported",
      }),
    ).toEqual({ status: "registered", kinds: ["completed"], hubDelivery: "hub-unsupported" });
    expect(
      environmentPushStateFromStatus({
        eligible: false,
        registered: false,
        keyId: null,
        kinds: [],
        hubDelivery: "offline",
      }),
    ).toEqual({ status: "ineligible" });
  });

  it("tells an older node from a channel that cannot receive push", () => {
    expect(
      environmentPushStateFromError(new Error("Unknown request tag: push.registerDevice")),
    ).toEqual({ status: "update-needed" });
    expect(environmentPushStateFromError(new PushRpcError({ message: "No Hub channel." }))).toEqual(
      {
        status: "ineligible",
      },
    );
    expect(environmentPushStateFromError({ _tag: "AuthRpcError", message: "denied" })).toEqual({
      status: "ineligible",
    });
    expect(environmentPushStateFromError(new Error("SocketCloseError"))).toEqual({
      status: "failed",
    });
  });

  it("maps the Hub's registration refusals", () => {
    expect(hubRegistrationFailure(new HostedHubApiError("not_found", 404))).toBe("hub-unsupported");
    expect(
      hubRegistrationFailure(
        new HostedHubApiError("conflict", 409, undefined, undefined, "push_enrollment_required"),
      ),
    ).toBe("enrollment-pending");
    expect(
      hubRegistrationFailure(
        new HostedHubApiError(
          "invalid_request",
          400,
          undefined,
          undefined,
          "push_topic_unsupported",
        ),
      ),
    ).toBe("topic-unsupported");
    expect(hubRegistrationFailure(new HostedHubApiError("unavailable", 0))).toBe("failed");
    expect(hubRegistrationFailure(new Error("boom"))).toBe("failed");
  });
});

describe("isBackgroundPushConfirmed", () => {
  it("holds only when the Hub, the device and the node all confirmed the kind", () => {
    const confirmed = snapshot({ environments: new Map([[A, registered()]]) });
    expect(isBackgroundPushConfirmed(confirmed, A, "approval")).toBe(true);
    expect(isBackgroundPushConfirmed(confirmed, A, "failed")).toBe(false);
    expect(isBackgroundPushConfirmed(confirmed, B, "approval")).toBe(false);
    expect(isBackgroundPushConfirmed({ ...confirmed, enabled: false }, A, "approval")).toBe(false);
    expect(isBackgroundPushConfirmed({ ...confirmed, hub: "failed" }, A, "approval")).toBe(false);
    expect(
      isBackgroundPushConfirmed({ ...confirmed, device: "token-unavailable" }, A, "approval"),
    ).toBe(false);
    for (const hubDelivery of ["unknown", "hub-unsupported", "offline"] as const) {
      expect(
        isBackgroundPushConfirmed(
          snapshot({ environments: new Map([[A, registered({ hubDelivery })]]) }),
          A,
          "approval",
        ),
      ).toBe(false);
    }
  });
});
