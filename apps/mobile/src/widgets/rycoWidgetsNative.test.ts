import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  requests: 0,
  module: null as null | { readonly isAvailable: () => boolean },
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => {
    native.requests += 1;
    return native.module;
  },
}));

async function freshNative() {
  vi.resetModules();
  return (await import("./rycoWidgetsNative")).rycoWidgetsNative;
}

describe("the widgets native module", () => {
  beforeEach(() => {
    native.requests = 0;
    native.module = null;
  });

  it("is missing on Android and in binaries without it", async () => {
    const rycoWidgetsNative = await freshNative();
    expect(rycoWidgetsNative()).toBeNull();
  });

  it("is missing in builds without the extension or its App Group", async () => {
    native.module = { isAvailable: () => false };
    const rycoWidgetsNative = await freshNative();
    expect(rycoWidgetsNative()).toBeNull();
  });

  it("is looked up once and kept", async () => {
    native.module = { isAvailable: () => true };
    const rycoWidgetsNative = await freshNative();
    expect(rycoWidgetsNative()).toBe(native.module);
    expect(rycoWidgetsNative()).toBe(native.module);
    expect(native.requests).toBe(1);
  });
});
