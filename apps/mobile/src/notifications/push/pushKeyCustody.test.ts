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
  EARLIER_INSTALL_PUSH_KEY,
  PUSH_INSTALL_MARKER_KEY,
  checkPushKeyAtLaunch,
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

const noKey = vi.fn(async () => null);
const PUBLIC_KEY = "yP7Kgb4ZbN8srer_E8SQPXYy3OSVWqaLbl2a3vVOJhY";

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
    const custody = createPushKeyCustody({ deleteKey, readKey: noKey }, store);
    await custody();
    await custody();
    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["delete (marked: false)"]);
    expect(store.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");
  });

  it("keeps the key this installation created", async () => {
    const deleteKey = vi.fn(async () => undefined);
    await createPushKeyCustody(
      { deleteKey, readKey: noKey },
      memoryKv({ [PUSH_INSTALL_MARKER_KEY]: "1" }),
    )();
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("stays unmarked when the delete failed, and tries again", async () => {
    const store = memoryKv();
    const deleteKey = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("keychain busy"));
    const custody = createPushKeyCustody({ deleteKey, readKey: noKey }, store);
    await expect(custody()).rejects.toThrow();
    expect(store.items.has(PUSH_INSTALL_MARKER_KEY)).toBe(false);
    await custody();
    expect(deleteKey).toHaveBeenCalledTimes(2);
    expect(store.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");
  });

  it("keeps the public half of an earlier installation's key to retire it, and deletes the key all the same", async () => {
    const store = memoryKv();
    const order: string[] = [];
    const readKey = vi.fn(async () => {
      order.push("read");
      return { publicKey: PUBLIC_KEY, enrollmentId: "enr_earlier" };
    });
    const deleteKey = vi.fn(async () => {
      order.push("delete");
    });
    await createPushKeyCustody({ deleteKey, readKey }, store, () => 1_234)();
    expect(order).toEqual(["read", "delete"]);
    expect(JSON.parse(store.items.get(EARLIER_INSTALL_PUSH_KEY)!)).toEqual({
      publicKey: PUBLIC_KEY,
      recordedAt: 1_234,
    });
    expect(store.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");

    // Nothing left, or nothing readable: nothing to retire, and the delete still runs.
    const empty = memoryKv();
    await createPushKeyCustody({ deleteKey, readKey: noKey }, empty)();
    expect(empty.items.has(EARLIER_INSTALL_PUSH_KEY)).toBe(false);
    const unreadable = memoryKv();
    const failing = vi.fn(async () => {
      throw new Error("keychain busy");
    });
    await createPushKeyCustody({ deleteKey, readKey: failing }, unreadable)();
    expect(unreadable.items.has(EARLIER_INSTALL_PUSH_KEY)).toBe(false);
    expect(unreadable.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");
    expect(deleteKey).toHaveBeenCalledTimes(3);
  });

  it("checks at every launch, and says when an earlier installation's key waits to be retired", async () => {
    const custody = vi.fn(async () => undefined);
    const store = memoryKv();
    expect(await checkPushKeyAtLaunch({ custody, kv: store })).toEqual({ retireEarlierKey: false });
    store.items.set(
      EARLIER_INSTALL_PUSH_KEY,
      JSON.stringify({ publicKey: PUBLIC_KEY, recordedAt: 1 }),
    );
    expect(await checkPushKeyAtLaunch({ custody, kv: store })).toEqual({ retireEarlierKey: true });
    expect(custody).toHaveBeenCalledTimes(2);
    // A failed check says nothing it could not know.
    await expect(
      checkPushKeyAtLaunch({
        custody: async () => {
          throw new Error("keychain busy");
        },
        kv: store,
      }),
    ).rejects.toThrow("keychain busy");
  });

  it("runs at launch with the app's storage, and not at all where there is no push key", async () => {
    await ensureMobilePushKeyCustody();
    expect(kv.items.size).toBe(0);

    const deleteKey = vi.fn(async () => undefined);
    native.module = { isAvailable: () => true, deleteKey, readKey: noKey };
    vi.resetModules();
    const fresh = await import("./pushKeyCustody");
    await fresh.ensureMobilePushKeyCustody();
    await fresh.ensureMobilePushKeyCustody();
    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(kv.items.get(PUSH_INSTALL_MARKER_KEY)).toBe("1");
  });
});
