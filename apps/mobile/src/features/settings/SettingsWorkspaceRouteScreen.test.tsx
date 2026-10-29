import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@ryco/contracts";

const state = vi.hoisted(() => ({ environmentId: "node-a" as string | null, configs: new Map() }));
const preferences = vi.hoisted(() => ({
  value: {} as { claudeResumeReview?: boolean },
  hydrated: true,
  update: vi.fn(),
}));
vi.mock("react-native", () => ({ ScrollView: "ScrollView" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/threadsRuntime", () => ({
  useStore: (selector: (value: unknown) => unknown) =>
    selector({ activeEnvironmentId: state.environmentId }),
}));
vi.mock("../../state/environmentServerConfigs", () => ({
  useEnvironmentServerConfigs: () => state.configs,
}));
vi.mock("../../state/preferencesStore", () => ({
  isClaudeResumeReviewEnabled: (value: { claudeResumeReview?: boolean }) =>
    value.claudeResumeReview !== false,
  updatePreferences: preferences.update,
  useIsPreferencesHydrated: () => preferences.hydrated,
  usePreferences: () => preferences.value,
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: "SettingsRow" }));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: "SettingsSwitchRow" }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "SettingsSection" }));
vi.mock("./NodeStorageSettings", () => ({ NodeStorageSettings: "NodeStorageSettings" }));
vi.mock("./updates/NodeUpdatesSettings", () => ({ NodeUpdatesSettings: "NodeUpdatesSettings" }));
vi.mock("./openMachinesFromSettings", () => ({ openMachinesFromSettings: vi.fn() }));
import { SettingsWorkspaceRouteScreen } from "./SettingsWorkspaceRouteScreen";

function findRow(node: unknown, label: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map((child) => findRow(child, label)).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  return props.label === label ? props : findRow(props.children, label);
}

const findSubmoduleRow = (node: unknown) => findRow(node, "Worktree submodules");

describe("native worktree submodule consumption", () => {
  it("shows the active node default and does not present project policy as node policy", () => {
    state.configs = new Map([
      [
        EnvironmentId.make("node-a"),
        {
          environment: { capabilities: { worktreeSubmoduleSettings: true } },
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            worktreeSubmodules: "top-level",
            projectWorktreeSubmodules: { p: "none" },
          },
        },
      ],
      [
        EnvironmentId.make("node-b"),
        {
          environment: { capabilities: { worktreeSubmoduleSettings: true } },
          settings: { ...DEFAULT_SERVER_SETTINGS, worktreeSubmodules: "none" },
        },
      ],
    ]);
    state.environmentId = "node-a";
    expect(findSubmoduleRow(SettingsWorkspaceRouteScreen())).toMatchObject({
      value: "Top-level only",
    });
    state.environmentId = "node-b";
    expect(findSubmoduleRow(SettingsWorkspaceRouteScreen())).toMatchObject({ value: "None" });
    state.environmentId = null;
    expect(findSubmoduleRow(SettingsWorkspaceRouteScreen())).toMatchObject({
      value: "Connect a machine",
    });
  });
  it("does not present decoding defaults as configurable policy on an older node", () => {
    state.environmentId = "old-node";
    state.configs = new Map([
      ["old-node", { environment: { capabilities: {} }, settings: DEFAULT_SERVER_SETTINGS }],
    ]);
    expect(findSubmoduleRow(SettingsWorkspaceRouteScreen())).toMatchObject({
      value: "Update this machine",
      detail: "This node does not support configurable submodules.",
    });
  });
});

describe("the Claude resume review switch", () => {
  const findReviewRow = () =>
    findRow(SettingsWorkspaceRouteScreen(), "Review large Claude resumes");

  it("is on until this device turns it off, and writes the device preference", () => {
    preferences.hydrated = true;
    preferences.value = {};
    expect(findReviewRow()).toMatchObject({ value: true });
    preferences.value = { claudeResumeReview: false };
    const row = findReviewRow();
    expect(row).toMatchObject({ value: false });
    (row?.onValueChange as (value: boolean) => void)(true);
    expect(preferences.update).toHaveBeenCalledWith({ claudeResumeReview: true });
  });

  it("waits for the saved preferences before offering the switch", () => {
    preferences.hydrated = false;
    expect(findReviewRow()).toBeUndefined();
    preferences.hydrated = true;
  });
});
