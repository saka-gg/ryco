import {
  initialBackgroundAlertsSnapshot,
  type BackgroundAlertsSnapshot,
  type EnvironmentPushState,
} from "@ryco/client-runtime/notifications/push";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { backgroundAlertsSupport, describeBackgroundAlerts } from "./backgroundAlertsModel";

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
