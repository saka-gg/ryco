import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { native, kv } = vi.hoisted(() => ({
  native: { module: null as unknown },
  kv: { items: new Map<string, string>() },
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => native.module }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => kv.items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      kv.items.set(key, value);
    },
    removeItem: async (key: string) => {
      kv.items.delete(key);
    },
  },
}));

import {
  PUSH_INSTALL_MARKER_KEY,
  createPushKeyCustody,
  ensureMobilePushKeyCustody,
} from "./pushKeyCustody";

function memoryKv(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn(async (key: string) => items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
  };
}

beforeEach(() => {
  kv.items.clear();
  native.module = null;
});

describe("the push key's install check", () => {
  it("deletes a key an earlier installation left before marking this one", async () => {
    // A reinstall: the keychain kept the key, the app's storage (and the marker) is new.
    const store = memoryKv();
    const order: string[] = [];
    const deleteKey = vi.fn(async () => {
      order.push(`delete (marked: ${store.items.has(PUSH_INSTALL_MARKER_KEY)})`);
    });
    const custody = createPushKeyCustody({ deleteKey }, store);
    await custody();
    await custody();
    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["delete (marked: false)"]);
    expect(store.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");
  });

  it("keeps the key this installation created", async () => {
    const deleteKey = vi.fn(async () => undefined);
    await createPushKeyCustody({ deleteKey }, memoryKv({ [PUSH_INSTALL_MARKER_KEY]: "1" }))();
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("stays unmarked when the delete failed, and tries again", async () => {
    const store = memoryKv();
    const deleteKey = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("keychain busy"));
    const custody = createPushKeyCustody({ deleteKey }, store);
    await expect(custody()).rejects.toThrow();
    expect(store.items.has(PUSH_INSTALL_MARKER_KEY)).toBe(false);
    await custody();
    expect(deleteKey).toHaveBeenCalledTimes(2);
    expect(store.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");
  });

  it("runs at launch with the app's storage, and not at all where there is no push key", async () => {
    await ensureMobilePushKeyCustody();
    expect(kv.items.size).toBe(0);

    const deleteKey = vi.fn(async () => undefined);
    native.module = { isAvailable: () => true, deleteKey };
    vi.resetModules();
    const fresh = await import("./pushKeyCustody");
    await fresh.ensureMobilePushKeyCustody();
    await fresh.ensureMobilePushKeyCustody();
    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(kv.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");
  });
});
