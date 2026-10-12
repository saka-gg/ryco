import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 13,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "1.2.3", extra: {} }, platform: { ios: {} } },
}));

import { encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import { e2eeKeyFingerprint, e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import { encodeClientE2eePrekeyCertificateCarrier } from "@ryco/shared/relayE2eeTranscripts";

import { createMobileNativeE2eePlatform, MobileNativeE2eePlatformError } from "./nativeE2ee";
import {
  E2EE_ACCOUNT_ENROLLMENT_ID_KEY,
  E2EE_ACCOUNT_TRUST_DOCUMENT_KEY,
  type E2eeSecureStore,
  type E2eeSecureStoreKey,
} from "./e2eeSecureStore";

const HUB = "https://hub.example.test";
const ACCOUNT = `acct_${"a".repeat(22)}`;
const NODE = `node_${"n".repeat(22)}`;
const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
const IDENTITY_PUBLIC = fromHex(
  "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
    "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
);
const AGREEMENT_PUBLIC = new Uint8Array(32).fill(4);
const NODE_PUBLIC = fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");

function memoryStore(initial: Partial<Record<E2eeSecureStoreKey, string>> = {}) {
  const values = new Map(Object.entries(initial));
  const store: E2eeSecureStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    destroy: async () => void values.clear(),
  };
  return { store, values };
}

function platform(store: E2eeSecureStore) {
  const transcript = new Uint8Array([1, 2, 3]);
  const signature = new Uint8Array(64).fill(7);
  return createMobileNativeE2eePlatform({
    store,
    platform: "ios",
    appVersion: "1.2.3",
    deviceLabel: () => "Phone",
    randomBytes: vi.fn(async (length: number) => new Uint8Array(length).fill(9)),
    ensureIdentity: async () => ({ publicKey: IDENTITY_PUBLIC, backing: "secure-enclave" }),
    ensureClientPrekey: async () => ({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      agreementPublicKey: AGREEMENT_PUBLIC,
      identityPublicKey: IDENTITY_PUBLIC,
      transcript,
      signature,
      createdAt: 100,
      expiresAt: 200,
    }),
    withAgreementSecret: async (use) => use(new Uint8Array(32).fill(8)),
  });
}

describe("mobile native E2EE platform", () => {
  it("restores one stable installation enrollment and exposes only public descriptors", async () => {
    const { store, values } = memoryStore();
    const adapter = platform(store);
    const identity = await adapter.ensureIdentity();
    const prekey = await adapter.ensureClientPrekey({ hubOrigin: HUB, accountId: ACCOUNT });
    const first = await adapter.getOrCreateEnrollmentId();
    const second = await adapter.getOrCreateEnrollmentId();

    expect(identity).toEqual({
      publicKey: IDENTITY_PUBLIC,
      fingerprint: e2eeKeyFingerprint("client-identity", IDENTITY_PUBLIC),
      backing: "secure-enclave",
    });
    expect(prekey.certificate).toEqual(
      encodeClientE2eePrekeyCertificateCarrier(
        new Uint8Array([1, 2, 3]),
        new Uint8Array(64).fill(7),
      ),
    );
    expect(prekey.certificateDigest).toEqual(e2eeSha256(prekey.certificate));
    expect(first).toBe(`enr_${encodeBase64Url(new Uint8Array(16).fill(9))}`);
    expect(second).toBe(first);

    await adapter.clearEnrollment({ hubOrigin: HUB, accountId: ACCOUNT });
    expect(values.get(E2EE_ACCOUNT_ENROLLMENT_ID_KEY)).toBe(first);
  });

  it("keeps account trust public, scoped, and monotonic", async () => {
    const { store } = memoryStore();
    const adapter = platform(store);
    const record = {
      hubOrigin: HUB,
      accountId: ACCOUNT,
      nodeId: NODE,
      identityPublicKey: NODE_PUBLIC,
      identityFingerprint: e2eeKeyFingerprint("node-identity", NODE_PUBLIC),
      agreementFingerprint: e2eeKeyFingerprint("agreement", AGREEMENT_PUBLIC),
      continuityId: `nct_${"c".repeat(22)}`,
      acceptedPolicyGeneration: 7,
      firstTrustedAt: 100,
      lastTrustedAt: 200,
      identityChanges: [],
    } as const;
    await adapter.writeAccountTrustedNode(record);

    await expect(
      adapter.readAccountTrustedNode({ hubOrigin: HUB, accountId: ACCOUNT, nodeId: NODE }),
    ).resolves.toEqual(record);
    await expect(
      adapter.readAccountTrustedNode({
        hubOrigin: HUB,
        accountId: `acct_${"b".repeat(22)}`,
        nodeId: NODE,
      }),
    ).resolves.toBeNull();
    await expect(
      adapter.writeAccountTrustedNode({
        ...record,
        acceptedPolicyGeneration: 6,
        lastTrustedAt: 300,
      }),
    ).rejects.toBeInstanceOf(MobileNativeE2eePlatformError);
  });

  it("fails closed on malformed or duplicate persisted trust records", async () => {
    const { store } = memoryStore({
      [E2EE_ACCOUNT_TRUST_DOCUMENT_KEY]: JSON.stringify({ version: 1, records: [{}] }),
    });
    const adapter = platform(store);
    await expect(
      adapter.readAccountTrustedNode({ hubOrigin: HUB, accountId: ACCOUNT, nodeId: NODE }),
    ).rejects.toBeInstanceOf(MobileNativeE2eePlatformError);
  });
});
