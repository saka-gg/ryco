import { EnvironmentId } from "@ryco/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useSettingsDialogStore } from "./settingsDialogStore";

describe("settingsDialogStore", () => {
  beforeEach(() => {
    useSettingsDialogStore.setState({
      open: false,
      editingScope: "client",
      section: "general",
      targetEnvironmentId: null,
    });
  });

  it("keeps an explicit node target until the dialog closes", () => {
    const environmentId = EnvironmentId.make("environment-qa");

    useSettingsDialogStore.getState().openSettings("providers", environmentId);

    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      section: "providers",
      targetEnvironmentId: environmentId,
    });

    useSettingsDialogStore.getState().closeSettings();

    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: false,
      targetEnvironmentId: null,
    });
  });
  it("keeps local appearance separate when switching from a node destination", () => {
    const store = useSettingsDialogStore.getState();
    store.openSettings("providers", EnvironmentId.make("remote"));
    expect(useSettingsDialogStore.getState().editingScope).toBe("node");
    store.setEditingScope("client");
    expect(useSettingsDialogStore.getState()).toMatchObject({
      editingScope: "client",
      section: "general",
    });
    store.openSettings("appearance");
    expect(useSettingsDialogStore.getState().editingScope).toBe("client");
  });
});
