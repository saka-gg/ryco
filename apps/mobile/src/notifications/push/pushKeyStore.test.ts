import { encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import { describe, expect, it, vi } from "vite-plus/test";

import vectors from "../../../../../packages/shared/src/pushSeal.vectors.json";
import {
  UNAVAILABLE_PUSH_KEY_STORE,
  createPushKeyStore,
  pushKeyOf,
  type RycoPushNativeModule,
} from "./pushKeyStore";

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function nativeModule(overrides: Partial<RycoPushNativeModule> = {}): RycoPushNativeModule {
  const publicKey = encodeBase64Url(hexToBytes(vectors.vectors[0]!.recipientPublicKey));
  return {
    isAvailable: () => true,
    ensureKey: vi.fn(async () => ({ publicKey, enrollmentId: null })),
    readKey: vi.fn(async () => null),
    setRegistration: vi.fn(async () => undefined),
    deleteKey: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("the push key", () => {
  it("derives the key id the node expects from the public key alone", () => {
    for (const vector of vectors.vectors) {
      const publicKey = encodeBase64Url(hexToBytes(vector.recipientPublicKey));
      expect(pushKeyOf({ publicKey, enrollmentId: "enr_x" })).toEqual({
        publicKey,
        keyId: vector.keyId,
        enrollmentId: "enr_x",
      });
    }
  });

  it("refuses anything but a 32-byte key", () => {
    expect(() => pushKeyOf({ publicKey: "AAAA", enrollmentId: null })).toThrow();
    expect(() => pushKeyOf({ publicKey: "A".repeat(43) + "=", enrollmentId: null })).toThrow();
  });

  it("is unavailable without the native module or the extension", async () => {
    expect(createPushKeyStore(null)).toBe(UNAVAILABLE_PUSH_KEY_STORE);
    expect(createPushKeyStore(nativeModule({ isAvailable: () => false }))).toBe(
      UNAVAILABLE_PUSH_KEY_STORE,
    );
    await expect(UNAVAILABLE_PUSH_KEY_STORE.ensureKey()).rejects.toThrow();
    await expect(UNAVAILABLE_PUSH_KEY_STORE.readKey()).resolves.toBeNull();
  });

  it("passes the native answers through as checked keys", async () => {
    const native = nativeModule({ readKey: vi.fn(async () => undefined as never) });
    const store = createPushKeyStore(native);
    expect(store.available).toBe(true);
    await expect(store.ensureKey()).resolves.toMatchObject({ keyId: vectors.vectors[0]!.keyId });
    await expect(store.readKey()).resolves.toBeNull();
    await store.setRegistration({ enrollmentId: "enr_x", sound: true });
    expect(native.setRegistration).toHaveBeenCalledWith("enr_x", true);
  });
});
