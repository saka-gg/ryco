import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  RELAY_INITIAL_LIMITS,
  RelayLimits,
  type RelayChannelId,
  type RelayFrame,
} from "@ryco/contracts";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import {
  e2eeChannelSizeBudget,
  e2eeNegotiationBufferMaxBytes,
  E2EE_HANDSHAKE_REJECT_BYTES,
  RPC_KEEPALIVE_INTERVAL,
  T_ADV,
  T_HANDSHAKE,
  T_KEEPALIVE_FLUSH_MARGIN,
  T_TRUST_COMMIT,
} from "@ryco/shared/relayE2eeConstants";
import {
  decodeE2eeClientHello,
  E2eeClientHandshake,
  E2eeNodeHandshake,
  type E2eeAdvertisedChannelMaterial,
  type E2eeClientAuthorization,
  type E2eeClientHandshakeCredentials,
  type E2eeHandshakeChannel,
} from "@ryco/shared/relayE2eeHandshake";
import type { NodeE2eeCapabilityVerification } from "@ryco/shared/relayE2eeCapabilityVerify";
import { e2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import {
  E2eeRecordSession,
  eraseE2eeSessionSecrets,
  type E2eeSessionSecrets,
} from "@ryco/shared/relayE2eeSession";
import { deriveE2eeWebSas } from "@ryco/shared/relayE2eeVerificationDisplay";
import {
  e2eeAuthorizationContextCommitment,
  encodeCanonicalE2eeCbor,
  encodeClientE2eePrekeyTranscript,
  encodeE2eeAuthorizationContext,
  encodeNodeE2eeCapabilitySigningEnvelope,
  encodeNodeE2eeCapabilityTranscript,
  encodeNodeE2eePrekeyTranscript,
  encodeNodeIdentityContinuityTranscript,
  type NodeE2eeCapabilityTranscriptInput,
} from "@ryco/shared/relayE2eeTranscripts";
import {
  E2EE_INNER_TYPE_RPC,
  E2EE_NEGOTIATION_TYPE_CLIENT_HELLO,
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  encodeE2eeCapabilityCarrier,
  encodeE2eeHandshakeReject,
  encodeE2eeNegotiationRecord,
} from "@ryco/shared/relayE2eeWire";
import { RELAY_CHUNK_CAPABILITY_PRELUDE } from "@ryco/shared/relayMessageChunks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { encodeBase64Url } from "./base64url.ts";
import {
  makeRelayE2eeInitiator,
  type RelayE2eeInitiator,
  type RelayE2eeInitiatorAttempt,
} from "./relayE2eeInitiator.ts";
import {
  HostedRelayEngine,
  RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE,
  RELAY_MESSAGE_TOO_LARGE_MESSAGE,
  RELAY_PEER_UNSUPPORTED_MESSAGE,
  type HostedRelaySocketCallbacks,
  type RelaySocket,
  type RelayTimers,
} from "./relayEngine.ts";

// §4.4 rows K1–K24 on the REAL relay path — the client mode machine wired into
// `HostedRelayEngine`, driven by a synthetic node that puts its §5.3 carrier at
// node-to-client data sequence 0 and answers with a real §8.6 responder.
//
// Every assertion about what did or did not reach the wire is made against the
// SOCKET'S FRAME LOG rather than against the engine's or the machine's internal
// state: §4.4's send-buffering rule is a statement about bytes on the relay, and
// a test that read the buffer instead would pass on an implementation that
// emptied it into the socket.

// ─── §16.1-style TEST-ONLY material ──────────────────────────────────────────
//
// The node identity seed, node identifiers, and timestamps are the ones
// `relayE2eeCapabilityVerify.test.ts` and `relayE2eeHandshake.test.ts` pin; the
// X25519 keys are the RFC 7748 §6.1 vectors and the P-256 identity key is the
// RFC 6979 A.2.5 vector. NONE OF IT MAY EVER REACH A REAL ENDPOINT.

const bytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const NODE_SEED = bytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const NODE_IDENTITY_PUBLIC = ed25519.getPublicKey(NODE_SEED);
const NODE_AGREEMENT_SECRET = bytes(
  "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
);
const NODE_AGREEMENT_PUBLIC = bytes(
  "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
);
const CLIENT_AGREEMENT_SECRET = bytes(
  "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
);
const CLIENT_AGREEMENT_PUBLIC = bytes(
  "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
);
const CLIENT_IDENTITY_SECRET = bytes(
  "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721",
);
const CLIENT_IDENTITY_PUBLIC = bytes(
  "04" +
    "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6" +
    "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299",
);

const HUB_ORIGIN = "https://hub.example.com";
const NODE_ID = "node_AAAAAAAAAAAAAAAAAAAAAA";
const IDENTITY_KEY_ID = "nkey_BBBBBBBBBBBBBBBBBBBBBB";
const PREKEY_ID = "epk_EEEEEEEEEEEEEEEEEEEEEE";
const CONTINUITY_ID = "nct_FFFFFFFFFFFFFFFFFFFFFF";
const ACCOUNT_ID = "acct_0123456789";
const CHANNEL_ID = "ch_cccccccccccccccccccccc" as RelayChannelId;
const CREATED_AT = 1_784_160_000_000;
const KEY_EXPIRES_AT = 1_786_752_000_000;
const ISSUED_AT = 1_784_160_030_000;
const STATEMENT_EXPIRES_AT = 1_784_160_630_000;
const NOW = 1_784_160_030_000;

const NODE_IDENTITY_FINGERPRINT = e2eeKeyFingerprint("node-identity", NODE_IDENTITY_PUBLIC);
const VERSION = { protocolMajor: 1, protocolMinor: 2 } as const;
const OPEN = 1;

const CLIENT_PREKEY_TRANSCRIPT = encodeClientE2eePrekeyTranscript({
  hubOrigin: HUB_ORIGIN,
  accountId: ACCOUNT_ID,
  identityPublicKey: CLIENT_IDENTITY_PUBLIC,
  agreementPublicKey: CLIENT_AGREEMENT_PUBLIC,
  createdAt: CREATED_AT,
  expiresAt: KEY_EXPIRES_AT,
});
const CLIENT_PREKEY_SIGNATURE = p256.sign(
  sha256(CLIENT_PREKEY_TRANSCRIPT),
  CLIENT_IDENTITY_SECRET,
  {
    prehash: false,
    lowS: false,
    format: "compact",
  },
);

const NODE_PREKEY_CROSS_SIGNATURE = ed25519.sign(
  encodeNodeE2eePrekeyTranscript({
    hubOrigin: HUB_ORIGIN,
    nodeId: NODE_ID,
    identityKeyId: IDENTITY_KEY_ID,
    prekeyId: PREKEY_ID,
    identityPublicKey: NODE_IDENTITY_PUBLIC,
    agreementPublicKey: NODE_AGREEMENT_PUBLIC,
    createdAt: CREATED_AT,
    expiresAt: KEY_EXPIRES_AT,
  }),
  NODE_SEED,
);

const BASE_TRANSCRIPT: NodeE2eeCapabilityTranscriptInput = {
  hubOrigin: HUB_ORIGIN,
  nodeId: NODE_ID,
  identityKeyId: IDENTITY_KEY_ID,
  identityPublicKey: NODE_IDENTITY_PUBLIC,
  e2eeVersionMin: 1,
  e2eeVersionMax: 1,
  suiteRegistry: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
  prekeyCertificate: {
    prekeyId: PREKEY_ID,
    agreementPublicKey: NODE_AGREEMENT_PUBLIC,
    crossSignature: NODE_PREKEY_CROSS_SIGNATURE,
    createdAt: CREATED_AT,
    expiresAt: KEY_EXPIRES_AT,
  },
  continuityChain: [],
  requireE2EE: false,
  requireApprovedClientE2EE: false,
  policyGeneration: 7,
  issuedAt: ISSUED_AT,
  expiresAt: STATEMENT_EXPIRES_AT,
  continuityId: CONTINUITY_ID,
};

function statement(overrides: Partial<NodeE2eeCapabilityTranscriptInput> = {}): Uint8Array {
  const transcript = encodeNodeE2eeCapabilityTranscript({ ...BASE_TRANSCRIPT, ...overrides });
  return encodeCanonicalE2eeCbor([
    transcript,
    ed25519.sign(encodeNodeE2eeCapabilitySigningEnvelope(transcript), NODE_SEED),
  ]);
}

const STATEMENT = statement();
/** A well-formed, correctly signed statement that is UNUSABLE: §5.2 step 8. */
const UNUSABLE_STATEMENT = statement({ e2eeVersionMin: 2, e2eeVersionMax: 2 });

// ─── §7.5: the identity this node rotated AWAY from ──────────────────────────
//
// The pin records the outgoing key; the statement presents the current one and
// carries the certificate that authenticates the step between them. This is the
// only configuration in which §8.3 elements 9 and 17 have two distinguishable
// sources, because §5.2 proves them byte-equal in every other one.

const PREVIOUS_SEED = bytes("101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f");
const PREVIOUS_PUBLIC = ed25519.getPublicKey(PREVIOUS_SEED);
const PREVIOUS_IDENTITY_FINGERPRINT = e2eeKeyFingerprint("node-identity", PREVIOUS_PUBLIC);
const PREVIOUS_KEY_ID = "nkey_DDDDDDDDDDDDDDDDDDDDDD";
const ROTATION_TRANSCRIPT = encodeNodeIdentityContinuityTranscript({
  hubOrigin: HUB_ORIGIN,
  continuityId: CONTINUITY_ID,
  generation: 1,
  oldKeyId: PREVIOUS_KEY_ID,
  oldPublicKey: PREVIOUS_PUBLIC,
  newKeyId: IDENTITY_KEY_ID,
  newPublicKey: NODE_IDENTITY_PUBLIC,
  createdAt: CREATED_AT,
});
/** §7.5: signed by the OUTGOING key, which is what authenticates the step. */
const ROTATION = {
  transcript: ROTATION_TRANSCRIPT,
  signature: ed25519.sign(ROTATION_TRANSCRIPT, PREVIOUS_SEED),
};
const ROTATED_STATEMENT = statement({ continuityChain: [ROTATION] });

const NODE_CHANNEL: E2eeHandshakeChannel = {
  hubOrigin: HUB_ORIGIN,
  channelId: CHANNEL_ID,
  relayProtocolMajor: 1,
  relayProtocolMinor: 2,
  channelOpenCapability: "ryco.rpc",
  channelOpenEffectiveRole: "operator",
};
const NODE_ADVERTISED: E2eeAdvertisedChannelMaterial = {
  nodeId: NODE_ID,
  nodeIdentityFingerprint: NODE_IDENTITY_FINGERPRINT,
  prekeyId: PREKEY_ID,
  agreementPublicKey: NODE_AGREEMENT_PUBLIC,
  continuityChainTranscripts: [],
  continuityId: CONTINUITY_ID,
};
/** The same node after the §7.5 rotation above: same identity, one chain entry. */
const ROTATED_ADVERTISED: E2eeAdvertisedChannelMaterial = {
  ...NODE_ADVERTISED,
  continuityChainTranscripts: [ROTATION_TRANSCRIPT],
};
const APPROVED: E2eeClientAuthorization = {
  status: "approved",
  maxRole: "owner",
  capabilitySet: ["ryco.rpc"],
};
const CREDENTIALS: E2eeClientHandshakeCredentials = {
  tier: "native",
  accountId: ACCOUNT_ID,
  identityPublicKey: CLIENT_IDENTITY_PUBLIC,
  agreementPublicKey: CLIENT_AGREEMENT_PUBLIC,
  agreementSecretKey: CLIENT_AGREEMENT_SECRET,
  prekeyTranscript: CLIENT_PREKEY_TRANSCRIPT,
  prekeySignature: CLIENT_PREKEY_SIGNATURE,
};
const BORROWED_CREDENTIALS = {
  tier: "native",
  accountId: ACCOUNT_ID,
  identityPublicKey: CLIENT_IDENTITY_PUBLIC,
  agreementPublicKey: CLIENT_AGREEMENT_PUBLIC,
  prekeyTranscript: CLIENT_PREKEY_TRANSCRIPT,
  prekeySignature: CLIENT_PREKEY_SIGNATURE,
} as const;

// ─── the harness ─────────────────────────────────────────────────────────────

class MockRelaySocket implements RelaySocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  #open: Array<() => void> = [];
  #message: Array<(bytes: Uint8Array) => void> = [];
  #close: Array<() => void> = [];
  #error: Array<() => void> = [];

  send(value: Uint8Array): void {
    this.sent.push(Uint8Array.from(value));
  }
  close(): void {
    this.readyState = 3;
  }
  onOpen(listener: () => void): void {
    this.#open.push(listener);
  }
  onBinaryMessage(listener: (value: Uint8Array) => void): void {
    this.#message.push(listener);
  }
  onClose(listener: () => void): void {
    this.#close.push(listener);
  }
  onError(listener: () => void): void {
    this.#error.push(listener);
  }
  open(): void {
    this.readyState = OPEN;
    for (const listener of this.#open) listener();
  }
  frame(frame: RelayFrame): void {
    const encoded = encodeRelayFrame(frame);
    if (!encoded.ok) throw new Error("test frame encoding failed");
    for (const listener of this.#message) listener(Uint8Array.from(encoded.value));
  }
}

/** Timers a test steps by hand, so `T_ADV` and `T_HANDSHAKE` are observable. */
function manualTimers() {
  let clock = NOW;
  let nextId = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: RelayTimers = {
    now: () => clock,
    setTimeout: (run, ms) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
    queueMicrotask: (run) => globalThis.queueMicrotask(run),
  };
  return {
    timers,
    /**
     * How many timers are still armed. Exposed because §4.4's "`T_ADV` is
     * cancelled when a hello is sent or a mode is locked" is a statement about
     * the CANCELLATION and not only about what the callback does when it fires:
     * the callbacks' state re-reads make a leaked timer harmless to the protocol
     * and invisible to every other assertion, while React Native still holds it.
     */
    armed: (): number => pending.size,
    advance(ms: number): void {
      clock += ms;
      // Snapshotted: a fired callback may arm or cancel another timer, and
      // mutating the map while walking it would skip or re-run an entry.
      const due = [...pending].filter(([, entry]) => entry.at <= clock);
      for (const [id, entry] of due) {
        pending.delete(id);
        entry.run();
      }
    },
  };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
};

// Several cases below spy on shared prototypes to observe steps §11.2 requires
// and the wire cannot show; none of them may leak into the next case.
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The pin a native client that reaches an APPLICATION session holds.
 *
 * §13.1's release gate is part of the shape rather than a decoration: "A native
 * client MUST NOT release application payload under the active-Hub guarantee
 * until the pin is `verified` (§2.2). With an `unverified` pin the client is
 * restricted to the pairing ceremony." An attempt with no pin therefore never
 * locks `e2ee` at all, so every case that establishes a channel carries this,
 * and the cases that assert the gate deliberately do not.
 */
const VERIFIED_PIN = {
  identityFingerprint: NODE_IDENTITY_FINGERPRINT,
  continuityId: CONTINUITY_ID,
} as const;

function attemptOf(overrides: Partial<RelayE2eeInitiatorAttempt> = {}): RelayE2eeInitiatorAttempt {
  return {
    hubOrigin: HUB_ORIGIN,
    selectionClass: "legacy-eligible",
    legacyPermitted: true,
    pairingOnly: false,
    localSuitePreference: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
    credentials: CREDENTIALS,
    accountId: ACCOUNT_ID,
    ...overrides,
  };
}

interface Harness {
  readonly engine: HostedRelayEngine;
  readonly socket: MockRelaySocket;
  readonly events: {
    onOpen: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
  };
  readonly callbacks: HostedRelaySocketCallbacks;
  readonly diagnostics: string[];
  readonly unexpected: string[];
  readonly statements: NodeE2eeCapabilityVerification[];
  readonly machine: () => RelayE2eeInitiator;
  readonly advance: (ms: number) => void;
  /** Timers still armed on this channel's machine (§4.4's cancellation rule). */
  readonly armed: () => number;
}

function harness(
  overrides: Partial<RelayE2eeInitiatorAttempt> = {},
  limits: RelayLimits = RELAY_INITIAL_LIMITS,
): Harness {
  const socket = new MockRelaySocket();
  const clock = manualTimers();
  const diagnostics: string[] = [];
  const unexpected: string[] = [];
  const statements: NodeE2eeCapabilityVerification[] = [];
  const events = {
    onOpen: vi.fn(),
    onData: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const callbacks: HostedRelaySocketCallbacks = {
    onTransportStatus: vi.fn(),
    onSessionStatus: vi.fn(),
    onRole: vi.fn(),
    onFailure: vi.fn(),
  };
  let machine: RelayE2eeInitiator | undefined;
  const engine = new HostedRelayEngine({
    ticket: encodeBase64Url(new Uint8Array(32).fill(7)),
    ticketExpiresAt: NOW + 60_000,
    socket,
    timers: clock.timers,
    callbacks,
    events,
    e2ee: (host) => {
      machine = makeRelayE2eeInitiator({
        host,
        attempt: attemptOf({
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.row),
          onUnexpectedNode: (evidence) => unexpected.push(evidence),
          onStatement: (verification) => {
            statements.push(verification);
          },
          ...overrides,
        }),
      });
      return machine;
    },
  });
  socket.open();
  socket.frame({ type: "ready", ...VERSION, limits });
  socket.frame({
    type: "channel.open",
    ...VERSION,
    channelId: CHANNEL_ID,
    capability: "ryco.rpc",
    effectiveRole: "operator",
  });
  socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });
  return {
    engine,
    socket,
    events,
    callbacks,
    diagnostics,
    unexpected,
    statements,
    machine: () => machine!,
    advance: clock.advance,
    armed: clock.armed,
  };
}

/** `E2eeClientHandshake.prototype.destroy`, captured before any case spies on it. */
const HANDSHAKE_DESTROY = E2eeClientHandshake.prototype.destroy;

/**
 * The machine on a HAND-BUILT host.
 *
 * Two properties need one. §11.2's procedure has an ORDER — erase the partial
 * handshake state, then close — and the engine's own teardown hides it by
 * destroying the handshake a second time from `dispose`, so a count taken
 * through the engine cannot tell the step from its cleanup. And the §4.5 row
 * below is preempted on the real path by the engine's admission bound, which is
 * the same quantity §4.5 derives the ceiling from.
 */
function standalone(
  overrides: Partial<RelayE2eeInitiatorAttempt> = {},
  limits: RelayLimits = RELAY_INITIAL_LIMITS,
) {
  const emitted: Uint8Array[] = [];
  const events: string[] = [];
  const machine = makeRelayE2eeInitiator({
    host: {
      limits,
      channel: {
        channelId: CHANNEL_ID,
        capability: "ryco.rpc",
        effectiveRole: "operator",
        relayProtocolMajor: 1,
        relayProtocolMinor: 2,
      },
      admit: () => ({
        release: () => undefined,
        send: (message: Uint8Array) => {
          emitted.push(Uint8Array.from(message));
          return true;
        },
      }),
      lockMode: (mode) => void events.push(`lock:${mode}`),
      close: (value) =>
        void events.push(`close:${value === undefined ? "clean" : value.closeReason}`),
      now: () => NOW,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    },
    attempt: attemptOf({
      onDiagnostic: (diagnostic) => events.push(`diagnostic:${diagnostic.row}`),
      ...overrides,
    }),
  });
  /** Record `destroy` in the same sequence, so §11.2's order is observable. */
  const watchDestroy = (): void => {
    vi.spyOn(E2eeClientHandshake.prototype, "destroy").mockImplementation(
      function (this: E2eeClientHandshake) {
        events.push("destroy");
        // The pristine method, captured before any spy: re-reading the prototype
        // here would find the previous case's spy and call it forever.
        HANDSHAKE_DESTROY.call(this);
      },
    );
  };
  return { machine, emitted, events, watchDestroy };
}

/** One node-to-client `data` frame carrying a post-strip payload at `sequence`. */
function deliver(socket: MockRelaySocket, payload: Uint8Array, sequence = 0): void {
  const framed = new Uint8Array(RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength + payload.byteLength);
  framed.set(RELAY_CHUNK_CAPABILITY_PRELUDE);
  framed.set(payload, RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength);
  socket.frame({
    type: "data",
    ...VERSION,
    channelId: CHANNEL_ID,
    sequence: sequence as never,
    payload: framed,
  });
}

function frames(socket: MockRelaySocket): RelayFrame[] {
  return socket.sent.flatMap((value) => {
    const decoded = decodeRelayFrame(value);
    return decoded.ok ? [decoded.value] : [];
  });
}

/** The post-strip payloads this client actually put on the relay. */
function outbound(socket: MockRelaySocket): Uint8Array[] {
  return frames(socket).flatMap((frame) =>
    frame.type === "data"
      ? [frame.payload.subarray(RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength)]
      : [],
  );
}

function closeReasons(socket: MockRelaySocket): (string | undefined)[] {
  return frames(socket).flatMap((frame) => (frame.type === "channel.close" ? [frame.reason] : []));
}

const CARRIER = encodeE2eeCapabilityCarrier(STATEMENT);
const UNUSABLE_CARRIER = encodeE2eeCapabilityCarrier(UNUSABLE_STATEMENT);
const ROTATED_CARRIER = encodeE2eeCapabilityCarrier(ROTATED_STATEMENT);
const LEGACY_PING = utf8('{"_tag":"Ping"}');
const LEGACY_RPC = utf8('{"_tag":"Request","id":1}');

/** The node half of one handshake, from the hello this client emitted. */
function respond(hello: Uint8Array, now = NOW, advertised = NODE_ADVERTISED) {
  const node = new E2eeNodeHandshake({
    channel: NODE_CHANNEL,
    advertised,
    advertisedVersionMin: 1,
    advertisedVersionMax: 1,
    agreementSecretKey: NODE_AGREEMENT_SECRET,
    advertisementEmittedAt: now,
    readPolicy: () => ({
      requireApprovedClientE2EE: false,
      suiteRegistry: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
    }),
    lookupClientAuthorization: () => APPROVED,
  });
  const accept = node.receiveHello(hello, now);
  if (accept.kind !== "accepted") {
    throw new Error(`synthetic node refused the hello: ${JSON.stringify(accept)}`);
  }
  return accept;
}

/** One authenticated node-to-client envelope, built from the node's own secrets. */
async function nodeEnvelope(
  secrets: E2eeSessionSecrets,
  sessionBindingHash: Uint8Array,
  body: Uint8Array,
  limits: RelayLimits = RELAY_INITIAL_LIMITS,
): Promise<Uint8Array> {
  const session = new E2eeRecordSession({
    secrets,
    suite: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
    sessionBindingHash,
    sendDirection: "n2c",
    plaintextCeiling: e2eeChannelSizeBudget(limits).plaintextCeiling,
  });
  let envelope: Uint8Array | undefined;
  const result = await session.protect({
    innerType: E2EE_INNER_TYPE_RPC,
    body,
    admit: () => true,
    transmit: (value) => {
      envelope = Uint8Array.from(value);
      return { kind: "sent" };
    },
  });
  if (result.kind !== "protected" || envelope === undefined) {
    throw new Error("synthetic node could not protect a record");
  }
  return envelope;
}

/** Drive rows K1 and K5 to completion and hand back the node's session material. */
async function establish(overrides: Partial<RelayE2eeInitiatorAttempt> = {}) {
  // The pin is part of establishing, not an option of it: §13.1's release gate
  // refuses the `e2ee` lock to a native attempt that resolved to none.
  const test = harness({ verifiedPin: VERIFIED_PIN, ...overrides });
  deliver(test.socket, CARRIER);
  await flush();
  const hello = outbound(test.socket).at(-1)!;
  const accept = respond(Uint8Array.from(hello));
  deliver(test.socket, accept.record, 1);
  await flush();
  return { test, accept };
}

// ─── §3.2.2 L1 ───────────────────────────────────────────────────────────────

describe("§3.2.2 L1 — the negotiating window fits inside one keepalive period", () => {
  it("holds the advertisement, trust-commit, handshake, and flush windows inside one keepalive period", () => {
    // §3.2.2: "A release in which any of L1–L5 is false is a specification
    // defect." The client is the only endpoint bound by it, and row K15 is
    // reachable ONLY while it holds — under a violating budget the transport
    // declares the peer dead mid-handshake and the specified FATAL-PRE, with
    // §11.5's uniform observable, can never execute (§17.14).
    expect(T_ADV + T_TRUST_COMMIT + T_HANDSHAKE + T_KEEPALIVE_FLUSH_MARGIN).toBeLessThanOrEqual(
      RPC_KEEPALIVE_INTERVAL,
    );
  });
});

// ─── §4.4 rows K1–K24 ────────────────────────────────────────────────────────

describe("§4.4 client transition table — rows K1–K4 (the capability carrier)", () => {
  it("K1: sends exactly one bounded hello on a validated, usable statement", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();

    const emitted = outbound(test.socket);
    expect(emitted).toHaveLength(1);
    const hello = decodeE2eeClientHello(Uint8Array.from(emitted[0]!));
    expect(hello.kind).toBe("ok");
    expect(test.machine().mode()).toBe("negotiating");
    // §4.4: nothing is released while the hello is in flight.
    expect(test.events.onOpen).not.toHaveBeenCalled();
  });

  it("K1: borrows the native agreement scalar only after validation and durable trust", async () => {
    let finishCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const lifecycle = { acquisitions: 0, active: 0, releases: 0 };
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      onStatement: () => committed,
      withNativeAgreementSecretKey: async (use) => {
        lifecycle.acquisitions += 1;
        lifecycle.active += 1;
        try {
          return await use(Uint8Array.from(CLIENT_AGREEMENT_SECRET));
        } finally {
          lifecycle.active -= 1;
          lifecycle.releases += 1;
        }
      },
    });

    expect(lifecycle).toEqual({ acquisitions: 0, active: 0, releases: 0 });
    deliver(test.socket, CARRIER);
    await flush();
    expect(lifecycle).toEqual({ acquisitions: 0, active: 0, releases: 0 });
    expect(outbound(test.socket)).toEqual([]);

    finishCommit();
    await flush();

    expect(lifecycle).toEqual({ acquisitions: 1, active: 0, releases: 1 });
    expect(outbound(test.socket)).toHaveLength(1);
  });

  it("K1/K5: delegates the Desktop IK handshake while keeping the record layer local", async () => {
    const clients = new Map<string, E2eeClientHandshake>();
    const lifecycle = { starts: 0, finishes: 0, destroys: 0 };
    const nativeHandshake: NonNullable<RelayE2eeInitiatorAttempt["nativeHandshake"]> = {
      start: async (input) => {
        lifecycle.starts += 1;
        expect(input.statement).toEqual(STATEMENT);
        const client = new E2eeClientHandshake({
          channel: {
            ...input.channel,
            channelId: input.channel.channelId as RelayChannelId,
          },
          advertised: NODE_ADVERTISED,
          selectedSuite: input.selectedSuite,
          offeredSuites: input.offeredSuites,
          credentials: CREDENTIALS,
          intendedCapability: input.intendedCapability,
          intendedRole: input.intendedRole,
        });
        const result = client.createHello(input.now);
        if (result.kind !== "hello") return { kind: "fatal", result };
        const handle = `desktop-${lifecycle.starts}`;
        clients.set(handle, client);
        return { kind: "hello", handle, result };
      },
      finish: async (handle, payload, now) => {
        lifecycle.finishes += 1;
        const client = clients.get(handle);
        clients.delete(handle);
        if (client === undefined) throw new Error("Missing Desktop handshake.");
        return client.receiveServerAccept(payload, now);
      },
      destroy: (handle) => {
        lifecycle.destroys += 1;
        clients.get(handle)?.destroy();
        clients.delete(handle);
      },
    };
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      nativeHandshake,
      verifiedPin: VERIFIED_PIN,
    });

    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));
    deliver(test.socket, accept.record, 1);
    await flush();

    expect(lifecycle).toEqual({ starts: 1, finishes: 1, destroys: 0 });
    expect(clients.size).toBe(0);
    expect(test.machine().mode()).toBe("e2ee");
    expect(test.events.onOpen).toHaveBeenCalledOnce();
  });

  it("gives a late K1 borrow only the trust deadline's final millisecond", async () => {
    let finishCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    let releaseRead!: () => void;
    const readReady = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const lifecycle = { acquisitions: 0, active: 0, releases: 0 };
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      onStatement: () => committed,
      withNativeAgreementSecretKey: async (use) => {
        lifecycle.acquisitions += 1;
        await readReady;
        lifecycle.active += 1;
        try {
          return await use(Uint8Array.from(CLIENT_AGREEMENT_SECRET));
        } finally {
          lifecycle.active -= 1;
          lifecycle.releases += 1;
        }
      },
    });

    deliver(test.socket, CARRIER);
    await flush();
    test.advance(T_TRUST_COMMIT - 1);
    finishCommit();
    await flush();

    expect(lifecycle).toEqual({ acquisitions: 1, active: 0, releases: 0 });
    expect(test.armed()).toBe(1);
    test.advance(1);
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(test.armed()).toBe(0);
    expect(outbound(test.socket)).toEqual([]);

    releaseRead();
    await flush();
    expect(lifecycle).toEqual({ acquisitions: 1, active: 0, releases: 1 });
    expect(outbound(test.socket)).toEqual([]);
  });

  it("closes pre-key when the late native agreement-key acquisition fails", async () => {
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      withNativeAgreementSecretKey: async () => {
        throw new Error("agreement key unavailable");
      },
    });

    deliver(test.socket, CARRIER);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("closes pre-key when the native borrower throws synchronously", async () => {
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      withNativeAgreementSecretKey: () => {
        throw new Error("synchronous agreement-key failure");
      },
    });

    deliver(test.socket, CARRIER);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("acquires no agreement scalar for an invalid capability carrier", async () => {
    let acquisitions = 0;
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      withNativeAgreementSecretKey: async (use) => {
        acquisitions += 1;
        return await use(Uint8Array.from(CLIENT_AGREEMENT_SECRET));
      },
    });
    const invalidCarrier = Uint8Array.from(CARRIER);
    invalidCarrier[invalidCarrier.byteLength - 1]! ^= 0x01;

    deliver(test.socket, invalidCarrier);
    await flush();

    expect(acquisitions).toBe(0);
    expect(outbound(test.socket)).toEqual([]);
  });

  it("closes pre-key when a native borrower resolves without invoking K1", async () => {
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      withNativeAgreementSecretKey: async () => ({ kind: "claimed" }) as never,
    });

    deliver(test.socket, CARRIER);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["local"]);
  });

  it("preserves native IK interoperability with one-operation borrowed custody", async () => {
    const lifecycle = { acquisitions: 0, active: 0, releases: 0 };
    const { test, accept } = await establish({
      credentials: BORROWED_CREDENTIALS,
      withNativeAgreementSecretKey: async (use) => {
        lifecycle.acquisitions += 1;
        lifecycle.active += 1;
        const secretKey = Uint8Array.from(CLIENT_AGREEMENT_SECRET);
        try {
          return use(secretKey);
        } finally {
          secretKey.fill(0);
          lifecycle.active -= 1;
          lifecycle.releases += 1;
        }
      },
    });

    expect(test.machine().mode()).toBe("e2ee");
    expect(accept.secrets).toBeDefined();
    expect(lifecycle).toEqual({ acquisitions: 1, active: 0, releases: 1 });
    eraseE2eeSessionSecrets(accept.secrets);
  });

  it("closes FATAL-PRE with zero hello when a restored certificate names another scalar", async () => {
    const lifecycle = { acquisitions: 0, active: 0, releases: 0 };
    const test = harness({
      credentials: {
        ...BORROWED_CREDENTIALS,
        agreementPublicKey: NODE_AGREEMENT_PUBLIC,
      },
      withNativeAgreementSecretKey: async (use) => {
        lifecycle.acquisitions += 1;
        lifecycle.active += 1;
        const secretKey = Uint8Array.from(CLIENT_AGREEMENT_SECRET);
        try {
          return use(secretKey);
        } finally {
          secretKey.fill(0);
          lifecycle.active -= 1;
          lifecycle.releases += 1;
        }
      },
    });

    deliver(test.socket, CARRIER);
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(outbound(test.socket)).toEqual([]);
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
    expect(lifecycle).toEqual({ acquisitions: 1, active: 0, releases: 1 });
  });

  it.each(["abort", "dispose", "close", "timeout"] as const)(
    "cancels a pending native agreement-key read on %s and ignores its late completion",
    async (terminal) => {
      let releaseRead!: () => void;
      const readReady = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const lifecycle = { acquisitions: 0, active: 0, releases: 0 };
      const test = harness({
        credentials: BORROWED_CREDENTIALS,
        withNativeAgreementSecretKey: async (use) => {
          lifecycle.acquisitions += 1;
          await readReady;
          lifecycle.active += 1;
          try {
            return await use(Uint8Array.from(CLIENT_AGREEMENT_SECRET));
          } finally {
            lifecycle.active -= 1;
            lifecycle.releases += 1;
          }
        },
      });
      deliver(test.socket, CARRIER);
      await flush();
      expect(lifecycle).toEqual({ acquisitions: 1, active: 0, releases: 0 });

      // The native provider's background transition invokes this same abort.
      if (terminal === "abort") test.machine().abort();
      else if (terminal === "dispose") test.machine().dispose();
      else if (terminal === "close") await test.machine().beginClose();
      else test.advance(T_TRUST_COMMIT);
      await flush();

      expect(test.machine().mode()).toBe("closed");
      expect(test.armed()).toBe(0);
      expect(outbound(test.socket)).toEqual([]);
      expect(lifecycle.active).toBe(0);

      releaseRead();
      await flush();

      expect(outbound(test.socket)).toEqual([]);
      expect(lifecycle).toEqual({ acquisitions: 1, active: 0, releases: 1 });
    },
  );

  it("ignores a pending borrower rejection after the channel is terminal", async () => {
    let rejectRead!: (cause: Error) => void;
    const readReady = new Promise<void>((_resolve, reject) => {
      rejectRead = reject;
    });
    const test = harness({
      credentials: BORROWED_CREDENTIALS,
      withNativeAgreementSecretKey: async (use) => {
        await readReady;
        return await use(Uint8Array.from(CLIENT_AGREEMENT_SECRET));
      },
    });
    deliver(test.socket, CARRIER);
    await flush();

    test.machine().abort();
    await flush();
    rejectRead(new Error("late agreement-store rejection"));
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(test.armed()).toBe(0);
    expect(outbound(test.socket)).toEqual([]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("K1: waits for the authenticated trust commit before sending the hello", async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({ onStatement: () => committed });
    test.engine.send(utf8('{"mustRemainBuffered":true}'));

    deliver(test.socket, CARRIER);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("negotiating");
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.armed()).toBe(1);

    release();
    await flush();

    expect(outbound(test.socket)).toHaveLength(1);
    expect(decodeE2eeClientHello(outbound(test.socket)[0]!).kind).toBe("ok");
    expect(test.armed()).toBe(1);
  });

  it("closes pre-key and sends nothing when the trust commit rejects", async () => {
    const test = harness({
      onStatement: async () => {
        throw new Error("durable trust write refused");
      },
    });
    test.engine.send(utf8('{"mustNotEscape":true}'));

    deliver(test.socket, CARRIER);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
    expect(test.events.onOpen).not.toHaveBeenCalled();
  });

  it("closes pre-key when the statement hook throws synchronously", async () => {
    const test = harness({
      onStatement: () => {
        throw new Error("synchronous trust boundary refusal");
      },
    });

    deliver(test.socket, CARRIER);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("closes at T_TRUST_COMMIT and a late commit cannot resume the channel", async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({ onStatement: () => committed });
    test.engine.send(utf8('{"mustNotEscape":true}'));

    deliver(test.socket, CARRIER);
    await flush();
    test.advance(T_TRUST_COMMIT);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);

    release();
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
    expect(test.events.onOpen).not.toHaveBeenCalled();
  });

  it("wakes a pending trust wait on abort and ignores its late settlement", async () => {
    let reject!: (cause: Error) => void;
    const committed = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const test = harness({ onStatement: () => committed });

    deliver(test.socket, CARRIER);
    await flush();
    test.machine().abort();
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(test.armed()).toBe(0);
    expect(outbound(test.socket)).toEqual([]);

    reject(new Error("late storage refusal"));
    await flush();
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("wakes a pending trust wait when a graceful close begins", async () => {
    let reject!: (cause: Error) => void;
    const committed = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const test = harness({ onStatement: () => committed });

    deliver(test.socket, CARRIER);
    await flush();
    expect(await test.machine().beginClose()).toBe("opened");
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(test.armed()).toBe(0);
    expect(outbound(test.socket)).toEqual([]);
    expect(closeReasons(test.socket)).toEqual([undefined]);

    reject(new Error("late storage refusal"));
    await flush();
    expect(outbound(test.socket)).toEqual([]);
    expect(closeReasons(test.socket)).toEqual([undefined]);
  });

  it("wakes a pending trust wait on disposal and ignores late success", async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({ onStatement: () => committed });

    deliver(test.socket, CARRIER);
    await flush();
    test.machine().dispose();
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(test.armed()).toBe(0);
    expect(outbound(test.socket)).toEqual([]);

    release();
    await flush();
    expect(outbound(test.socket)).toEqual([]);
    expect(test.events.onOpen).not.toHaveBeenCalled();
  });

  it("emits nothing when abort wins after commit settlement but before its continuation", async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({ onStatement: () => committed });
    test.engine.send(utf8('{"mustNotEscape":true}'));

    deliver(test.socket, CARRIER);
    await flush();
    release();
    // The hook's fulfillment settles the initiator wait. Its async continuation
    // is now queued behind this test continuation, so abort deterministically
    // wins the same-tick ordering that previously allowed a stale hello.
    await Promise.resolve();
    test.machine().abort();
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(test.armed()).toBe(0);
    expect(outbound(test.socket)).toEqual([]);
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("arms a fresh full handshake deadline after a near-deadline trust commit", async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({ onStatement: () => committed });

    deliver(test.socket, CARRIER);
    await flush();
    test.advance(T_TRUST_COMMIT - 1);
    release();
    await flush();
    expect(outbound(test.socket)).toHaveLength(1);

    test.advance(T_HANDSHAKE - 1);
    expect(test.machine().mode()).toBe("negotiating");
    test.advance(1);
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["P20"]);
  });

  it("awaits the statement hook before applying an unusable verdict", async () => {
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({ selectionClass: "legacy-eligible", onStatement: () => observed });

    deliver(test.socket, UNUSABLE_CARRIER);
    await flush();

    expect(test.diagnostics).toEqual([]);
    expect(test.machine().mode()).toBe("negotiating");

    release();
    await flush();

    expect(test.diagnostics).toEqual(["K3"]);
    expect(outbound(test.socket)).toEqual([]);
  });

  it("closes pre-key when the observer of an unusable verdict rejects", async () => {
    const test = harness({
      selectionClass: "legacy-eligible",
      onStatement: async () => {
        throw new Error("trust observer refused the verdict");
      },
    });

    deliver(test.socket, UNUSABLE_CARRIER);
    await flush();

    expect(test.machine().mode()).toBe("closed");
    expect(test.armed()).toBe(0);
    expect(outbound(test.socket)).toEqual([]);
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("K2: closes FATAL-PRE on an unusable statement while the selection is latched", async () => {
    const test = harness({ selectionClass: "latched" });
    deliver(test.socket, UNUSABLE_CARRIER);
    await flush();

    // §11.2 P15, and §11.2's procedure: the client sends NOTHING.
    expect(outbound(test.socket)).toEqual([]);
    expect(test.diagnostics).toEqual(["P15"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("K3: treats an unusable statement as absent evidence when the selection is not latched", async () => {
    const test = harness({ selectionClass: "legacy-eligible" });
    deliver(test.socket, UNUSABLE_CARRIER);
    await flush();

    expect(test.machine().mode()).toBe("negotiating");
    expect(outbound(test.socket)).toEqual([]);
    expect(test.diagnostics).toEqual(["K3"]);
    // The `T_ADV` rows still decide the channel.
    test.advance(T_ADV);
    expect(test.machine().mode()).toBe("legacy");
  });

  it("K4: closes FATAL-PRE on a duplicate carrier", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();
    deliver(test.socket, CARRIER, 1);
    await flush();

    expect(test.diagnostics).toEqual(["P4"]);
    expect(test.machine().mode()).toBe("closed");
  });
});

describe("§4.4 client transition table — rows K5–K8 (negotiation records)", () => {
  it("K5: verifies the accept, enters e2ee, and only then releases the channel", async () => {
    const { test } = await establish();

    expect(test.machine().mode()).toBe("e2ee");
    expect(test.events.onOpen).toHaveBeenCalledOnce();
    expect(test.callbacks.onTransportStatus).toHaveBeenCalledWith("online");
  });

  it("K6: closes FATAL-PRE on an accept with no hello sent", async () => {
    const test = harness();
    // A well-formed accept, produced from a hello this client never sent.
    const other = harness();
    deliver(other.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(other.socket).at(-1)!));

    deliver(test.socket, accept.record);
    await flush();

    expect(test.diagnostics).toEqual(["P16"]);
    expect(outbound(test.socket)).toEqual([]);
  });

  it("K6: closes FATAL-PRE on a tampered accept and emits no record", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));
    const tampered = Uint8Array.from(accept.record);
    tampered[tampered.byteLength - 1]! ^= 0x01;

    deliver(test.socket, tampered, 1);
    await flush();

    // §8.8 step 5's constant-time comparison, reached through the real wiring.
    expect(test.diagnostics).toEqual(["P16"]);
    expect(outbound(test.socket)).toHaveLength(1);
    expect(test.events.onOpen).not.toHaveBeenCalled();
  });

  it("K7: closes FATAL-PRE on an E2EEHandshakeReject after a hello", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();
    const reject = encodeE2eeHandshakeReject();
    expect(reject.byteLength).toBe(E2EE_HANDSHAKE_REJECT_BYTES);

    deliver(test.socket, reject, 1);
    await flush();

    expect(test.diagnostics).toEqual(["P17"]);
    // §4.4: one attempt per channel — a retry needs a fresh ticket and channel.
    expect(test.machine().mode()).toBe("closed");
  });

  it("K8: closes FATAL-PRE with P3 on a reject that no hello asked for", async () => {
    // §4.4: "a reject with no hello matches no guard of K7 and falls to K8". The
    // wire observable is the same generic close either way, so the row is the
    // whole of the difference — and an operator reading P17 would be told a
    // handshake failed on a channel that never started one.
    const test = harness();
    deliver(test.socket, encodeE2eeHandshakeReject());
    await flush();

    expect(test.diagnostics).toEqual(["P3"]);
    expect(outbound(test.socket)).toEqual([]);
    expect(test.machine().mode()).toBe("closed");
  });

  it("K8: closes FATAL-PRE on a misdirected negotiation record", async () => {
    const test = harness();
    // `E2EEClientHello` is a client-to-node record (§3.4).
    deliver(
      test.socket,
      encodeE2eeNegotiationRecord(E2EE_NEGOTIATION_TYPE_CLIENT_HELLO, new Uint8Array([0x80])),
    );
    await flush();

    expect(test.diagnostics).toEqual(["P3"]);
    expect(outbound(test.socket)).toEqual([]);
  });
});

describe("§4.4 client transition table — rows K9–K12 (plaintext and stray classes)", () => {
  it("K9: locks legacy and delivers when the selection is legacy-eligible", async () => {
    const test = harness({ selectionClass: "legacy-eligible", legacyPermitted: true });
    deliver(test.socket, LEGACY_RPC);
    await flush();

    expect(test.machine().mode()).toBe("legacy");
    expect(test.events.onOpen).toHaveBeenCalledOnce();
    expect(test.events.onData).toHaveBeenCalledWith(LEGACY_RPC);
  });

  it("K10: closes FATAL-PRE on non-carrier legacy JSON while latched", async () => {
    const test = harness({ selectionClass: "latched" });
    deliver(test.socket, LEGACY_PING);
    await flush();

    expect(test.diagnostics).toEqual(["P18"]);
    expect(test.events.onData).not.toHaveBeenCalled();
  });

  it("K10: closes FATAL-PRE on non-carrier legacy JSON after a hello was sent", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();
    deliver(test.socket, LEGACY_PING, 1);
    await flush();

    expect(test.diagnostics).toEqual(["P18"]);
  });

  it("K10: closes FATAL-PRE on non-carrier legacy JSON while local policy forbids legacy", async () => {
    // The strict-legacy half of the row, on the path a hostile Hub actually
    // controls: §12.1.1's "never legacy on this Hub" policy is what row K10
    // enforces against one unsolicited plaintext frame, and it is the guard that
    // decides the channel here — the selection is legacy-eligible and no hello
    // has been sent, so every other clause of the row is false.
    const test = harness({ selectionClass: "legacy-eligible", legacyPermitted: false });
    test.engine.send(utf8('{"_tag":"Request","id":1}'));

    deliver(test.socket, LEGACY_PING);
    await flush();

    expect(test.diagnostics).toEqual(["P18"]);
    expect(test.machine().mode()).toBe("closed");
    // The buffered send is discarded unflushed and the frame never reaches the
    // parser: a policy that forbids legacy forbids the release valve with it.
    expect(outbound(test.socket)).toEqual([]);
    expect(test.events.onData).not.toHaveBeenCalled();
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("K11: closes FATAL-PRE on an envelope before establishment", async () => {
    const test = harness();
    deliver(test.socket, new Uint8Array([0x01, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    await flush();

    expect(test.diagnostics).toEqual(["P5"]);
  });

  it("K12: closes FATAL-PRE on an unknown or absent first byte", async () => {
    const unknown = harness();
    deliver(unknown.socket, new Uint8Array([0xff]));
    await flush();
    expect(unknown.diagnostics).toEqual(["P6"]);

    // §3.4's absent case: a zero-length post-strip payload is never a benign
    // no-op and never silently dropped.
    const absent = harness();
    deliver(absent.socket, new Uint8Array(0));
    await flush();
    expect(absent.diagnostics).toEqual(["P6"]);
  });
});

describe("§4.4 client transition table — rows K13–K15 (timers)", () => {
  it("K13: locks legacy at T_ADV when the selection is legacy-eligible", async () => {
    const test = harness();
    test.advance(T_ADV - 1);
    expect(test.machine().mode()).toBe("negotiating");

    test.advance(1);
    expect(test.machine().mode()).toBe("legacy");
    expect(test.events.onOpen).toHaveBeenCalledOnce();
  });

  it("K14: closes FATAL-PRE at T_ADV when the selection is latched", () => {
    const test = harness({ selectionClass: "latched" });
    test.advance(T_ADV);

    expect(test.diagnostics).toEqual(["P19"]);
    expect(outbound(test.socket)).toEqual([]);
  });

  it("K14: closes FATAL-PRE at T_ADV when local policy forbids legacy", () => {
    const test = harness({ selectionClass: "legacy-eligible", legacyPermitted: false });
    test.advance(T_ADV);

    expect(test.diagnostics).toEqual(["P19"]);
  });

  it("K15: closes FATAL-PRE at T_HANDSHAKE and never falls back to legacy", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();

    // `T_ADV` was cancelled at the hello emit: advancing past it changes nothing.
    test.advance(T_ADV);
    expect(test.machine().mode()).toBe("negotiating");

    test.advance(T_HANDSHAKE);
    expect(test.diagnostics).toEqual(["P20"]);
    expect(test.machine().mode()).toBe("closed");
    expect(outbound(test.socket)).toHaveLength(1);
  });

  it("ignores a superseded T_ADV after the mode locked", async () => {
    const test = harness();
    deliver(test.socket, LEGACY_RPC);
    await flush();
    expect(test.machine().mode()).toBe("legacy");

    test.advance(T_ADV + T_HANDSHAKE);
    // One-way: a legacy channel is never re-decided by a timer.
    expect(test.machine().mode()).toBe("legacy");
    expect(test.diagnostics).toEqual([]);
  });
});

describe("§4.4 client transition table — rows K16–K18 (the established channel)", () => {
  it("K16: delivers an authenticated inner RPC record", async () => {
    const { test, accept } = await establish();
    const envelope = await nodeEnvelope(
      accept.secrets,
      accept.sessionBindingHash,
      utf8('{"_tag":"Response"}'),
    );

    deliver(test.socket, envelope, 2);
    await flush();

    expect(test.events.onData).toHaveBeenCalledWith(utf8('{"_tag":"Response"}'));
  });

  it("K17: closes FATAL-POST on an envelope whose checks fail", async () => {
    const { test, accept } = await establish();
    const envelope = await nodeEnvelope(
      accept.secrets,
      accept.sessionBindingHash,
      utf8('{"_tag":"Response"}'),
    );
    envelope[envelope.byteLength - 1]! ^= 0x01;

    deliver(test.socket, envelope, 2);
    await flush();

    expect(test.events.onData).not.toHaveBeenCalled();
    expect(closeReasons(test.socket)).toContain("channel_rejected");
  });

  it("K18: closes FATAL-POST on plaintext after E2EE", async () => {
    const { test } = await establish();

    deliver(test.socket, LEGACY_PING, 2);
    await flush();

    // The keepalive `Pong` a synthesized-Pong implementation must stop injecting
    // at the mode lock is exactly this record, and it is still fatal.
    expect(test.events.onData).not.toHaveBeenCalled();
    expect(closeReasons(test.socket)).toContain("channel_rejected");
  });
});

describe("§4.4 client transition table — rows K19–K22 (after a legacy lock)", () => {
  async function locked() {
    const test = harness();
    test.advance(T_ADV);
    return test;
  }

  it("K19: delivers non-carrier legacy JSON to the RPC parser", async () => {
    const test = await locked();
    deliver(test.socket, LEGACY_RPC);
    await flush();

    expect(test.events.onData).toHaveBeenCalledWith(LEGACY_RPC);
  });

  it("K20: ignores a carrier after a legacy lock and never upgrades", async () => {
    const test = await locked();
    deliver(test.socket, CARRIER);
    await flush();

    expect(test.machine().mode()).toBe("legacy");
    expect(test.events.onData).not.toHaveBeenCalled();
    expect(test.diagnostics).toEqual(["K20"]);
    expect(outbound(test.socket)).toEqual([]);
  });

  it("K21: closes FATAL-PRE on an envelope or a negotiation record", async () => {
    const envelope = await locked();
    deliver(
      envelope.socket,
      new Uint8Array([0x01, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
    await flush();
    expect(envelope.diagnostics).toEqual(["P5"]);

    const negotiation = await locked();
    deliver(negotiation.socket, encodeE2eeHandshakeReject());
    await flush();
    // §11.2 P24: no session keys exist in `legacy`, so it is FATAL-PRE.
    expect(negotiation.diagnostics).toEqual(["P24"]);
  });

  it("K22: closes FATAL-PRE on an unknown first byte", async () => {
    const test = await locked();
    deliver(test.socket, new Uint8Array([0x2a]));
    await flush();

    expect(test.diagnostics).toEqual(["P6"]);
  });
});

// ─── the substituted node (§13.2.1, rows K23/K24) ────────────────────────────

describe("NEGATIVE — a substituted node raises the §13.2.1 surface and releases nothing", () => {
  it("K23: closes FATAL-PRE on legacy JSON and discards the buffer UNFLUSHED", async () => {
    const test = harness({ selectionClass: "unexpected", legacyPermitted: true });
    test.engine.send(utf8('{"_tag":"Request","id":7}'));
    expect(outbound(test.socket)).toEqual([]);

    deliver(test.socket, LEGACY_PING);
    await flush();

    expect(test.unexpected).toEqual(["none"]);
    expect(test.diagnostics).toEqual(["P22"]);
    // THE POINT OF THE ROW: the buffered application send is NOT flushed as
    // plaintext on the way out, which is what a legacy lock would have done.
    expect(outbound(test.socket)).toEqual([]);
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.events.onData).not.toHaveBeenCalled();
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("K24: closes FATAL-PRE at T_ADV and discards the buffer UNFLUSHED", () => {
    const test = harness({ selectionClass: "unexpected", legacyPermitted: true });
    test.engine.send(utf8('{"_tag":"Request","id":8}'));

    test.advance(T_ADV);

    expect(test.unexpected).toEqual(["none"]);
    expect(test.diagnostics).toEqual(["P22"]);
    expect(outbound(test.socket)).toEqual([]);
    expect(test.events.onOpen).not.toHaveBeenCalled();
  });
});

// ─── §4.4 send buffering ─────────────────────────────────────────────────────

describe("§4.4 send buffering — no plaintext byte reaches the wire while negotiating", () => {
  it("holds every submission, including a keepalive Ping injected mid-window", async () => {
    const test = harness();
    test.engine.send(utf8('{"_tag":"Request","id":1}'));
    // The keepalive `Ping` is generated by the RPC layer several levels above
    // this seam and is not otherwise controllable; §4.4 classifies it exactly as
    // any other plaintext, which is why the buffer covers all of it.
    test.engine.send(LEGACY_PING);
    test.engine.send(utf8('{"_tag":"Request","id":2}'));

    // Asserted on the socket's FRAME LOG: not one `data` frame exists.
    expect(frames(test.socket).some((frame) => frame.type === "data")).toBe(false);

    deliver(test.socket, CARRIER);
    await flush();
    // Still nothing but the hello: the flush waits for §8.8 step 6.
    expect(outbound(test.socket)).toHaveLength(1);
  });

  it("flushes as envelopes only after §8.8 step 6, in submission order", async () => {
    const test = harness({ verifiedPin: VERIFIED_PIN });
    test.engine.send(utf8('{"_tag":"Request","id":1}'));
    test.engine.send(LEGACY_PING);
    deliver(test.socket, CARRIER);
    await flush();
    const hello = Uint8Array.from(outbound(test.socket).at(-1)!);
    expect(outbound(test.socket)).toHaveLength(1);

    const accept = respond(hello);
    deliver(test.socket, accept.record, 1);
    await flush();

    const emitted = outbound(test.socket);
    // The hello, then two envelopes — every one of them a `0x01` envelope and
    // none of them a plaintext byte.
    expect(emitted).toHaveLength(3);
    expect(emitted[1]![0]).toBe(0x01);
    expect(emitted[2]![0]).toBe(0x01);
    expect(test.engine.bufferedAmount).toBe(0);
  });

  it("flushes as plaintext on a legacy lock, before the first delivery", async () => {
    const test = harness();
    test.engine.send(utf8('{"first":1}'));
    test.engine.send(utf8('{"second":2}'));

    test.advance(T_ADV);

    const emitted = outbound(test.socket).map((value) => new TextDecoder().decode(value));
    expect(emitted).toEqual(['{"first":1}', '{"second":2}']);
  });

  it("makes the buffered keepalive Ping the §8.9 implicit finish when nothing else is pending", async () => {
    const test = harness({ verifiedPin: VERIFIED_PIN });
    test.engine.send(LEGACY_PING);
    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));

    deliver(test.socket, accept.record, 1);
    await flush();

    // §8.9: the first valid client-to-node envelope IS the implicit finish, and
    // §4.4/§3.2.2 L1 budget for exactly this frame.
    const emitted = outbound(test.socket);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]![0]).toBe(0x01);
  });

  /**
   * Small enough to fill by hand, and every buffered message below fits in a
   * single data chunk — what the flush does with a multi-chunk message is the
   * next case's subject, not this one's.
   */
  const SMALL_LIMITS = RelayLimits.make({
    ...RELAY_INITIAL_LIMITS,
    maxControlFrameBytes: 4_096,
    maxDataChunkBytes: 8_192,
    maxQueuedBytes: 32_768,
  });

  it("refuses a submission past E2EE_NEGOTIATION_BUFFER_MAX_BYTES without failing the channel", () => {
    const test = harness({}, SMALL_LIMITS);

    // The charge is the queue's own — every planned payload plus its per-entry
    // overhead — against the same aggregate budget the relay send queue
    // enforces, per relay connection.
    for (let index = 0; index < 4; index += 1) test.engine.send(new Uint8Array(6_000).fill(0x7b));
    expect(test.engine.bufferedAmount).toBeLessThanOrEqual(
      e2eeNegotiationBufferMaxBytes(SMALL_LIMITS),
    );
    expect(() => test.engine.send(new Uint8Array(6_000).fill(0x7b))).toThrow(
      RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE,
    );

    // §11.4 `e2ee_send_unavailable`: no wire record of any kind, the channel
    // unaffected and still usable, and never a silent drop.
    expect(frames(test.socket).some((frame) => frame.type === "data")).toBe(false);
    expect(test.callbacks.onFailure).not.toHaveBeenCalled();
    expect(test.machine().mode()).toBe("negotiating");
    // The share is released the instant the channel leaves `negotiating`.
    test.advance(T_ADV);
    expect(test.engine.bufferedAmount).toBe(0);
    expect(() => test.engine.send(new Uint8Array(32).fill(0x7b))).not.toThrow();
  });

  it("keeps a buffer filled to its bound flushable in full", () => {
    // §4.4 charges the buffer "as though the bytes had already been enqueued",
    // so everything the engine accepted must fit in the queue it is drained
    // into. Charging the raw byte lengths leaves the queue's per-entry and
    // per-chunk overhead unfunded, and the flush of a full buffer then trips the
    // queue's own bound — turning a submission-time, non-fatal §11.4 refusal into
    // the channel-fatal `slow_consumer` §11.4 forbids.
    const test = harness({}, SMALL_LIMITS);
    let held = 0;
    for (;;) {
      try {
        test.engine.send(new Uint8Array(64).fill(0x7b));
      } catch {
        break;
      }
      held += 1;
    }
    expect(held).toBeGreaterThan(0);

    test.advance(T_ADV);

    expect(test.callbacks.onFailure).not.toHaveBeenCalled();
    expect(test.machine().mode()).toBe("legacy");
    expect(outbound(test.socket)).toHaveLength(held);
    expect(test.engine.bufferedAmount).toBe(0);
  });

  it("keeps the one hello a negotiating channel may still owe admissible", () => {
    // §11.4: ordinary backpressure MUST NOT be escalated to a channel-fatal
    // condition. The buffer and the handshake draw on ONE aggregate budget, so a
    // buffer entitled to all of it would leave `host.admit` unable to take the
    // hello — and §4.4's no-legacy-after-validated-evidence rule leaves a client
    // that cannot send it only FATAL-PRE. The buffer is bounded below the
    // aggregate by exactly that record instead.
    const test = harness({}, SMALL_LIMITS);
    // Filled to the last byte it will take, coarsely and then finely, so the
    // only headroom left is whatever the bound deliberately holds back.
    for (const size of [6_000, 64]) {
      for (;;) {
        try {
          test.engine.send(new Uint8Array(size).fill(0x7b));
        } catch {
          break;
        }
      }
    }

    deliver(test.socket, CARRIER);

    return flush().then(() => {
      const emitted = outbound(test.socket);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]![0]).toBe(0x02);
      expect(test.diagnostics).toEqual([]);
      expect(test.machine().mode()).toBe("negotiating");
    });
  });

  it("does not change the shape of any pre-existing refusal", () => {
    // Every legacy refusal still throws synchronously with its own message,
    // which both facades map by string — AND the `negotiating` buffer raises the
    // same one for the same submission, because §4.4 requires the §4.5
    // per-message bound at submission and a caller cannot observe the mode it
    // would otherwise have to branch on.
    const negotiating = harness();
    expect(() =>
      negotiating.engine.send(new Uint8Array(RELAY_INITIAL_LIMITS.maxQueuedBytes * 4)),
    ).toThrow(RELAY_MESSAGE_TOO_LARGE_MESSAGE);
    // §11.4: sender-local, so the channel is untouched and still usable.
    expect(negotiating.callbacks.onFailure).not.toHaveBeenCalled();
    expect(negotiating.machine().mode()).toBe("negotiating");
    expect(() => negotiating.engine.send(LEGACY_PING)).not.toThrow();

    const legacy = harness();
    legacy.advance(T_ADV);
    expect(() =>
      legacy.engine.send(new Uint8Array(RELAY_INITIAL_LIMITS.maxQueuedBytes * 4)),
    ).toThrow(RELAY_MESSAGE_TOO_LARGE_MESSAGE);
  });

  it("refuses an over-ceiling submission at submission on the e2ee sink too", async () => {
    // The other sink, and the worse disposition: `emit` refuses an over-ceiling
    // body as §11.4 `e2ee_message_too_large` and the flush has no caller to tell,
    // so a message admitted here would be dropped in silence on a channel the
    // application has just been told is open.
    const test = harness({ verifiedPin: VERIFIED_PIN });
    const overCeiling = e2eeChannelSizeBudget(RELAY_INITIAL_LIMITS).plaintextCeiling + 1;
    expect(() => test.engine.send(new Uint8Array(overCeiling))).toThrow(
      RELAY_MESSAGE_TOO_LARGE_MESSAGE,
    );

    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));
    deliver(test.socket, accept.record, 1);
    await flush();

    // The refusal left the channel usable: it still establishes.
    expect(test.machine().mode()).toBe("e2ee");
    expect(outbound(test.socket)).toHaveLength(1);
  });

  it("refuses a submission the peer's framing cannot carry, with the legacy message", () => {
    // A peer that has not advertised chunk support bounds every message at
    // `maxDataChunkBytes`, far below the §4.5 ceiling. Row K13 against a node
    // that never advertises is exactly that channel, and the flush is where the
    // refusal would otherwise land — with `transfer_limit` and no caller.
    const test = harness();
    expect(() =>
      test.engine.send(new Uint8Array(RELAY_INITIAL_LIMITS.maxDataChunkBytes + 1)),
    ).toThrow(RELAY_PEER_UNSUPPORTED_MESSAGE);
    expect(test.callbacks.onFailure).not.toHaveBeenCalled();
    expect(test.machine().mode()).toBe("negotiating");
  });
});

// ─── FATAL-PRE discard (§4.4, §11.2) ─────────────────────────────────────────

describe("§4.4 FATAL-PRE — the buffer is zeroized and discarded, and no record is emitted", () => {
  const rows: readonly (readonly [string, (test: Harness) => Promise<void> | void])[] = [
    ["K2", (test) => void deliver(test.socket, UNUSABLE_CARRIER)],
    [
      "K4",
      async (test) => {
        deliver(test.socket, CARRIER);
        await flush();
        deliver(test.socket, CARRIER, 1);
      },
    ],
    [
      "K6",
      async (test) => {
        deliver(test.socket, CARRIER);
        await flush();
        const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));
        const tampered = Uint8Array.from(accept.record);
        tampered[tampered.byteLength - 1]! ^= 0x01;
        deliver(test.socket, tampered, 1);
      },
    ],
    [
      "K7",
      async (test) => {
        deliver(test.socket, CARRIER);
        await flush();
        deliver(test.socket, encodeE2eeHandshakeReject(), 1);
      },
    ],
    [
      "K8",
      (test) =>
        void deliver(
          test.socket,
          encodeE2eeNegotiationRecord(E2EE_NEGOTIATION_TYPE_CLIENT_HELLO, new Uint8Array([0x80])),
        ),
    ],
    ["K10", (test) => void deliver(test.socket, LEGACY_PING)],
    [
      "K11",
      (test) =>
        void deliver(
          test.socket,
          new Uint8Array([0x01, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        ),
    ],
    ["K12", (test) => void deliver(test.socket, new Uint8Array(0))],
    ["K14", (test) => test.advance(T_ADV)],
    [
      "K15",
      async (test) => {
        deliver(test.socket, CARRIER);
        await flush();
        test.advance(T_ADV + T_HANDSHAKE);
      },
    ],
  ];

  for (const [row, drive] of rows) {
    it(`${row}: discards the buffered sends unflushed`, async () => {
      // `latched` reaches every row above whose guard needs it and changes none
      // of the others: rows K4, K6, K7, K8, K11, K12 and K15 are unguarded.
      const test = harness({ selectionClass: "latched" });
      test.engine.send(utf8('{"_tag":"Request","id":99}'));
      await drive(test);
      await flush();

      const emitted = outbound(test.socket);
      // The hello is the ONE record a client may emit; nothing else — and in
      // particular no buffered plaintext — reaches the relay.
      for (const payload of emitted) expect(payload[0]).toBe(0x02);
      expect(test.engine.bufferedAmount).toBe(0);
      expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
      expect(test.events.onOpen).not.toHaveBeenCalled();
    });
  }

  it("K23 and K24 take the same discard path", async () => {
    for (const drive of [
      async (test: Harness) => {
        deliver(test.socket, LEGACY_PING);
        await flush();
      },
      async (test: Harness) => test.advance(T_ADV),
    ]) {
      const test = harness({ selectionClass: "unexpected" });
      test.engine.send(utf8('{"_tag":"Request","id":99}'));
      await drive(test);
      await flush();
      expect(outbound(test.socket)).toEqual([]);
      expect(test.engine.bufferedAmount).toBe(0);
    }
  });
});

// ─── §13.2 the pairing-only attempt ──────────────────────────────────────────

describe("NEGATIVE — a pairing-only attempt releases no application payload", () => {
  it("sends exactly one bounded hello and never flushes, on the reject path", async () => {
    const test = harness({ pairingOnly: true, selectionClass: "unexpected" });
    test.engine.send(utf8('{"_tag":"Request","id":1}'));
    deliver(test.socket, CARRIER);
    await flush();

    const emitted = outbound(test.socket);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]![0]).toBe(0x02);

    deliver(test.socket, encodeE2eeHandshakeReject(), 1);
    await flush();

    expect(outbound(test.socket)).toHaveLength(1);
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.diagnostics).toEqual(["P17"]);
  });

  it("never flushes at row K13, the ordinary first-contact configuration", () => {
    // §13.2 pairing runs against the selection §12.1.1 branch (a) classifies
    // LEGACY-ELIGIBLE — genuine first contact — so this pair of guards is the
    // ceremony's ordinary case and not a corner of it. A Hub that simply
    // withholds the carrier past `T_ADV` reaches row K13, whose action is to
    // flush the buffer as plaintext and open the channel; §13.2 step 2 fixes the
    // outcome first: "buffered application sends are never flushed, and no
    // application payload is released regardless of outcome".
    const test = harness({ pairingOnly: true, selectionClass: "legacy-eligible" });
    test.engine.send(utf8('{"_tag":"Request","id":1}'));

    test.advance(T_ADV);

    expect(outbound(test.socket)).toEqual([]);
    expect(test.engine.bufferedAmount).toBe(0);
    expect(test.machine().mode()).toBe("closed");
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.diagnostics).toEqual(["local"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("never flushes or delivers at row K9 either", async () => {
    // The same guards on the input the node controls directly: one plaintext
    // frame would otherwise lock legacy, flush the ceremony's buffered sends,
    // and hand the frame to the RPC parser.
    const test = harness({ pairingOnly: true, selectionClass: "legacy-eligible" });
    test.engine.send(utf8('{"_tag":"Request","id":1}'));

    deliver(test.socket, LEGACY_RPC);
    await flush();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.engine.bufferedAmount).toBe(0);
    expect(test.machine().mode()).toBe("closed");
    expect(test.events.onData).not.toHaveBeenCalled();
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.diagnostics).toEqual(["local"]);
  });

  it("releases nothing on a hypothetical accept path either", async () => {
    const test = harness({ pairingOnly: true, selectionClass: "unexpected" });
    test.engine.send(utf8('{"_tag":"Request","id":1}'));
    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));

    // A conforming node never emits this to an unapproved client; §13.2 fixes
    // the outcome anyway — "no application payload is released REGARDLESS OF
    // OUTCOME" — so a node that answers one gains nothing.
    deliver(test.socket, accept.record, 1);
    await flush();

    expect(outbound(test.socket)).toHaveLength(1);
    expect(test.machine().mode()).toBe("closed");
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.events.onData).not.toHaveBeenCalled();
    expect(test.diagnostics).toEqual(["P21"]);
  });
});

// ─── §4.4 no legacy after validated evidence ─────────────────────────────────

describe("§4.4 no legacy after validated evidence", () => {
  it("sends the hello rather than idling past T_ADV, and never falls back", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();
    expect(outbound(test.socket)).toHaveLength(1);

    test.advance(T_ADV);
    expect(test.machine().mode()).toBe("negotiating");
    test.advance(T_HANDSHAKE);

    // P20, not a legacy lock — the two are the only outcomes this rule leaves.
    expect(test.machine().mode()).toBe("closed");
    expect(test.diagnostics).toEqual(["P20"]);
  });

  it("closes FATAL-PRE with P21 rather than proceeding when the client cannot", async () => {
    const test = harness({ pairingOnly: true });
    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));
    deliver(test.socket, accept.record, 1);
    await flush();

    expect(test.diagnostics).toEqual(["P21"]);
    expect(test.machine().mode()).toBe("closed");
  });
});

// ─── §13.1's release gate ────────────────────────────────────────────────────

describe("§13.1 release gate — a native channel with no verified pin never opens", () => {
  /**
   * The state this exists for is NOT the ceremony's own channel.
   *
   * The owner approved this device at the node CLI (§13.2 step 5's node half)
   * and has not yet marked the pin `verified` here, or this device lost its
   * durable trust document while the node kept the approval (§13.1.1 partial
   * loss). The node then holds an approved record and answers a
   * cryptographically sound `E2EEServerAccept` — which is exactly the input a
   * `pairingOnly` flag keyed on a local pairing record does not see, because on
   * this path no such record exists.
   */
  it("closes FATAL-PRE with P21 on a sound accept and releases nothing", async () => {
    const test = harness({ selectionClass: "legacy-eligible" });
    test.engine.send(utf8('{"_tag":"Request","id":1}'));
    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));

    deliver(test.socket, accept.record, 1);
    await flush();

    // §13.1: "A native client MUST NOT release application payload under the
    // active-Hub guarantee until the pin is `verified`." The hello is the only
    // thing on the wire, the buffered application send was discarded unflushed,
    // and no session was opened.
    expect(test.machine().mode()).toBe("closed");
    expect(outbound(test.socket)).toHaveLength(1);
    expect(test.engine.bufferedAmount).toBe(0);
    expect(test.events.onOpen).not.toHaveBeenCalled();
    expect(test.events.onData).not.toHaveBeenCalled();
    expect(test.diagnostics).toEqual(["P21"]);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });

  it("leaves rows K9 and K13 alone — first contact may still fall back to legacy", async () => {
    // The gate closes the E2EE valve ALONE. §12.1.1 branch (a) classifies
    // genuine first contact legacy-eligible, and a node running no §4 channel is
    // reached through exactly these two rows; folding the gate into
    // `pairingOnly` would make both of them fatal.
    const k13 = harness({ selectionClass: "legacy-eligible" });
    k13.advance(T_ADV);
    expect(k13.machine().mode()).toBe("legacy");

    const k9 = harness({ selectionClass: "legacy-eligible" });
    deliver(k9.socket, LEGACY_RPC);
    await flush();
    expect(k9.machine().mode()).toBe("legacy");
  });

  it("locks e2ee for the same channel once the selection resolves to a pin", async () => {
    // The positive direction, so the gate cannot be satisfied by never
    // establishing at all.
    const { test } = await establish();
    expect(test.machine().mode()).toBe("e2ee");
    expect(test.diagnostics).toEqual([]);
  });
});

// ─── §13.5 the web verification string ───────────────────────────────────────

describe("§13.5 WebSAS — the web tier's advisory code, and only the web tier's", () => {
  /** Everything a web attempt is: no static, no pin, no account-scoped record. */
  const WEB_CREDENTIALS: E2eeClientHandshakeCredentials = { tier: "web" };

  /** Drive rows K1 and K5 on the WEB tier and collect what was published. */
  async function establishWeb(overrides: Partial<RelayE2eeInitiatorAttempt> = {}) {
    const codes: unknown[] = [];
    const test = harness({
      credentials: WEB_CREDENTIALS,
      onWebVerificationCode: (code) => codes.push(code),
      ...overrides,
    });
    deliver(test.socket, CARRIER);
    await flush();
    const hello = outbound(test.socket).at(-1);
    const accept = hello === undefined ? undefined : respond(Uint8Array.from(hello));
    if (accept !== undefined) {
      deliver(test.socket, accept.record, 1);
      await flush();
    }
    return { test, accept, codes };
  }

  it("publishes the code once, at the e2ee lock, and it is the node's own value", async () => {
    const { test, accept, codes } = await establishWeb();

    expect(test.machine().mode()).toBe("e2ee");
    expect(codes).toHaveLength(1);
    // §13.5's whole purpose: the owner compares this against what the node CLI
    // shows for the same session. The node derives it from the ephemeral it read
    // off message 1 and its own §8.8 binding, so agreement here is the property.
    expect(codes[0]).toBe(
      deriveE2eeWebSas({
        nodeIdentityPublicKey: NODE_IDENTITY_PUBLIC,
        webEphemeralPublicKey: accept!.peerEphemeralPublicKey,
        sessionBindingHash: accept!.sessionBindingHash,
      }).display,
    );
    // A RENDERED STRING AND NOTHING ELSE. No app tier ever receives the
    // ephemeral, so no surface can draw a code for a handshake this client did
    // not complete — which is exactly what §13.5's session binding rests on.
    expect(typeof codes[0]).toBe("string");
    expect(codes[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("never publishes one for a native attempt, pin or no pin", async () => {
    const codes: unknown[] = [];
    const test = harness({
      verifiedPin: VERIFIED_PIN,
      onWebVerificationCode: (code) => codes.push(code),
    });
    deliver(test.socket, CARRIER);
    await flush();
    deliver(test.socket, respond(Uint8Array.from(outbound(test.socket).at(-1)!)).record, 1);
    await flush();

    // The native channel established — so this is a withheld code, not an
    // unreached branch — and §13.4's long-term safety number is its value.
    expect(test.machine().mode()).toBe("e2ee");
    expect(codes).toEqual([]);
  });

  it("publishes nothing on a FATAL-PRE row, on either side of the hello", async () => {
    // §11.2: a client executing FATAL-PRE sends nothing and closes. There is no
    // session, so there is nothing for a code to describe — and a string that
    // outlived its channel is exactly the "value the operator can read that
    // describes a session that does not exist" the node's own rule forbids.
    // Row K2 / §11.2 P15: an unusable statement under a latched selection, so
    // no hello is ever built and no ephemeral ever exists.
    const codes: unknown[] = [];
    const k2 = harness({
      credentials: WEB_CREDENTIALS,
      selectionClass: "latched",
      onWebVerificationCode: (code) => codes.push(code),
    });
    deliver(k2.socket, UNUSABLE_CARRIER);
    await flush();
    expect(k2.machine().mode()).toBe("closed");
    expect(k2.diagnostics).toEqual(["P15"]);
    expect(codes).toEqual([]);

    // Row K6: a hello went out and the accept does not verify.
    const test = harness({
      credentials: WEB_CREDENTIALS,
      onWebVerificationCode: (code) => codes.push(code),
    });
    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));
    const tampered = Uint8Array.from(accept.record);
    tampered[tampered.length - 1]! ^= 0xff;
    deliver(test.socket, tampered, 1);
    await flush();
    expect(test.machine().mode()).toBe("closed");
    expect(codes).toEqual([]);

    // Row K15: the handshake deadline expires with the accept never arriving.
    const expired = harness({
      credentials: WEB_CREDENTIALS,
      onWebVerificationCode: () => codes.push("K15"),
    });
    deliver(expired.socket, CARRIER);
    await flush();
    expired.advance(T_HANDSHAKE);
    expect(expired.machine().mode()).toBe("closed");
    expect(expired.diagnostics).toEqual(["P20"]);
    expect(codes).toEqual([]);
  });

  it("publishes nothing on the two FATAL-PRE rows that follow an established accept", async () => {
    // THE ROWS ABOVE HAVE NO SESSION MATERIAL AT ALL, which is why they cannot
    // observe where the publish sits. §4.5's P14 and §11.2's P21 are the only
    // FATAL-PRE rows reached AFTER `receiveServerAccept` returned an established
    // result — an ephemeral, a session binding, and secrets all exist — so they
    // are the only rows on which a `WebSAS` could actually be drawn for a channel
    // that never opened. On the web tier that string is the whole of the owner's
    // handshake evidence (§13.5), and the node's own rule is that a value the
    // owner can read must describe a session that exists.

    // Row P14 / §4.5: CONFORMING limits whose plaintext ceiling is not positive,
    // so the channel fails during establishment. The hand-built host is what
    // reaches it — the engine's admission bound preempts the row on the real
    // path.
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 2_048,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 2_048,
    });
    expect(e2eeChannelSizeBudget(limits).establishable).toBe(false);
    const p14Codes: unknown[] = [];
    const p14 = standalone(
      {
        credentials: WEB_CREDENTIALS,
        onWebVerificationCode: (code) => p14Codes.push(code),
      },
      limits,
    );
    expect(await p14.machine.intercept(CARRIER)).toEqual({ kind: "claimed" });
    expect(await p14.machine.intercept(respond(p14.emitted.at(-1)!).record)).toEqual({
      kind: "rejected",
    });
    expect(p14.machine.mode()).toBe("closed");
    expect(p14.events).toEqual(["diagnostic:P14", "close:channel_rejected"]);
    expect(p14Codes).toEqual([]);

    // Row P21 / §13.2 step 2: a pairing-only attempt releases nothing at all
    // regardless of outcome, and a code is a release the owner reads.
    const p21Codes: unknown[] = [];
    const p21 = harness({
      credentials: WEB_CREDENTIALS,
      pairingOnly: true,
      onWebVerificationCode: (code) => p21Codes.push(code),
    });
    deliver(p21.socket, CARRIER);
    await flush();
    deliver(p21.socket, respond(Uint8Array.from(outbound(p21.socket).at(-1)!)).record, 1);
    await flush();
    expect(p21.machine().mode()).toBe("closed");
    expect(p21.diagnostics).toEqual(["P21"]);
    expect(p21.events.onOpen).not.toHaveBeenCalled();
    expect(p21Codes).toEqual([]);
  });

  it("locks the channel whether or not a caller asked for the code", async () => {
    // §11.2 admits no channel outcome that varies with a display duty: omitting
    // the callback reaches the same mode, the same release, and the same one
    // bounded hello. (The bytes differ only in the §8.5 nonce and the ephemeral,
    // both of which come from the §14.5 CSPRNG on this path.)
    const withCallback = await establishWeb();
    const without = harness({ credentials: WEB_CREDENTIALS });
    deliver(without.socket, CARRIER);
    await flush();
    deliver(without.socket, respond(Uint8Array.from(outbound(without.socket).at(-1)!)).record, 1);
    await flush();

    for (const test of [without, withCallback.test]) {
      expect(test.machine().mode()).toBe("e2ee");
      expect(test.events.onOpen).toHaveBeenCalledOnce();
      expect(test.diagnostics).toEqual([]);
      expect(closeReasons(test.socket)).toEqual([]);
      const emitted = outbound(test.socket);
      expect(emitted).toHaveLength(1);
      const hello = decodeE2eeClientHello(Uint8Array.from(emitted[0]!));
      expect(hello.kind === "ok" && hello.value.tier).toBe("web");
    }
  });

  it("releases application payload on the web tier — §13.1's gate is native-only", async () => {
    // The reason the web row could not reuse `unverified`: web holds no durable
    // pin of any kind (§6.3, §13.1), so the release gate does not apply to it
    // and an NX channel carries application traffic exactly as a locked native
    // one does. A tier that reported itself unusable here would be lying.
    const { test } = await establishWeb();
    expect(test.machine().mode()).toBe("e2ee");
    expect(test.events.onOpen).toHaveBeenCalledOnce();
    expect(test.diagnostics).toEqual([]);
  });
});

// ─── §8.3 provenance and §8.8 wiring ─────────────────────────────────────────

describe("§8.3 provenance — elements 9 and 17 come from the resolved verified pin", () => {
  it("builds the context commitment from the pin, not from the statement", async () => {
    const test = harness({
      selectionClass: "latched",
      verifiedPin: {
        identityFingerprint: NODE_IDENTITY_FINGERPRINT,
        continuityId: CONTINUITY_ID,
      },
    });
    deliver(test.socket, CARRIER);
    await flush();

    const hello = decodeE2eeClientHello(Uint8Array.from(outbound(test.socket).at(-1)!));
    if (hello.kind !== "ok") throw new Error("expected a decodable hello");
    const expected = e2eeAuthorizationContextCommitment(
      encodeE2eeAuthorizationContext({
        hubOrigin: HUB_ORIGIN,
        channelId: CHANNEL_ID,
        relayProtocolMajor: 1,
        relayProtocolMinor: 2,
        e2eeVersion: 1,
        suiteId: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
        nodeId: NODE_ID,
        // The PIN's fingerprint and continuity id, which is what §8.3 requires
        // wherever a verified pin resolves.
        nodeIdentityFingerprint: NODE_IDENTITY_FINGERPRINT,
        clientIntendedCapability: "ryco.rpc",
        clientIntendedRole: "operator",
        channelOpenCapability: "ryco.rpc",
        channelOpenEffectiveRole: "operator",
        nodeAgreementFingerprint: e2eeKeyFingerprint("agreement", NODE_AGREEMENT_PUBLIC),
        nodeContinuityChainTranscripts: [],
        nodeContinuityId: CONTINUITY_ID,
        client: {
          tier: "native",
          accountId: ACCOUNT_ID,
          identityFingerprint: e2eeKeyFingerprint("client-identity", CLIENT_IDENTITY_PUBLIC),
          agreementFingerprint: e2eeKeyFingerprint("agreement", CLIENT_AGREEMENT_PUBLIC),
        },
      }),
    );
    expect(Buffer.from(hello.value.contextCommitment).toString("hex")).toBe(
      Buffer.from(expected).toString("hex"),
    );
  });

  it("takes the ROTATED fingerprint, not the pinned one, once the chain authenticates", async () => {
    // The only direction in which elements 9 and 17 can be told apart. Under
    // `pin-unchanged` §5.2 has already proved the two sources byte-equal — step
    // 2 recomputes the statement's fingerprint from its own key and the chain
    // walk compares the pin against it — so a rotation is what shows whose value
    // the hello carries. §8.3 wants the CURRENT identity, authenticated back to
    // the pin by the §7.5 chain; committing the pin's outgoing fingerprint would
    // build a context the node cannot reconstruct.
    const test = harness({
      selectionClass: "latched",
      verifiedPin: {
        identityFingerprint: PREVIOUS_IDENTITY_FINGERPRINT,
        continuityId: CONTINUITY_ID,
      },
    });
    deliver(test.socket, ROTATED_CARRIER);
    await flush();

    const hello = decodeE2eeClientHello(Uint8Array.from(outbound(test.socket).at(-1)!));
    if (hello.kind !== "ok") throw new Error("expected a decodable hello");
    const context = (nodeIdentityFingerprint: Uint8Array): Uint8Array =>
      e2eeAuthorizationContextCommitment(
        encodeE2eeAuthorizationContext({
          hubOrigin: HUB_ORIGIN,
          channelId: CHANNEL_ID,
          relayProtocolMajor: 1,
          relayProtocolMinor: 2,
          e2eeVersion: 1,
          suiteId: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
          nodeId: NODE_ID,
          nodeIdentityFingerprint,
          clientIntendedCapability: "ryco.rpc",
          clientIntendedRole: "operator",
          channelOpenCapability: "ryco.rpc",
          channelOpenEffectiveRole: "operator",
          nodeAgreementFingerprint: e2eeKeyFingerprint("agreement", NODE_AGREEMENT_PUBLIC),
          nodeContinuityChainTranscripts: [ROTATION.transcript],
          nodeContinuityId: CONTINUITY_ID,
          client: {
            tier: "native",
            accountId: ACCOUNT_ID,
            identityFingerprint: e2eeKeyFingerprint("client-identity", CLIENT_IDENTITY_PUBLIC),
            agreementFingerprint: e2eeKeyFingerprint("agreement", CLIENT_AGREEMENT_PUBLIC),
          },
        }),
      );
    const committed = Buffer.from(hello.value.contextCommitment).toString("hex");
    expect(committed).toBe(Buffer.from(context(NODE_IDENTITY_FINGERPRINT)).toString("hex"));
    expect(committed).not.toBe(Buffer.from(context(PREVIOUS_IDENTITY_FINGERPRINT)).toString("hex"));

    // And the node — which reconstructs the same context from ITS OWN current
    // identity — accepts it, which is the check this provenance exists to pass.
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!), NOW, ROTATED_ADVERTISED);
    deliver(test.socket, accept.record, 1);
    await flush();
    expect(test.machine().mode()).toBe("e2ee");
  });

  it("closes FATAL-PRE when the statement cannot authenticate to the pin", async () => {
    const test = harness({
      selectionClass: "latched",
      verifiedPin: {
        identityFingerprint: e2eeKeyFingerprint("node-identity", ed25519.getPublicKey(NODE_SEED)),
        continuityId: "nct_HHHHHHHHHHHHHHHHHHHHHH",
      },
    });
    deliver(test.socket, CARRIER);
    await flush();

    // §5.2 step 6: a continuity id disagreeing with the pinned value is already
    // channel-fatal before a hello may be sent, so no hello exists to carry an
    // adopted value.
    expect(outbound(test.socket)).toEqual([]);
    expect(test.diagnostics).toEqual(["P15"]);
  });

  it("commits to the capability and role the channel.open actually presented", async () => {
    const test = harness();
    deliver(test.socket, CARRIER);
    await flush();

    // §8.3 requires elements 11–12 to byte-equal elements 13–14 at both
    // endpoints; the node reconstructs the context from its own `channel.open`
    // and refuses a hello whose commitment disagrees in EITHER direction. The
    // synthetic node accepting this hello is that check passing.
    expect(() => respond(Uint8Array.from(outbound(test.socket).at(-1)!))).not.toThrow();
  });
});

describe("§8.8 wiring — the client hashes its OWN hello wire bytes", () => {
  it("an honest handshake produces a matching confirmation", async () => {
    const { test } = await establish();
    expect(test.machine().mode()).toBe("e2ee");
  });

  it("a suite list stripped in transit after the hello was hashed breaks the confirmation", async () => {
    // §16.3 F16's `suite-list-strip-after-the-hello-was-hashed`: every node-side
    // check passes, so the node's transcript covers the STRIPPED bytes while the
    // client's covers the original.
    const test = harness({ localSuitePreference: [E2EE_SUITE_25519_CHACHAPOLY_SHA256, 2] });
    deliver(test.socket, CARRIER);
    await flush();
    const sent = Uint8Array.from(outbound(test.socket).at(-1)!);
    const delivered = Uint8Array.from(sent);
    // The `offeredSuites` array header and its two entries sit at a fixed offset
    // in the §8.5 wrapper; strip the second entry and shorten the array.
    const index = delivered.indexOf(0x82, 6);
    expect(index).toBeGreaterThan(0);
    expect(delivered[index + 1]).toBe(0x01);
    expect(delivered[index + 2]).toBe(0x02);
    const stripped = new Uint8Array(delivered.byteLength - 1);
    stripped.set(delivered.subarray(0, index));
    stripped[index] = 0x81;
    stripped[index + 1] = 0x01;
    stripped.set(delivered.subarray(index + 3), index + 2);

    const accept = respond(stripped);
    deliver(test.socket, accept.record, 1);
    await flush();

    expect(test.diagnostics).toEqual(["P16"]);
    expect(test.machine().mode()).toBe("closed");
    expect(outbound(test.socket)).toHaveLength(1);
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
  });
});

// ─── §5.2's verdict, §11.2's erasure, §4.4's timers ──────────────────────────

describe("§5.2 — the verdict reaches the caller's durable trust state", () => {
  it("hands every validated statement to the trust store and nothing else", async () => {
    // The §13.1 pin the NEXT connection classifies against is written from this
    // callback. A client that established `e2ee` and recorded nothing would
    // re-classify as first contact every time and never latch (§13.2.1), with
    // no wire symptom at all — which is why the delivery is asserted here and
    // not left to the caller's own suite.
    const verified = harness();
    deliver(verified.socket, CARRIER);
    await flush();
    expect(verified.statements.map((verification) => verification.kind)).toEqual(["verified"]);

    // Rows K3 and K2 alike: the row decides the CHANNEL, and the store still
    // learns what this channel presented.
    const eligible = harness({ selectionClass: "legacy-eligible" });
    deliver(eligible.socket, UNUSABLE_CARRIER);
    await flush();
    expect(eligible.statements.map((verification) => verification.kind)).toEqual(["unusable"]);
    expect(eligible.diagnostics).toEqual(["K3"]);

    const latched = harness({ selectionClass: "latched" });
    deliver(latched.socket, UNUSABLE_CARRIER);
    await flush();
    expect(latched.statements.map((verification) => verification.kind)).toEqual(["unusable"]);
    expect(latched.diagnostics).toEqual(["P15"]);
  });

  it("records nothing on the rows that never reach §5.2", async () => {
    for (const payload of [
      encodeE2eeNegotiationRecord(E2EE_NEGOTIATION_TYPE_CLIENT_HELLO, new Uint8Array([0x80])), // K8
      new Uint8Array([0x01, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // K11
      new Uint8Array([0xff]), // K12
    ]) {
      const test = harness();
      deliver(test.socket, payload);
      await flush();
      expect(test.statements).toEqual([]);
    }
  });
});

describe("§11.2 — the FATAL-PRE procedure erases what it built", () => {
  it("zeroizes the buffered plaintext rather than only dropping it", async () => {
    // The rows above assert that no buffered byte reached the wire; §4.4's
    // discard path also has to leave none of it resident. The engine holds its
    // OWN copy — the caller's payload is deliberately untouched — so the wipe is
    // observed through the one operation that can perform it.
    const wiped: Uint8Array[] = [];
    const fill = Uint8Array.prototype.fill;
    const spy = vi.spyOn(Uint8Array.prototype, "fill").mockImplementation(function (
      this: Uint8Array,
      ...args: Parameters<typeof fill>
    ) {
      if (args[0] === 0) wiped.push(this);
      return fill.apply(this, args);
    });

    const test = harness({ selectionClass: "latched" });
    // A length nothing else in this channel shares, so the copy is identifiable.
    const submitted = new Uint8Array(4_099).fill(0x7b);
    test.engine.send(submitted);
    deliver(test.socket, LEGACY_PING); // K10 / P18.
    await flush();
    spy.mockRestore();

    const copies = wiped.filter((value) => value.byteLength === submitted.byteLength);
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect(copy.some((byte) => byte !== 0)).toBe(false);
    expect(test.diagnostics).toEqual(["P18"]);
    // The caller's own buffer is not the engine's to erase.
    expect(submitted.every((byte) => byte === 0x7b)).toBe(true);
  });

  it("destroys the partial handshake BEFORE it closes, on every path that ends one", async () => {
    // §11.2 step 2, in the order the procedure states it. Each of these paths
    // holds a live `E2eeClientHandshake` — an ephemeral agreement secret and a
    // Noise state — and none of it is observable from the wire, so the sequence
    // is what pins the step apart from the teardown that would follow anyway.
    const fatal = standalone();
    fatal.watchDestroy();
    await fatal.machine.intercept(CARRIER);
    expect(fatal.events).toEqual([]);
    // Row K4, chosen because the handshake it ends is one nothing else has
    // touched: a failing accept destroys itself inside `receiveServerAccept`, so
    // that row cannot show whether the procedure's own step ran.
    await fatal.machine.intercept(CARRIER); // K4 / P4.
    expect(fatal.events).toEqual(["destroy", "diagnostic:P4", "close:channel_rejected"]);

    const closing = standalone();
    closing.watchDestroy();
    await closing.machine.intercept(CARRIER);
    expect(await closing.machine.beginClose()).toBe("opened");
    expect(closing.events).toEqual(["destroy", "close:clean"]);

    const disposed = standalone();
    disposed.watchDestroy();
    await disposed.machine.intercept(CARRIER);
    disposed.machine.dispose();
    expect(disposed.events).toEqual(["destroy"]);
  });

  it("erases the §6.5 secrets a pairing-only attempt was handed", async () => {
    // §13.2 P21: the accept verified, so this client derived the same session
    // material the node did — and then refused to use it. The node's copy is not
    // a substitute for erasing this one.
    const received = vi.spyOn(E2eeClientHandshake.prototype, "receiveServerAccept");
    const test = harness({ pairingOnly: true });
    deliver(test.socket, CARRIER);
    await flush();
    const accept = respond(Uint8Array.from(outbound(test.socket).at(-1)!));
    deliver(test.socket, accept.record, 1);
    await flush();

    expect(test.diagnostics).toEqual(["P21"]);
    const established = received.mock.results.at(-1);
    if (established?.type !== "return" || established.value.kind !== "established") {
      throw new Error("expected the pairing attempt to have established secrets");
    }
    const { secrets } = established.value;
    for (const key of [
      secrets.epochSecretC2N,
      secrets.epochSecretN2C,
      secrets.exporterSecret,
      secrets.serverConfirmationKey,
    ]) {
      expect(key.byteLength).toBeGreaterThan(0);
      expect(key.some((byte) => byte !== 0)).toBe(false);
    }
  });
});

describe("§4.4 timers — a cancelled deadline is cancelled, not merely ignored", () => {
  it("holds exactly the deadline the state is subject to", async () => {
    // The callbacks re-read the state, so a leaked timer changes no protocol
    // outcome and no other assertion in this file moves when one is left armed.
    // What it does change is what a suspended React Native app is holding.
    const test = harness();
    expect(test.armed()).toBe(1); // `T_ADV`, from `channel.accept`.

    deliver(test.socket, CARRIER);
    await flush();
    // `T_ADV` is cancelled at the hello emit and `T_HANDSHAKE` armed in its
    // place — one deadline, not two.
    expect(test.armed()).toBe(1);

    test.advance(T_ADV + T_HANDSHAKE); // K15 / P20.
    expect(test.armed()).toBe(0);
  });

  it("clears both deadlines on every exit from negotiating", async () => {
    const legacy = harness();
    deliver(legacy.socket, LEGACY_RPC); // K9.
    await flush();
    expect(legacy.machine().mode()).toBe("legacy");
    expect(legacy.armed()).toBe(0);

    const { test: established } = await establish();
    expect(established.machine().mode()).toBe("e2ee"); // K5.
    expect(established.armed()).toBe(0);

    const fatal = harness({ selectionClass: "latched" });
    deliver(fatal.socket, LEGACY_PING); // K10 / P18.
    await flush();
    expect(fatal.armed()).toBe(0);

    const aborted = harness();
    aborted.machine().abort();
    expect(aborted.armed()).toBe(0);

    const disposed = harness();
    disposed.machine().dispose();
    expect(disposed.armed()).toBe(0);

    const closing = harness();
    await closing.machine().beginClose();
    expect(closing.armed()).toBe(0);
  });
});

// ─── §4.5 / §11.2 P14 ────────────────────────────────────────────────────────

describe("§4.5 — a channel with no positive plaintext ceiling never establishes", () => {
  it("closes FATAL-PRE with P14 at the accept, and erases what it was handed", async () => {
    // CONFORMING relay limits: `maxQueuedBytes` at its floor and
    // `maxControlFrameBytes` equal to it. §4.5 adopts whatever the Hub asserts
    // verbatim, so `plaintextCeiling` is negative here and the channel MUST fail
    // during establishment rather than be released with a silently shrunk one.
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 2_048,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 2_048,
    });
    expect(e2eeChannelSizeBudget(limits).establishable).toBe(false);

    const received = vi.spyOn(E2eeClientHandshake.prototype, "receiveServerAccept");
    const test = standalone({ verifiedPin: VERIFIED_PIN }, limits);
    expect(await test.machine.intercept(CARRIER)).toEqual({ kind: "claimed" });
    const accept = respond(test.emitted.at(-1)!);
    expect(await test.machine.intercept(accept.record)).toEqual({ kind: "rejected" });

    // The valve was never touched, so nothing was released to the application.
    expect(test.events).toEqual(["diagnostic:P14", "close:channel_rejected"]);
    expect(test.machine.mode()).toBe("closed");

    // §6.5 ownership transferred with `receiveServerAccept`, and this row is
    // the one that ends the channel holding it.
    const established = received.mock.results.at(-1);
    if (established?.type !== "return" || established.value.kind !== "established") {
      throw new Error("expected the accept to have produced session secrets");
    }
    expect(established.value.secrets.epochSecretC2N.some((byte) => byte !== 0)).toBe(false);
    expect(established.value.secrets.epochSecretN2C.some((byte) => byte !== 0)).toBe(false);
  });
});

// ─── the RN lifecycle abort ──────────────────────────────────────────────────

describe("a client-initiated abort while negotiating", () => {
  it("closes FATAL-PRE, emits no record, and discards the buffer", () => {
    const test = harness();
    test.engine.send(utf8('{"_tag":"Request","id":1}'));

    test.machine().abort();

    expect(outbound(test.socket)).toEqual([]);
    expect(test.engine.bufferedAmount).toBe(0);
    expect(test.machine().mode()).toBe("closed");
    expect(closeReasons(test.socket)).toEqual(["channel_rejected"]);
    expect(test.events.onOpen).not.toHaveBeenCalled();
  });

  it("is a no-op once a mode has locked", async () => {
    const { test } = await establish();
    test.machine().abort();
    expect(test.machine().mode()).toBe("e2ee");
  });
});
