import { HostedHubApiError } from "@ryco/client-runtime/authorization";
import { EnvironmentId } from "@ryco/contracts";
import { PushRpcError } from "@ryco/contracts/push";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundAlertsSupport,
  describeBackgroundAlerts,
  environmentPushStateFromError,
  environmentPushStateFromStatus,
  hubRegistrationFailure,
  initialBackgroundAlertsSnapshot,
  isBackgroundPushConfirmed,
  type BackgroundAlertsSnapshot,
  type EnvironmentPushState,
} from "./backgroundAlertsModel";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");
const C = EnvironmentId.make("env-c");
const labels: Record<string, string> = { "env-a": "Studio", "env-b": "Laptop", "env-c": "Server" };
const labelOf = (environmentId: EnvironmentId) => labels[environmentId] ?? "a machine";

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

describe("backgroundAlertsSupport", () => {
  it("needs an iPhone build with the extension that is not a Personal Team build", () => {
    expect(
      backgroundAlertsSupport({
        platform: "android",
        personalTeamBuild: false,
        keyStoreAvailable: false,
      }),
    ).toBe("unsupported-platform");
    expect(
      backgroundAlertsSupport({
        platform: "ios",
        personalTeamBuild: true,
        keyStoreAvailable: false,
      }),
    ).toBe("personal-team");
    expect(
      backgroundAlertsSupport({
        platform: "ios",
        personalTeamBuild: false,
        keyStoreAvailable: false,
      }),
    ).toBe("unavailable-build");
    expect(
      backgroundAlertsSupport({
        platform: "ios",
        personalTeamBuild: false,
        keyStoreAvailable: true,
      }),
    ).toBe("supported");
  });
});

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

describe("the settings row", () => {
  it("is hidden where there is no push and explains builds that cannot have it", () => {
    expect(
      describeBackgroundAlerts(initialBackgroundAlertsSnapshot("unsupported-platform"), labelOf),
    ).toMatchObject({ visible: false });
    expect(
      describeBackgroundAlerts(initialBackgroundAlertsSnapshot("personal-team"), labelOf),
    ).toEqual({
      visible: true,
      canEnable: false,
      detail: "Not in this build: a Personal Team build cannot receive push.",
    });
  });

  it("says when the Hub cannot send, and keeps the switch from turning on", () => {
    for (const enabled of [false, true]) {
      expect(
        describeBackgroundAlerts(snapshot({ enabled, hub: "hub-unsupported" }), labelOf),
      ).toEqual({
        visible: true,
        canEnable: false,
        detail: "Your Hub doesn't send background alerts yet.",
      });
    }
    expect(describeBackgroundAlerts(snapshot({ hub: "topic-unsupported" }), labelOf)).toMatchObject(
      {
        canEnable: false,
        detail: "Your Hub can't send background alerts to this build.",
      },
    );
    expect(describeBackgroundAlerts(snapshot({ hub: "signed-out" }), labelOf)).toMatchObject({
      canEnable: false,
      detail: "Sign in to your Hub to get alerts while Ryco is closed.",
    });
  });

  it("asks to update an older machine and names where it is on", () => {
    expect(
      describeBackgroundAlerts(
        snapshot({
          environments: new Map<EnvironmentId, EnvironmentPushState>([
            [A, { status: "update-needed" }],
            [B, registered()],
          ]),
        }),
        labelOf,
      ).detail,
    ).toBe("Update Studio for background alerts; on for Laptop.");
    expect(
      describeBackgroundAlerts(
        snapshot({
          environments: new Map([
            [A, registered()],
            [B, registered()],
            [C, registered()],
          ]),
        }),
        labelOf,
      ).detail,
    ).toBe("On for Studio, Laptop and 1 more.");
    expect(describeBackgroundAlerts(snapshot(), labelOf).detail).toBe(
      "On. Each machine joins when Ryco connects to it.",
    );
    expect(
      describeBackgroundAlerts(
        snapshot({ environments: new Map([[A, registered({ hubDelivery: "hub-unsupported" })]]) }),
        labelOf,
      ).detail,
    ).toBe("Your Hub doesn't send background alerts yet.");
  });

  it("explains a device that is not ready", () => {
    expect(
      describeBackgroundAlerts(snapshot({ device: "permission-denied" }), labelOf).detail,
    ).toBe("Allow notifications for Ryco in Settings.");
    expect(
      describeBackgroundAlerts(snapshot({ hub: "enrollment-pending", device: "idle" }), labelOf)
        .detail,
    ).toBe("Waiting for this iPhone to finish signing in to your Hub.");
    expect(
      describeBackgroundAlerts(
        snapshot({ enabled: false, hub: "available", device: "idle" }),
        labelOf,
      ),
    ).toEqual({
      visible: true,
      canEnable: true,
      detail: "Also alert this iPhone while Ryco is closed, through your Hub.",
    });
  });
});
