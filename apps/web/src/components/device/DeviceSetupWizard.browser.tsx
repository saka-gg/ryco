import "../../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { DeviceListResult } from "@ryco/contracts";

import { DeviceSetupWizard } from "./DeviceSetupWizard";

const listing: DeviceListResult = {
  devices: [],
  availability: { kind: "available" },
  platforms: [
    { platform: "ios-simulator", availability: { kind: "available" } },
    {
      platform: "android-emulator",
      availability: {
        kind: "setup-required",
        steps: [
          {
            id: "install-android-platform-tools",
            label: "Install Android SDK Platform-Tools",
            done: true,
          },
          {
            id: "create-android-avd",
            label: "Create an Android virtual device",
            done: false,
            detail: "Use Android Studio's Device Manager.",
          },
        ],
      },
    },
  ],
};

describe("DeviceSetupWizard", () => {
  it("walks consent, each platform's checks with Check again, and agent access", async () => {
    const list = vi.fn(async () => listing);
    const update = vi.fn();
    const onComplete = vi.fn();
    const screen = await render(
      <DeviceSetupWizard
        values={{ devicesEnabled: true, agentDevicesEnabled: true }}
        canManage
        list={list}
        update={update}
        onComplete={onComplete}
      />,
    );
    await screen.getByRole("switch", { name: "Use simulators" }).click();
    expect(update).toHaveBeenCalledWith({ devicesEnabled: false });
    // The checks run only once the person reaches them.
    expect(list).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Continue" }).click();
    await expect.element(screen.getByText("iOS Simulator")).toBeVisible();
    await expect.element(screen.getByText("Ready", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Create an Android virtual device")).toBeVisible();
    await expect.element(screen.getByText("Use Android Studio's Device Manager.")).toBeVisible();
    await screen.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => list.mock.calls.length).toBe(2);
    await screen.getByRole("button", { name: "Continue" }).click();
    await screen.getByRole("switch", { name: "Agents can use simulators" }).click();
    expect(update).toHaveBeenCalledWith({ agentDevicesEnabled: false });
    await screen.getByRole("button", { name: "Finish" }).click();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("lets only an owner change the settings or finish", async () => {
    const screen = await render(
      <DeviceSetupWizard
        values={{ devicesEnabled: true, agentDevicesEnabled: true }}
        canManage={false}
        list={async () => listing}
        update={() => {}}
        onComplete={() => {}}
      />,
    );
    await expect.element(screen.getByRole("switch", { name: "Use simulators" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Skip setup" })).toBeDisabled();
    await expect
      .element(screen.getByText("Only the node's owner can change these settings."))
      .toBeVisible();
  });
});
