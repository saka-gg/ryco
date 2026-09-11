import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { DeviceIconPicker } from "./DeviceIconPicker";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  config: null as ServerConfig | null,
  setState: vi.fn(),
}));
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, mocks.setState],
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/DeviceIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../../state/environmentServerConfigs", () => ({
  useEnvironmentServerConfigs: () => new Map([[EnvironmentId.make("remote"), mocks.config]]),
}));
vi.mock("../../connection/environmentApi", () => ({
  updateEnvironmentServerSettings: mocks.update,
}));

function elements(value: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}
function choices(canEdit = true) {
  return elements(
    DeviceIconPicker({ environmentId: EnvironmentId.make("remote"), label: "Remote", canEdit }),
  ).filter((element) => element.props.accessibilityRole === "radio");
}
beforeEach(() => {
  mocks.update.mockReset().mockResolvedValue(undefined);
  mocks.setState.mockReset();
  mocks.config = {
    environment: {
      capabilities: { environmentIcon: true },
      platform: { os: "linux", arch: "x64", machine: "laptop" },
    },
    settings: DEFAULT_SERVER_SETTINGS,
  } as ServerConfig;
});
describe("native device icon picker", () => {
  it("saves the exact node and supports resetting to Automatic", async () => {
    const options = choices();
    expect(options).toHaveLength(9);
    (options[3]!.props.onPress as () => void)();
    await vi.waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("remote", { environmentIcon: "mini-pc" }),
    );
    (options[0]!.props.onPress as () => void)();
    await vi.waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith("remote", { environmentIcon: null }),
    );
  });
  it("keeps unauthorized, stale, and unsupported selections inert", async () => {
    for (const option of choices(false)) {
      expect(option.props.disabled).toBe(true);
      (option.props.onPress as () => void)();
    }
    mocks.config = null;
    for (const option of choices()) {
      expect(option.props.disabled).toBe(true);
      (option.props.onPress as () => void)();
    }
    await Promise.resolve();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("shows a failed save and keeps the picker open", async () => {
    mocks.update.mockRejectedValueOnce(new Error("offline"));
    (choices()[1]!.props.onPress as () => void)();
    await vi.waitFor(() =>
      expect(mocks.setState).toHaveBeenCalledWith(
        "Could not save the icon for Remote. Reconnect and try again.",
      ),
    );
    expect(mocks.config?.settings.environmentIcon).toBeNull();
  });
});
