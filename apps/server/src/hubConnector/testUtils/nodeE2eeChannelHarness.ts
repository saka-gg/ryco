import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

import { expect } from "vite-plus/test";

import {
  RELAY_INITIAL_LIMITS,
  type RelayAccountGrantContext,
  type RelayChannelId,
  type RelayCloseReason,
  type RelayDataFrame,
  type RelayFrame,
  type RelayLimits,
} from "@ryco/contracts/relay";
import { decodeRelayFrame } from "@ryco/shared/relayCodec";
import { E2EE_PREKEY_LIFETIME } from "@ryco/shared/relayE2eeConstants";
import {
  E2eeCloseMachine,
  type E2eeCloseRecordToSend,
  type E2eeSequencePosition,
} from "@ryco/shared/relayE2eeClose";
import {
  E2eeClientHandshake,
  type E2eeClientAuthorization,
  type E2eeClientHandshakeCredentials,
  type E2eeHandshakeChannel,
} from "@ryco/shared/relayE2eeHandshake";
import { deriveE2eeAgreementPublicKey } from "@ryco/shared/relayE2eeKeys";
import {
  E2eeRecordSession,
  type E2eeDirectionState,
  type E2eeSyntheticDirectionState,
} from "@ryco/shared/relayE2eeSession";
import {
  encodeClientE2eePrekeyTranscript,
  encodeNodeE2eePrekeyTranscript,
} from "@ryco/shared/relayE2eeTranscripts";
import {
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  type E2eeInnerRecordType,
} from "@ryco/shared/relayE2eeWire";
import { RelayMessageAssembler } from "@ryco/shared/relayMessageChunks";

import {
  makeNodeE2eeCapabilityStatementClient,
  type NodeE2eeAdvertisement,
  type NodeE2eeAdvertisementResult,
} from "../../hubIdentity/NodeE2eeCapabilityStatement.ts";
import type { NodeE2eeChannelRegistration } from "../../hubIdentity/NodeE2eePolicyClient.ts";
import {
  e2eePolicyNarrows,
  effectiveNodeE2eePolicy,
  initialNodeE2eePolicyRecord,
  nodeE2eeAdmissionPolicyOf,
  type EffectiveNodeE2eePolicy,
  type NodeE2eeAdmissionPolicy,
  type NodeE2eePolicyRecordFile,
  type NodeE2eePolicyStore,
} from "../../hubIdentity/NodeE2eePolicyStore.ts";
import type { NodeE2eePrekeyCertificate } from "../../hubIdentity/NodeE2eePrekeyClient.ts";
import {
  makeNodeE2eeChannelAdvertiser,
  type E2eeAdvertisementUnavailableReason,
} from "../NodeE2eeChannelAdvertiser.ts";
import {
  makeNodeE2eeChannelSession,
  makeNodeE2eeHandshakeRateLimiter,
  type NodeE2eeChannelAuthorization,
  type NodeE2eeChannelSession,
  type NodeE2eeChannelSessionSources,
} from "../NodeE2eeChannelSession.ts";
import {
  makeNodeE2eeRelayChannelSession,
  nodeE2eeChannelPlaintextCeiling,
} from "../NodeE2eeRelayChannel.ts";
import { RelayChannelRegistry, type RelayRpcChannelSession } from "../RelayChannelRegistry.ts";
import { RelaySendQueue } from "../RelaySendQueue.ts";

// The node's E2EE layer assembled from the real relay pieces, shared by every
// test that needs a node to talk to.
//
// It lives here rather than inside one test file because two suites now drive
// it: `NodeE2eeChannelSession.test.ts`, which asserts the module's behavior
// directly, and `relayE2eeNodeCorpus.test.ts`, which replays the committed
// §16.3 F10 fixture rows through it. A second copy of this assembly would be a
// second chance for the two to disagree about what "the node" is, which is
// exactly the disagreement the corpus exists to rule out.
//
// `RelayChannelRegistry` supplies the send handle, the §9.3 admission handle, the
// close handle, and the acceptance announcement. The channel session's
// `intercept` sits exactly where `RpcByteSession` puts it — after the relay
// message assembler and before the RPC parser — so `deliveredToParser` is
// literally the set of bytes that would reach the parser and nothing else.
//
// EVERY INBOUND PAYLOAD GOES IN AS A RELAY `data` FRAME and every assertion a
// caller makes is against bytes the send queue put on the socket, so nothing
// can pass while the seam it is about is bypassed.
//
// TEST-ONLY KEY MATERIAL. The Ed25519 identity is generated per run; the X25519
// and P-256 material is the published RFC vector material `relayE2eeHandshake`'s
// own suite pins, so a wrong curve or encoding shows up immediately. NONE OF IT
// MAY EVER REACH A REAL ENDPOINT.

export const HUB_ORIGIN = "https://relay.example";
export const NODE_ID = `node_${"N".repeat(22)}`;
export const IDENTITY_KEY_ID = `nkey_${"K".repeat(22)}`;
export const PREKEY_ID = `epk_${"P".repeat(22)}`;
export const CONTINUITY_ID = `nct_${"C".repeat(22)}`;
export const ACCOUNT_ID = "acct_0123456789";
export const CHANNEL_ID = `ch_${"A".repeat(22)}` as RelayChannelId;
export const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const version = { protocolMajor: 1, protocolMinor: 2 } as const;
export const limits: RelayLimits = RELAY_INITIAL_LIMITS;
export const CAPABILITY = "ryco.rpc" as const;
export const ROLE = "owner" as const;
export const NOW = 1_784_160_030_000;

/** Let every pending microtask run: `protect` is serialized and asynchronous. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const NODE_AGREEMENT_SECRET = hex(
  "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
);
export const NODE_AGREEMENT_PUBLIC = deriveE2eeAgreementPublicKey(NODE_AGREEMENT_SECRET);
export const CLIENT_AGREEMENT_SECRET = hex(
  "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
);
export const CLIENT_AGREEMENT_PUBLIC = deriveE2eeAgreementPublicKey(CLIENT_AGREEMENT_SECRET);
/**
 * The client device key (§7.1), generated per run through the platform's own
 * P-256 implementation.
 *
 * `ieee-p1363` is the raw `r ‖ s` encoding §7.1 fixes; DER would be rejected by
 * the certificate verifier, which is the point of naming it here rather than
 * relying on a default.
 */
export const clientIdentity = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const CLIENT_IDENTITY_PUBLIC = Uint8Array.from(
  clientIdentity.publicKey.export({ format: "der", type: "spki" }).subarray(-65),
);
export const signClientPrekey = (transcript: Uint8Array): Uint8Array =>
  Uint8Array.from(
    sign("sha256", transcript, {
      key: clientIdentity.privateKey,
      dsaEncoding: "ieee-p1363",
    }),
  );

export const APPROVED: E2eeClientAuthorization = {
  status: "approved",
  maxRole: ROLE,
  capabilitySet: [CAPABILITY],
};

export const PERMISSIVE_POLICY = effectiveNodeE2eePolicy({
  mode: "compatibility",
  requireE2EE: false,
  requireApprovedClientE2EE: false,
  suiteRegistry: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
});

export const REQUIRE_E2EE_POLICY = effectiveNodeE2eePolicy({
  mode: "require-e2ee",
  requireE2EE: true,
  requireApprovedClientE2EE: false,
  suiteRegistry: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
});

export function decodeFrame(bytes: Uint8Array): RelayFrame {
  const result = decodeRelayFrame(bytes);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

/** The relay chunk layer's own prelude, stripped exactly as a receiver does. */
export function stripPrelude(payload: Uint8Array): Uint8Array {
  const assembler = new RelayMessageAssembler();
  const result = assembler.push(payload);
  if (result.kind !== "done") throw new Error("expected one complete message");
  return result.message;
}

/**
 * A real §5.2 statement client over real Ed25519 custody.
 *
 * One per harness, and the same instance answers the node's advertiser and the
 * test's client: §8.3 gives the client's element 15 exactly one source — the
 * statement it validated on this channel — so the material a client uses must be
 * the material the node advertised, not a second statement that merely looks
 * like it.
 */
export function statementClient(policy: () => EffectiveNodeE2eePolicy) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const identityPublicKey = Uint8Array.from(
    createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(SPKI_PREFIX.byteLength),
  );
  const signBytes = (message: Uint8Array): Uint8Array =>
    Uint8Array.from(
      sign(null, message, createPrivateKey({ key: der, format: "der", type: "pkcs8" })),
    );
  // §6.4: a window this node's own advertisement could legitimately carry —
  // open at `NOW` and no longer than `E2EE_PREKEY_LIFETIME`. It used to be
  // `[1_000, 9_000_000_000_000]`, a ~285-year window, which no node responder
  // here ever objected to because §5.2 step 5 is the CLIENT verifier's rule, not
  // the responder's. Nothing caught it until the interop matrix ran the real
  // `verifyNodeE2eeCapabilityStatement` over this statement and got
  // `prekey_lifetime_too_long`. A harness that advertises material a conforming
  // client refuses is a harness that cannot be pointed at one.
  const PREKEY_CREATED_AT = NOW - 60_000;
  const PREKEY_EXPIRES_AT = PREKEY_CREATED_AT + E2EE_PREKEY_LIFETIME;
  const prekey: NodeE2eePrekeyCertificate = {
    hubOrigin: HUB_ORIGIN,
    nodeId: NODE_ID,
    identityKeyId: IDENTITY_KEY_ID,
    prekeyId: PREKEY_ID,
    agreementPublicKey: NODE_AGREEMENT_PUBLIC,
    createdAt: PREKEY_CREATED_AT,
    expiresAt: PREKEY_EXPIRES_AT,
    crossSignature: signBytes(
      encodeNodeE2eePrekeyTranscript({
        hubOrigin: HUB_ORIGIN,
        nodeId: NODE_ID,
        identityKeyId: IDENTITY_KEY_ID,
        prekeyId: PREKEY_ID,
        identityPublicKey,
        agreementPublicKey: NODE_AGREEMENT_PUBLIC,
        createdAt: PREKEY_CREATED_AT,
        expiresAt: PREKEY_EXPIRES_AT,
      }),
    ),
  };
  return makeNodeE2eeCapabilityStatementClient({
    identity: async () => ({
      nodeId: NODE_ID,
      identityKeyId: IDENTITY_KEY_ID,
      identityPublicKey,
      sign: async (envelope) => signBytes(envelope),
    }),
    prekey: async () => prekey,
    continuity: async () => ({ continuityId: CONTINUITY_ID, chain: [] }),
    policy,
    generation: () => 3,
    now: () => NOW,
  });
}

/**
 * An in-memory §12.6 policy store with the real commit semantics and no
 * durability, so a test can run the REAL `NodeE2eePolicyClient` — its ordered
 * procedure, its single snapshot, and its dispatch by phase — against a real
 * channel session.
 */
export function stubPolicyStore(): NodeE2eePolicyStore {
  let record: NodeE2eePolicyRecordFile = initialNodeE2eePolicyRecord();
  let advertised: NodeE2eeAdmissionPolicy = PERMISSIVE_POLICY.advertised;
  const apply = (next: NodeE2eePolicyRecordFile, nextPolicy = advertised) => {
    const previous = effectiveNodeE2eePolicy(advertised);
    const policy = effectiveNodeE2eePolicy(nextPolicy);
    record = next;
    advertised = nextPolicy;
    return {
      record: next,
      policy,
      previous,
      withdrawal: e2eePolicyNarrows(previous, policy),
      changed: true,
    };
  };
  return {
    read: async () => ({
      record,
      policy: effectiveNodeE2eePolicy(advertised),
    }),
    commit: async (proposal) => {
      const requireE2EE = proposal.requireE2EE ?? advertised.requireE2EE;
      const requireApprovedClientE2EE =
        proposal.requireApprovedClientE2EE ?? advertised.requireApprovedClientE2EE;
      const next: NodeE2eeAdmissionPolicy = {
        mode:
          proposal.mode ??
          (requireApprovedClientE2EE
            ? "require-locally-approved-native-e2ee"
            : requireE2EE
              ? "require-e2ee"
              : "compatibility"),
        requireE2EE,
        requireApprovedClientE2EE,
        suiteRegistry: proposal.suiteRegistry ?? advertised.suiteRegistry,
      };
      return apply(
        {
          ...record,
          revision: record.revision + 1,
          generation: record.generation + 1,
          mode: next.mode,
        },
        next,
      );
    },
    recoverGeneration: async () =>
      apply({ ...record, revision: record.revision + 1, generation: record.generation + 1 }),
  };
}

/** A policy registration that admits everything, so a test isolates one rule. */
export function permissiveRegistration(): NodeE2eeChannelRegistration {
  return {
    selectHandshake: () => ({
      establish: () => ({ kind: "entered", established: () => undefined }),
    }),
    lockLegacy: () => ({ kind: "entered" }),
    release: () => undefined,
  };
}

export function authorizationFor(
  record: E2eeClientAuthorization | undefined,
): NodeE2eeChannelAuthorization {
  return {
    lookupClientAuthorization: () => record,
    reReadAuthorization: () => record,
    registerInFlightHandshake: () => ({
      establish: () => ({
        kind: "entered",
        release: () => undefined,
        established: () => undefined,
      }),
      release: () => undefined,
    }),
    // §13.2 step 3 against a stub that holds ONE record rather than a record
    // set: an existing record is not first-seen and creates nothing, and an
    // absent one has no slot here to be created in. Either way the commit owes
    // nothing. The ceremony itself is driven against the real client, in
    // `NodeE2eePairingAdmission.test.ts`.
    evaluatePairingAdmission: () =>
      record === undefined
        ? { kind: "refused", reason: "pending_cap_global", spentPairingWindow: undefined }
        : {
            kind: "existing",
            status: record.status,
            spentPairingWindow: undefined,
            observedRoleRefresh: undefined,
          },
    commitPairingAdmission: async () => undefined,
  };
}

export interface Harness {
  readonly dataPayloads: () => readonly Uint8Array[];
  readonly closeReasons: () => readonly (RelayCloseReason | undefined)[];
  readonly deliveredToParser: readonly Uint8Array[];
  readonly session: () => NodeE2eeChannelSession;
  /** The registry-facing channel, exactly as `HubConnectorLive` binds it. */
  readonly channel: () => RelayRpcChannelSession;
  /** How many times the RPC runtime behind the channel was released. */
  readonly releases: () => number;
  readonly open: () => Promise<NodeE2eeAdvertisement>;
  /** Open a channel whose advertisement this node cannot produce (§5.5). */
  readonly openRaw: () => Promise<void>;
  readonly deliver: (payload: Uint8Array) => Promise<void>;
  /** The peer tore the channel down: the registry's own teardown path. */
  readonly closeFromPeer: () => Promise<void>;
  readonly flush: () => void;
  readonly sendQueue: RelaySendQueue;
  /** §12.5's peer-legacy class: how many occurrences row N2 recorded. */
  readonly fallbacks: () => number;
  /**
   * §12.5's advertisement-unavailable class, as reason labels in the order the
   * advertiser recorded them (§5.5 U1 `undersized-connection`, U2
   * `statement-unavailable`). Separate from `fallbacks` on purpose: §12.5's two
   * classes are two facts about two different parties and are never summed.
   */
  readonly advertisementFallbacks: () => readonly E2eeAdvertisementUnavailableReason[];
  /** The node-local §11.4 diagnostic rows, for asserting WHICH rule fired. */
  readonly rows: () => readonly string[];
  /**
   * Fire `T_HANDSHAKE_NODE` (§4.4 N8, §8.9), without waiting for it.
   *
   * The channel session takes a `RelaySessionScheduler`, so the deadline is a
   * callback this harness holds rather than a real timer: a test drives the
   * expiry deterministically and no suite is made slow, or flaky, by a constant
   * measured in seconds. Returns `false` when no deadline is armed, which is
   * itself an assertable outcome — `announce` arms it only after the carrier
   * reached the send path.
   */
  readonly expireHandshakeDeadline: () => Promise<boolean>;
}

/**
 * The node, assembled from the real relay pieces.
 *
 * `RelayChannelRegistry` supplies the send handle, the §9.3 admission handle,
 * the close handle, and the acceptance announcement. The channel session's
 * `intercept` sits exactly where `RpcByteSession` puts it — after the relay
 * message assembler and before the RPC parser — so `deliveredToParser` is
 * literally the set of bytes that would reach the parser and nothing else.
 */
export async function harness(
  options: {
    readonly policy?: () => EffectiveNodeE2eePolicy;
    readonly protocolMinor?: 2 | 3;
    readonly accountGrantContext?:
      | ((
          advertisement: NodeE2eeAdvertisement,
        ) => RelayAccountGrantContext | Promise<RelayAccountGrantContext>)
      | undefined;
    readonly verifyAccountGrant?: NodeE2eeChannelSessionSources["verifyAccountGrant"];
    readonly authorization?: NodeE2eeChannelAuthorization;
    readonly registration?: () => NodeE2eeChannelRegistration;
    /** §5.5: what this node's statement builder answers, when a test needs U2. */
    readonly readAdvertisement?: () => Promise<NodeE2eeAdvertisementResult>;
    /** §5.5 U1: an asserted chunk limit below `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`. */
    readonly maxDataChunkBytes?: number;
    /**
     * §4.5: an asserted queue bound, which is what actually MOVES the
     * `plaintextCeiling` — `e2eeChannelSizeBudget` derives it from
     * `maxQueuedBytes − maxControlFrameBytes` against `RELAY_MAX_RPC_MESSAGE_BYTES`,
     * and `maxDataChunkBytes` decides only how many chunks a record is cut into.
     * A test that wants a different ceiling has to set this one.
     */
    readonly maxQueuedBytes?: number;
    /**
     * Runs inside `withPrekeySecret`, after the borrow's body has returned and
     * before the borrow resolves — the exact window a §12.6 sweep can land in
     * while a hello is being processed.
     */
    readonly afterPrekeyBorrow?: () => Promise<void>;
    /** §16.3 F9: place the node's send direction at §9.6's exhaustion boundary. */
    readonly syntheticSendState?: E2eeSyntheticDirectionState;
    /**
     * §16.3 F9, for the node's RECEIVE direction.
     *
     * The client's own send state MUST be given the same value — `establish`'s
     * last argument — because §9.2 advances the receiver's expectation by exactly
     * the sender's §9.4 rule: a synthetic state on one side only is a sequence
     * mismatch and tests row Q2 rather than §9.6's exhaustion.
     */
    readonly syntheticReceiveState?: E2eeSyntheticDirectionState;
    /** §13.5: the operator directory this channel publishes itself to. */
    readonly registerSession?: NodeE2eeChannelSessionSources["registerSession"];
  } = {},
): Promise<Harness> {
  const protocol = { protocolMajor: 1, protocolMinor: options.protocolMinor ?? 2 } as const;
  const readyLimits: RelayLimits = {
    ...RELAY_INITIAL_LIMITS,
    ...(options.maxDataChunkBytes === undefined
      ? {}
      : { maxDataChunkBytes: options.maxDataChunkBytes }),
    ...(options.maxQueuedBytes === undefined ? {} : { maxQueuedBytes: options.maxQueuedBytes }),
  };
  const sent: Uint8Array[] = [];
  const socket = {
    bufferedAmount: 0,
    send: (bytes: Uint8Array) => {
      sent.push(Uint8Array.from(bytes));
    },
  };
  const sendQueue = new RelaySendQueue(socket, readyLimits);
  const policy = options.policy ?? (() => PERMISSIVE_POLICY);
  const statements = statementClient(policy);
  // §12.5's advertisement-unavailable class, recorded where the real connector
  // records it: the advertiser's own suppression path, not the channel session.
  // Kept as the ordered list of reason labels rather than a count, because §12.5
  // makes the label part of the occurrence and row N16's claim is about both.
  const advertisementFallbacks: E2eeAdvertisementUnavailableReason[] = [];
  const advertiser = makeNodeE2eeChannelAdvertiser({
    hubOrigin: HUB_ORIGIN,
    readAdvertisement:
      options.readAdvertisement ?? ((hubOrigin) => statements.advertised(hubOrigin)),
    policy,
    recordFallback: async ({ reason }) => {
      advertisementFallbacks.push(reason);
    },
  });
  const deliveredToParser: Uint8Array[] = [];
  const assembler = new RelayMessageAssembler();
  // The channel session's own timers, held rather than run: `expireHandshakeDeadline`
  // below is what fires them. The registry keeps the real scheduler, because
  // nothing here asserts on a registry timer.
  const pendingTimers = new Map<symbol, () => void>();
  const scheduler = {
    setTimeout: (callback: () => void) => {
      const handle = Symbol("e2ee-deadline");
      pendingTimers.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle: unknown) => {
      pendingTimers.delete(handle as symbol);
    },
  };
  let channelSession: NodeE2eeChannelSession | undefined;
  let relayChannel: RelayRpcChannelSession | undefined;
  let releases = 0;
  let fallbacks = 0;
  let inboundSequence = 0;
  const rows: string[] = [];

  const registry = new RelayChannelRegistry({
    limits: readyLimits,
    protocol,
    sendQueue,
    onOutboundReady: () => sendQueue.flush(),
    factory: {
      connectionReady: ({ limits: ready }) =>
        advertiser.connectionReady({ maxDataChunkBytes: ready.maxDataChunkBytes }),
      open: async ({
        channelId,
        capability,
        effectiveRole,
        accountGrantContext,
        send,
        admit,
        close,
      }) => {
        const announcement = await advertiser.openChannel();
        const e2ee = makeNodeE2eeChannelSession({
          channel: {
            hubOrigin: HUB_ORIGIN,
            channelId,
            relayProtocolMajor: protocol.protocolMajor,
            relayProtocolMinor: protocol.protocolMinor,
            channelOpenCapability: capability,
            channelOpenEffectiveRole: effectiveRole,
            ...(accountGrantContext === undefined
              ? {}
              : {
                  accountGrantContext: {
                    relayTicketId: accountGrantContext[1],
                    deviceGrantDigest: Uint8Array.from(accountGrantContext[2]),
                    nodeCapabilityStatementDigest: Uint8Array.from(accountGrantContext[3]),
                  },
                }),
          },
          announcement,
          plaintextCeiling: nodeE2eeChannelPlaintextCeiling(readyLimits),
          send,
          admit,
          close,
          policy,
          registerPolicyChannel: options.registration ?? permissiveRegistration,
          authorization: options.authorization ?? authorizationFor(APPROVED),
          ...(options.verifyAccountGrant === undefined
            ? {}
            : { verifyAccountGrant: options.verifyAccountGrant }),
          withPrekeySecret: async (prekeyId, use) => {
            expect(prekeyId).toBe(PREKEY_ID);
            const result = await use(NODE_AGREEMENT_SECRET);
            await options.afterPrekeyBorrow?.();
            return result;
          },
          rateLimiter: makeNodeE2eeHandshakeRateLimiter(),
          now: () => NOW,
          scheduler,
          recordPeerLegacyFallback: () => {
            fallbacks += 1;
          },
          onDiagnostic: (value) => rows.push(value.row),
          ...(options.registerSession === undefined
            ? {}
            : { registerSession: options.registerSession }),
          ...(options.syntheticSendState === undefined
            ? {}
            : { testOnlySyntheticSendState: options.syntheticSendState }),
          ...(options.syntheticReceiveState === undefined
            ? {}
            : { testOnlySyntheticReceiveState: options.syntheticReceiveState }),
        });
        channelSession = e2ee;
        // The binding `HubConnectorLive` uses, over the same pipeline
        // `RpcByteSession` provides: reassemble and strip the prelude, then
        // discriminate. Nothing reaches `deliveredToParser` except an `rpc`
        // disposition, which is what the parser boundary is.
        relayChannel = makeNodeE2eeRelayChannelSession({
          e2ee,
          rpc: {
            receive: async (bytes) => {
              const assembled = assembler.push(bytes);
              if (assembled.kind === "error") throw new Error(assembled.reason);
              if (assembled.kind === "pending") return true;
              const disposition = await e2ee.intercept(assembled.message);
              if (disposition.kind === "rpc") deliveredToParser.push(disposition.message);
              return disposition.kind !== "rejected";
            },
            queuedBytes: async () => 0,
            supportsChunkedMessages: () => assembler.peerSupportsChunking,
            incompleteReassembly: () => assembler.incompleteMessage,
          },
          release: async () => {
            releases += 1;
          },
        });
        return relayChannel;
      },
    },
  });

  const frames = (): readonly RelayFrame[] => sent.map(decodeFrame);
  return {
    dataPayloads: () =>
      frames()
        .filter((frame): frame is RelayDataFrame => frame.type === "data")
        .map((frame) => Uint8Array.from(frame.payload)),
    closeReasons: () =>
      frames()
        .filter(
          (frame): frame is Extract<RelayFrame, { type: "channel.close" }> =>
            frame.type === "channel.close",
        )
        .map((frame) => frame.reason),
    deliveredToParser,
    session: () => {
      if (channelSession === undefined) throw new Error("channel is not open");
      return channelSession;
    },
    channel: () => {
      if (relayChannel === undefined) throw new Error("channel is not open");
      return relayChannel;
    },
    releases: () => releases,
    openRaw: async () => {
      await registry.handle({
        type: "channel.open",
        ...protocol,
        channelId: CHANNEL_ID,
        capability: CAPABILITY,
        effectiveRole: ROLE,
      });
      sendQueue.flush();
    },
    open: async () => {
      const result = await statements.advertised(HUB_ORIGIN);
      if (result.kind !== "available") throw new Error(result.reason);
      await registry.handle({
        type: "channel.open",
        ...protocol,
        channelId: CHANNEL_ID,
        capability: CAPABILITY,
        effectiveRole: ROLE,
        ...(options.accountGrantContext === undefined
          ? {}
          : { accountGrantContext: await options.accountGrantContext(result.advertisement) }),
      });
      sendQueue.flush();
      return result.advertisement;
    },
    deliver: async (payload) => {
      await registry.handle({
        type: "data",
        ...protocol,
        channelId: CHANNEL_ID,
        sequence: inboundSequence as RelayDataFrame["sequence"],
        payload,
      });
      inboundSequence += 1;
      // The registry defers every close it schedules to a microtask, so a
      // caller that asserts on the wire has to let those run first.
      await Promise.resolve();
      await Promise.resolve();
      sendQueue.flush();
    },
    closeFromPeer: async () => {
      await registry.handle({ type: "channel.close", ...protocol, channelId: CHANNEL_ID });
      await Promise.resolve();
      sendQueue.flush();
    },
    flush: () => sendQueue.flush(),
    sendQueue,
    fallbacks: () => fallbacks,
    advertisementFallbacks: () => advertisementFallbacks,
    rows: () => rows,
    expireHandshakeDeadline: async () => {
      const armed = [...pendingTimers.entries()];
      if (armed.length === 0) return false;
      for (const [handle, callback] of armed) {
        pendingTimers.delete(handle);
        callback();
      }
      // The §11.3 path is asynchronous — it protects a record and drains the
      // queue — so the caller's assertions have to follow the microtasks it
      // schedules, exactly as `deliver` does.
      await settle();
      sendQueue.flush();
      return true;
    },
  };
}

export function nativeCredentials(): E2eeClientHandshakeCredentials {
  const transcript = encodeClientE2eePrekeyTranscript({
    hubOrigin: HUB_ORIGIN,
    accountId: ACCOUNT_ID,
    identityPublicKey: CLIENT_IDENTITY_PUBLIC,
    agreementPublicKey: CLIENT_AGREEMENT_PUBLIC,
    createdAt: NOW - 1_000,
    // §6.4 bounds the certificate's whole lifetime, not just its expiry.
    expiresAt: NOW - 1_000 + E2EE_PREKEY_LIFETIME,
  });
  return {
    tier: "native",
    accountId: ACCOUNT_ID,
    identityPublicKey: CLIENT_IDENTITY_PUBLIC,
    agreementPublicKey: CLIENT_AGREEMENT_PUBLIC,
    agreementSecretKey: CLIENT_AGREEMENT_SECRET,
    prekeyTranscript: transcript,
    prekeySignature: signClientPrekey(transcript),
  };
}

export const clientChannel: E2eeHandshakeChannel = {
  hubOrigin: HUB_ORIGIN,
  channelId: CHANNEL_ID,
  relayProtocolMajor: version.protocolMajor,
  relayProtocolMinor: version.protocolMinor,
  channelOpenCapability: CAPABILITY,
  channelOpenEffectiveRole: ROLE,
};

export interface EstablishedClient {
  /** §8.8, kept so a test can reproduce the §13.5 derivation independently. */
  readonly sessionBindingHash: Uint8Array;
  readonly record: E2eeRecordSession;
  readonly close: E2eeCloseMachine;
}

export const positionOf = (state: E2eeDirectionState): E2eeSequencePosition => {
  if (state.epoch === undefined || state.counter === undefined) {
    throw new Error("direction is exhausted");
  }
  return { epoch: state.epoch, counter: state.counter };
};

/**
 * Drive a whole handshake against the harness and return the client's session.
 *
 * The node is a real relay channel throughout: the hello goes in as a `data`
 * frame the assembler strips, and the accept comes back out of the send queue.
 */
export async function establish(
  node: Harness,
  tier: "native" | "web",
  advertisement: NodeE2eeAdvertisement,
  /**
   * §16.3 F9 / §13.5: pin the client's Noise ephemeral so a test can compute the
   * `WebSAS` the node should have derived, rather than only checking its shape.
   */
  clientEphemeralSecretKey?: Uint8Array,
  /**
   * §16.3 F9: the client's send direction, which the node's `syntheticReceiveState`
   * must mirror exactly. See that option for why one side alone is not enough.
   */
  clientSyntheticSendState?: E2eeSyntheticDirectionState,
  /**
   * §4.5: the client's own `plaintextCeiling`. Defaults to a value comfortably
   * inside every limit set this harness is used with, because most tests do not
   * care; the interop matrix passes the CHANNEL's derived ceiling so that both
   * ends run the same §4.5 arithmetic and a record at the ceiling really crosses.
   */
  clientPlaintextCeiling?: number,
): Promise<EstablishedClient> {
  const client = new E2eeClientHandshake({
    channel: clientChannel,
    // §8.3: the client's node material has one source — the statement it
    // validated on this channel.
    advertised: advertisement.material,
    selectedSuite: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
    offeredSuites: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
    credentials: tier === "native" ? nativeCredentials() : { tier: "web" },
    intendedCapability: CAPABILITY,
    intendedRole: ROLE,
    ...(clientEphemeralSecretKey === undefined
      ? {}
      : { testOnlyEphemeralSecretKey: clientEphemeralSecretKey }),
  });
  const hello = client.createHello(NOW);
  if (hello.kind !== "hello") throw new Error(`hello: ${JSON.stringify(hello)}`);
  const before = node.dataPayloads().length;
  await node.deliver(hello.record);
  const accept = node.dataPayloads().slice(before);
  expect(accept).toHaveLength(1);
  const established = client.receiveServerAccept(stripPrelude(accept[0]!), NOW);
  if (established.kind !== "established") {
    throw new Error(`accept: ${JSON.stringify(established)} rows=${node.rows().join(",")}`);
  }
  return {
    sessionBindingHash: Uint8Array.from(established.sessionBindingHash),
    record: new E2eeRecordSession({
      secrets: established.secrets,
      suite: established.suite,
      sessionBindingHash: established.sessionBindingHash,
      sendDirection: "c2n",
      plaintextCeiling: clientPlaintextCeiling ?? 512 * 1_024,
      ...(clientSyntheticSendState === undefined
        ? {}
        : { testOnlySyntheticSendState: clientSyntheticSendState }),
    }),
    close: new E2eeCloseMachine({
      sessionBindingHash: established.sessionBindingHash,
      sendDirection: "c2n",
    }),
  };
}

/** Protect one client record and hand the envelope to the node as a data frame. */
export async function clientSend(
  node: Harness,
  client: EstablishedClient,
  innerType: E2eeInnerRecordType,
  body: Uint8Array,
): Promise<{ readonly epoch: bigint; readonly counter: bigint; readonly epochCompleted: boolean }> {
  let envelope: Uint8Array | undefined;
  const result = await client.record.protect({
    innerType,
    body,
    admit: () => true,
    transmit: (bytes) => {
      envelope = Uint8Array.from(bytes);
      return { kind: "sent" };
    },
  });
  if (result.kind !== "protected" || envelope === undefined) {
    throw new Error(`client protect: ${JSON.stringify(result)}`);
  }
  await node.deliver(envelope);
  return {
    epoch: result.epoch,
    counter: result.counter,
    epochCompleted: result.epochCompleted,
  };
}

export async function clientSendCloseRecord(
  node: Harness,
  client: EstablishedClient,
  toSend: E2eeCloseRecordToSend,
): Promise<void> {
  const sent = await clientSend(node, client, toSend.innerType, toSend.body);
  client.close.noteTransmitted({ record: toSend, ...sent, at: NOW });
}

/** Authenticate one node-to-client payload and hand it to the client's close machine. */
export function clientReceive(client: EstablishedClient, payload: Uint8Array) {
  const authenticated = client.record.unprotect(stripPrelude(payload));
  if (authenticated.kind !== "authenticated") {
    throw new Error(`client unprotect: ${JSON.stringify(authenticated)}`);
  }
  return authenticated;
}
