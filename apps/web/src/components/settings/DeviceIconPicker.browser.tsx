import "../../index.css";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { EnvironmentId, DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@ryco/contracts";
import { SettingsTargetProvider, type SettingsTarget } from "../../settingsTarget";
import { DeviceIconPicker } from "./DeviceIconPicker";

vi.mock("../../composerDraftStore", () => ({ DraftId: { make: (value: string) => value } }));
const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../environments/runtime", () => ({ updateEnvironmentServerSettings: update }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    control,
    status,
  }: {
    control: import("react").ReactNode;
    status: import("react").ReactNode;
  }) => (
    <div>
      {control}
      {status}
    </div>
  ),
}));

const config = {
  environment: {
    environmentId: EnvironmentId.make("remote-node"),
    label: "Remote laptop",
    platform: { os: "linux", arch: "x64", machine: "laptop" },
    serverVersion: "1",
    capabilities: { environmentIcon: true },
  },
  settings: { ...DEFAULT_SERVER_SETTINGS },
} as ServerConfig;
const target: SettingsTarget = {
  environmentId: config.environment.environmentId,
  nodeLabel: "Remote laptop",
  serverConfig: config,
  primary: false,
  connected: true,
  canManage: true,
  canMutate: true,
};
async function mount(overrides: Partial<SettingsTarget> = {}) {
  return render(
    <SettingsTargetProvider value={{ ...target, ...overrides }}>
      <DeviceIconPicker />
    </SettingsTargetProvider>,
  );
}
describe("device icon selection", () => {
  beforeEach(() => update.mockReset().mockResolvedValue(undefined));
  it("offers every device icon and writes only to the selected remote node", async () => {
    await mount();
    await page.getByLabelText("Device icon for Remote laptop").click();
    for (const label of [
      "Automatic",
      "Laptop",
      "Desktop",
      "Mini PC",
      "Workstation",
      "Server",
      "Cloud",
      "Linux / WSL",
      "Windows",
    ])
      await expect.element(page.getByRole("option", { name: label, exact: true })).toBeVisible();
    await page.getByRole("option", { name: "Mini PC", exact: true }).click();
    expect(update).toHaveBeenCalledExactlyOnceWith(target.environmentId, {
      environmentIcon: "mini-pc",
    });
  });
  it("resets the override with an explicit null", async () => {
    await mount({
      serverConfig: { ...config, settings: { ...config.settings, environmentIcon: "cloud" } },
    });
    await page.getByLabelText("Device icon for Remote laptop").click();
    await page.getByRole("option", { name: "Automatic", exact: true }).click();
    expect(update).toHaveBeenCalledExactlyOnceWith(target.environmentId, { environmentIcon: null });
  });
  it.each([
    { connected: false },
    { canManage: false },
    { canMutate: false },
    {
      serverConfig: {
        ...config,
        environment: {
          ...config.environment,
          capabilities: { ...config.environment.capabilities, environmentIcon: false },
        },
      },
    },
  ])("does not allow unavailable or unauthorized writes: %j", async (overrides) => {
    await mount(overrides);
    await expect.element(page.getByLabelText("Device icon for Remote laptop")).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });
  it("shows a failed save without replacing the selected icon", async () => {
    update.mockRejectedValueOnce(new Error("disconnected"));
    await mount();
    await page.getByLabelText("Device icon for Remote laptop").click();
    await page.getByRole("option", { name: "Server", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not save the icon for Remote laptop");
    await expect
      .element(page.getByLabelText("Device icon for Remote laptop"))
      .toHaveTextContent("Automatic · Laptop");
  });
});
