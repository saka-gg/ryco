/**
 * The on-device relay-E2EE vector runner (docs/relay-e2ee-protocol.md §16).
 *
 * The repository's conformance corpus runs under Node. Nothing in it proves the
 * pinned primitives behave on Hermes, which is the only engine the app ships:
 * §14.2's curve and AEAD implementations are BigInt- and typed-array-heavy,
 * §14.5's randomness is a polyfill, and §3.6's canonical CBOR needs a
 * `TextEncoder` React Native does not provide. This module is the Hermes-side
 * evidence for exactly those four things. See `apps/mobile/README.md` for the
 * physical-device procedure it belongs to.
 *
 * WHY A SUBSET, EMBEDDED. `packages/shared/fixtures/e2ee/v1` is 844 KB of JSON
 * and MUST NOT enter the bundle. The cases below are transcribed from it and
 * `e2eeVectorRunner.test.ts` proves, against the real corpus files, that every
 * transcribed byte still matches — so the subset cannot drift, and the corpus
 * stays out of the app.
 *
 * WHAT THE SUBSET COVERS, and why it is enough for a runtime check:
 *
 * - F15 `cacophony/Noise_IK_25519_ChaChaPoly_SHA256` — the published upstream
 *   Noise vector for the pattern the native tier runs (§8.1), and the only case
 *   in the corpus whose bytes this repository did not produce. Driving it at both
 *   roles exercises four X25519 DH operations, the whole HKDF-SHA256 chain, the
 *   ChaCha20-Poly1305 seal and open inside both handshake messages, and `Split()`.
 *   IK and not NX: the native tier is IK-only, and IK is the strictly larger of
 *   the two — four DH operations against NX's two, plus the encrypted-static step.
 * - F6 `ik-handshake-complete-trace`, §6.5 outputs onward — the §9.1 record path
 *   through `E2eeRecordSession`: real key schedule, real AAD, real nonces, a
 *   byte-exact envelope in each direction, an authenticated round trip back, and
 *   a rejected single-byte tamper. This also pins the §6.5 output ORDER, because
 *   the c2n envelope is produced under the first output and the n2c envelope
 *   under the second; swapping them fails here.
 * - F4 `valid-node-agreement-prekey-certificate` — the §7.3 transcript rebuilt
 *   here and checked by strict Ed25519 verification. A signature that verifies
 *   over a locally rebuilt transcript pins every byte of that canonical-CBOR
 *   encoding, which is why the 278-byte transcript itself is not transcribed.
 * - F13 `node-identity-key-fingerprint` — the §7.1 display form.
 *
 * NOT COVERED BY THE EMBEDDED SUBSET: P-256, NX, and §3.6 decode/re-encode.
 * The bounded development-only side-load below adds those cases without
 * bundling their families in production. F15 transport messages remain outside
 * this module: they would need a direct `@noble/ciphers` dependency, while F6
 * already pins the §6.5 outputs and their order.
 *
 * THIS SUBSET DOES NOT DISCHARGE §16.4, which requires the COMPLETE corpus to
 * pass on physical devices on both mobile platforms before the native client
 * ships E2EE support. That gate is open; `apps/mobile/README.md` records what it
 * still needs.
 */

import { E2EE_ENVELOPE_HEADER_BYTES } from "@ryco/shared/relayE2eeConstants";
import {
  E2EE_NODE_IDENTITY_ALGORITHM,
  deriveE2eeAgreementPublicKey,
  e2eeKeyFingerprint,
  formatE2eeKeyFingerprint,
  generateE2eeAgreementKeyPair,
  validateE2eeClientIdentityPublicKey,
  validateE2eeClientSignature,
  verifyE2eeSignature,
} from "@ryco/shared/relayE2eeKeys";
import {
  E2eeNoiseHandshake,
  E2EE_NOISE_PROTOCOL_NAME_IK,
  e2eeNoiseProtocolName,
} from "@ryco/shared/relayE2eeNoise";
import {
  E2eeRecordSession,
  e2eeSessionSecretsFromNoiseKeys,
  eraseE2eeSessionSecrets,
  type E2eeSessionSecrets,
} from "@ryco/shared/relayE2eeSession";
import {
  E2EE_NOISE_PATTERN_NX,
  E2EE_NOISE_PATTERN_IK,
  decodeCanonicalE2eeCbor,
  encodeNodeE2eePrekeyTranscript,
} from "@ryco/shared/relayE2eeTranscripts";
import {
  E2EE_DIRECTION_CLIENT_TO_NODE,
  E2EE_DIRECTION_NODE_TO_CLIENT,
  E2EE_INNER_TYPE_RPC,
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  e2eeEnvelopeAad,
  type E2eeDirection,
} from "@ryco/shared/relayE2eeWire";

import { e2eeGlobalProvenance } from "../../polyfills";
import { readMobileAppVariant } from "../platform/config";
import { assertE2eeRuntimeGlobals, type E2eeRuntimeHost } from "../platform/e2eeRuntime";

const HEX_DIGITS = "0123456789abcdef";

/**
 * Local hex codecs. The pinned primitives ship their own, but they are not a
 * dependency of this app — and `Buffer` is not a Hermes global — so the vector
 * data is decoded here rather than pulling either in.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 0x0f]!;
  return hex;
}

/** The shape of each transcribed family, widened so a test can perturb a copy. */
interface NoiseIkVector {
  readonly prologue: string;
  readonly initiatorStaticSecretKey: string;
  readonly initiatorEphemeralSecretKey: string;
  readonly initiatorRemoteStaticPublicKey: string;
  readonly responderStaticSecretKey: string;
  readonly responderEphemeralSecretKey: string;
  readonly handshakePayloads: readonly string[];
  readonly handshakeMessages: readonly string[];
  readonly handshakeHash: string;
}

interface RecordDirectionVector {
  readonly innerBody: string;
  readonly envelope: string;
  readonly aad: string;
}

interface RecordVector {
  readonly sessionBindingHash: string;
  readonly epochSecretC2N: string;
  readonly epochSecretN2C: string;
  readonly exporterSecret: string;
  readonly serverConfirmationKey: string;
  readonly clientToNode: RecordDirectionVector;
  readonly nodeToClient: RecordDirectionVector;
}

interface NodePrekeyVector {
  readonly hubOrigin: string;
  readonly nodeId: string;
  readonly identityKeyId: string;
  readonly prekeyId: string;
  readonly identityPublicKey: string;
  readonly agreementPublicKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly transcriptBytes: number;
  readonly identityFingerprint: string;
  readonly crossSignature: string;
}

interface NodeIdentityVector {
  readonly fingerprintDisplay: string;
  readonly agreementSecretKey: string;
}

/** Every transcribed value, as each check reads it. */
export interface E2eeVectorSet {
  readonly f15Ik: NoiseIkVector;
  readonly f6Ik: RecordVector;
  readonly f4NodePrekey: NodePrekeyVector;
  readonly f13NodeIdentity: NodeIdentityVector;
}

/**
 * TEST-ONLY MATERIAL (§16.1). Every secret below is published deterministic test
 * material transcribed from the checked-in corpus. It MUST NEVER reach a real
 * endpoint, and nothing outside this module may read it.
 *
 * Exported for two readers, and no others: the drift test, which reads the real
 * corpus files with `node:fs` — which neither this module nor anything else the
 * bundler sees may do — and compares them against these so the subset cannot
 * silently fall behind a regenerated corpus; and the negative cases, which pass
 * each check a perturbed copy.
 */
export const testOnlyEmbeddedVectors: E2eeVectorSet = {
  f15Ik: {
    prologue: "4a6f686e2047616c74",
    initiatorStaticSecretKey: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
    initiatorEphemeralSecretKey: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    initiatorRemoteStaticPublicKey:
      "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
    responderStaticSecretKey: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    responderEphemeralSecretKey: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    handshakePayloads: ["4c756477696720766f6e204d69736573", "4d757272617920526f746862617264"],
    handshakeMessages: [
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7",
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5",
    ],
    handshakeHash: "0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7",
  },
  f6Ik: {
    sessionBindingHash: "5f0ca343c437b1aa35e1a1c6eff4d2be244dde8dd384ff023559a2cee8c38a67",
    epochSecretC2N: "b89ee30677c2855a7b9e88f6d4e9f85b1a317007734895653baac3463b19204d",
    epochSecretN2C: "b1acc4b4ce50246a35b4075217acda93c68e4201eee1b5c307f1b2fec5adf290",
    exporterSecret: "3df08be20cc319578a156b636a3ae5d017a6622899a48847ae8d99d3b084f722",
    serverConfirmationKey: "46d17787aa5f5ec03d51247fe85c3f6178bd40272d76b19ce0fef8bba1c6738a",
    clientToNode: {
      innerBody: "7b225f746167223a227279636f2e7270632e70696e67227d",
      envelope:
        "01010100000000000000000000000078fe898e903e04ca8b3290545503de837a216f91ddad4f6adcb8b6ae1f2c456e4edca85e0ad5e7458b",
      aad: "0101010000000000000000000000005f0ca343c437b1aa35e1a1c6eff4d2be244dde8dd384ff023559a2cee8c38a6763326e",
    },
    nodeToClient: {
      innerBody: "7b225f746167223a227279636f2e7270632e706f6e67227d",
      envelope:
        "010101000000000000000000000000deae6ba8ca34d2bae3071723cf2bfc31780cfe3e37acb8811c1a82f236a76629825f8ff5c878cd3429",
      aad: "0101010000000000000000000000005f0ca343c437b1aa35e1a1c6eff4d2be244dde8dd384ff023559a2cee8c38a676e3263",
    },
  },
  f4NodePrekey: {
    hubOrigin: "https://hub.example.com",
    nodeId: "node_AAAAAAAAAAAAAAAAAAAAAA",
    identityKeyId: "nkey_BBBBBBBBBBBBBBBBBBBBBB",
    prekeyId: "epk_EEEEEEEEEEEEEEEEEEEEEE",
    identityPublicKey: "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
    agreementPublicKey: "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
    createdAt: 1_784_160_000_000,
    expiresAt: 1_786_752_000_000,
    transcriptBytes: 278,
    identityFingerprint: "0156cdedee6f84797b28b7be83048194483cc17165b1ae7afe7bbc77eedf9b64",
    crossSignature:
      "58f2c7365b5f5cfe1193fcbf194dfc34ff77e173eb622ecd187b7c5e3c38134de93dee609798456a770fa8efba8a02dd72119fe68ebbb3f365b091be3c716207",
  },
  f13NodeIdentity: {
    fingerprintDisplay: "SHA256:AVbN7e5vhHl7KLe-gwSBlEg8wXFlsa56_nu8d-7fm2Q",
    agreementSecretKey: "1111111111111111111111111111111111111111111111111111111111111111",
  },
};

/** The runner's own admission bound; not a vector value. Larger than any case. */
const RUNNER_PLAINTEXT_CEILING = 4_096;

/** One check's verdict. The name is a fixed label; no drawn or decrypted byte. */
export interface E2eeVectorCheck {
  readonly name: string;
  readonly ok: boolean;
}

export interface E2eeVectorSuiteResult {
  readonly ok: boolean;
  readonly checks: readonly E2eeVectorCheck[];
  /**
   * Which implementation each §14.5 global resolved to, as recorded when
   * `../../polyfills` installed them. It answers what THIS app's startup did on
   * this runtime, which is the question the device procedure exists to settle;
   * it is not a re-reading of `host`, which on a device is always `globalThis`.
   */
  readonly globals: typeof e2eeGlobalProvenance;
}

function equalHex(actual: Uint8Array, expected: string): boolean {
  return bytesToHex(actual) === expected;
}

/**
 * Drives one deterministic IK handshake at both roles, exactly as F15 pins it.
 *
 * Every check below takes the vector set it reads. On a device it is always the
 * transcribed one; a test perturbs a copy to prove each comparison here is the
 * thing that rejects, because a check that signals only by throwing is otherwise
 * indistinguishable from a check that was deleted.
 */
function checkNoiseIkVector(vectors: E2eeVectorSet = testOnlyEmbeddedVectors): void {
  const F15_IK = vectors.f15Ik;
  if (e2eeNoiseProtocolName(E2EE_NOISE_PATTERN_IK) !== E2EE_NOISE_PROTOCOL_NAME_IK) {
    throw new Error("protocol name");
  }
  const initiator = new E2eeNoiseHandshake({
    pattern: E2EE_NOISE_PATTERN_IK,
    role: "initiator",
    prologue: hexToBytes(F15_IK.prologue),
    staticSecretKey: hexToBytes(F15_IK.initiatorStaticSecretKey),
    remoteStaticPublicKey: hexToBytes(F15_IK.initiatorRemoteStaticPublicKey),
    testOnlyEphemeralSecretKey: hexToBytes(F15_IK.initiatorEphemeralSecretKey),
  });
  const responder = new E2eeNoiseHandshake({
    pattern: E2EE_NOISE_PATTERN_IK,
    role: "responder",
    prologue: hexToBytes(F15_IK.prologue),
    staticSecretKey: hexToBytes(F15_IK.responderStaticSecretKey),
    testOnlyEphemeralSecretKey: hexToBytes(F15_IK.responderEphemeralSecretKey),
  });

  // Each role reads the VECTOR's bytes rather than the ones just written, so a
  // writer defect cannot mask a reader defect.
  const message1 = initiator.writeMessage(hexToBytes(F15_IK.handshakePayloads[0]!));
  if (!equalHex(message1, F15_IK.handshakeMessages[0]!)) throw new Error("message 1");
  const read1 = responder.readMessage(hexToBytes(F15_IK.handshakeMessages[0]!));
  if (!equalHex(read1, F15_IK.handshakePayloads[0]!)) throw new Error("payload 1");

  const message2 = responder.writeMessage(hexToBytes(F15_IK.handshakePayloads[1]!));
  if (!equalHex(message2, F15_IK.handshakeMessages[1]!)) throw new Error("message 2");
  const read2 = initiator.readMessage(hexToBytes(F15_IK.handshakeMessages[1]!));
  if (!equalHex(read2, F15_IK.handshakePayloads[1]!)) throw new Error("payload 2");

  const handshakeHash = initiator.testOnlyHandshakeHash;
  if (handshakeHash === undefined || !equalHex(handshakeHash, F15_IK.handshakeHash)) {
    throw new Error("handshake hash");
  }

  // The two roles agreeing on all three §6.5 outputs is what makes the four DH
  // operations above meaningful; the upstream set publishes no split keys of its
  // own, and the F6 case below is what pins their order.
  const initiatorKeys = initiator.split();
  const responderKeys = responder.split();
  try {
    if (bytesToHex(initiatorKeys.epochSecretC2N) !== bytesToHex(responderKeys.epochSecretC2N)) {
      throw new Error("split c2n");
    }
    if (bytesToHex(initiatorKeys.epochSecretN2C) !== bytesToHex(responderKeys.epochSecretN2C)) {
      throw new Error("split n2c");
    }
    if (bytesToHex(initiatorKeys.exporterSecret) !== bytesToHex(responderKeys.exporterSecret)) {
      throw new Error("split exporter");
    }
  } finally {
    for (const keys of [initiatorKeys, responderKeys]) {
      keys.epochSecretC2N.fill(0);
      keys.epochSecretN2C.fill(0);
      keys.exporterSecret.fill(0);
    }
  }
}

/** A fresh §6.5 bundle each call: the consumer takes ownership of the buffers. */
function f6SessionSecrets(vector: RecordVector): E2eeSessionSecrets {
  return e2eeSessionSecretsFromNoiseKeys({
    epochSecretC2N: hexToBytes(vector.epochSecretC2N),
    epochSecretN2C: hexToBytes(vector.epochSecretN2C),
    exporterSecret: hexToBytes(vector.exporterSecret),
  });
}

function recordSession(vector: RecordVector, sendDirection: E2eeDirection): E2eeRecordSession {
  return new E2eeRecordSession({
    secrets: f6SessionSecrets(vector),
    suite: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
    sessionBindingHash: hexToBytes(vector.sessionBindingHash),
    sendDirection,
    plaintextCeiling: RUNNER_PLAINTEXT_CEILING,
  });
}

/** §9.1 protect and unprotect, in both directions, against the F6 envelopes. */
async function checkRecordProtection(
  vectors: E2eeVectorSet = testOnlyEmbeddedVectors,
): Promise<void> {
  const F6_IK = vectors.f6Ik;
  const secrets = f6SessionSecrets(F6_IK);
  try {
    if (!equalHex(secrets.serverConfirmationKey, F6_IK.serverConfirmationKey)) {
      throw new Error("confirmation key");
    }
  } finally {
    eraseE2eeSessionSecrets(secrets);
  }

  for (const [sendDirection, vector] of [
    [E2EE_DIRECTION_CLIENT_TO_NODE, F6_IK.clientToNode],
    [E2EE_DIRECTION_NODE_TO_CLIENT, F6_IK.nodeToClient],
  ] as const) {
    const receiveDirection =
      sendDirection === E2EE_DIRECTION_CLIENT_TO_NODE
        ? E2EE_DIRECTION_NODE_TO_CLIENT
        : E2EE_DIRECTION_CLIENT_TO_NODE;
    const sender = recordSession(F6_IK, sendDirection);
    const receiver = recordSession(F6_IK, receiveDirection);
    // A fresh receiver for the tamper case: `receiver` has already consumed
    // counter 0, so it would refuse a replay as a sequence mismatch instead.
    const tamperReceiver = recordSession(F6_IK, receiveDirection);
    try {
      let envelope: Uint8Array | undefined;
      const protectResult = await sender.protect({
        innerType: E2EE_INNER_TYPE_RPC,
        body: hexToBytes(vector.innerBody),
        admit: () => true,
        transmit: (bytes) => {
          envelope = bytes;
          return { kind: "sent" };
        },
      });
      if (protectResult.kind !== "protected") throw new Error("protect");
      if (envelope === undefined || !equalHex(envelope, vector.envelope)) {
        throw new Error("envelope");
      }
      const aad = e2eeEnvelopeAad({
        header: envelope.subarray(0, E2EE_ENVELOPE_HEADER_BYTES),
        sessionBindingHash: hexToBytes(F6_IK.sessionBindingHash),
        direction: sendDirection,
      });
      if (!equalHex(aad, vector.aad)) throw new Error("aad");

      // §9.5: the decrypted plaintext belongs to the caller from here on.
      const received = receiver.unprotect(hexToBytes(vector.envelope));
      if (received.kind !== "authenticated") throw new Error("unprotect");
      const plaintextMatches = equalHex(received.body, vector.innerBody);
      received.body.fill(0);
      if (!plaintextMatches) throw new Error("plaintext");

      // §9.2 Q3: one flipped ciphertext byte is a fatal authentication failure,
      // not a silently accepted record.
      const tampered = hexToBytes(vector.envelope);
      tampered[E2EE_ENVELOPE_HEADER_BYTES] = tampered[E2EE_ENVELOPE_HEADER_BYTES]! ^ 0x01;
      const tamperedResult = tamperReceiver.unprotect(tampered);
      if (tamperedResult.kind !== "fatal" || tamperedResult.reason !== "authentication_failed") {
        throw new Error("tamper");
      }
    } finally {
      sender.erase();
      receiver.erase();
      tamperReceiver.erase();
    }
  }
}

/** §7.3 transcript encoding and §7.1 strict Ed25519 verification. */
function checkNodePrekeyCertificate(vectors: E2eeVectorSet = testOnlyEmbeddedVectors): void {
  const F4_NODE_PREKEY = vectors.f4NodePrekey;
  const F13_NODE_IDENTITY = vectors.f13NodeIdentity;
  const identityPublicKey = hexToBytes(F4_NODE_PREKEY.identityPublicKey);
  const transcript = encodeNodeE2eePrekeyTranscript({
    hubOrigin: F4_NODE_PREKEY.hubOrigin,
    nodeId: F4_NODE_PREKEY.nodeId,
    identityKeyId: F4_NODE_PREKEY.identityKeyId,
    prekeyId: F4_NODE_PREKEY.prekeyId,
    identityPublicKey,
    agreementPublicKey: hexToBytes(F4_NODE_PREKEY.agreementPublicKey),
    createdAt: F4_NODE_PREKEY.createdAt,
    expiresAt: F4_NODE_PREKEY.expiresAt,
  });
  if (transcript.byteLength !== F4_NODE_PREKEY.transcriptBytes) throw new Error("transcript size");
  if (
    !equalHex(
      e2eeKeyFingerprint("node-identity", identityPublicKey),
      F4_NODE_PREKEY.identityFingerprint,
    )
  ) {
    throw new Error("fingerprint");
  }
  if (
    formatE2eeKeyFingerprint(e2eeKeyFingerprint("node-identity", identityPublicKey)) !==
    F13_NODE_IDENTITY.fingerprintDisplay
  ) {
    throw new Error("fingerprint display");
  }

  // The signature verifies over the transcript REBUILT above, so this pins every
  // byte of the §3.6 canonical encoding — including the UTF-8 `tstr` elements.
  const signature = hexToBytes(F4_NODE_PREKEY.crossSignature);
  if (
    !verifyE2eeSignature({
      algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
      publicKey: identityPublicKey,
      message: transcript,
      signature,
    })
  ) {
    throw new Error("verify");
  }
  const forged = hexToBytes(F4_NODE_PREKEY.crossSignature);
  forged[0] = forged[0]! ^ 0x01;
  if (
    verifyE2eeSignature({
      algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
      publicKey: identityPublicKey,
      message: transcript,
      signature: forged,
    })
  ) {
    throw new Error("forgery accepted");
  }
}

/** §6.2 keygen off the live §14.5 CSPRNG, plus the pinned base-point derivation. */
function checkAgreementKeygen(vectors: E2eeVectorSet = testOnlyEmbeddedVectors): void {
  const F4_NODE_PREKEY = vectors.f4NodePrekey;
  const F13_NODE_IDENTITY = vectors.f13NodeIdentity;
  if (
    !equalHex(
      deriveE2eeAgreementPublicKey(hexToBytes(F13_NODE_IDENTITY.agreementSecretKey)),
      F4_NODE_PREKEY.agreementPublicKey,
    )
  ) {
    throw new Error("derivation");
  }

  const first = generateE2eeAgreementKeyPair();
  const second = generateE2eeAgreementKeyPair();
  try {
    if (bytesToHex(deriveE2eeAgreementPublicKey(first.secretKey)) !== bytesToHex(first.publicKey)) {
      throw new Error("keypair");
    }
    // Two draws from a working CSPRNG collide with negligible probability; two
    // draws from a stubbed-out one are identical.
    if (bytesToHex(first.secretKey) === bytesToHex(second.secretKey)) {
      throw new Error("repeated draw");
    }
  } finally {
    first.secretKey.fill(0);
    second.secretKey.fill(0);
  }
}

/**
 * The individual checks, for the negative cases the suite cannot drive from
 * outside. Nothing on a device calls these; `runE2eeVectorSuite` is the entry.
 */
export const testOnlyChecks = {
  noiseIk: checkNoiseIkVector,
  recordProtection: checkRecordProtection,
  nodePrekeyCertificate: checkNodePrekeyCertificate,
  agreementKeygen: checkAgreementKeygen,
};

/** The §14.5 preflight, which gates every vector case below it. */
const E2EE_RUNTIME_GLOBALS_CASE = "runtime globals (§14.5)";

/**
 * The vector cases, each bound to the runner that produces its verdict — one
 * table rather than two positional arrays, so a name cannot drift onto another
 * case's check and mislabel the failure an operator is told to capture.
 */
const E2EE_VECTOR_CASES: readonly (readonly [string, () => void | Promise<void>])[] = [
  ["F15 Noise IK vector (§14.1)", checkNoiseIkVector],
  ["F6 record protection (§9.1)", checkRecordProtection],
  ["F4 node prekey certificate (§7.3)", checkNodePrekeyCertificate],
  ["X25519 agreement keygen (§6.2)", checkAgreementKeygen],
];

/** The cases, in the order the on-device report prints them. */
export const E2EE_VECTOR_SUITE_CASES: readonly string[] = [
  E2EE_RUNTIME_GLOBALS_CASE,
  ...E2EE_VECTOR_CASES.map(([name]) => name),
];

/**
 * Run the whole subset and report a bounded verdict per case.
 *
 * Never throws and never reports a byte: a failing case yields its fixed name
 * and `ok: false`, because the values that would explain it are key material.
 * `host` exists so a test can present a runtime without the §14.5 globals; on a
 * device it is always the real one.
 *
 * FAIL-CLOSED (§14.5). This runner is a caller like any other, so a refused
 * preflight refuses the rest: every later case is reported `false` UNRUN — no
 * handshake and no key generation on a source the preflight has condemned —
 * rather than run against it and reported green.
 */
export async function runE2eeVectorSuite(
  host: E2eeRuntimeHost = globalThis,
): Promise<E2eeVectorSuiteResult> {
  let runtimeOk = true;
  try {
    assertE2eeRuntimeGlobals(host);
  } catch {
    runtimeOk = false;
  }
  const checks: E2eeVectorCheck[] = [{ name: E2EE_RUNTIME_GLOBALS_CASE, ok: runtimeOk }];
  for (const [name, run] of E2EE_VECTOR_CASES) {
    let ok = runtimeOk;
    if (runtimeOk) {
      try {
        await run();
      } catch {
        ok = false;
      }
    }
    checks.push({ name, ok });
  }
  return { ok: checks.every((check) => check.ok), checks, globals: e2eeGlobalProvenance };
}

// ─── complete-corpus development side-load ──────────────────────────────────

const SIDELOAD_LIMITS = {
  totalJsonBytes: 2 * 1_024 * 1_024,
  familyJsonBytes: 256 * 1_024,
  families: 32,
  casesPerFamily: 64,
  totalCases: 512,
  fixtureIdUtf8Bytes: 128,
  ordinaryDecodedBytes: 16 * 1_024,
  recipePayloadBytes: 4_194_304,
} as const;
const MOBILE_SIDELOAD_RUNNER = "mobile-dev-sideload";
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const FAMILY_FILE = /^f\d{2}-[a-z0-9-]+\.json$/u;

export interface E2eeSideloadFamily {
  readonly file: string;
  /** Raw UTF-8 JSON. Its digest is over these exact bytes, before parsing. */
  readonly json: string;
}

export interface E2eeSideloadInput {
  /** Raw manifest JSON and its independently transported SHA-256. */
  readonly manifestJson: string;
  readonly manifestSha256: string;
  /** Only selected family payloads. The corpus is never imported by the app. */
  readonly families: readonly E2eeSideloadFamily[];
  /** Exact portable routes the caller asks this device to execute. */
  readonly fixtureIds: readonly string[];
}

export interface E2eeSideloadResult {
  readonly fixtureId: string;
  readonly ok: boolean;
}

export interface E2eeSideloadDependencies {
  readonly sha256: (bytes: Uint8Array) => Promise<Uint8Array>;
}

interface SideloadCase {
  readonly name: string;
  readonly inputs: Record<string, unknown>;
  readonly expected: Record<string, unknown>;
}

interface SideloadFamilyDocument {
  readonly testKeyMaterial: Record<string, unknown>;
  readonly cases: readonly SideloadCase[];
}

interface SideloadRoute {
  readonly fixtureId: string;
  readonly file: string;
  readonly caseName: string;
}

class InvalidE2eeSideloadError extends Error {
  constructor() {
    super("Invalid E2EE fixture side-load.");
    this.name = "InvalidE2eeSideloadError";
  }
}

function invalidSideload(): never {
  throw new InvalidE2eeSideloadError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidSideload();
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") invalidSideload();
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidSideload();
  return value;
}

function bytesValue(value: unknown): Uint8Array {
  const wrapper = record(value);
  if (Object.keys(wrapper).length !== 1) invalidSideload();
  const hex = stringValue(wrapper.$bytes);
  if (!/^(?:[0-9a-f]{2})*$/u.test(hex)) invalidSideload();
  if (hex.length / 2 > SIDELOAD_LIMITS.ordinaryDecodedBytes) invalidSideload();
  return hexToBytes(hex);
}

function exactBytes(actual: Uint8Array, expected: unknown): boolean {
  return bytesToHex(actual) === bytesToHex(bytesValue(expected));
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function equalDigest(actual: Uint8Array, expected: string): boolean {
  return SHA256_HEX.test(expected) && bytesToHex(actual) === expected;
}

function validateFixtureValues(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) validateFixtureValues(entry);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const object = value as Record<string, unknown>;
  // No mobile-routed v1 case uses a recipe. F1's reference-only maximum-boundary
  // recipe is deliberately rejected here; a future mobile recipe route must add
  // an exact shared schema and executor before admission.
  if (Object.hasOwn(object, "$recipe")) invalidSideload();
  if (Object.hasOwn(object, "$bytes")) {
    bytesValue(object);
    return;
  }
  for (const child of Object.values(object)) validateFixtureValues(child);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalidSideload();
  }
}

function parseFamily(value: unknown): SideloadFamilyDocument {
  const document = record(value);
  const cases = document.cases;
  if (!Array.isArray(cases) || cases.length > SIDELOAD_LIMITS.casesPerFamily) invalidSideload();
  const names = new Set<string>();
  const parsedCases = cases.map((candidate): SideloadCase => {
    const entry = record(candidate);
    const name = stringValue(entry.name);
    if (names.has(name)) invalidSideload();
    names.add(name);
    return { name, inputs: record(entry.inputs), expected: record(entry.expected) };
  });
  const material = document.testKeyMaterial;
  return {
    testKeyMaterial: material === undefined ? {} : record(material),
    cases: parsedCases,
  };
}

async function defaultSideloadSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const crypto = await import("expo-crypto");
  return new Uint8Array(
    await crypto.digest(crypto.CryptoDigestAlgorithm.SHA256, bytes as unknown as BufferSource),
  );
}

const DEFAULT_SIDELOAD_DEPENDENCIES: E2eeSideloadDependencies = {
  sha256: defaultSideloadSha256,
};

function checkManifestLimits(limits: Record<string, unknown>): void {
  for (const [key, expected] of Object.entries(SIDELOAD_LIMITS)) {
    if (limits[key] !== expected) invalidSideload();
  }
}

function parseRoutes(portable: Record<string, unknown>): Map<string, SideloadRoute> {
  if (portable.version !== 1) invalidSideload();
  checkManifestLimits(record(portable.limits));
  if (!Array.isArray(portable.routes)) invalidSideload();
  const routes = new Map<string, SideloadRoute>();
  for (const candidate of portable.routes) {
    const route = record(candidate);
    const fixtureId = stringValue(route.fixtureId);
    const file = stringValue(route.file);
    const caseName = stringValue(route.case);
    const runners = route.runners;
    if (!Array.isArray(runners) || !runners.every((runner) => typeof runner === "string")) {
      invalidSideload();
    }
    if (!runners.includes(MOBILE_SIDELOAD_RUNNER)) continue;
    if (routes.has(fixtureId)) invalidSideload();
    routes.set(fixtureId, { fixtureId, file, caseName });
  }
  return routes;
}

function eraseNoiseKeys(keys: {
  readonly epochSecretC2N: Uint8Array;
  readonly epochSecretN2C: Uint8Array;
  readonly exporterSecret: Uint8Array;
}): void {
  keys.epochSecretC2N.fill(0);
  keys.epochSecretN2C.fill(0);
  keys.exporterSecret.fill(0);
}

function runSideloadedNoise(
  pattern: typeof E2EE_NOISE_PATTERN_IK | typeof E2EE_NOISE_PATTERN_NX,
  family: SideloadFamilyDocument,
  entry: SideloadCase,
): void {
  const material = family.testKeyMaterial;
  const expected = entry.expected;
  const initiator = new E2eeNoiseHandshake({
    pattern,
    role: "initiator",
    prologue: bytesValue(expected.prologue),
    ...(pattern === E2EE_NOISE_PATTERN_IK
      ? {
          staticSecretKey: bytesValue(material.testOnlyClientAgreementSecretKey),
          remoteStaticPublicKey: bytesValue(material.nodeAgreementPublicKey),
        }
      : {}),
    testOnlyEphemeralSecretKey: bytesValue(material.testOnlyClientEphemeralSecretKey),
  });
  const responder = new E2eeNoiseHandshake({
    pattern,
    role: "responder",
    prologue: bytesValue(expected.prologue),
    staticSecretKey: bytesValue(material.testOnlyNodeAgreementSecretKey),
    testOnlyEphemeralSecretKey: bytesValue(material.testOnlyNodeEphemeralSecretKey),
  });
  const payload1 = bytesValue(expected.message1PayloadPlaintext);
  const payload2 = bytesValue(expected.message2PayloadPlaintext);
  const message1 = initiator.writeMessage(payload1);
  if (!exactBytes(message1, expected.noiseMessage1)) invalidSideload();
  if (
    !exactBytes(
      responder.readMessage(bytesValue(expected.noiseMessage1)),
      expected.message1PayloadPlaintext,
    )
  ) {
    invalidSideload();
  }
  const message2 = responder.writeMessage(payload2);
  if (!exactBytes(message2, expected.noiseMessage2)) invalidSideload();
  if (
    !exactBytes(
      initiator.readMessage(bytesValue(expected.noiseMessage2)),
      expected.message2PayloadPlaintext,
    )
  ) {
    invalidSideload();
  }
  const handshakeHash = initiator.testOnlyHandshakeHash;
  if (handshakeHash === undefined || !exactBytes(handshakeHash, expected.noiseHandshakeHash)) {
    invalidSideload();
  }
  const initiatorKeys = initiator.split();
  const responderKeys = responder.split();
  try {
    for (const [key, expectedKey] of [
      ["epochSecretC2N", expected.epochSecretC2N],
      ["epochSecretN2C", expected.epochSecretN2C],
      ["exporterSecret", expected.exporterSecret],
    ] as const) {
      if (!exactBytes(initiatorKeys[key], expectedKey)) invalidSideload();
      if (bytesToHex(initiatorKeys[key]) !== bytesToHex(responderKeys[key])) invalidSideload();
    }
  } finally {
    eraseNoiseKeys(initiatorKeys);
    eraseNoiseKeys(responderKeys);
  }
}

function runSideloadedNodePrekey(entry: SideloadCase): void {
  const inputs = entry.inputs;
  const expected = entry.expected;
  const identityPublicKey = bytesValue(inputs.identityPublicKey);
  const transcript = encodeNodeE2eePrekeyTranscript({
    hubOrigin: stringValue(inputs.hubOrigin),
    nodeId: stringValue(inputs.nodeId),
    identityKeyId: stringValue(inputs.identityKeyId),
    prekeyId: stringValue(inputs.prekeyId),
    identityPublicKey,
    agreementPublicKey: bytesValue(inputs.agreementPublicKey),
    createdAt: numberValue(inputs.createdAt),
    expiresAt: numberValue(inputs.expiresAt),
  });
  if (!exactBytes(transcript, expected.transcript)) invalidSideload();
  if (transcript.byteLength !== numberValue(expected.transcriptBytes)) invalidSideload();
  if (
    !exactBytes(
      e2eeKeyFingerprint("node-identity", identityPublicKey),
      expected.identityFingerprint,
    )
  ) {
    invalidSideload();
  }
  if (
    !verifyE2eeSignature({
      algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
      publicKey: identityPublicKey,
      message: transcript,
      signature: bytesValue(expected.crossSignature),
    }) ||
    expected.crossSignatureReconstructionVerifies !== true
  ) {
    invalidSideload();
  }
}

function runSideloadedF4Decode(entry: SideloadCase): void {
  const decoded = decodeCanonicalE2eeCbor(bytesValue(entry.inputs.transcript));
  if (entry.name === "client-certificate-wrong-element-count") {
    if (decoded.kind !== "ok" || !Array.isArray(decoded.value) || decoded.value.length === 11) {
      invalidSideload();
    }
    return;
  }
  const declared = record(entry.inputs.canonicalDecode);
  if (decoded.kind !== "error" || declared.kind !== "error" || decoded.reason !== declared.reason) {
    invalidSideload();
  }
}

function accepts(run: () => void): boolean {
  try {
    run();
    return true;
  } catch {
    return false;
  }
}

function runSideloadedP256(entry: SideloadCase): void {
  if (entry.name.startsWith("p256-public-key-")) {
    const accepted = accepts(() => {
      validateE2eeClientIdentityPublicKey(bytesValue(entry.inputs.publicKey));
    });
    const declared =
      entry.expected.validationAccepted === true ||
      record(entry.expected.validation).rejected === false;
    if (accepted !== declared) invalidSideload();
    return;
  }
  if (entry.name.startsWith("p256-signature-")) {
    const accepted = accepts(() => {
      validateE2eeClientSignature(bytesValue(entry.inputs.signature));
    });
    if (accepted || record(entry.expected.encodingValidation).rejected !== true) invalidSideload();
    return;
  }
  invalidSideload();
}

function executeSideloadedCase(
  route: SideloadRoute,
  family: SideloadFamilyDocument,
  entry: SideloadCase,
): void {
  if (route.file === "f06-ik-handshake.json" && entry.name === "ik-handshake-complete-trace") {
    runSideloadedNoise(E2EE_NOISE_PATTERN_IK, family, entry);
    return;
  }
  if (route.file === "f07-nx-handshake.json" && entry.name === "nx-handshake-complete-trace") {
    runSideloadedNoise(E2EE_NOISE_PATTERN_NX, family, entry);
    return;
  }
  if (route.file === "f04-prekey-certificates.json") {
    if (entry.name === "valid-node-agreement-prekey-certificate") runSideloadedNodePrekey(entry);
    else runSideloadedF4Decode(entry);
    return;
  }
  if (route.file === "f17-key-material-validation.json") {
    runSideloadedP256(entry);
    return;
  }
  // A manifest route is authorization to run a case, not an implementation of
  // its oracle. Unsupported routes produce a bounded false verdict.
  invalidSideload();
}

/**
 * Execute caller-supplied portable vectors without ever bundling the corpus.
 *
 * Admission failures reject with one stable, data-free error. Once admitted,
 * each case yields only its already-bounded fixture id and a boolean; caught
 * primitive errors, payloads, keys, hashes, and stack details never cross this
 * boundary.
 */
export async function runSideloadedE2eeVectors(
  input: E2eeSideloadInput,
  dependencies: E2eeSideloadDependencies = DEFAULT_SIDELOAD_DEPENDENCIES,
): Promise<readonly E2eeSideloadResult[]> {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.manifestJson !== "string" ||
    typeof input.manifestSha256 !== "string" ||
    !Array.isArray(input.families) ||
    !Array.isArray(input.fixtureIds) ||
    input.families.length > SIDELOAD_LIMITS.families ||
    input.fixtureIds.length > SIDELOAD_LIMITS.totalCases
  ) {
    invalidSideload();
  }
  const manifestBytes = utf8Bytes(input.manifestJson);
  const familyByteLengths = input.families.map((family) => {
    if (typeof family !== "object" || family === null || typeof family.json !== "string") {
      return invalidSideload();
    }
    return utf8Bytes(family.json).byteLength;
  });
  if (
    manifestBytes.byteLength + familyByteLengths.reduce((total, size) => total + size, 0) >
      SIDELOAD_LIMITS.totalJsonBytes ||
    familyByteLengths.some((size) => size > SIDELOAD_LIMITS.familyJsonBytes)
  ) {
    invalidSideload();
  }
  if (!equalDigest(await dependencies.sha256(manifestBytes), input.manifestSha256)) {
    invalidSideload();
  }

  const manifest = record(parseJson(input.manifestJson));
  if (manifest.formatVersion !== 1) invalidSideload();
  const files = record(manifest.files);
  const routes = parseRoutes(record(manifest.portableExecution));
  const loaded = new Map<string, SideloadFamilyDocument>();
  let totalCases = 0;
  for (const supplied of input.families) {
    if (
      typeof supplied.file !== "string" ||
      !FAMILY_FILE.test(supplied.file) ||
      loaded.has(supplied.file)
    ) {
      invalidSideload();
    }
    const fileEntry = record(files[supplied.file]);
    const digest = stringValue(fileEntry.sha256);
    if (!equalDigest(await dependencies.sha256(utf8Bytes(supplied.json)), digest))
      invalidSideload();
    const parsedJson = parseJson(supplied.json);
    validateFixtureValues(parsedJson);
    const family = parseFamily(parsedJson);
    if (fileEntry.cases !== family.cases.length) invalidSideload();
    totalCases += family.cases.length;
    if (totalCases > SIDELOAD_LIMITS.totalCases) invalidSideload();
    loaded.set(supplied.file, family);
  }

  const seenFixtureIds = new Set<string>();
  const selected: { route: SideloadRoute; family: SideloadFamilyDocument; entry: SideloadCase }[] =
    [];
  for (const fixtureId of input.fixtureIds) {
    if (
      typeof fixtureId !== "string" ||
      utf8Bytes(fixtureId).byteLength > SIDELOAD_LIMITS.fixtureIdUtf8Bytes ||
      seenFixtureIds.has(fixtureId)
    ) {
      invalidSideload();
    }
    seenFixtureIds.add(fixtureId);
    const route = routes.get(fixtureId);
    if (route === undefined || route.fixtureId !== fixtureId) invalidSideload();
    const family = loaded.get(route.file);
    const entry = family?.cases.find((candidate) => candidate.name === route.caseName);
    if (family === undefined || entry === undefined) invalidSideload();
    selected.push({ route, family, entry });
  }

  return selected.map(({ route, family, entry }) => {
    let ok = true;
    try {
      executeSideloadedCase(route, family, entry);
    } catch {
      ok = false;
    }
    return { fixtureId: route.fixtureId, ok };
  });
}

/** The dev-build global the README's device procedure invokes. */
export const E2EE_VECTOR_RUNNER_GLOBAL = "__rycoRunE2eeVectors";
/** The caller-supplied corpus runner; installed under the same two dev gates. */
export const E2EE_SIDELOAD_RUNNER_GLOBAL = "__rycoRunSideloadedE2eeVectors";

/**
 * Expose the runner to the development client's JS console.
 *
 * Two gates, and both are load-bearing. `index.ts` requires this module only
 * inside `if (__DEV__)`, which Metro constant-folds away before it collects
 * dependencies, so a release bundle contains neither the hook nor this file.
 * The variant check is the same `APP_VARIANT` -> `extra.appVariant` chain
 * `app.config.ts` stamps, so a `preview` or `production` JS bundle that somehow
 * did reach here still installs nothing.
 */
export function installE2eeVectorRunnerDevHook(host: Record<string, unknown> = globalThis): void {
  if (readMobileAppVariant() !== "development") return;
  Object.defineProperty(host, E2EE_VECTOR_RUNNER_GLOBAL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: runE2eeVectorSuite,
  });
  Object.defineProperty(host, E2EE_SIDELOAD_RUNNER_GLOBAL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: runSideloadedE2eeVectors,
  });
}
