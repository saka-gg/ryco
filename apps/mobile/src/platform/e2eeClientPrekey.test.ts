import { encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import {
  E2EE_PREKEY_LIFETIME,
  E2EE_PREKEY_ROTATION_OVERLAP,
} from "@ryco/shared/relayE2eeConstants";
import {
  deriveE2eeAgreementPublicKey,
  e2eeKeyFingerprint,
  verifyE2eeSignature,
} from "@ryco/shared/relayE2eeKeys";
import { encodeClientE2eePrekeyTranscript } from "@ryco/shared/relayE2eeTranscripts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0xd,
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { ensureKey, sign, hasKey, deleteKey } = vi.hoisted(() => ({
  ensureKey: vi.fn(),
  sign: vi.fn(),
  hasKey: vi.fn(),
  deleteKey: vi.fn(),
}));
vi.mock("@ryco/mobile-device-key", () => ({
  default: { ensureKey, sign, hasKey, deleteKey },
}));

/**
 * The §14.5 preflight the agreement key runs, so this suite can present a runtime
 * §14.5 condemns to the WHOLE path — `ensure` composed over a real agreement key,
 * which is where the fail-closed rule has to hold. Its default is the real one's
 * verdict under Node: it passes.
 */
const { preflight } = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./e2eeRuntime", () => ({ assertE2eeRuntimeGlobals: preflight }));

import { resetMobileDeviceKeyForTests } from "./deviceKey";
import { makeMobileE2eeAgreementKey, type MobileE2eeAgreementKey } from "./e2eeAgreementKey";
import * as prekeyModule from "./e2eeClientPrekey";
import {
  clientE2eePrekeyValidity,
  CLIENT_E2EE_PREKEY_RECORD_KEY,
  makeMobileClientE2eePrekey,
  MobileClientE2eePrekeyError,
  type ClientE2eePrekeyNamespace,
} from "./e2eeClientPrekey";
import {
  E2EE_AGREEMENT_SECRET_KEY,
  E2EE_SECURE_STORE_KEYS,
  type E2eeSecureStore,
} from "./e2eeSecureStore";

const NAMESPACE = { hubOrigin: "https://hub.example", accountId: "acct_01J8ZQ5V2N7X0000000000" };
const NOW = 1_780_000_000_000;

/**
 * A real WebCrypto P-256 key stands in for the enclave, so the signatures this
 * suite checks are real ECDSA over the real transcript bytes. The native module
 * returns DER on both platforms, so the fake returns DER too — the raw `r ‖ s`
 * §7.1 requires is `deviceKey`'s conversion, and a test that skipped it would
 * not be testing the path the device runs.
 */
let devicePublicPoint: Uint8Array;
let devicePrivateKey: CryptoKey;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from({ length: decoded.length }, (_, index) => decoded.charCodeAt(index));
}

function derInteger(coordinate: Uint8Array): number[] {
  let start = 0;
  while (start < coordinate.length - 1 && coordinate[start] === 0) start += 1;
  const trimmed = [...coordinate.subarray(start)];
  if ((trimmed[0]! & 0x80) !== 0) trimmed.unshift(0);
  return [0x02, trimmed.length, ...trimmed];
}

function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

async function derSign(payloadBase64: string): Promise<string> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      devicePrivateKey,
      fromBase64(payloadBase64) as BufferSource,
    ),
  );
  return toBase64(rawSignatureToDer(raw));
}

function inMemoryStore(): E2eeSecureStore {
  const entries = new Map<string, string>();
  return {
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => {
      entries.set(key, value);
    },
    remove: async (key) => {
      entries.delete(key);
    },
    destroy: async () => {
      entries.clear();
    },
  };
}

function harness(
  overrides: {
    readonly agreementKey?: MobileE2eeAgreementKey;
    readonly now?: () => number;
    readonly record?: string;
    readonly onSetItem?: () => void;
  } = {},
) {
  const items = new Map<string, string>();
  if (overrides.record !== undefined) items.set(CLIENT_E2EE_PREKEY_RECORD_KEY, overrides.record);
  // §13.1.1: the certificate lives in the §6.3 namespace beside the key it names,
  // so it cannot outlive that key on an OS migration.
  const store: E2eeSecureStore = {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      overrides.onSetItem?.();
      items.set(key, value);
    },
    remove: async (key) => {
      items.delete(key);
    },
    destroy: async () => {
      items.clear();
    },
  };
  const purged: string[] = [];
  const kv = {
    removeItem: async (key: string): Promise<void> => {
      purged.push(key);
    },
  };
  const agreementKey = overrides.agreementKey ?? makeMobileE2eeAgreementKey(inMemoryStore());
  return {
    items,
    purged,
    agreementKey,
    prekey: makeMobileClientE2eePrekey({
      agreementKey,
      store,
      kv,
      now: overrides.now ?? (() => NOW),
    }),
  };
}

/** A fresh process: no memoized device key and no in-flight certificate. */
function restartApplication(): void {
  resetMobileDeviceKeyForTests();
  vi.clearAllMocks();
  preflight.mockReset();
  ensureKey.mockResolvedValue({
    publicKey: toBase64(devicePublicPoint),
    backing: "secure-enclave",
  });
  sign.mockImplementation(derSign);
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  devicePublicPoint = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  devicePrivateKey = pair.privateKey;
});

beforeEach(() => {
  restartApplication();
});

describe("client agreement-prekey certificate (§7.4)", () => {
  it("signs the exact encoder output, and nothing else", async () => {
    // §7.2: no consumer of the device key may construct to-be-signed bytes ad
    // hoc. The bytes the enclave saw must be byte-identical to the named
    // encoder's output for the same described transcript.
    const { prekey } = harness();

    const certificate = await prekey.ensure(NAMESPACE);

    const expected = encodeClientE2eePrekeyTranscript({
      hubOrigin: NAMESPACE.hubOrigin,
      accountId: NAMESPACE.accountId,
      identityPublicKey: certificate.identityPublicKey,
      agreementPublicKey: certificate.agreementPublicKey,
      createdAt: certificate.createdAt,
      expiresAt: certificate.expiresAt,
    });
    expect([...certificate.transcript]).toEqual([...expected]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect([...fromBase64(sign.mock.calls[0]![0] as string)]).toEqual([...expected]);
  });

  it("binds the device key, the agreement key, and the namespace", async () => {
    const { prekey, agreementKey } = harness();

    const certificate = await prekey.ensure(NAMESPACE);

    expect(certificate.identityPublicKey).toHaveLength(65);
    expect([...certificate.identityPublicKey]).toEqual([...devicePublicPoint]);
    expect([...certificate.agreementPublicKey]).toEqual([
      ...(await agreementKey.getPublicDescriptor()).publicKey,
    ]);
    expect(certificate.hubOrigin).toBe(NAMESPACE.hubOrigin);
    expect(certificate.accountId).toBe(NAMESPACE.accountId);
    // §7.4 element 5 is the `ryco.client-key.v1` fingerprint of element 4, which
    // the encoder recomputes rather than accepting from a caller.
    expect(e2eeKeyFingerprint("client-identity", certificate.identityPublicKey)).toHaveLength(32);
  });

  it("produces a fixed-width raw r ‖ s signature that verifies under the device key", async () => {
    const { prekey } = harness();

    const certificate = await prekey.ensure(NAMESPACE);

    expect(certificate.signature).toHaveLength(64);
    expect(
      verifyE2eeSignature({
        algorithm: "p256",
        publicKey: certificate.identityPublicKey,
        message: certificate.transcript,
        signature: certificate.signature,
      }),
    ).toBe(true);
  });

  it("uses exactly E2EE_PREKEY_LIFETIME and never exceeds it (§6.4)", async () => {
    const { prekey } = harness();

    const certificate = await prekey.ensure(NAMESPACE);

    expect(certificate.createdAt).toBe(NOW);
    expect(certificate.expiresAt - certificate.createdAt).toBe(E2EE_PREKEY_LIFETIME);
    expect(certificate.expiresAt - certificate.createdAt).toBeLessThanOrEqual(E2EE_PREKEY_LIFETIME);
  });

  it("re-signs nothing when the stored certificate is still usable", async () => {
    const { prekey } = harness();
    const first = await prekey.ensure(NAMESPACE);

    const second = await prekey.ensure(NAMESPACE);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(second.createdAt).toBe(first.createdAt);
    expect([...second.transcript]).toEqual([...first.transcript]);
  });

  it("re-signs at application start when the stored certificate has expired (§6.4)", async () => {
    const clock = { value: NOW };
    const agreementStore = inMemoryStore();
    const first = await harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
      now: () => clock.value,
    }).prekey.ensure(NAMESPACE);

    clock.value = first.expiresAt + E2EE_PREKEY_LIFETIME;
    restartApplication();
    const restarted = harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
      now: () => clock.value,
      record: storedRecord(first),
    });

    const reissued = await restarted.prekey.ensure(NAMESPACE);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(reissued.createdAt).toBe(clock.value);
    expect(reissued.expiresAt - reissued.createdAt).toBe(E2EE_PREKEY_LIFETIME);
    // §6.4's remedy is a new certificate, not a new key: the device's one static
    // agreement key (§6.2) survives the re-sign.
    expect([...reissued.agreementPublicKey]).toEqual([...first.agreementPublicKey]);
  });

  it("re-signs inside the rotation overlap, not only once expired (§6.4)", async () => {
    // §6.4's client remedy matches the node's: re-sign when the certificate is
    // expired OR when it would expire within `E2EE_PREKEY_ROTATION_OVERLAP`.
    // Waiting for actual expiry leaves a handshake started near the boundary — or
    // one whose clock runs a few minutes behind the node's — failing §8.6 with
    // `e2ee_prekey_expired` and E2EE unavailable until a later launch.
    const clock = { value: NOW };
    const agreementStore = inMemoryStore();
    const first = await harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
      now: () => clock.value,
    }).prekey.ensure(NAMESPACE);

    clock.value = first.expiresAt - E2EE_PREKEY_ROTATION_OVERLAP / 2;
    expect(clientE2eePrekeyValidity(first, clock.value)).toBe("renewable");
    restartApplication();
    const restarted = harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
      now: () => clock.value,
      record: storedRecord(first),
    });

    const reissued = await restarted.prekey.ensure(NAMESPACE);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(reissued.createdAt).toBe(clock.value);
    expect(reissued.expiresAt - reissued.createdAt).toBe(E2EE_PREKEY_LIFETIME);
    expect(clientE2eePrekeyValidity(reissued, clock.value)).toBe("usable");
  });

  it("re-signs for the requested namespace when the record validly names another", async () => {
    // The record is INTERNALLY CONSISTENT — this device signed it, over its own
    // keys, for a namespace it was in — so nothing downstream of the namespace
    // comparison rejects it. Returning it would present a §7.4 certificate
    // binding a foreign `(hubOrigin, accountId)` inside the §8.5 IK payload,
    // which §8.6 rejects: E2EE silently unavailable until the record is evicted.
    const other = { hubOrigin: "https://other.example", accountId: "acct_01J8ZQ5V2N7X0000000099" };
    const agreementStore = inMemoryStore();
    const foreign = await harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
    }).prekey.ensure(other);
    expect(
      verifyE2eeSignature({
        algorithm: "p256",
        publicKey: foreign.identityPublicKey,
        message: foreign.transcript,
        signature: foreign.signature,
      }),
    ).toBe(true);

    restartApplication();
    const restarted = harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
      record: storedRecord(foreign),
    });

    const certificate = await restarted.prekey.ensure(NAMESPACE);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(certificate.hubOrigin).toBe(NAMESPACE.hubOrigin);
    expect(certificate.accountId).toBe(NAMESPACE.accountId);
    expect([...certificate.transcript]).toEqual([
      ...encodeClientE2eePrekeyTranscript({
        hubOrigin: NAMESPACE.hubOrigin,
        accountId: NAMESPACE.accountId,
        identityPublicKey: certificate.identityPublicKey,
        agreementPublicKey: certificate.agreementPublicKey,
        createdAt: certificate.createdAt,
        expiresAt: certificate.expiresAt,
      }),
    ]);
  });

  it("re-signs when the stored record names another namespace, key, or signature", async () => {
    const agreementStore = inMemoryStore();
    const first = await harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
    }).prekey.ensure(NAMESPACE);
    const stored = JSON.parse(storedRecord(first)) as Record<string, unknown>;

    for (const mutation of [
      { accountId: "acct_01J8ZQ5V2N7X0000000099" },
      { hubOrigin: "https://other.example" },
      { agreementPublicKey: encodeBase64Url(new Uint8Array(32).fill(7)) },
      { identityPublicKey: encodeBase64Url(new Uint8Array(65).fill(4)) },
      { signature: encodeBase64Url(new Uint8Array(64).fill(3)) },
      { expiresAt: first.createdAt + E2EE_PREKEY_LIFETIME * 2 },
    ]) {
      restartApplication();
      const restarted = harness({
        agreementKey: makeMobileE2eeAgreementKey(agreementStore),
        record: JSON.stringify({ ...stored, ...mutation }),
      });

      const reissued = await restarted.prekey.ensure(NAMESPACE);

      expect(sign).toHaveBeenCalledTimes(1);
      expect(reissued.expiresAt - reissued.createdAt).toBe(E2EE_PREKEY_LIFETIME);
      expect(
        verifyE2eeSignature({
          algorithm: "p256",
          publicKey: reissued.identityPublicKey,
          message: reissued.transcript,
          signature: reissued.signature,
        }),
      ).toBe(true);
    }
  });

  it("survives a durable store that cannot be read or written", async () => {
    // Losing the record costs one signature at the next launch; failing the
    // certificate over a storage hiccup would take a working device off E2EE.
    const { prekey } = harness({
      record: "{ not json",
      onSetItem: () => {
        throw new Error("kv unavailable");
      },
    });

    await expect(prekey.ensure(NAMESPACE)).resolves.toMatchObject({ createdAt: NOW });
  });

  it("replaces a record whose window the §7.4 encoder or §6.4 would refuse", async () => {
    // The record survives `JSON.parse`, names the right namespace and the right
    // two keys, and classifies "usable" — but the encoder admits UNSIGNED safe
    // integers only, so a negative `createdAt` reaching it would throw out of
    // `ensure` instead of falling through to a re-sign. Nothing would then
    // overwrite the record, and the device could never obtain a §7.4 certificate
    // again — permanently defeating the very remedy §6.4 defines.
    const agreementStore = inMemoryStore();
    const first = await harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
    }).prekey.ensure(NAMESPACE);
    const stored = JSON.parse(storedRecord(first)) as Record<string, unknown>;

    for (const window of [
      { createdAt: -1, expiresAt: Number.MAX_SAFE_INTEGER },
      { createdAt: NOW, expiresAt: -1 },
      { createdAt: NOW, expiresAt: NOW },
      { createdAt: NOW, expiresAt: NOW + E2EE_PREKEY_LIFETIME + 1 },
    ]) {
      restartApplication();
      const restarted = harness({
        agreementKey: makeMobileE2eeAgreementKey(agreementStore),
        record: JSON.stringify({ ...stored, ...window }),
      });

      const reissued = await restarted.prekey.ensure(NAMESPACE);

      expect(sign).toHaveBeenCalledTimes(1);
      expect(reissued.createdAt).toBe(NOW);
      expect(reissued.expiresAt - reissued.createdAt).toBe(E2EE_PREKEY_LIFETIME);
      // Self-repairing: the record on disk is the new one, so the next launch
      // starts from something the encoder accepts.
      expect(JSON.parse(restarted.items.get(CLIENT_E2EE_PREKEY_RECORD_KEY)!)).toMatchObject({
        createdAt: reissued.createdAt,
        expiresAt: reissued.expiresAt,
      });
    }
  });

  it("signs once when two callers race at launch", async () => {
    // Bootstrap and the first handshake both call `ensure` before either settles.
    // Without the mutex both observe an empty record, both drive the enclave, and
    // the caller that resolves first holds a certificate that is not the one
    // durably stored — so the next launch rejects the record and re-signs again.
    const { prekey, items } = harness();

    const [first, second] = await Promise.all([prekey.ensure(NAMESPACE), prekey.ensure(NAMESPACE)]);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(second.createdAt).toBe(first.createdAt);
    expect([...second.transcript]).toEqual([...first.transcript]);
    expect(JSON.parse(items.get(CLIENT_E2EE_PREKEY_RECORD_KEY)!)).toMatchObject({
      createdAt: first.createdAt,
    });
  });
});

describe("§13.1.1 partial loss", () => {
  it("keeps the record in the §6.3 namespace, so it dies with the key it names", async () => {
    // The record is not a secret; the placement is about SURVIVAL. Kept in the
    // backed-up plain KV it would outlive the agreement key on an OS migration,
    // which is §13.1.1's "non-secret application state recording a prior E2EE
    // association" — the case that then has to raise the §13.2.1 surface. §13.1.1
    // also names the way out this takes: a client that keeps no such record "is a
    // fresh install by the rule above".
    const { prekey, items } = harness();
    await prekey.ensure(NAMESPACE);
    expect(items.has(CLIENT_E2EE_PREKEY_RECORD_KEY)).toBe(true);
    expect([...E2EE_SECURE_STORE_KEYS]).toContain(CLIENT_E2EE_PREKEY_RECORD_KEY);

    // §6.3's clone/restore purge and §13's re-pairing destroy the namespace whole.
    items.clear();

    expect(items.has(CLIENT_E2EE_PREKEY_RECORD_KEY)).toBe(false);
  });

  it("purges the entry an earlier build left in the backed-up store", async () => {
    const { prekey, purged } = harness();

    await prekey.ensure(NAMESPACE);
    await prekey.ensure(NAMESPACE);

    // Removed, never read: a migrated record would be the very thing the move
    // exists to avoid. Once per process, not once per call.
    expect(purged).toEqual([CLIENT_E2EE_PREKEY_RECORD_KEY]);
  });
});

describe("§6.4 validity", () => {
  it("classifies the window with the clock-skew allowance", () => {
    const certificate = { createdAt: NOW, expiresAt: NOW + E2EE_PREKEY_LIFETIME };

    expect(clientE2eePrekeyValidity(certificate, NOW)).toBe("usable");
    expect(clientE2eePrekeyValidity(certificate, certificate.expiresAt)).toBe("renewable");
    expect(clientE2eePrekeyValidity(certificate, certificate.expiresAt + 600_000)).toBe("expired");
    // A clock that jumped backwards past the skew allowance: the material is
    // fine, but no verifier would accept it, so re-issuing is the repair.
    expect(clientE2eePrekeyValidity(certificate, NOW - 600_000)).toBe("expired");
  });
});

describe("custody failures", () => {
  it("refuses with a bounded code when the device key is unavailable", async () => {
    ensureKey.mockResolvedValue({ publicKey: toBase64(devicePublicPoint), backing: "unavailable" });
    const { prekey } = harness();

    const failure = await failureOf(prekey.ensure(NAMESPACE));

    expect(failure).toBeInstanceOf(MobileClientE2eePrekeyError);
    expect(failure?.code).toBe("e2ee_prekey_custody_failed");
    expect(failure?.message).toBe("Device E2EE prekey operation failed.");
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses when the agreement key cannot be held, with no fallback key", async () => {
    const failing: E2eeSecureStore = {
      get: async () => {
        throw new Error(`SecItemCopyMatching -25300 for ${E2EE_AGREEMENT_SECRET_KEY}`);
      },
      set: async () => {},
      remove: async () => {},
      destroy: async () => {},
    };
    const { prekey } = harness({ agreementKey: makeMobileE2eeAgreementKey(failing) });

    const failure = await failureOf(prekey.ensure(NAMESPACE));

    expect(failure?.code).toBe("e2ee_prekey_custody_failed");
    for (const detail of [E2EE_AGREEMENT_SECRET_KEY, "25300", "SecItemCopyMatching"]) {
      expect(failure?.message).not.toContain(detail);
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it("restores a valid public certificate without reading unavailable agreement custody", async () => {
    const agreementStore = inMemoryStore();
    const first = await harness({
      agreementKey: makeMobileE2eeAgreementKey(agreementStore),
    }).prekey.ensure(NAMESPACE);

    restartApplication();
    const lifecycle = { acquisitions: 0, active: 0, releases: 0 };
    const reads = { count: 0 };
    const unavailableStore: E2eeSecureStore = {
      get: async () => {
        reads.count += 1;
        throw new Error("agreement store unavailable");
      },
      set: async () => {},
      remove: async () => {},
      destroy: async () => {},
    };
    const agreementKey = makeMobileE2eeAgreementKey(unavailableStore, {
      acquired: () => {
        lifecycle.acquisitions += 1;
      },
      borrowStarted: () => {
        lifecycle.active += 1;
      },
      released: () => {
        lifecycle.active -= 1;
        lifecycle.releases += 1;
      },
    });
    const restarted = harness({
      agreementKey,
      record: storedRecord(first),
    });

    const restored = await restarted.prekey.ensure(NAMESPACE);

    expect([...restored.transcript]).toEqual([...first.transcript]);
    expect(sign).not.toHaveBeenCalled();
    expect(reads.count).toBe(0);
    expect(lifecycle).toEqual({ acquisitions: 0, active: 0, releases: 0 });

    await expect(agreementKey.withSecretKey(() => undefined)).rejects.toMatchObject({
      code: "agreement_key_operation_failed",
    });
    expect(reads.count).toBe(1);
    expect(lifecycle).toEqual({ acquisitions: 0, active: 0, releases: 0 });
  });

  it("restores a signed old public key but repairs it only after certificate removal", async () => {
    const originalStore = inMemoryStore();
    const original = await harness({
      agreementKey: makeMobileE2eeAgreementKey(originalStore),
    }).prekey.ensure(NAMESPACE);
    const replacementStore = inMemoryStore();
    const replacementKey = makeMobileE2eeAgreementKey(replacementStore);
    const replacement = await replacementKey.generate();
    expect([...replacement.publicKey]).not.toEqual([...original.agreementPublicKey]);

    restartApplication();
    const restarted = harness({
      agreementKey: replacementKey,
      record: storedRecord(original),
    });

    const restored = await restarted.prekey.ensure(NAMESPACE);

    // Restore is deliberately public-only. The production handshake's K1
    // secret/public self-check fails closed for this mismatch; it cannot turn
    // key replacement into legacy eligibility.
    expect([...restored.agreementPublicKey]).toEqual([...original.agreementPublicKey]);
    await replacementKey.withSecretKey((secretKey) => {
      expect([...deriveE2eeAgreementPublicKey(secretKey)]).not.toEqual([
        ...restored.agreementPublicKey,
      ]);
    });
    expect(sign).not.toHaveBeenCalled();

    // Recovery is explicit: expiry follows the renewal path tested above, while
    // re-enrollment removes this public certificate beside the replaced key.
    // Only then may `ensure` issue a certificate for the replacement scalar.
    restarted.items.delete(CLIENT_E2EE_PREKEY_RECORD_KEY);
    const reissued = await restarted.prekey.ensure(NAMESPACE);
    expect([...reissued.agreementPublicKey]).toEqual([...replacement.publicKey]);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("refuses its own certificate when the enclave signature does not verify", async () => {
    // The self-check is the check a node runs in §8.6, run here against this
    // device's own certificate: a `derSignatureToRaw` regression, a DER variant
    // the converter mishandles, or an enclave that signed a different digest
    // yields a well-formed signature over the wrong bytes. Failing locally with a
    // bounded code beats failing the handshake with no local evidence of why.
    sign.mockImplementation(async () => await derSign(toBase64(new Uint8Array(32).fill(9))));
    const { prekey, items } = harness();

    const failure = await failureOf(prekey.ensure(NAMESPACE));

    expect(failure?.code).toBe("e2ee_prekey_custody_failed");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(items.has(CLIENT_E2EE_PREKEY_RECORD_KEY)).toBe(false);
  });

  it("defers a restored certificate's §14.5 refusal to the K1 secret borrow", async () => {
    // Restoring the signed public certificate draws no randomness and opens no
    // agreement scalar. K1's one-operation borrow still runs §14.5 before the
    // Noise handshake can use the key or draw its ephemeral.
    const agreementStore = inMemoryStore();
    const agreementKey = makeMobileE2eeAgreementKey(agreementStore);
    const first = await harness({ agreementKey }).prekey.ensure(NAMESPACE);

    restartApplication();
    preflight.mockImplementation(() => {
      throw new Error("End-to-end encryption requires a cryptographic random source…");
    });
    const restarted = harness({
      agreementKey,
      record: storedRecord(first),
    });

    const restored = await restarted.prekey.ensure(NAMESPACE);

    expect([...restored.transcript]).toEqual([...first.transcript]);
    expect(sign).not.toHaveBeenCalled();
    await expect(agreementKey.withSecretKey(() => undefined)).rejects.toMatchObject({
      code: "agreement_key_runtime_unavailable",
    });
  });

  it("refuses a namespace that cannot be represented in a §7.4 transcript", async () => {
    const { prekey } = harness();

    for (const namespace of [
      { hubOrigin: "http://insecure.example", accountId: NAMESPACE.accountId },
      { hubOrigin: NAMESPACE.hubOrigin, accountId: "" },
    ]) {
      const failure = await failureOf(prekey.ensure(namespace));
      expect(failure?.code).toBe("e2ee_prekey_unavailable");
    }
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("no ad-hoc transcripts (§7.2)", () => {
  it("exports nothing that accepts bytes to sign", () => {
    // The regression guard: the exact export list fails as soon as a raw-bytes
    // signing entry point is added anywhere in this module.
    const exported = Object.keys(prekeyModule).toSorted();

    expect(exported).toEqual([
      "CLIENT_E2EE_PREKEY_RECORD_KEY",
      "MobileClientE2eePrekeyError",
      "clientE2eePrekeyValidity",
      "makeMobileClientE2eePrekey",
      "mobileClientE2eePrekey",
    ]);
    for (const name of exported) {
      expect(name.toLowerCase()).not.toContain("sign");
    }
  });

  it("takes a described namespace, not bytes", async () => {
    const { prekey } = harness();

    expect(Object.keys(prekey)).toEqual(["ensure"]);
    const failure = await failureOf(
      prekey.ensure(new Uint8Array(32) as unknown as ClientE2eePrekeyNamespace),
    );

    expect(failure?.code).toBe("e2ee_prekey_unavailable");
    expect(sign).not.toHaveBeenCalled();
  });
});

function storedRecord(certificate: {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly identityPublicKey: Uint8Array;
  readonly agreementPublicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}): string {
  return JSON.stringify({
    hubOrigin: certificate.hubOrigin,
    accountId: certificate.accountId,
    identityPublicKey: encodeBase64Url(certificate.identityPublicKey),
    agreementPublicKey: encodeBase64Url(certificate.agreementPublicKey),
    signature: encodeBase64Url(certificate.signature),
    createdAt: certificate.createdAt,
    expiresAt: certificate.expiresAt,
  });
}

async function failureOf(operation: Promise<unknown>): Promise<MobileClientE2eePrekeyError | null> {
  return await operation.then(
    () => null,
    (error: unknown) => error as MobileClientE2eePrekeyError,
  );
}
