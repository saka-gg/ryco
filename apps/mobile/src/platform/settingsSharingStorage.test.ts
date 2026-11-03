import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => undefined },
}));

import { createMobileSettingsSharingStorage } from "./settingsSharingStorage";

describe("the phone's shared settings storage", () => {
  it("reads and writes synchronously through the kv store", () => {
    const store = new Map<string, string>();
    const storage = createMobileSettingsSharingStorage({
      getItemSync: (key) => store.get(key) ?? null,
      setItemSync: (key, value) => void store.set(key, value),
    });
    expect(storage.getItem("k")).toBeNull();
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
  });
});
