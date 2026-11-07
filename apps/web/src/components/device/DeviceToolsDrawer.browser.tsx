import "../../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { DeviceDetail, DeviceTestingInput } from "@ryco/contracts";

import { DeviceToolsDrawer, type DeviceToolsApi } from "./DeviceToolsDrawer";

const UDID = "AAAA-1111";
const IOS_CONTROLS: DeviceDetail["controls"] = [
  "foreground-app",
  "terminate-app",
  "launch-app",
  "open-url",
  "appearance",
  "text-size",
  "orientation",
  "liquid-glass",
  "color-filter",
  "reduce-motion",
  "increase-contrast",
  "reduce-transparency",
  "show-borders",
  "voiceover",
  "location",
  "clear-location",
  "permission",
  "push",
  "presets",
];

/** A device whose settings change only when a testing action applies them. */
function fakeDevice(platform: DeviceDetail["platform"], controls = IOS_CONTROLS) {
  let detail: DeviceDetail = {
    udid: UDID,
    platform,
    capturedAt: new Date().toISOString(),
    foregroundApp: { bundleId: "com.example.app", name: "Example" },
    settings: { appearance: "light", reduceMotion: false, textSize: "large" },
    controls,
  };
  const testing = vi.fn(async ({ action }: DeviceTestingInput) => {
    if (action.type === "appearance")
      detail = { ...detail, settings: { ...detail.settings, appearance: action.value } };
    if (action.type === "accessibility" && action.setting === "reduce-motion")
      detail = { ...detail, settings: { ...detail.settings, reduceMotion: action.value } };
  });
  const api: DeviceToolsApi = {
    detail: vi.fn(async () => detail),
    testing,
    launchApp: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    describeUi: vi.fn(async () => ({
      udid: UDID,
      capturedAt: new Date().toISOString(),
      root: {
        role: "Application",
        subrole: null,
        label: "Example",
        value: null,
        frame: { x: 0, y: 0, width: 400, height: 800 },
        activationPoint: null,
        children: [
          {
            role: "Button",
            subrole: null,
            label: "OK",
            value: null,
            frame: { x: 10, y: 20, width: 100, height: 40 },
            activationPoint: null,
            children: [],
          },
        ],
      },
    })),
  };
  return { api, testing };
}

describe("DeviceToolsDrawer", () => {
  it("shows what the device reports, and reads it back after a change", async () => {
    const { api, testing } = fakeDevice("ios-simulator");
    const screen = await render(
      <DeviceToolsDrawer
        udid={UDID}
        platform="ios-simulator"
        canChange
        api={api}
        onFramesChange={() => {}}
      />,
    );
    await expect.element(screen.getByText("com.example.app (Example)")).toBeVisible();
    const dark = screen.getByRole("radio", { name: "Dark" });
    await expect.element(dark).not.toBeChecked();
    await dark.click();
    expect(testing).toHaveBeenCalledWith({
      udid: UDID,
      action: { type: "appearance", value: "dark" },
    });
    await expect.element(dark).toBeChecked();
    expect(api.detail).toHaveBeenCalledTimes(2);

    const motion = screen.getByRole("switch", { name: "Reduce Motion" });
    await motion.click();
    await expect.element(motion).toBeChecked();
    // A switch the device did not report says so instead of showing off.
    await expect.element(screen.getByText("Not reported").first()).toBeVisible();
  });

  it("shows only the controls the platform supports", async () => {
    const { api } = fakeDevice("android-emulator", [
      "foreground-app",
      "appearance",
      "orientation",
      "network",
      "reduce-motion",
      "location",
      "permission",
    ]);
    const screen = await render(
      <DeviceToolsDrawer
        udid={UDID}
        platform="android-emulator"
        canChange
        api={api}
        onFramesChange={() => {}}
      />,
    );
    await expect.element(screen.getByText("Network")).toBeVisible();
    await expect.element(screen.getByText("Liquid Glass")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Push", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("sends alert text as a push payload to the app in front", async () => {
    const { api, testing } = fakeDevice("ios-simulator");
    const screen = await render(
      <DeviceToolsDrawer
        udid={UDID}
        platform="ios-simulator"
        canChange
        api={api}
        onFramesChange={() => {}}
      />,
    );
    await screen.getByLabelText("Alert text").fill("Ship it");
    await screen.getByRole("button", { name: "Send push" }).click();
    expect(testing).toHaveBeenCalledWith({
      udid: UDID,
      action: {
        type: "push",
        bundleId: "com.example.app",
        payload: JSON.stringify({ aps: { alert: "Ship it", sound: "default" } }),
      },
    });
  });

  it("reads values but changes nothing without owner access", async () => {
    const { api, testing } = fakeDevice("ios-simulator");
    const screen = await render(
      <DeviceToolsDrawer
        udid={UDID}
        platform="ios-simulator"
        canChange={false}
        api={api}
        onFramesChange={() => {}}
      />,
    );
    await expect.element(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    await expect.element(screen.getByRole("radio", { name: "Dark" })).toBeDisabled();
    expect(testing).not.toHaveBeenCalled();
  });

  it("hands the overlay the element frames while it is on", async () => {
    const { api } = fakeDevice("ios-simulator");
    const frames = vi.fn();
    const screen = await render(
      <DeviceToolsDrawer
        udid={UDID}
        platform="ios-simulator"
        canChange
        api={api}
        onFramesChange={frames}
      />,
    );
    await screen.getByRole("switch", { name: "Show element frames" }).click();
    await expect
      .poll(() => frames.mock.calls.at(-1)?.[0])
      .toEqual([{ x: 10, y: 20, width: 100, height: 40 }]);
    await screen.getByRole("switch", { name: "Show element frames" }).click();
    await expect.poll(() => frames.mock.calls.at(-1)?.[0]).toBeNull();
  });
});
