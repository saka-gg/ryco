import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { derSignatureToRaw, uncompressedPointToJwk } from "@ryco/client-runtime/relay";
import { generateE2eeAgreementKeyPair } from "@ryco/shared/relayE2eeKeys";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DesktopE2eePrekeyError,
  DesktopE2eePrekeyIssuer,
  desktopClientPublicKeys,
  type DesktopClientPublicKeySource,
} from "./desktopE2eePrekey.ts";
import type { DesktopLocalIntroductionSecurity } from "./localTrustedIntroduction.ts";
import type { DesktopProtectedRecordStore } from "./protectedRecordStore.ts";

const rawP256 = (key: KeyObject) => {
  const jwk = key.export({ format: "jwk" });
  return Uint8Array.from([
    0x04,
    ...Buffer.from(jwk.x!, "base64url"),
    ...Buffer.from(jwk.y!, "base64url"),
  ]);
};

function harness() {
  const values = new Map<string, string>();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const identityPublicKey = rawP256(keys.publicKey);
  const agreement = generateE2eeAgreementKeyPair();
  let currentAgreement = agreement;
  const keyListeners = new Set<() => void>();
  const signTranscript = vi.fn(async (message: Uint8Array) =>
    derSignatureToRaw(Uint8Array.from(sign("sha256", message, keys.privateKey))),
  );
  const store: DesktopProtectedRecordStore = {
    read: async (name) => values.get(name) ?? null,
    create: async (name, value) => {
      if (values.has(name)) return false;
      values.set(name, value);
      return true;
    },
    write: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => {
      values.delete(name);
    },
  };
  const getSigningPublicKey = vi.fn(async () => identityPublicKey);
  const ensureAgreementPublicKey = vi.fn(async () => currentAgreement.publicKey);
  const security: DesktopLocalIntroductionSecurity & DesktopClientPublicKeySource = {
    getSigningPublicKey,
    getSigningKey: async () => ({
      algorithm: "ES256",
      publicJwk: uncompressedPointToJwk(identityPublicKey),
      sign: signTranscript,
    }),
    ensureAgreementPublicKey,
    onPublicKeysChanged: (listener) => {
      keyListeners.add(listener);
      return () => void keyListeners.delete(listener);
    },
  };
  /** The helper's agreement key is reset: a new key pair, and the reset is reported. */
  const resetAgreementKey = () => {
    currentAgreement = generateE2eeAgreementKeyPair();
    for (const listener of keyListeners) listener();
    return currentAgreement;
  };
  return {
    values,
    store,
    security,
    signTranscript,
    agreement,
    getSigningPublicKey,
    ensureAgreementPublicKey,
    resetAgreementKey,
  };
}

describe("Desktop E2EE client prekey", () => {
  it("reuses one verified public certificate for an unchanged account", async () => {
    const state = harness();
    const issuer = new DesktopE2eePrekeyIssuer({
      origin: "https://hub.example.test",
      security: state.security,
      records: state.store,
      now: () => 1_800_000_000_000,
    });

    const first = await issuer.ensure(`acct_${"A".repeat(22)}`);
    const second = await issuer.ensure(`acct_${"A".repeat(22)}`);

    expect(second).toEqual(first);
    expect(state.signTranscript).toHaveBeenCalledOnce();
    expect(state.values.has("e2ee-client-prekey")).toBe(true);
    state.agreement.secretKey.fill(0);
  });

  it("re-signs instead of trusting a corrupted stored certificate", async () => {
    const state = harness();
    state.values.set("e2ee-client-prekey", "not-json");
    const issuer = new DesktopE2eePrekeyIssuer({
      origin: "https://hub.example.test",
      security: state.security,
      records: state.store,
      now: () => 1_800_000_000_000,
    });

    await expect(issuer.ensure(`acct_${"A".repeat(22)}`)).resolves.toMatchObject({
      hubOrigin: "https://hub.example.test",
    });
    expect(state.signTranscript).toHaveBeenCalledOnce();
    state.agreement.secretKey.fill(0);
  });

  it("reads each public key from the helper once across ensures", async () => {
    const state = harness();
    const accountId = `acct_${"A".repeat(22)}`;
    const options = {
      origin: "https://hub.example.test",
      security: state.security,
      records: state.store,
      now: () => 1_800_000_000_000,
    };
    const issuer = new DesktopE2eePrekeyIssuer(options);

    await issuer.ensure(accountId);
    await issuer.ensure(accountId);
    await new DesktopE2eePrekeyIssuer(options).ensure(accountId);

    expect(state.getSigningPublicKey).toHaveBeenCalledOnce();
    expect(state.ensureAgreementPublicKey).toHaveBeenCalledOnce();
    state.agreement.secretKey.fill(0);
  });

  it("asks the helper again after a key reset and certifies the new key", async () => {
    const state = harness();
    const accountId = `acct_${"A".repeat(22)}`;
    const issuer = new DesktopE2eePrekeyIssuer({
      origin: "https://hub.example.test",
      security: state.security,
      records: state.store,
      now: () => 1_800_000_000_000,
    });
    const first = await issuer.ensure(accountId);

    const reset = state.resetAgreementKey();
    const second = await issuer.ensure(accountId);

    expect(state.ensureAgreementPublicKey).toHaveBeenCalledTimes(2);
    expect(second.agreementPublicKey).toEqual(reset.publicKey);
    expect(second.agreementPublicKey).not.toEqual(first.agreementPublicKey);
    expect(state.signTranscript).toHaveBeenCalledTimes(2);
    state.agreement.secretKey.fill(0);
    reset.secretKey.fill(0);
  });

  it("does not keep a failed read", async () => {
    const state = harness();
    state.ensureAgreementPublicKey.mockRejectedValueOnce(new Error("unavailable"));
    const issuer = new DesktopE2eePrekeyIssuer({
      origin: "https://hub.example.test",
      security: state.security,
      records: state.store,
      now: () => 1_800_000_000_000,
    });

    await expect(issuer.ensure(`acct_${"A".repeat(22)}`)).rejects.toBeInstanceOf(
      DesktopE2eePrekeyError,
    );
    await expect(issuer.ensure(`acct_${"A".repeat(22)}`)).resolves.toMatchObject({
      hubOrigin: "https://hub.example.test",
    });
    expect(state.ensureAgreementPublicKey).toHaveBeenCalledTimes(2);
    state.agreement.secretKey.fill(0);
  });

  it("hands out copies so a caller that wipes its key cannot change the kept one", async () => {
    const state = harness();
    const keys = desktopClientPublicKeys(state.security);

    const first = await keys.signing();
    const expected = Uint8Array.from(first);
    first.fill(0);
    const agreement = await keys.agreement();
    agreement.fill(0);

    expect(await keys.signing()).toEqual(expected);
    expect(await keys.agreement()).toEqual(state.agreement.publicKey);
    expect(desktopClientPublicKeys(state.security)).toBe(keys);
    state.agreement.secretKey.fill(0);
  });
});
