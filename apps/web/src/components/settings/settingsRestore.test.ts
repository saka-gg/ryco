import { describe, expect, it } from "vitest";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { settingsRestorePlan } from "./settingsRestore";

const changed = {
  ...DEFAULT_UNIFIED_SETTINGS,
  timestampFormat: "12-hour" as const,
  enableProviderUpdateChecks: false,
  addProjectBaseDirectory: "/remote/projects",
};
describe("settings reset ownership", () => {
  it("resets local preferences without changing any node settings", () => {
    const plan = settingsRestorePlan(changed, "dark", "client");
    expect(plan).toEqual({
      labels: ["Theme", "Time format"],
      resetTheme: true,
      patch: { timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat },
    });
  });
  it("resets the node without changing the current client's theme or preferences", () => {
    const plan = settingsRestorePlan(changed, "dark", "node");
    expect(plan).toEqual({
      labels: ["Provider update checks", "Add project base directory"],
      resetTheme: false,
      patch: { enableProviderUpdateChecks: true, addProjectBaseDirectory: "" },
    });
  });
  it("restores the follow-up behaviour as a local preference", () => {
    const plan = settingsRestorePlan(
      { ...DEFAULT_UNIFIED_SETTINGS, followUpBehavior: "steer" },
      "system",
      "client",
    );
    expect(plan).toEqual({
      labels: ["Follow-up while working"],
      resetTheme: false,
      patch: { followUpBehavior: "queue" },
    });
    expect(
      settingsRestorePlan(
        { ...DEFAULT_UNIFIED_SETTINGS, followUpBehavior: "steer" },
        "system",
        "node",
      ).patch,
    ).toEqual({});
  });
  it("does not write defaults for unchanged settings", () => {
    expect(settingsRestorePlan(DEFAULT_UNIFIED_SETTINGS, "system", "node").patch).toEqual({});
  });
});
