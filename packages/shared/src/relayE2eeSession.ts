import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { expand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { clean, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { encode, rfc8949EncodeOptions } from "cborg";

import {
  E2EE_AEAD_TAG_BYTES,
  E2EE_CLOSE_COMMITMENT_BYTES,
  E2EE_CLOSE_RECORDS_RESERVED,
  E2EE_COUNTER_FIELD_BYTES,
  E2EE_COUNTER_MAX,
  E2EE_ENVELOPE_OVERHEAD_BYTES,
  E2EE_EPOCH_FIELD_BYTES,
  E2EE_EPOCH_MAX,
  E2EE_ERROR_BODY_MAX_BYTES,
  E2EE_ERROR_RECORDS_RESERVED,
  E2EE_INNER_TYPE_BYTES,
  E2EE_PROTOCOL_VERSION,
  E2EE_REKEY_MAX_BYTES,
  E2EE_REKEY_MAX_RECORDS,
  E2EE_SECRET_BYTES,
  E2EE_SESSION_BINDING_HASH_BYTES,
} from "./relayE2eeConstants.ts";
import { e2eeNativePrimitives } from "./relayE2eeKeys.ts";
import type { E2eeNoiseHandshake, E2eeNoiseSessionKeys } from "./relayE2eeNoise.ts";
import {
  E2EE_DIRECTION_CLIENT_TO_NODE,
  E2EE_DIRECTION_NODE_TO_CLIENT,
  E2EE_INNER_TYPE_CLOSE,
  E2EE_INNER_TYPE_CLOSE_ACK,
  E2EE_INNER_TYPE_ERROR,
  E2EE_INNER_TYPE_RPC,
  decodeE2eeEnvelope,
  decodeE2eeInnerRecord,
  e2eeAeadNonceFromHeader,
  e2eeEnvelopeAad,
  encodeE2eeDirectionLabel,
  encodeE2eeEnvelope,
  encodeE2eeEnvelopeHeader,
  encodeE2eeInnerRecord,
  isE2eeDirection,
  isE2eeInnerRecordType,
  isE2eeSuiteId,
  type E2eeDirection,
  type E2eeInnerRecordType,
  type E2eeSuiteId,
} from "./relayE2eeWire.ts";

// The session key schedule and record protection of the Ryco relay E2EE
// protocol — docs/relay-e2ee-protocol.md §6.5 (session keys), §9.1 (AEAD
// invocation), §9.2 (receiver-state sequencing), §9.3 (sender rules), §9.4
// (epoch key schedule and rekey ratchet), §9.5 (erasure), and §9.6 (exhaustion).
//
// This is the layer between the handshake and the application: `relayE2eeNoise`
// hands over three values (§6.5), this module turns them into the two
// directional epoch schedules, and every byte the application sends or receives
// on an `e2ee` channel passes through `protect` or `unprotect` below.
//
// IT OWNS NO FRAMING AND NO STATE MACHINE. The envelope layout, the inner-record
// framing, the AEAD nonce, and the AAD are `relayE2eeWire`'s (§3.3) and are
// REUSED here rather than rebuilt — a second construction of a nonce or an AAD
// is a second chance to disagree with the peer. The mode machine (§4.4), the
// close machine (§10), and the `E2EEError` body (§11.3) are not here either;
// what is here is the part of their behavior §9 fixes: close and error records
// consume the same directional sequence as RPC records, they count toward the
// same thresholds, and §9.6 reserves capacity for them.
//
// Epochs and counters are `bigint` throughout, per §3.1 and §9.3. The per-epoch
// usage counters are `number`, deliberately: they are bounded by
// `E2EE_REKEY_MAX_RECORDS` and by `E2EE_REKEY_MAX_BYTES` plus one record, both
// far below `Number.MAX_SAFE_INTEGER`, and they are usage accounting rather than
// wire values — nothing derived from them reaches a nonce.
//
// RESULTS ARE TYPED FOR PEER INPUT AND THROWN FOR LOCAL MISTAKES, as in
// `relayE2eeWire`: every reason `unprotect` returns is a condition the caller
// maps onto a §11.3 row, and every throw here is reachable only from a local
// programming error.

// ─── §3.5 HKDF labels ────────────────────────────────────────────────────────

/**
 * §3.5, §8.7: derives `serverConfirmationKey` from `exporterSecret`. Not
 * directional.
 */
export const E2EE_CONFIRMATION_KEY_LABEL = "ryco.relay-e2ee.confirmation-key.v1" as const;
/**
 * §3.5, §9.4: derives the per-epoch directional AEAD key. DIRECTIONAL — the
 * `info` input is these bytes followed by the §3.4 direction label of the
 * derived direction.
 */
export const E2EE_AEAD_KEY_LABEL = "ryco.relay-e2ee.aead-key.v1" as const;
/**
 * §3.5, §9.4: derives the next directional epoch secret. DIRECTIONAL, exactly
 * as `E2EE_AEAD_KEY_LABEL` is.
 */
export const E2EE_RATCHET_LABEL = "ryco.relay-e2ee.ratchet.v1" as const;

const CONFIRMATION_KEY_LABEL_BYTES = utf8ToBytes(E2EE_CONFIRMATION_KEY_LABEL);
const AEAD_KEY_LABEL_BYTES = utf8ToBytes(E2EE_AEAD_KEY_LABEL);
const RATCHET_LABEL_BYTES = utf8ToBytes(E2EE_RATCHET_LABEL);

function requireSecret(value: Uint8Array, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== E2EE_SECRET_BYTES) {
    throw new TypeError(`Relay E2EE ${what} must be exactly E2EE_SECRET_BYTES long.`);
  }
  return value;
}

function requireDirection(direction: E2eeDirection): E2eeDirection {
  if (!isE2eeDirection(direction)) {
    throw new TypeError("Relay E2EE direction must be a registered direction label.");
  }
  return direction;
}

/**
 * The directional `info` input of §3.5: the label bytes followed by the §3.4
 * direction label. Built through `encodeE2eeDirectionLabel` so the label bytes
 * are the registry's and not a second spelling of them.
 */
function directionalInfo(label: Uint8Array, direction: E2eeDirection): Uint8Array {
  return concatBytes(label, encodeE2eeDirectionLabel(requireDirection(direction)));
}

// ─── §9.5 ownership and erasure ──────────────────────────────────────────────
//
// THE OWNERSHIP RULE OF EVERY MODULE THAT HOLDS §6.5 OR §9.4 KEY MATERIAL, of
// which this one holds the most. One defect produces every violation of §9.5
// this implementation has had: key material is acquired, and then a statement
// that can throw runs before anything is in a position to erase it. The buffer
// that survives such a throw belongs to nobody — no object owns it, no caller
// may touch it — and it lives, unzeroed, to the end of the process.
//
// A constructor, a factory, or a method that takes ownership therefore has
// exactly two admissible shapes:
//
//   (a) ACQUIRE LAST. Every validation and every fallible derivation runs
//       BEFORE the first byte is acquired, and nothing after the acquisition
//       can throw. A failure then acquires nothing and there is nothing to
//       erase. PREFER THIS: it removes the failure mode rather than handling
//       it. `DirectionalRecordState`, `#protectCommitted`'s buffered plaintext,
//       and `relayE2eeNoise`'s handshake constructor are built this way.
//
//   (b) ONE FUNNEL. The acquisition and every fallible statement after it sit
//       inside `ownE2eeSecrets`, which erases on any throw — with no statement
//       between the acquisition and the funnel's start, and nothing fallible
//       after its end. This is the shape for an ownership transfer the caller
//       cannot take back, where (a) would only strand the same buffer one frame
//       further up the stack: `e2eeSessionSecretsFromNoiseKeys` takes ownership
//       with the CALL, so its funnel starts with the call.
//
// Every erasure helper below is TOTAL: it never throws, whatever it is handed.
// Erasure runs on failure paths, and a caller must see the failure that brought
// it there rather than one raised while cleaning up after it.

/** §9.5: overwrite each buffer with zeros, independently and without throwing. */
function eraseE2eeSecretBuffers(...buffers: readonly (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) {
    if (!(buffer instanceof Uint8Array)) continue;
    try {
      clean(buffer);
    } catch {
      // One unusable buffer must not stop the rest from being zeroed, and no
      // erasure may replace the failure that reached this path.
    }
  }
}

/**
 * Shape (b): run `build` as the ONE fallible region that follows an ownership
 * transfer. If it throws, every buffer in `owned` is zeroed before the throw
 * propagates.
 *
 * `owned` is evaluated as the argument list, so the acquisition and the funnel's
 * start are the same statement — there is no window for a future edit to grow a
 * statement between them.
 */
function ownE2eeSecrets<T>(owned: readonly (Uint8Array | undefined)[], build: () => T): T {
  try {
    return build();
  } catch (error) {
    eraseE2eeSecretBuffers(...owned);
    throw error;
  }
}

/**
 * §8.7: `serverConfirmationKey = HKDF-Expand(exporterSecret,
 * "ryco.relay-e2ee.confirmation-key.v1", E2EE_SECRET_BYTES)`.
 *
 * `exporterSecret` feeds this and nothing else (§6.5). The confirmation MAC
 * itself, and the transcript it covers, are §8.7's and belong to the handshake
 * driver; this module derives the key because the key schedule is one object.
 */
export function deriveE2eeServerConfirmationKey(exporterSecret: Uint8Array): Uint8Array {
  return expand(
    sha256,
    requireSecret(exporterSecret, "exporter secret"),
    CONFIRMATION_KEY_LABEL_BYTES,
    E2EE_SECRET_BYTES,
  );
}

/**
 * §9.4: `aeadKey_d[e] = HKDF-Expand(epochSecret_d[e],
 * "ryco.relay-e2ee.aead-key.v1" ‖ label_d, E2EE_SECRET_BYTES)`.
 */
export function deriveE2eeAeadKey(epochSecret: Uint8Array, direction: E2eeDirection): Uint8Array {
  return expand(
    sha256,
    requireSecret(epochSecret, "epoch secret"),
    directionalInfo(AEAD_KEY_LABEL_BYTES, direction),
    E2EE_SECRET_BYTES,
  );
}

/**
 * §9.4: `epochSecret_d[e+1] = HKDF-Expand(epochSecret_d[e],
 * "ryco.relay-e2ee.ratchet.v1" ‖ label_d, E2EE_SECRET_BYTES)`.
 */
export function deriveE2eeNextEpochSecret(
  epochSecret: Uint8Array,
  direction: E2eeDirection,
): Uint8Array {
  return expand(
    sha256,
    requireSecret(epochSecret, "epoch secret"),
    directionalInfo(RATCHET_LABEL_BYTES, direction),
    E2EE_SECRET_BYTES,
  );
}

/**
 * Both §9.4 outputs of one epoch secret, in the order §9.4 lists them.
 *
 * Two derived secrets means the first is live while the second is derived, so
 * the second derivation runs inside the §9.5 funnel — shape (b). The window is
 * unreachable for a validated secret and direction, because the two derivations
 * validate the same two inputs and the first would have thrown already; the
 * funnel is here so that the shape of the code cannot be read as a licence to
 * leave a derived secret uncovered.
 */
export function deriveE2eeEpochKeys(
  epochSecret: Uint8Array,
  direction: E2eeDirection,
): { readonly aeadKey: Uint8Array; readonly nextEpochSecret: Uint8Array } {
  const aeadKey = deriveE2eeAeadKey(epochSecret, direction);
  return ownE2eeSecrets([aeadKey], () => ({
    aeadKey,
    nextEpochSecret: deriveE2eeNextEpochSecret(epochSecret, direction),
  }));
}

// ─── §6.5 session secrets ────────────────────────────────────────────────────

/**
 * The complete set of secrets a session holds (§6.5, §8.7). Nothing else is
 * extractable from a finished handshake, and every buffer here is erased on
 * close (§9.5).
 */
export interface E2eeSessionSecrets {
  /** `k_c2n` — `epochSecret_c2n[0]`, the first `Split()` output (§6.5). */
  readonly epochSecretC2N: Uint8Array;
  /** `k_n2c` — `epochSecret_n2c[0]`, the second `Split()` output (§6.5). */
  readonly epochSecretN2C: Uint8Array;
  /** `HKDF-Expand(ck_final, "ryco.relay-e2ee.exporter.v1", …)`; feeds only §8.7. */
  readonly exporterSecret: Uint8Array;
  /** `HKDF-Expand(exporterSecret, "ryco.relay-e2ee.confirmation-key.v1", …)` (§8.7). */
  readonly serverConfirmationKey: Uint8Array;
}

/**
 * The §6.5 session secrets from the three values `Split()` yields.
 *
 * TAKES OWNERSHIP of the three buffers: they are the only copies of that key
 * material, and duplicating them would double the number of buffers §9.5
 * erasure has to find. The caller MUST NOT reuse or erase them independently —
 * hand them to an `E2eeRecordSession`, or erase them with
 * `eraseE2eeSessionSecrets`.
 *
 * Ownership transfers with the CALL, not with the return: the usual caller is
 * `deriveE2eeSessionSecrets`, which passes the `Split()` outputs straight
 * through and holds no reference of its own, so a failure here can strand them
 * nowhere else. This is therefore shape (b) and the funnel starts with the
 * call — the three §6.5 length checks and the §8.7 derivation each run with the
 * earlier buffers live, and any one of them failing zeroes all three.
 */
export function e2eeSessionSecretsFromNoiseKeys(keys: E2eeNoiseSessionKeys): E2eeSessionSecrets {
  return ownE2eeSecrets([keys.epochSecretC2N, keys.epochSecretN2C, keys.exporterSecret], () => ({
    epochSecretC2N: requireSecret(keys.epochSecretC2N, "epoch secret"),
    epochSecretN2C: requireSecret(keys.epochSecretN2C, "epoch secret"),
    exporterSecret: requireSecret(keys.exporterSecret, "exporter secret"),
    serverConfirmationKey: deriveE2eeServerConfirmationKey(keys.exporterSecret),
  }));
}

/**
 * §6.5 in one step: `Split()` the completed Noise handshake — which also erases
 * the entire handshake state, as §6.5 requires — and derive
 * `serverConfirmationKey` from the exported secret.
 *
 * This is the only path from a handshake to a session in this implementation,
 * so no caller has to remember that the exporter runs before the handshake
 * state is gone.
 */
export function deriveE2eeSessionSecrets(handshake: E2eeNoiseHandshake): E2eeSessionSecrets {
  return e2eeSessionSecretsFromNoiseKeys(handshake.split());
}

/**
 * §9.5: overwrite every session secret with zeros before releasing it.
 *
 * TOTAL, like every erasure helper here: a bundle that is not an object, a
 * field that is not a buffer, and a buffer that cannot be written are all
 * tolerated, because this runs on failure paths where a malformed bundle is
 * itself one of the failures that reaches it.
 */
export function eraseE2eeSessionSecrets(secrets: E2eeSessionSecrets): void {
  if (secrets === null || typeof secrets !== "object") return;
  eraseE2eeSecretBuffers(
    secrets.epochSecretC2N,
    secrets.epochSecretN2C,
    secrets.exporterSecret,
    secrets.serverConfirmationKey,
  );
}

// ─── §9.6 the post-application reserve ───────────────────────────────────────

/**
 * The authenticated inner plaintext of one close-machine record: the inner type
 * byte plus the §10.1 body, which is the canonical-CBOR array of exactly five
 * byte strings of fixed widths — two epoch fields, two counter fields, and the
 * close commitment. Every close-machine record is therefore the same size, and
 * the size is computed from the pinned codec (§3.6) rather than written out by
 * hand, so a change to the §10.1 body cannot silently leave the §9.6 reserve
 * accounting behind. `relayE2eeSession.test.ts` pins the literal it produces.
 */
export const E2EE_CLOSE_RECORD_PLAINTEXT_BYTES: number =
  E2EE_INNER_TYPE_BYTES +
  encode(
    [
      new Uint8Array(E2EE_EPOCH_FIELD_BYTES),
      new Uint8Array(E2EE_COUNTER_FIELD_BYTES),
      new Uint8Array(E2EE_EPOCH_FIELD_BYTES),
      new Uint8Array(E2EE_COUNTER_FIELD_BYTES),
      new Uint8Array(E2EE_CLOSE_COMMITMENT_BYTES),
    ],
    rfc8949EncodeOptions,
  ).byteLength;

/**
 * The authenticated inner plaintext an `E2EEError` record may cost: the inner
 * type byte plus the §11.3 body bound. The bound rather than the actual body,
 * because §9.6 requires the capacity to be held before the code is known.
 */
export const E2EE_ERROR_RECORD_PLAINTEXT_MAX_BYTES: number =
  E2EE_INNER_TYPE_BYTES + E2EE_ERROR_BODY_MAX_BYTES;

/**
 * §9.6: `post-application reserve = E2EE_CLOSE_RECORDS_RESERVED +
 * E2EE_ERROR_RECORDS_RESERVED` records, each with its own plaintext cost,
 * because the reserve is held under BOTH §9.4 thresholds and the byte half is
 * normative even though it is nearly free.
 *
 * The close half is unconditional in every role and the error half is
 * unconditional in every role: an endpoint cannot know at reservation time
 * whether it will initiate, respond, or land in the simultaneous branch, and
 * §11.3 obliges it to be able to emit one terminal `E2EEError`.
 */
export const E2EE_POST_APPLICATION_RESERVE_PLAINTEXT_BYTES: readonly number[] = Object.freeze([
  ...Array.from({ length: E2EE_CLOSE_RECORDS_RESERVED }, () => E2EE_CLOSE_RECORD_PLAINTEXT_BYTES),
  ...Array.from(
    { length: E2EE_ERROR_RECORDS_RESERVED },
    () => E2EE_ERROR_RECORD_PLAINTEXT_MAX_BYTES,
  ),
]);

/** §9.6: how many records the post-application reserve covers. */
export const E2EE_POST_APPLICATION_RESERVE_RECORDS: number =
  E2EE_CLOSE_RECORDS_RESERVED + E2EE_ERROR_RECORDS_RESERVED;

// ─── §9.1 AEAD selection ─────────────────────────────────────────────────────

/** The suite AEAD, as §9.1 invokes it. `open` throws on authentication failure. */
export interface E2eeRecordAead {
  seal(nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  open(nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;
}

/**
 * Selects the AEAD implementation for a `(version, suite)` pair. §9.1 requires
 * the transmitted version and suite to equal the established session state
 * BEFORE this runs, so every call site here is placed after that comparison and
 * the guard inside the default factory is defense in depth, never the check.
 */
export type E2eeRecordAeadFactory = (input: {
  readonly version: number;
  readonly suite: E2eeSuiteId;
  readonly key: Uint8Array;
}) => E2eeRecordAead;

const suiteRecordAead: E2eeRecordAeadFactory = ({ version, suite, key }) => {
  if (version !== E2EE_PROTOCOL_VERSION || !isE2eeSuiteId(suite)) {
    throw new TypeError("Relay E2EE record AEAD selected for an unregistered version or suite.");
  }
  requireSecret(key, "AEAD key");
  return {
    seal: (nonce, plaintext, aad) => {
      // §14.7: RFC 8439 sealing is a deterministic function of (key, nonce,
      // AAD, plaintext), so a native seal is the pinned seal byte for byte.
      // Small records stay on the pinned primitive, which is faster there.
      const native = e2eeNativePrimitives()?.chacha20Poly1305;
      if (native !== undefined && plaintext.byteLength >= native.minBytes) {
        try {
          return native.seal(key, nonce, plaintext, aad);
        } catch {
          // Answered by the pinned primitive below.
        }
      }
      return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
    },
    open: (nonce, ciphertext, aad) => {
      // §14.7: a native open that returns has authenticated the tag, so the
      // pinned primitive accepts the same input and yields the same plaintext.
      // Every native failure — including every authentication failure — is
      // decided again by the pinned primitive, whose throw is the one §9.2
      // classifies, so the rejected set is exactly the pinned primitive's.
      const native = e2eeNativePrimitives()?.chacha20Poly1305;
      if (
        native !== undefined &&
        ciphertext.byteLength - E2EE_AEAD_TAG_BYTES >= Math.max(native.minBytes, 0)
      ) {
        try {
          return native.open(key, nonce, ciphertext, aad);
        } catch {
          // Answered by the pinned primitive below.
        }
      }
      return chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
    },
  };
};

// ─── §9.2/§9.3/§9.4 directional state ────────────────────────────────────────

/**
 * A synthetic starting position for one direction. TEST AND FIXTURE-GENERATOR
 * USE ONLY: §16.3 F9 requires threshold-boundary, exhaustion, and degenerate
 * reserve states that no reachable amount of test traffic could produce
 * (`E2EE_REKEY_MAX_BYTES` alone is 256 MiB per epoch).
 *
 * The epoch secret is NOT ratcheted to `epoch`: the state is synthetic in the
 * key schedule as well as in the position, which is exactly why both endpoints
 * of a synthetic test must be constructed from the same secrets and the same
 * synthetic state. Production callers MUST omit it.
 */
export interface E2eeSyntheticDirectionState {
  readonly epoch?: bigint;
  readonly counter?: bigint;
  /** Records already protected or authenticated in this epoch (§9.4). */
  readonly epochRecords?: number;
  /** Authenticated inner-plaintext bytes already counted in this epoch (§9.4). */
  readonly epochBytes?: number;
}

/** The position and epoch usage of one direction (§9.2, §9.4). */
export interface E2eeDirectionState {
  /** Next `(epoch, counter)` to send, or expected next to receive; absent when exhausted. */
  readonly epoch: bigint | undefined;
  readonly counter: bigint | undefined;
  readonly epochRecords: number;
  readonly epochBytes: number;
  /** §9.6: the direction's sequence space is spent; no record may wrap or reuse. */
  readonly exhausted: boolean;
}

/**
 * One direction's epoch schedule, position, and usage — the same machinery on
 * both sides, because §9.2 requires the receiver's expectation to advance by
 * exactly the rule §9.4 gives the sender. A second, mirrored implementation of
 * that rule is the defect the shared class exists to prevent.
 */
class DirectionalRecordState {
  readonly #direction: E2eeDirection;
  #epochSecret: Uint8Array | undefined;
  #aeadKey: Uint8Array | undefined;
  #epoch: bigint;
  #counter: bigint;
  #epochRecords: number;
  #epochBytes: number;
  #exhausted = false;

  /**
   * Takes ownership of `epochSecret` (§6.5): it is `epochSecret_d[0]`.
   *
   * ACQUIRE LAST (§9.5, shape (a)). The direction, the epoch secret, and the
   * synthetic start position are ALL validated first — the synthetic position
   * throws on any out-of-range epoch, counter, record count, or byte count, and
   * that check used to run after the epoch-0 AEAD key had been derived, leaving
   * a derived key that no object owned and no funnel could reach. The
   * derivation is now the last fallible statement in the constructor and the
   * ownership assignment follows it, so a failure derives nothing and holds
   * nothing.
   */
  constructor(
    direction: E2eeDirection,
    epochSecret: Uint8Array,
    synthetic?: E2eeSyntheticDirectionState | undefined,
  ) {
    const validatedDirection = requireDirection(direction);
    requireSecret(epochSecret, "epoch secret");
    const start = DirectionalRecordState.#startPosition(synthetic);
    this.#direction = validatedDirection;
    this.#epoch = start.epoch;
    this.#counter = start.counter;
    this.#epochRecords = start.epochRecords;
    this.#epochBytes = start.epochBytes;
    // Both direction schedules are always derived, at both endpoints,
    // regardless of traffic volume (§9.4): `aeadKey_d[0]` exists from the
    // moment the session does, on the direction this endpoint never sends as
    // much as on the one it does.
    this.#aeadKey = deriveE2eeAeadKey(epochSecret, validatedDirection);
    this.#epochSecret = epochSecret;
  }

  /**
   * The starting position: epoch 0 with an unused epoch, or the validated §16.3
   * F9 synthetic one. PURE — it reads the caller's option object, throws on
   * anything out of range, and touches no key material, which is what lets the
   * constructor validate before it derives.
   */
  static #startPosition(synthetic: E2eeSyntheticDirectionState | undefined): {
    readonly epoch: bigint;
    readonly counter: bigint;
    readonly epochRecords: number;
    readonly epochBytes: number;
  } {
    const epoch = synthetic?.epoch ?? 0n;
    const counter = synthetic?.counter ?? 0n;
    const records = synthetic?.epochRecords ?? 0;
    const bytes = synthetic?.epochBytes ?? 0;
    if (typeof epoch !== "bigint" || epoch < 0n || epoch > E2EE_EPOCH_MAX) {
      throw new RangeError("Synthetic relay E2EE epoch must be a bigint in the uint32 range.");
    }
    if (typeof counter !== "bigint" || counter < 0n || counter > E2EE_COUNTER_MAX) {
      throw new RangeError("Synthetic relay E2EE counter must be a bigint in the uint64 range.");
    }
    if (!Number.isInteger(records) || records < 0 || records >= E2EE_REKEY_MAX_RECORDS) {
      throw new RangeError("Synthetic relay E2EE epoch record count must leave the epoch live.");
    }
    if (!Number.isInteger(bytes) || bytes < 0 || bytes >= E2EE_REKEY_MAX_BYTES) {
      throw new RangeError("Synthetic relay E2EE epoch byte count must leave the epoch live.");
    }
    return { epoch, counter, epochRecords: records, epochBytes: bytes };
  }

  get direction(): E2eeDirection {
    return this.#direction;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get epoch(): bigint {
    return this.#epoch;
  }

  get counter(): bigint {
    return this.#counter;
  }

  get state(): E2eeDirectionState {
    return {
      epoch: this.#exhausted ? undefined : this.#epoch,
      counter: this.#exhausted ? undefined : this.#counter,
      epochRecords: this.#epochRecords,
      epochBytes: this.#epochBytes,
      exhausted: this.#exhausted,
    };
  }

  get aeadKey(): Uint8Array {
    const key = this.#aeadKey;
    if (key === undefined) {
      throw new TypeError("Relay E2EE directional AEAD key is unavailable.");
    }
    return key;
  }

  /**
   * §9.4: the epoch is complete when the record count reaches
   * `E2EE_REKEY_MAX_RECORDS` or the byte count reaches or exceeds
   * `E2EE_REKEY_MAX_BYTES`, whichever occurs first.
   */
  static #epochComplete(records: number, bytes: number): boolean {
    return records >= E2EE_REKEY_MAX_RECORDS || bytes >= E2EE_REKEY_MAX_BYTES;
  }

  /**
   * §9.6: can this direction still protect (or authenticate) the given
   * sequence of records, each costing that many authenticated inner-plaintext
   * bytes, without wrapping?
   *
   * The simulation is the §9.4 rule run forward: a record may be protected only
   * while its epoch is live, a completed epoch advances to `e + 1`, and there is
   * no epoch beyond `E2EE_EPOCH_MAX`. Below the terminal epoch the answer is
   * always yes, which is why the reserve binds only there.
   */
  capacityFor(plaintextSizes: readonly number[]): boolean {
    if (this.#exhausted) return false;
    let epoch = this.#epoch;
    let records = this.#epochRecords;
    let bytes = this.#epochBytes;
    for (const size of plaintextSizes) {
      if (DirectionalRecordState.#epochComplete(records, bytes)) {
        if (epoch >= E2EE_EPOCH_MAX) return false;
        epoch += 1n;
        records = 0;
        bytes = 0;
      }
      records += 1;
      bytes += size;
    }
    return true;
  }

  /**
   * §9.4: update the epoch's usage with a record that has just been protected
   * (sender) or authenticated (receiver), then apply boundary ownership — the
   * record that reaches a threshold is the LAST of its epoch, so the next record
   * in this direction carries epoch `e + 1` and counter 0.
   *
   * §9.5 erasure happens here, in the order §9.5 fixes it: `epochSecret_d[e]`
   * is erased immediately after `epochSecret_d[e+1]` and `aeadKey_d[e+1]` are
   * derived, and `aeadKey_d[e]` immediately after the threshold evaluation that
   * makes its last record the last one.
   */
  advance(plaintextBytes: number): { readonly epochCompleted: boolean } {
    if (this.#exhausted) {
      throw new TypeError("Relay E2EE direction is exhausted; no record may advance it.");
    }
    this.#epochRecords += 1;
    this.#epochBytes += plaintextBytes;
    if (!DirectionalRecordState.#epochComplete(this.#epochRecords, this.#epochBytes)) {
      // Defensive (§9.4, §9.6): the record threshold keeps the counter below
      // `E2EE_REKEY_MAX_RECORDS`, so this cannot fire while both endpoints
      // apply the same thresholds. It exists so that a state that reached here
      // anyway terminates rather than wraps.
      if (this.#counter >= E2EE_COUNTER_MAX) {
        this.#exhaust();
        return { epochCompleted: false };
      }
      this.#counter += 1n;
      return { epochCompleted: false };
    }
    if (this.#epoch >= E2EE_EPOCH_MAX) {
      // §9.6: completing epoch `E2EE_EPOCH_MAX` exhausts the direction.
      this.#exhaust();
      return { epochCompleted: true };
    }
    const previousEpochSecret = this.#epochSecret;
    const previousAeadKey = this.#aeadKey;
    if (previousEpochSecret === undefined) {
      throw new TypeError("Relay E2EE epoch secret is unavailable.");
    }
    const nextEpochSecret = deriveE2eeNextEpochSecret(previousEpochSecret, this.#direction);
    // `epochSecret_d[e+1]` is live and owned by nothing until it reaches the
    // field below, so the second derivation runs inside the §9.5 funnel.
    const nextAeadKey = ownE2eeSecrets([nextEpochSecret], () =>
      deriveE2eeAeadKey(nextEpochSecret, this.#direction),
    );
    // §9.5's order: `epochSecret_d[e]` goes immediately after both `e+1` values
    // exist, and `aeadKey_d[e]` with it. The erasure is total, so the two new
    // secrets below cannot be stranded by a failure to zero the old ones.
    eraseE2eeSecretBuffers(previousEpochSecret, previousAeadKey);
    this.#epochSecret = nextEpochSecret;
    this.#aeadKey = nextAeadKey;
    this.#epoch += 1n;
    this.#counter = 0n;
    this.#epochRecords = 0;
    this.#epochBytes = 0;
    return { epochCompleted: true };
  }

  #exhaust(): void {
    this.#exhausted = true;
    this.erase();
  }

  /** §9.5: zero the directional key material. Total, and idempotent. */
  erase(): void {
    eraseE2eeSecretBuffers(this.#epochSecret, this.#aeadKey);
    this.#epochSecret = undefined;
    this.#aeadKey = undefined;
  }
}

// ─── §9.3 send results ───────────────────────────────────────────────────────

/** §11.4 sender-local error codes reachable from `protect`. */
export type E2eeSenderLocalErrorCode = "e2ee_message_too_large" | "e2ee_send_unavailable";

/**
 * Why the send path refused a record without consuming a `(epoch, counter)`
 * pair and without producing any wire record.
 */
export type E2eeSendUnavailableReason =
  /** §9.3: a post-AEAD send failure reached no byte of the relay (§11.3 Q10). */
  | "send_path_unusable"
  /**
   * §10.2: this endpoint has protected a close-machine record — its `E2EEClose`
   * or, in the sequential-responder role, its `E2EECloseAck`; no further
   * application RPC record may follow either.
   */
  | "application_phase_closed"
  /** §10.2: the terminal `E2EEError` has been protected; nothing may follow it. */
  | "terminal_record_protected"
  /** §9.5: the session was erased while the send was waiting for admission. */
  | "session_erased";

/**
 * What the send path established about a protected record's delivery (§9.3).
 * `none` is reserved for the case the sender can establish that NO byte of the
 * record reached the relay; anything less certain is `ambiguous`, which is what
 * a chunked record's partial transmission — and an exception carrying no
 * delivery information — amounts to.
 */
export type E2eeTransmitOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly delivery: "none" | "ambiguous" };

/**
 * Is this what a `transmit` callback promised to report? The callback is the
 * caller's, it runs after the pair is consumed, and reading a field off
 * whatever it returned is the difference between §9.3's ambiguous branch and an
 * exception thrown out of a record that is already on its way to the relay.
 */
function isTransmitOutcome(value: unknown): value is E2eeTransmitOutcome {
  if (typeof value !== "object" || value === null) return false;
  const outcome = value as { kind?: unknown; delivery?: unknown };
  if (outcome.kind === "sent") return true;
  return (
    outcome.kind === "failed" && (outcome.delivery === "none" || outcome.delivery === "ambiguous")
  );
}

export interface E2eeProtectRequest {
  readonly innerType: E2eeInnerRecordType;
  /** The inner-record body (§3.3); zero-length is valid (§9.1). Never mutated. */
  readonly body: Uint8Array;
  /**
   * §9.3 reserve before you encrypt: transmission admission for the ENTIRE
   * record — every chunk of it — before a pair is assigned and before the AEAD
   * runs. `false` refuses, which is `e2ee_send_unavailable` (§11.4): ordinary
   * backpressure, no pair consumed, channel unaffected.
   */
  readonly admit: (envelopeBytes: number) => boolean | Promise<boolean>;
  /**
   * Hands the finished envelope to the relay send path, unchanged (§4.2 step
   * 6), and reports what it can establish about delivery. Called inside the
   * per-direction serialization, so envelopes reach the relay in the order their
   * pairs were assigned — the order the peer's §9.2 expectation requires.
   */
  readonly transmit: (envelope: Uint8Array) => E2eeTransmitOutcome | Promise<E2eeTransmitOutcome>;
}

export type E2eeProtectResult =
  | {
      readonly kind: "protected";
      readonly epoch: bigint;
      readonly counter: bigint;
      /** The authenticated inner plaintext length: type byte plus body (§9.4). */
      readonly plaintextBytes: number;
      readonly envelopeBytes: number;
      /** §9.4: this record reached a threshold and is the last of its epoch. */
      readonly epochCompleted: boolean;
    }
  /** §11.4: sender-local, nothing consumed, nothing transmitted, channel usable. */
  | { readonly kind: "refused"; readonly reason: E2eeSenderLocalErrorCode }
  /** Nothing consumed: the send path does not admit this record in this state. */
  | { readonly kind: "unavailable"; readonly reason: E2eeSendUnavailableReason }
  /**
   * §9.6: protecting this application record would leave less than the
   * post-application reserve. Nothing consumed; the endpoint MUST initiate the
   * §10 close now.
   */
  | { readonly kind: "close_required" }
  /**
   * §9.6 degenerate state: no capacity remains for this record. Nothing
   * consumed, nothing wrapped, nothing reused; the close is recorded
   * **Unclean — abrupt** (§10.4).
   */
  | { readonly kind: "exhausted" }
  | {
      readonly kind: "send_failed";
      /** The pair this record consumed. Consumed means consumed (§9.3). */
      readonly epoch: bigint;
      readonly counter: bigint;
      readonly delivery: "none" | "ambiguous";
      /** §9.3: false only for `none`, where no further record may be protected. */
      readonly sendPathUsable: boolean;
      /**
       * §9.3, §11.3 Q10: false for `none` — an `E2EEError` would itself consume
       * the next pair and create exactly the gap being avoided.
       */
      readonly mayEmitError: boolean;
    };

// ─── §9.2 receive results ────────────────────────────────────────────────────

/** Every fatal receive condition, each a FATAL-POST row of §11.3. */
export type E2eeReceiveFatalReason =
  /** Q4: shorter than `E2EE_ENVELOPE_OVERHEAD_BYTES`, or not an envelope at all. */
  | "malformed_envelope"
  /** Q1: transmitted `version` differs from established session state. */
  | "version_mismatch"
  /** Q1: transmitted `suite` differs from established session state. */
  | "suite_mismatch"
  /** Q2: not the receiver-expected pair. Fatal, and NOT attributable (§9.7). */
  | "sequence_mismatch"
  /** Q3: AEAD authentication failure. */
  | "authentication_failed"
  /** Q5: reserved inner-record type, read only after authentication. */
  | "reserved_inner_type"
  /** Q5 companion: an authenticated plaintext too short to carry a type byte. */
  | "malformed_record"
  /** A fatal condition already terminated this direction; nothing more is processed. */
  | "receive_terminated";

export type E2eeUnprotectResult =
  | {
      readonly kind: "authenticated";
      readonly innerType: E2eeInnerRecordType;
      /**
       * A view into the decrypted plaintext, which the caller now owns and MUST
       * erase when it is done with it (§9.5, buffered plaintext).
       */
      readonly body: Uint8Array;
      readonly epoch: bigint;
      readonly counter: bigint;
      readonly plaintextBytes: number;
      /** §9.4: this record reached a threshold and was the last of its epoch. */
      readonly epochCompleted: boolean;
    }
  | { readonly kind: "fatal"; readonly reason: E2eeReceiveFatalReason };

// ─── the session ─────────────────────────────────────────────────────────────

export interface E2eeRecordSessionOptions {
  /** §6.5 secrets; OWNERSHIP TRANSFERS to the session, which erases them (§9.5). */
  readonly secrets: E2eeSessionSecrets;
  /** The established suite (§3.4). Every envelope's `suite` must equal it (§9.1). */
  readonly suite: E2eeSuiteId;
  /** §8.8 `sessionBindingHash`; it enters the AAD of every envelope (§3.3). */
  readonly sessionBindingHash: Uint8Array;
  /** §3.4: `"c2n"` on a client, `"n2c"` on a node. The other direction is received. */
  readonly sendDirection: E2eeDirection;
  /** §4.5 `plaintextCeiling`; MUST be positive, or the channel may not exist. */
  readonly plaintextCeiling: number;
  /** TEST AND FIXTURE USE ONLY (§16.3 F9). See `E2eeSyntheticDirectionState`. */
  readonly testOnlySyntheticSendState?: E2eeSyntheticDirectionState | undefined;
  /** TEST AND FIXTURE USE ONLY (§16.3 F9). See `E2eeSyntheticDirectionState`. */
  readonly testOnlySyntheticReceiveState?: E2eeSyntheticDirectionState | undefined;
  /**
   * TEST USE ONLY: substitutes the suite AEAD, so a test can observe WHETHER —
   * and at which point — an AEAD implementation is selected. §9.1's ordering
   * rule ("before any AEAD implementation is selected") is otherwise
   * unobservable from outside, and an unobservable ordering rule is one a
   * refactor silently inverts. Production callers MUST omit it.
   */
  readonly testOnlyAeadFactory?: E2eeRecordAeadFactory | undefined;
}

type SendPathState = "open" | "closing" | "spent" | "unusable";

/**
 * Everything an `E2eeRecordSession` validates and derives before it exists,
 * INSIDE THE §9.5 ERASURE FUNNEL.
 *
 * The session takes ownership of `secrets` (§6.5), so a constructor that threw
 * would leave the caller holding buffers it has already handed over and no
 * object to erase them — key material that is nobody's and lives to the end of
 * the process. Construction therefore has exactly two outcomes: a session that
 * owns the secrets, or a throw that has already erased them. That includes the
 * §4.5 ceiling check, whose failure §4.5 requires to end the channel before it
 * is released to the application, and it includes the second directional state,
 * whose failure would otherwise strand the first one's derived AEAD key.
 *
 * It returns EVERY value the constructor assigns, including the ones it merely
 * reads off `options`, so that the constructor's body after this call is field
 * assignments from this record and nothing else. A read left behind in the
 * constructor would be a statement after the funnel's end — the same defect at
 * one remove.
 */
function prepareE2eeRecordSession(options: E2eeRecordSessionOptions): {
  readonly suite: E2eeSuiteId;
  readonly sessionBindingHash: Uint8Array;
  readonly plaintextCeiling: number;
  readonly aeadFactory: E2eeRecordAeadFactory;
  readonly secrets: E2eeSessionSecrets;
  readonly send: DirectionalRecordState;
  readonly receive: DirectionalRecordState;
} {
  // Both directional states are hoisted out of the `try` so the `catch` can
  // reach either one. A state constructed here owns a derived epoch-0 AEAD key,
  // so one that is still referenced only by a `const` inside the block would be
  // stranded by any later throw — the ownership rule above, restated for the
  // two locals it is easiest to reintroduce it on.
  let send: DirectionalRecordState | undefined;
  let receive: DirectionalRecordState | undefined;
  try {
    if (!isE2eeSuiteId(options.suite)) {
      throw new TypeError("Relay E2EE session suite must be a registered suite id.");
    }
    if (
      !(options.sessionBindingHash instanceof Uint8Array) ||
      options.sessionBindingHash.byteLength !== E2EE_SESSION_BINDING_HASH_BYTES
    ) {
      throw new TypeError("Relay E2EE session requires a full-length session binding hash.");
    }
    if (!Number.isInteger(options.plaintextCeiling) || options.plaintextCeiling <= 0) {
      // §4.5: a channel whose plaintext ceiling is not positive MUST fail during
      // establishment, before the channel is released to the application.
      throw new RangeError("Relay E2EE session requires a positive plaintext ceiling.");
    }
    const sendDirection = requireDirection(options.sendDirection);
    const receiveDirection =
      sendDirection === E2EE_DIRECTION_CLIENT_TO_NODE
        ? E2EE_DIRECTION_NODE_TO_CLIENT
        : E2EE_DIRECTION_CLIENT_TO_NODE;

    // Both direction schedules are always derived, at both endpoints,
    // regardless of traffic (§9.4). The client's send schedule is `c2n` and its
    // receive schedule `n2c`; the node's are the same two schedules with the
    // roles swapped, which is why one pair of `Split()` outputs serves both.
    const sendSecret =
      sendDirection === E2EE_DIRECTION_CLIENT_TO_NODE
        ? options.secrets.epochSecretC2N
        : options.secrets.epochSecretN2C;
    const receiveSecret =
      sendDirection === E2EE_DIRECTION_CLIENT_TO_NODE
        ? options.secrets.epochSecretN2C
        : options.secrets.epochSecretC2N;
    send = new DirectionalRecordState(
      sendDirection,
      sendSecret,
      options.testOnlySyntheticSendState,
    );
    receive = new DirectionalRecordState(
      receiveDirection,
      receiveSecret,
      options.testOnlySyntheticReceiveState,
    );
    return {
      suite: options.suite,
      sessionBindingHash: Uint8Array.from(options.sessionBindingHash),
      plaintextCeiling: options.plaintextCeiling,
      aeadFactory: options.testOnlyAeadFactory ?? suiteRecordAead,
      secrets: options.secrets,
      send,
      receive,
    };
  } catch (error) {
    // Every erasure here is total, so none can replace the failure that reached
    // here — a malformed `secrets` object is itself one of those failures.
    send?.erase();
    receive?.erase();
    eraseE2eeSessionSecrets(options.secrets);
    throw error;
  }
}

/**
 * One channel's protected-record session: the two directional schedules of
 * §9.4, the sender rules of §9.3, the receiver sequencing of §9.2, and the
 * exhaustion accounting of §9.6.
 *
 * PER CHANNEL, DESTROYED ON CLOSE, NEVER RESUMED (§6.5). There is no session
 * ticket, no resumption secret, and no cross-channel derivation; `erase()` is
 * the end of it.
 */
export class E2eeRecordSession {
  readonly #version = E2EE_PROTOCOL_VERSION;
  readonly #suite: E2eeSuiteId;
  readonly #sessionBindingHash: Uint8Array;
  readonly #plaintextCeiling: number;
  readonly #aeadFactory: E2eeRecordAeadFactory;
  readonly #secrets: E2eeSessionSecrets;
  readonly #send: DirectionalRecordState;
  readonly #receive: DirectionalRecordState;
  #sendPath: SendPathState = "open";
  #receiveTerminated = false;
  #erased = false;
  /**
   * §9.3 send serialization. Assigning `(epoch, counter)`, invoking the AEAD,
   * committing the state advance, and handing the envelope to the relay are
   * atomic with respect to every other send in this direction: each call chains
   * onto the previous one, so two concurrent callers can never observe the same
   * pair and can never reorder two records against their pairs.
   */
  #sendQueue: Promise<void> = Promise.resolve();

  constructor(options: E2eeRecordSessionOptions) {
    // Every validation, every derivation, and every read of `options` happens
    // in `prepareE2eeRecordSession`, which erases `secrets` on any failure.
    // What is left here is assignment from the record it returned — nothing
    // that can throw — so the session either exists holding the secrets or
    // never existed and they are already zeroed (§6.5, §9.5).
    const prepared = prepareE2eeRecordSession(options);
    this.#suite = prepared.suite;
    this.#sessionBindingHash = prepared.sessionBindingHash;
    this.#plaintextCeiling = prepared.plaintextCeiling;
    this.#aeadFactory = prepared.aeadFactory;
    this.#secrets = prepared.secrets;
    this.#send = prepared.send;
    this.#receive = prepared.receive;
  }

  get suite(): E2eeSuiteId {
    return this.#suite;
  }

  get version(): typeof E2EE_PROTOCOL_VERSION {
    return this.#version;
  }

  get sendDirection(): E2eeDirection {
    return this.#send.direction;
  }

  get receiveDirection(): E2eeDirection {
    return this.#receive.direction;
  }

  /** §9.3: the next `(epoch, counter)` this endpoint will send, and its usage. */
  get sendState(): E2eeDirectionState {
    return this.#send.state;
  }

  /** §9.2: the receiver-expected next `(epoch, counter)`, and its usage. */
  get receiveState(): E2eeDirectionState {
    return this.#receive.state;
  }

  /**
   * §9.6: does the send direction still hold the post-application reserve? An
   * endpoint MUST initiate the §10 close no later than the point at which
   * exactly that reserve remains, and this is that point.
   */
  get postApplicationReserveHeld(): boolean {
    return this.#send.capacityFor(E2EE_POST_APPLICATION_RESERVE_PLAINTEXT_BYTES);
  }

  /** True once a §9.3 post-AEAD failure or the terminal record spent the send path. */
  get sendPathUsable(): boolean {
    return !this.#erased && this.#sendPath !== "unusable" && this.#sendPath !== "spent";
  }

  /**
   * §9.1 and §4.3: the transmitted version and suite MUST equal the established
   * session state BEFORE any AEAD implementation is selected. This is the only
   * place an AEAD is selected, and it takes the already-compared values so that
   * the comparison cannot be skipped on one of the two paths.
   */
  #selectAead(version: number, suite: E2eeSuiteId, key: Uint8Array): E2eeRecordAead {
    if (version !== this.#version || suite !== this.#suite) {
      throw new TypeError("Relay E2EE AEAD selection requires the established version and suite.");
    }
    return this.#aeadFactory({ version, suite, key });
  }

  /**
   * Protect and transmit exactly one authenticated inner record (§9.1). One
   * envelope, one record — RPC or control, both consuming the same directional
   * sequence, because §4.1 defines no second nonce space.
   *
   * The order below is §9.3's and §9.6's, and it is the whole point of the
   * method: state gates, then the §4.5 ceiling, then the §9.6 capacity check,
   * then transmission admission for the entire record, and only then the pair
   * assignment and the AEAD. Nothing before the assignment consumes anything,
   * so ordinary backpressure never costs a nonce.
   */
  async protect(request: E2eeProtectRequest): Promise<E2eeProtectResult> {
    this.#assertUsable();
    if (!isE2eeInnerRecordType(request.innerType)) {
      throw new TypeError("Relay E2EE inner record type must be a registered type.");
    }
    if (!(request.body instanceof Uint8Array)) {
      throw new TypeError("Relay E2EE inner record body must be a Uint8Array.");
    }
    if (typeof request.admit !== "function" || typeof request.transmit !== "function") {
      throw new TypeError("Relay E2EE sends require an admission and a transmit callback.");
    }
    const run = this.#sendQueue.then(
      () => this.#protectSerialized(request),
      () => this.#protectSerialized(request),
    );
    this.#sendQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #protectSerialized(request: E2eeProtectRequest): Promise<E2eeProtectResult> {
    if (this.#erased) return { kind: "unavailable", reason: "session_erased" };
    const gate = this.#sendGate(request.innerType);
    if (gate !== undefined) return { kind: "unavailable", reason: gate };

    // §4.5, enforced before encryption: a body over the ceiling is
    // `e2ee_message_too_large` and MUST NOT be encrypted or transmitted.
    if (request.body.byteLength > this.#plaintextCeiling) {
      return { kind: "refused", reason: "e2ee_message_too_large" };
    }

    // §9.6. An application record must leave the whole post-application reserve
    // behind it; a close-machine or error record is protected OUT of that
    // reserve and needs only its own capacity.
    const plaintextBytes = E2EE_INNER_TYPE_BYTES + request.body.byteLength;
    if (request.innerType === E2EE_INNER_TYPE_RPC) {
      if (
        !this.#send.capacityFor([plaintextBytes, ...E2EE_POST_APPLICATION_RESERVE_PLAINTEXT_BYTES])
      ) {
        return { kind: "close_required" };
      }
    } else if (!this.#send.capacityFor([plaintextBytes])) {
      return { kind: "exhausted" };
    }

    // §9.3: admission for the ENTIRE record, before the pair is assigned.
    const envelopeBytes = E2EE_ENVELOPE_OVERHEAD_BYTES + request.body.byteLength;
    if (!(await request.admit(envelopeBytes))) {
      return { kind: "refused", reason: "e2ee_send_unavailable" };
    }
    if (this.#erased) return { kind: "unavailable", reason: "session_erased" };

    const epoch = this.#send.epoch;
    const counter = this.#send.counter;
    const header = encodeE2eeEnvelopeHeader({ suite: this.#suite, epoch, counter });
    // §9.1: compare the TRANSMITTED version and suite — the bytes that will
    // actually go on the wire — against session state before selecting an AEAD.
    // On this path the header was built from session state, so the comparison is
    // a self-check on the encoder rather than a check on a peer; §9.1 makes the
    // rule symmetric and it is made on both paths.
    const transmittedVersion = header[1]!;
    const transmittedSuite = header[2]!;
    if (
      transmittedVersion !== this.#version ||
      !isE2eeSuiteId(transmittedSuite) ||
      transmittedSuite !== this.#suite
    ) {
      throw new TypeError("Relay E2EE envelope header disagrees with the established session.");
    }
    const aead = this.#selectAead(transmittedVersion, transmittedSuite, this.#send.aeadKey);

    // From here the pair has been passed to an AEAD invocation: it is consumed
    // and MUST NOT be reused under any circumstance (§9.3), including every
    // failure below. The state advance therefore commits on the failure paths
    // too, and a failure that produced no envelope at all is by construction the
    // "no byte reached the relay" branch.
    //
    // NOTHING BELOW MAY THROW OUT OF THIS METHOD. A pair is consumed and this
    // session stays usable by construction — the caller holds it and every
    // later `protect` would run against a state the throw left unadvanced,
    // which is the one outcome §9.3 forbids outright. The funnel therefore
    // converts any escaping throw into the same disposition as a local AEAD
    // failure: the send path is unusable and no further record follows.
    try {
      return await this.#protectCommitted(request, {
        epoch,
        counter,
        plaintextBytes,
        aead,
        header,
      });
    } catch {
      this.#sendPath = "unusable";
      return {
        kind: "send_failed",
        epoch,
        counter,
        delivery: "ambiguous",
        sendPathUsable: false,
        mayEmitError: false,
      };
    }
  }

  async #protectCommitted(
    request: E2eeProtectRequest,
    committed: {
      readonly epoch: bigint;
      readonly counter: bigint;
      readonly plaintextBytes: number;
      readonly aead: E2eeRecordAead;
      readonly header: Uint8Array;
    },
  ): Promise<E2eeProtectResult> {
    const { epoch, counter, plaintextBytes, aead, header } = committed;
    // The nonce and the AAD are built BEFORE the plaintext copy exists: shape
    // (a) for buffered plaintext, which §9.5 erases exactly as it erases key
    // material. Either encoder can throw, and doing it in this order means
    // nothing that can throw runs between the copy and the `finally` that
    // zeroes it.
    const nonce = e2eeAeadNonceFromHeader(header);
    const aad = e2eeEnvelopeAad({
      header,
      sessionBindingHash: this.#sessionBindingHash,
      direction: this.#send.direction,
    });
    const plaintext = encodeE2eeInnerRecord(request.innerType, request.body);
    let envelope: Uint8Array | undefined;
    try {
      const ciphertext = aead.seal(nonce, plaintext, aad);
      envelope = encodeE2eeEnvelope({ suite: this.#suite, epoch, counter, ciphertext });
    } catch {
      envelope = undefined;
    } finally {
      // §9.5: the buffered plaintext copy this method made is erased as soon as
      // the ciphertext exists. The caller's `body` is untouched and is the
      // caller's to erase. Total, so a `finally` cannot convert a protected
      // record into a throw out of a method that has already consumed a pair.
      eraseE2eeSecretBuffers(plaintext);
    }
    // The state advance commits whether or not the record could be built, and it
    // is atomic with the assignment and the AEAD with respect to every other
    // send in this direction (§9.3).
    const { epochCompleted } = this.#send.advance(plaintextBytes);
    if (envelope === undefined) {
      // The AEAD or the envelope encoder failed locally: the pair is spent and
      // no byte of the record reached the relay, which is exactly §9.3's first
      // branch — no further record on this channel, and no `E2EEError`.
      this.#sendPath = "unusable";
      return {
        kind: "send_failed",
        epoch,
        counter,
        delivery: "none",
        sendPathUsable: false,
        mayEmitError: false,
      };
    }
    this.#latchSendPath(request.innerType);

    let outcome: E2eeTransmitOutcome;
    try {
      const reported = await request.transmit(envelope);
      // §9.3: the disposition follows what the sender can ESTABLISH about
      // delivery, and a report this module cannot read establishes nothing. It
      // is the ambiguous branch rather than a throw, because the pair is already
      // consumed and the envelope is already with the send path.
      outcome = isTransmitOutcome(reported) ? reported : { kind: "failed", delivery: "ambiguous" };
    } catch {
      // A throw establishes nothing either, which is the same branch — the one a
      // partially chunked record lands in.
      outcome = { kind: "failed", delivery: "ambiguous" };
    }
    if (outcome.kind === "sent") {
      return {
        kind: "protected",
        epoch,
        counter,
        plaintextBytes,
        envelopeBytes: envelope.byteLength,
        epochCompleted,
      };
    }
    if (outcome.delivery === "none") {
      // §9.3, §11.3 Q10: the peer's expected-next pair is still the consumed
      // one, so no further record may be protected on this channel — including
      // an `E2EEError`, which would itself create the gap being avoided.
      this.#sendPath = "unusable";
      return {
        kind: "send_failed",
        epoch,
        counter,
        delivery: "none",
        sendPathUsable: false,
        mayEmitError: false,
      };
    }
    return {
      kind: "send_failed",
      epoch,
      counter,
      delivery: "ambiguous",
      sendPathUsable: this.sendPathUsable,
      mayEmitError: this.sendPathUsable,
    };
  }

  #sendGate(innerType: E2eeInnerRecordType): E2eeSendUnavailableReason | undefined {
    switch (this.#sendPath) {
      case "unusable":
        return "send_path_unusable";
      case "spent":
        // §10.2: nothing may be protected after the terminal `E2EEError`.
        return "terminal_record_protected";
      case "closing":
        // §10.2: after its FIRST close-machine record an endpoint MUST NOT
        // protect further application RPC records — the keepalive `Ping`
        // included, since it is an ordinary RPC record. Which close-machine
        // records may still follow is §10's state machine, not this module's.
        return innerType === E2EE_INNER_TYPE_RPC ? "application_phase_closed" : undefined;
      case "open":
        return undefined;
    }
  }

  /**
   * §10.2: the application phase is over for this endpoint from its FIRST
   * close-machine record, whichever of the two that record is. It is the
   * `E2EEClose` for an initiator and for either side of a simultaneous close,
   * and the `E2EECloseAck` for a sequential responder — whose whole close
   * machine is that one record, so latching only on `0x02` would leave the
   * responder's send path open and let it protect an application record after
   * it had already acknowledged the close.
   */
  #latchSendPath(innerType: E2eeInnerRecordType): void {
    if (innerType === E2EE_INNER_TYPE_ERROR) {
      this.#sendPath = "spent";
      return;
    }
    if (
      (innerType === E2EE_INNER_TYPE_CLOSE || innerType === E2EE_INNER_TYPE_CLOSE_ACK) &&
      this.#sendPath === "open"
    ) {
      this.#sendPath = "closing";
    }
  }

  /**
   * Authenticate and decrypt exactly one inbound envelope (§4.3 step 3, §9.1,
   * §9.2), taking the post-strip payload the relay assembler produced.
   *
   * The order is §4.3's and it is normative: length bound, then `version`, then
   * `suite` — all before any AEAD implementation is selected — then the §9.2
   * sequence comparison, before decryption, and only then the AEAD. A sequence
   * mismatch never decrypts the ciphertext.
   *
   * Every fatal reason is FATAL-POST (§11.3) and terminates the channel; this
   * method latches that so a second payload delivered after a fatal condition
   * cannot be processed as though nothing happened. It does NOT erase: §11.3
   * requires the detecting endpoint to emit one `E2EEError` while its send path
   * is still usable, which needs the send schedule, so `erase()` is the
   * caller's step after that record — or immediately, when the send path is
   * unusable.
   */
  unprotect(payload: Uint8Array): E2eeUnprotectResult {
    // Pure preconditions first, exactly as the Noise state machine orders its
    // turn checks: they touch nothing, so a throw out of them is an argument
    // rejection and not a half-processed record.
    this.#assertUsable();
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError("Relay E2EE payloads must be a Uint8Array.");
    }
    if (this.#receiveTerminated) return this.#receiveFatal("receive_terminated");
    try {
      return this.#unprotect(payload);
    } catch (error) {
      // Everything below the preconditions runs against the receive schedule,
      // and the only throws it admits are local invariant violations — a version
      // or suite that disagrees with session state at AEAD selection, a
      // directional key that is gone. §11.3 makes every such condition terminal
      // for the direction, so the funnel latches it: a payload delivered after
      // it is `receive_terminated` and is never processed as though nothing had
      // happened.
      this.#receiveTerminated = true;
      throw error;
    }
  }

  #unprotect(payload: Uint8Array): E2eeUnprotectResult {
    const decoded = decodeE2eeEnvelope(payload);
    if (decoded.kind === "error") {
      switch (decoded.reason) {
        case "unsupported_version":
          return this.#receiveFatal("version_mismatch");
        case "unsupported_suite":
          return this.#receiveFatal("suite_mismatch");
        default:
          return this.#receiveFatal("malformed_envelope");
      }
    }
    const envelope = decoded.value;
    // §9.1: equality against ESTABLISHED SESSION STATE, which the decoder cannot
    // check — it knows only the §3.4 registry.
    if (envelope.version !== this.#version) return this.#receiveFatal("version_mismatch");
    if (envelope.suite !== this.#suite) return this.#receiveFatal("suite_mismatch");

    // §9.2: the receiver defines the expected sequence. The comparison is made
    // BEFORE decryption and a mismatch is fatal with the ciphertext never
    // decrypted — a gap, a repeat, a regression, and an early, late or skipped
    // rekey are all the same comparison, because the expectation already
    // encodes the §9.4 boundary.
    if (
      this.#receive.exhausted ||
      envelope.epoch !== this.#receive.epoch ||
      envelope.counter !== this.#receive.counter
    ) {
      return this.#receiveFatal("sequence_mismatch");
    }

    const aead = this.#selectAead(envelope.version, envelope.suite, this.#receive.aeadKey);
    const nonce = e2eeAeadNonceFromHeader(envelope.header);
    const aad = e2eeEnvelopeAad({
      header: envelope.header,
      sessionBindingHash: this.#sessionBindingHash,
      direction: this.#receive.direction,
    });
    let plaintext: Uint8Array;
    try {
      plaintext = aead.open(nonce, envelope.ciphertext, aad);
    } catch {
      return this.#receiveFatal("authentication_failed");
    }
    // The decode is the first fallible statement after the plaintext is
    // acquired, so it carries the plaintext's erasure with it rather than
    // leaving a gap the ownership rule above forbids. `decodeE2eeInnerRecord`
    // returns a typed result today and so cannot reach the `catch`; the funnel
    // is structural, so that a decoder which later gains a throwing path cannot
    // silently strand a decrypted record.
    let record: ReturnType<typeof decodeE2eeInnerRecord>;
    try {
      record = decodeE2eeInnerRecord(plaintext);
    } catch (error) {
      eraseE2eeSecretBuffers(plaintext);
      throw error;
    }
    if (record.kind === "error") {
      eraseE2eeSecretBuffers(plaintext);
      return this.#receiveFatal(
        record.reason === "truncated" ? "malformed_record" : "reserved_inner_type",
      );
    }
    const epoch = envelope.epoch;
    const counter = envelope.counter;
    // §9.2: the receiver advances AFTER successful authentication, by the same
    // §9.4 rule the sender applies — which is why the boundary needs no
    // signaling.
    //
    // The decrypted plaintext is now held, and the ratchet inside the advance
    // is the one thing here that can throw, so the advance runs inside the §9.5
    // funnel: a local failure erases the buffered plaintext instead of leaving
    // it in the heap of a channel that is about to be terminated (§11.3).
    const { epochCompleted } = ownE2eeSecrets([plaintext], () =>
      this.#receive.advance(plaintext.byteLength),
    );
    return {
      kind: "authenticated",
      innerType: record.value.innerType,
      body: record.value.body,
      epoch,
      counter,
      plaintextBytes: plaintext.byteLength,
      epochCompleted,
    };
  }

  #receiveFatal(reason: E2eeReceiveFatalReason): E2eeUnprotectResult {
    this.#receiveTerminated = true;
    return { kind: "fatal", reason };
  }

  /**
   * §6.5, §9.5: on channel close — clean, unclean, or fatal — every session
   * secret is overwritten with zeros: both directions' epoch secrets and AEAD
   * keys, `exporterSecret`, and `serverConfirmationKey`. Idempotent, and the end
   * of the session: a session is never resumed.
   */
  erase(): void {
    if (this.#erased) return;
    this.#erased = true;
    this.#send.erase();
    this.#receive.erase();
    eraseE2eeSessionSecrets(this.#secrets);
  }

  get erased(): boolean {
    return this.#erased;
  }

  #assertUsable(): void {
    if (this.#erased) {
      throw new TypeError("Relay E2EE session has been erased; it is never resumed.");
    }
  }
}
