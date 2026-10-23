import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  requestSettingsReveal,
  takeSettingsReveal,
  useSettingsSearchRevealStore,
} from "./settingsSearchReveal";

afterEach(() => {
  useSettingsSearchRevealStore.setState({ request: null });
});

describe("settings search reveal", () => {
  it("holds a request until the page takes it", () => {
    requestSettingsReveal("Diff style");
    const request = useSettingsSearchRevealStore.getState().request;
    expect(request).toEqual({ targetId: "Diff style" });

    takeSettingsReveal(request!);
    expect(useSettingsSearchRevealStore.getState().request).toBeNull();
  });

  it("keeps a newer request when the page takes an older one", () => {
    requestSettingsReveal("Diff style");
    const older = useSettingsSearchRevealStore.getState().request!;
    requestSettingsReveal("Diff style");
    const newer = useSettingsSearchRevealStore.getState().request;
    expect(newer).not.toBe(older);

    takeSettingsReveal(older);
    expect(useSettingsSearchRevealStore.getState().request).toBe(newer);
  });
});
