import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import {
  deriveE2eeAgreementPublicKey,
  e2eeKeyFingerprint,
  E2EE_AGREEMENT_ALGORITHM,
  generateE2eeAgreementKeyPair,
} from "@ryco/shared/relayE2eeKeys";

import { assertE2eeRuntimeGlobals } from "./e2eeRuntime";
import {
  E2EE_AGREEMENT_SECRET_KEY,
  mobileE2eeSecureStore,
  type E2eeSecureStore,
} from "./e2eeSecureStore";

// Custody of this device's static X25519 agreement key —
// docs/relay-e2ee-protocol.md §6.2 (static agreement keys and cross-signatures)
// and §6.3 (custody by endpoint), whose native-client row is a device-only
// platform secure-store entry.
//
// A SIBLING OF THE DEVICE KEY, NOT AN EXTENSION OF IT, exactly as
// `NodeAgreementIdentity` is a sibling of `NodeSigningIdentity` on the node.
// §6.2's key-separation rule is absolute — the identity key never performs key
// agreement and the agreement key never signs — so THIS MODULE EXPOSES NO
// `sign`, and `deviceKey.ts` exposes no agreement. Two modules over two stores
// is what makes the rule structural rather than a comment someone has to obey.
//
// ONE KEY PER DEVICE, so the entry has a fixed name. §6.2 says "one static
// X25519 keypair per device" for the native client; the `(hubOrigin, accountId)`
// namespace is bound by the §7.4 certificate that cross-signs this key, not by
// the key itself. A fixed name is also what lets §6.3's clone/restore purge
// destroy the whole namespace without reading any of it.
//
// WHERE THIS DIFFERS FROM THE DEVICE KEY, AND WHY IT HAS TO. The device key's
// private half never crosses its module boundary — the enclave signs, and only a
// signature comes back. That is not available for key agreement: the Noise
// initiator takes the static secret as raw bytes (§8), and no platform keystore
// on either OS performs X25519. `withSecretKey` is the narrowest thing that is
// actually expressible: the scalar is live only for the duration of one
// caller-supplied function, this module zeroizes it on every exit from that
// function, and no accessor returns it.

export type MobileE2eeAgreementKeyErrorCode =
  /** No agreement key exists for this device yet. */
  | "agreement_key_not_found"
  /** The stored value is not a well-formed 32-byte scalar. */
  | "agreement_key_corrupt"
  /** §6.2 admits one key per device, and one already exists. */
  | "agreement_key_conflict"
  /** The secure store failed, or the §14.5 runtime preflight refused. */
  | "agreement_key_operation_failed"
  | "agreement_key_runtime_unavailable";

/**
 * One fixed message for every code.
 *
 * The code is the diagnostic; the message is a constant so that no keychain
 * service, entry name, store path, native status code, or key-shaped byte can
 * reach a caller, a log, a crash report, or a view through an error.
 */
export class MobileE2eeAgreementKeyError extends Error {
  readonly code: MobileE2eeAgreementKeyErrorCode;

  constructor(code: MobileE2eeAgreementKeyErrorCode) {
    super("Device agreement key operation failed.");
    this.name = "MobileE2eeAgreementKeyError";
    this.code = code;
  }
}

export interface MobileE2eeAgreementPublicDescriptor {
  readonly algorithm: typeof E2EE_AGREEMENT_ALGORITHM;
  /** Raw X25519 public key, `E2EE_AGREEMENT_PUBLIC_KEY_BYTES` (§7.1). */
  readonly publicKey: Uint8Array;
  /** `ryco.e2ee-agreement-key.v1` fingerprint of `publicKey` (§7.1). */
  readonly fingerprint: Uint8Array;
}

export interface MobileE2eeAgreementKey {
  /**
   * Create the device's agreement key. Create-only: an existing key is a
   * conflict, never an overwrite, because overwriting would silently invalidate
   * the §7.4 certificate that cross-signs it and every pin taken against it.
   */
  readonly generate: () => Promise<MobileE2eeAgreementPublicDescriptor>;
  readonly getPublicDescriptor: () => Promise<MobileE2eeAgreementPublicDescriptor>;
  /**
   * Borrow the agreement secret for exactly one operation (§6.3).
   *
   * The bytes handed to `use` are this module's buffer and are zeroized before
   * this call settles — on return, on throw, and on rejection alike. A caller
   * MUST NOT retain the reference past `use`; the Noise handshake copies what it
   * needs and erases its own copy (§8), which is what makes the borrow window
   * exactly the length of one handshake construction.
   */
  readonly withSecretKey: <A>(use: (secretKey: Uint8Array) => Promise<A> | A) => Promise<A>;
  readonly delete: () => Promise<void>;
}

/** Test-only lifecycle telemetry. It reports counts/events, never key material. */
interface AgreementSecretBorrowObserver {
  readonly acquired: () => void;
  readonly borrowStarted: () => void;
  readonly released: () => void;
}

/**
 * X25519 secret-scalar length (RFC 7748 §5).
 *
 * Stated separately from `E2EE_AGREEMENT_PUBLIC_KEY_BYTES` even though the curve
 * makes the two equal: they bound different values, and a future check that
 * reused the public-key constant for a secret would read as if the two were the
 * same thing.
 */
const AGREEMENT_SECRET_KEY_BYTES = 32;

function agreementError(code: MobileE2eeAgreementKeyErrorCode): never {
  throw new MobileE2eeAgreementKeyError(code);
}

function publicDescriptorFromSecretKey(secretKey: Uint8Array): MobileE2eeAgreementPublicDescriptor {
  let publicKey: Uint8Array;
  try {
    publicKey = deriveE2eeAgreementPublicKey(secretKey);
  } catch {
    return agreementError("agreement_key_corrupt");
  }
  return {
    algorithm: E2EE_AGREEMENT_ALGORITHM,
    publicKey,
    fingerprint: e2eeKeyFingerprint("agreement", publicKey),
  };
}

export function makeMobileE2eeAgreementKey(
  store: E2eeSecureStore = mobileE2eeSecureStore,
  testOnlyObserver?: AgreementSecretBorrowObserver,
): MobileE2eeAgreementKey {
  const readStored = async (): Promise<string | null> => {
    try {
      return await store.get(E2EE_AGREEMENT_SECRET_KEY);
    } catch {
      // A store that throws is not a store that reported "no key": treating the
      // two alike would let a transient keychain failure look like a first run
      // and mint a second key that no §7.4 certificate covers.
      return agreementError("agreement_key_operation_failed");
    }
  };

  /**
   * Load the stored scalar, zeroizing it before rejecting.
   *
   * The rejection path matters as much as the success path: a stored value of the
   * wrong length is still key-shaped material, and leaving it in a live buffer
   * because the length check failed would be the one leak this discipline exists
   * to prevent.
   *
   * The base64url string it decodes from cannot be erased — JavaScript strings
   * are immutable and the secure store is string-valued on both platforms — so
   * nothing here retains one beyond the decode.
   */
  const loadSecretKey = async (): Promise<Uint8Array> => {
    const stored = await readStored();
    if (stored === null) return agreementError("agreement_key_not_found");
    let secretKey: Uint8Array;
    try {
      secretKey = decodeBase64Url(stored);
    } catch {
      return agreementError("agreement_key_corrupt");
    }
    if (secretKey.byteLength !== AGREEMENT_SECRET_KEY_BYTES) {
      secretKey.fill(0);
      return agreementError("agreement_key_corrupt");
    }
    return secretKey;
  };

  /**
   * Serializes the create path so two callers cannot both observe "no key" and
   * both mint one. The store has no create-only primitive — expo-secure-store
   * offers read, write, and delete — so create-only is read-then-write, and that
   * pair has to be atomic with respect to this module's own callers.
   */
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = pending.then(operation, operation);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * §14.5's fail-closed check, run before EVERY operation that produces or uses
   * key material — not only the one launch that mints the key.
   *
   * §14.5 requires the source to be verified "at startup", refusing E2EE "rather
   * than discovering the absence mid-handshake". Gating creation alone would
   * satisfy that on exactly one launch: a device that already holds a key reaches
   * `getPublicDescriptor` and `withSecretKey` without passing through `generate`,
   * so a runtime that lost its CSPRNG between launches would go on issuing §7.4
   * certificates and would first notice at the Noise ephemeral draw — the
   * mid-handshake discovery §14.5 forbids.
   *
   * Not memoized. The draw is 32 bytes and the check is the cheapest thing in any
   * operation that reaches it, so there is nothing to buy by remembering a verdict
   * about a source that can stop working.
   *
   * `delete` is deliberately NOT gated: §6.3's clone/restore purge and §13's
   * re-pairing destroy must still run on a runtime E2EE is refused on, and
   * refusing to destroy key material would be refusing to destroy it.
   */
  const preflight = (): void => {
    try {
      assertE2eeRuntimeGlobals();
    } catch {
      agreementError("agreement_key_runtime_unavailable");
    }
  };

  return {
    generate: () =>
      exclusive(async () => {
        // A refusal means E2EE is unavailable on this device, never a weaker key,
        // so it lands before anything is drawn, read, or written.
        preflight();
        if ((await readStored()) !== null) return agreementError("agreement_key_conflict");
        // §6.2/§14.5: generated by the shared primitive surface, so this endpoint
        // has no curve arithmetic and no randomness policy of its own.
        const { secretKey } = generateE2eeAgreementKeyPair();
        try {
          // Derived before the write, so a scalar this device cannot turn into a
          // public key is never the thing durably stored.
          const descriptor = publicDescriptorFromSecretKey(secretKey);
          try {
            await store.set(E2EE_AGREEMENT_SECRET_KEY, encodeBase64Url(secretKey));
          } catch {
            return agreementError("agreement_key_operation_failed");
          }
          return descriptor;
        } finally {
          secretKey.fill(0);
        }
      }),
    getPublicDescriptor: async () => {
      preflight();
      const secretKey = await loadSecretKey();
      try {
        return publicDescriptorFromSecretKey(secretKey);
      } finally {
        secretKey.fill(0);
      }
    },
    withSecretKey: async (use) => {
      preflight();
      const secretKey = await loadSecretKey();
      try {
        testOnlyObserver?.acquired();
        testOnlyObserver?.borrowStarted();
        // Awaited, not returned: the `finally` below zeroizes this module's
        // buffer, and an unawaited promise would erase the scalar while the
        // borrower still held it — X25519 clamps an all-zero scalar to a fixed,
        // publicly known one.
        return await use(secretKey);
      } finally {
        secretKey.fill(0);
        testOnlyObserver?.released();
      }
    },
    delete: () =>
      exclusive(async () => {
        try {
          await store.remove(E2EE_AGREEMENT_SECRET_KEY);
        } catch {
          return agreementError("agreement_key_operation_failed");
        }
      }),
  };
}

export const mobileE2eeAgreementKey = makeMobileE2eeAgreementKey();
