import { EnvironmentId } from "@ryco/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useSettingsDialogStore } from "./settingsDialogStore";

describe("settingsDialogStore", () => {
  beforeEach(() => {
    useSettingsDialogStore.setState({
      open: false,
      section: "general",
      targetEnvironmentId: null,
      deviceView: "all",
    });
  });

  it("opens a named device's own values, and every device's otherwise", () => {
    const store = useSettingsDialogStore.getState();
    store.openSettings("usage", EnvironmentId.make("remote"));
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "usage",
      targetEnvironmentId: "remote",
      deviceView: "device",
    });

    store.openSettings("usage");
    expect(useSettingsDialogStore.getState().deviceView).toBe("all");

    store.setDeviceView("device");
    store.closeSettings();
    expect(useSettingsDialogStore.getState().deviceView).toBe("all");
  });

  it("keeps an explicit device until settings close", () => {
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
      deviceView: "all",
    });
  });

  it("opens a device's page when only the device is named", () => {
    const environmentId = EnvironmentId.make("remote");
    useSettingsDialogStore.getState().openSettings(undefined, environmentId);
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "device",
      targetEnvironmentId: environmentId,
    });
  });

  it("switches the device without leaving the section", () => {
    const store = useSettingsDialogStore.getState();
    store.openSettings("projects");
    store.setTargetEnvironmentId(EnvironmentId.make("remote"));
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "projects",
      targetEnvironmentId: "remote",
    });
  });

  it("keeps an old id as asked, for the page and the phone tier to redirect", () => {
    useSettingsDialogStore.getState().openSettings("connections");
    expect(useSettingsDialogStore.getState().section).toBe("connections");
  });
});
