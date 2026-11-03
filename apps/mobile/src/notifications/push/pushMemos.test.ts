import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import { encodeBase64Url } from "@ryco/client-runtime/relay/base64url";

import vectors from "../../../../../packages/shared/src/pushSeal.vectors.json";
import { EARLIER_INSTALL_PUSH_KEY } from "./pushKeyCustody";
import {
  EARLIER_INSTALL_KEY_RETIRE_MS,
  HUB_REMOVAL_OWED_KEY,
  createEarlierInstallKeyMemo,
  createHubRemovalMarker,
} from "./pushMemos";

// A pinned vector: the node knows a key by this id.
const VECTOR = vectors.vectors[0]!;
const PUBLIC_KEY = encodeBase64Url(
  Uint8Array.from(VECTOR.recipientPublicKey.match(/../gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  ),
);
const KEY_ID = VECTOR.keyId;

function memoryKv(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn(async (key: string) => items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      items.delete(key);
    }),
  };
}

describe("the owed Hub removal", () => {
  it("is saved in the app's storage until the Hub confirms it, across a restart", async () => {
    const storage = memoryKv();
    await createHubRemovalMarker(storage).write("acct_a");
    expect(storage.items.get(HUB_REMOVAL_OWED_KEY)).toBe("acct_a");
    // The next launch reads it back.
    const restarted = createHubRemovalMarker(storage);
    expect(await restarted.read()).toBe("acct_a");
    await restarted.write(null);
    expect(storage.items.has(HUB_REMOVAL_OWED_KEY)).toBe(false);
    expect(await restarted.read()).toBeNull();
  });

  it("is gone after a reinstall, whose storage starts empty", async () => {
    expect(await createHubRemovalMarker(memoryKv()).read()).toBeNull();
  });
});

describe("the key an earlier installation left", () => {
  const record = (recordedAt: number, publicKey = PUBLIC_KEY) =>
    JSON.stringify({ publicKey, recordedAt });

  it("reads as a push key with the id a node knows it by, for as long as it is kept", async () => {
    const storage = memoryKv({ [EARLIER_INSTALL_PUSH_KEY]: record(1_000) });
    const memo = createEarlierInstallKeyMemo(storage, () => 2_000);
    expect(await memo.read()).toEqual({ publicKey: PUBLIC_KEY, keyId: KEY_ID, enrollmentId: null });
    expect(await memo.read()).toEqual({ publicKey: PUBLIC_KEY, keyId: KEY_ID, enrollmentId: null });
  });

  it("is dropped once nodes have dropped what it registered, or when it can't be read", async () => {
    const old = memoryKv({ [EARLIER_INSTALL_PUSH_KEY]: record(1_000) });
    expect(
      await createEarlierInstallKeyMemo(old, () => 1_000 + EARLIER_INSTALL_KEY_RETIRE_MS).read(),
    ).toBeNull();
    expect(old.items.has(EARLIER_INSTALL_PUSH_KEY)).toBe(false);

    for (const raw of ["not json", JSON.stringify({ publicKey: 1 }), record(1_000, "AAAA")]) {
      const broken = memoryKv({ [EARLIER_INSTALL_PUSH_KEY]: raw });
      expect(await createEarlierInstallKeyMemo(broken, () => 2_000).read()).toBeNull();
      expect(broken.items.has(EARLIER_INSTALL_PUSH_KEY)).toBe(false);
    }
  });
});
