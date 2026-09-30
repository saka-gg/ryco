import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@ryco/contracts";

const state = vi.hoisted(() => ({ environmentId: "node-a" as string | null, configs: new Map() }));
vi.mock("react-native", () => ({ ScrollView: "ScrollView" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/threadsRuntime", () => ({
  useStore: (selector: (value: unknown) => unknown) =>
    selector({ activeEnvironmentId: state.environmentId }),
}));
vi.mock("../../state/environmentServerConfigs", () => ({
  useEnvironmentServerConfigs: () => state.configs,
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: "SettingsRow" }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "SettingsSection" }));
vi.mock("./NodeStorageSettings", () => ({ NodeStorageSettings: "NodeStorageSettings" }));
vi.mock("./openMachinesFromSettings", () => ({ openMachinesFromSettings: vi.fn() }));
import { SettingsWorkspaceRouteScreen } from "./SettingsWorkspaceRouteScreen";

function findSubmoduleRow(node: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map(findSubmoduleRow).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  return props.label === "Worktree submodules" ? props : findSubmoduleRow(props.children);
}

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
