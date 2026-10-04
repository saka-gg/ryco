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
  it("does not write defaults for unchanged settings", () => {
    expect(settingsRestorePlan(DEFAULT_UNIFIED_SETTINGS, "system", "node").patch).toEqual({});
  });
  it("restores the usage-limit recovery settings to off on the node", () => {
    const plan = settingsRestorePlan(
      { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true, snoozeLimitedThreads: true },
      "system",
      "node",
    );
    expect(plan).toEqual({
      labels: ["Auto-resume limited threads", "Snooze limited threads"],
      resetTheme: false,
      patch: { autoResumeLimitedThreads: false, snoozeLimitedThreads: false },
    });
  });
  it("restores continue-after-restart to off on the node only", () => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, continueThreadsAfterRestart: true };
    expect(settingsRestorePlan(settings, "system", "node")).toEqual({
      labels: ["Continue after restart"],
      resetTheme: false,
      patch: { continueThreadsAfterRestart: false },
    });
    expect(settingsRestorePlan(settings, "system", "client").patch).toEqual({});
  });
});
