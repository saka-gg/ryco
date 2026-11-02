import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const preferences = vi.hoisted(() => ({
  value: {} as { claudeResumeReview?: boolean },
  hydrated: true,
  update: vi.fn(),
}));
vi.mock("react-native", () => ({ ScrollView: "ScrollView" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
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
vi.mock("./NodeNewTaskDefaults", () => ({ NodeNewTaskDefaults: "NodeNewTaskDefaults" }));
vi.mock("./updates/NodeUpdatesSettings", () => ({ NodeUpdatesSettings: "NodeUpdatesSettings" }));
vi.mock("./openMachinesFromSettings", () => ({ openMachinesFromSettings: vi.fn() }));
import { SettingsWorkspaceRouteScreen } from "./SettingsWorkspaceRouteScreen";

function findRow(node: unknown, label: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map((child) => findRow(child, label)).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  return props.label === label ? props : findRow(props.children, label);
}

function hasElement(node: unknown, type: string): boolean {
  if (Array.isArray(node)) return node.some((child) => hasElement(child, type));
  if (!node || typeof node !== "object" || !("props" in node)) return false;
  const element = node as ReactElement<Record<string, unknown>>;
  return element.type === type || hasElement(element.props.children, type);
}

describe("new-task defaults", () => {
  it("are each node's own editable panel, not fixed labels", () => {
    const screen = SettingsWorkspaceRouteScreen();
    expect(hasElement(screen, "NodeNewTaskDefaults")).toBe(true);
    expect(findRow(screen, "Provider and model")).toBeUndefined();
    // Runtime mode is execution authority, chosen per task: never a default here.
    expect(findRow(screen, "Runtime mode")).toBeUndefined();
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
