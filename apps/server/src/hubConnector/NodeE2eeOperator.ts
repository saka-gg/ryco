import { parseE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import type { NodeE2eeAdmissionPolicy } from "@ryco/contracts/native-e2ee";

import {
  NodeClientAuthorizationError,
  type NodeClientAuthorizationChangeResult,
  type NodeClientAuthorizationListing,
  type NodeClientAuthorizationRecord,
} from "../hubIdentity/NodeClientAuthorizationClient.ts";
import type { NodeE2eeFallbackState } from "../hubIdentity/NodeE2eeFallbackCounter.ts";
import type {
  NodeE2eePolicyChangeResult,
  NodeE2eePolicyPreview,
} from "../hubIdentity/NodeE2eePolicyClient.ts";
import type {
  EffectiveNodeE2eePolicy,
  NodeE2eePolicyProposal,
} from "../hubIdentity/NodeE2eePolicyStore.ts";
import {
  E2EE_PREKEY_EXPIRED_REMEDY,
  nodeE2eePrekeyValidity,
} from "../hubIdentity/NodeE2eePrekeyClient.ts";
import type { NodeE2eePrekeyCertificate } from "../hubIdentity/NodeE2eePrekeyClient.ts";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import { isE2eeSuiteId, type E2eeSuiteId } from "@ryco/shared/relayE2eeWire";
import type {
  E2eeAuthorizationChangeView,
  E2eeClientListingView,
  E2eeClientRecordView,
  E2eeContinuityView,
  E2eeFallbackView,
  E2eePolicyChangeView,
  E2eePolicyPreviewView,
  E2eePolicyView,
  E2eePrekeyView,
  E2eeSessionView,
} from "./e2eeOperatorContract.ts";
import type { HubConnectorE2eeOperator } from "./HubConnectorLive.ts";
import type { HubIdentityRuntimeShape, NodeE2eeContinuityStatus } from "./HubIdentityRuntime.ts";
import type {
  NodeE2eeSessionDirectory,
  NodeE2eeSessionSummary,
} from "./NodeE2eeSessionDirectory.ts";

// The node's E2EE operator surface, assembled from the runtime's owner commands
// — docs/relay-e2ee-protocol.md §6.4, §7.5, §12.5, §12.6, §13.4, §13.5, §13.6.
//
// WHAT THIS OWNS: translation and nothing else. Every ordering rule, every
// sweep, every durable commit, and every cap belongs to the client the runtime
// hands over; this module turns an owner's request into that client's call and
// that client's answer into the bounded view the route serves.
//
// IT DECIDES NO POLICY AND ENFORCES NO ORDER. In particular it does not
// re-implement §13.6's "commit, then sweep, then acknowledge" or §12.6's
// one-snapshot rule: both are inside the clients, which is where they can be
// atomic with the reads the relay path makes. What this module DOES guarantee is
// that it never returns before the call it made has settled — an `await` on
// every mutation, and no fire-and-forget anywhere — because a translation layer
// that resolved early would undo both orderings from the outside.

/**
 * The owner's key, as an owner types it.
 *
 * The fingerprint arrives in the §7.1 display form because that is the form the
 * owner reads off their own device (§13.6), and it is parsed strictly: a lenient
 * parse would let two spellings name one record.
 */
export interface E2eeClientKeyInput {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly fingerprint: string;
}

/**
 * An owner's proposed suite registry, checked against the §3.4 registry.
 *
 * A registry naming a suite this build does not implement would be advertised in
 * §7.6 element 9 and then fail every handshake that selected it, so an unknown
 * id is refused here rather than committed. The same bounded code every other
 * malformed operator input takes, because the operator's remedy is the same:
 * read the registry and state a set from it.
 */
function suiteRegistryOf(values: readonly number[]): readonly E2eeSuiteId[] {
  const registry: E2eeSuiteId[] = [];
  for (const value of values) {
    if (!isE2eeSuiteId(value))
      throw new NodeClientAuthorizationError("client_authorization_invalid");
    if (!registry.includes(value)) registry.push(value);
  }
  return registry;
}

function policyProposalOf(proposal: {
  readonly mode?: NodeE2eeAdmissionPolicy | undefined;
  readonly requireE2EE?: boolean | undefined;
  readonly requireApprovedClientE2EE?: boolean | undefined;
  readonly suiteRegistry?: readonly number[] | undefined;
}): NodeE2eePolicyProposal {
  return {
    ...(proposal.mode === undefined ? {} : { mode: proposal.mode }),
    ...(proposal.requireE2EE === undefined ? {} : { requireE2EE: proposal.requireE2EE }),
    ...(proposal.requireApprovedClientE2EE === undefined
      ? {}
      : { requireApprovedClientE2EE: proposal.requireApprovedClientE2EE }),
    ...(proposal.suiteRegistry === undefined
      ? {}
      : { suiteRegistry: suiteRegistryOf(proposal.suiteRegistry) }),
  };
}

function authorizationKey(input: E2eeClientKeyInput): {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly clientIdentityFingerprint: Uint8Array;
} {
  let clientIdentityFingerprint: Uint8Array;
  try {
    clientIdentityFingerprint = parseE2eeKeyFingerprint(input.fingerprint);
  } catch {
    // The same bounded code the client raises for a malformed key, so a bad
    // fingerprint and a bad role reach the operator as one class of answer
    // rather than as a parse error from a module they did not call.
    throw new NodeClientAuthorizationError("client_authorization_invalid");
  }
  return {
    hubOrigin: input.hubOrigin,
    accountId: input.accountId,
    clientIdentityFingerprint,
  };
}

function recordView(record: NodeClientAuthorizationRecord): E2eeClientRecordView {
  return {
    status: record.status,
    hubOrigin: record.hubOrigin,
    accountId: record.accountId,
    fingerprint: record.fingerprintDisplay,
    maxRole: record.maxRole,
    capabilitySet: record.capabilitySet,
    createdAt: record.createdAt,
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
    safetyNumber: record.safetyNumber,
    ...(record.displayLabel === undefined ? {} : { displayLabel: record.displayLabel }),
    pairingReserved: record.pairingReserved,
    ...(record.observedRole === undefined ? {} : { observedRole: record.observedRole }),
  };
}

function listingView(listing: NodeClientAuthorizationListing): E2eeClientListingView {
  return {
    records: listing.records.map(recordView),
    pendingGlobalSaturated: listing.pendingGlobalSaturated,
    saturatedAccounts: listing.saturatedAccounts,
    refusedPairingAttempts: listing.refusedPairingAttempts,
    ...(listing.pairingWindow === undefined
      ? {}
      : {
          pairingWindow: {
            fingerprint: listing.pairingWindow.fingerprintDisplay,
            openedAt: listing.pairingWindow.openedAt,
            expiresAt: listing.pairingWindow.expiresAt,
            spent: listing.pairingWindow.spent,
          },
        }),
  };
}

function policyView(policy: EffectiveNodeE2eePolicy, generation: number): E2eePolicyView {
  return {
    mode: policy.mode,
    // The RAW pair, from `advertised` — §7.6 elements 12 and 13 — beside the
    // effective value §12.4 derives from them. Both, because §12.4's implication
    // makes them differ and a display showing one would misreport the other.
    requireE2EE: policy.advertised.requireE2EE,
    requireApprovedClientE2EE: policy.advertised.requireApprovedClientE2EE,
    effectiveRequireE2EE: policy.requireE2EE,
    admittedPatterns: policy.admittedPatterns,
    suiteRegistry: policy.suiteRegistry,
    generation,
  };
}

function changeView(result: NodeClientAuthorizationChangeResult): E2eeAuthorizationChangeView {
  return {
    closedChannels: result.closedChannels,
    abortedHandshakes: result.abortedHandshakes,
  };
}

function policyChangeView(
  result: NodeE2eePolicyChangeResult,
  generation: number,
): E2eePolicyChangeView {
  return {
    policy: policyView(result.policy, generation),
    withdrawal: result.withdrawal,
    changed: result.changed,
    counts: result.counts,
  };
}

function policyPreviewView(
  preview: NodeE2eePolicyPreview,
  generation: number,
): E2eePolicyPreviewView {
  return {
    policy: policyView(preview.policy, generation),
    withdrawal: preview.withdrawal,
    changed: preview.changed,
    counts: preview.counts,
  };
}

function prekeyView(certificate: NodeE2eePrekeyCertificate | null, now: number): E2eePrekeyView {
  if (certificate === null) return { present: false };
  const validity = nodeE2eePrekeyValidity(certificate, now);
  return {
    present: true,
    prekeyId: certificate.prekeyId,
    // The AGREEMENT KEY'S FINGERPRINT, never the key. §13.6's "raw keys are
    // never displayed" is written about client keys, but the node's own
    // agreement key is public material with no operator use in raw form, and the
    // fingerprint is what §7.1 defines a human-comparable form for.
    fingerprint: formatE2eeKeyFingerprint(
      e2eeKeyFingerprint("agreement", certificate.agreementPublicKey),
    ),
    createdAt: certificate.createdAt,
    expiresAt: certificate.expiresAt,
    validity,
    // §6.4 gives expiry a named local diagnostic AND a specific repair, and the
    // repair is only a repair if an operator meets it. Carried from the module
    // that defines the diagnostic rather than restated, so the sentence and the
    // condition cannot drift apart.
    ...(validity === "expired" ? { remedy: E2EE_PREKEY_EXPIRED_REMEDY } : {}),
  };
}

function continuityView(status: NodeE2eeContinuityStatus): E2eeContinuityView {
  if (status.status === "unavailable") {
    return {
      status: "unavailable",
      reason: status.reason,
      // §7.5's own words, carried from the condition that raised them so the
      // surface printing the remedy cannot drift from the state it describes.
      remedy: status.remedy,
    };
  }
  return {
    status: "advertisable",
    continuityId: status.continuityId,
    generation: status.generation,
    chainLength: status.chain.length,
    ...(status.repair === null ? {} : { repair: status.repair }),
    ...(status.chainBreak === null ? {} : { chainBreak: status.chainBreak }),
    ...(status.lastBreak === null
      ? {}
      : { lastBreakReason: status.lastBreak.reason, lastBreakAt: status.lastBreak.at }),
  };
}

function sessionView(session: NodeE2eeSessionSummary): E2eeSessionView {
  const view = {
    sessionIndex: session.sessionIndex,
    tier: session.tier,
    suite: session.suite,
    establishedAt: session.establishedAt,
  };
  // §13.5 has no value for a native session, and an absent field says that;
  // `verificationCode: undefined` would say the node computed one and lost it.
  return session.verificationCode === undefined
    ? view
    : { ...view, verificationCode: session.verificationCode };
}

function fallbackView(
  state: NodeE2eeFallbackState,
  undersized:
    | {
        readonly assertedMaxDataChunkBytes: number;
        readonly advertisementMinChunkBytes: number;
      }
    | undefined,
): E2eeFallbackView {
  const forClass = (value: NodeE2eeFallbackState["classes"]["peer-legacy"]) => ({
    occurrences: value.occurrences,
    ringOverflows: value.ringOverflows,
    ...(value.lastOccurrenceAt === undefined ? {} : { lastOccurrenceAt: value.lastOccurrenceAt }),
  });
  return {
    ...(state.windowStartedAt === undefined ? {} : { windowStartedAt: state.windowStartedAt }),
    // §12.5: the two occurrence counters are reported SEPARATELY and never as a
    // single total. They are two facts about two different parties, and the
    // §12.3 criterion names only one of them.
    peerLegacy: forClass(state.classes["peer-legacy"]),
    advertisementUnavailable: forClass(state.classes["advertisement-unavailable"]),
    // Oldest first, so §12.5's "retained ring entries in time order with their
    // reason labels" reads as the shape §12.3 is asked to judge. The origin hash
    // is dropped here; see the view's own note.
    ring: state.ring.map((entry) => ({ occurredAt: entry.occurredAt, reason: entry.reason })),
    // §12.5 Display: for a LIVE `undersized-connection` condition the two
    // figures §5.5 U1 compares must both be shown. They describe the connection
    // this node is on now, so they are absent — rather than stale — when it is
    // not on one.
    ...(undersized === undefined ? {} : { undersizedConnection: undersized }),
  };
}

export function makeNodeE2eeOperator(options: {
  readonly identity: HubIdentityRuntimeShape;
  readonly sessions: NodeE2eeSessionDirectory;
  /** The origin this connector serves; the prekey and lineage operations are per origin. */
  readonly hubOrigin: () => string;
  /** §12.5 Display: the live §5.5 U1 pair, read from the current connection. */
  readonly undersizedConnection?: () =>
    | {
        readonly assertedMaxDataChunkBytes: number;
        readonly advertisementMinChunkBytes: number;
      }
    | undefined;
  /** Republish the signed statement after any mutation of advertised material. */
  readonly onAdvertisementChanged?: () => Promise<void>;
  readonly now?: () => number;
}): HubConnectorE2eeOperator {
  const now = options.now ?? Date.now;
  const identity = options.identity;
  const admin = () => identity.e2eeAuthorizationAdmin;
  const liveUndersizedConnection = options.undersizedConnection ?? (() => undefined);
  const advertisementChanged = options.onAdvertisementChanged ?? (() => Promise.resolve());

  /**
   * Read the listing AFTER the mutation that changed it.
   *
   * The pairing-window commands answer with the whole listing rather than with
   * the window alone, because §13.6's display duties are about the listing —
   * saturation, the refusal count, the window's three fields — and an operator
   * who has just opened a window is looking at exactly those.
   */
  const listing = async (): Promise<E2eeClientListingView> => listingView(await admin().list());

  return {
    listClients: listing,
    getClient: async (key) => {
      const record = await admin().get(authorizationKey(key));
      return record === undefined ? undefined : recordView(record);
    },
    approveClient: async (input) => {
      const result = await admin().approve({
        key: authorizationKey(input),
        maxRole: input.maxRole,
        capabilitySet: input.capabilitySet,
        ...(input.displayLabel === undefined ? {} : { displayLabel: input.displayLabel }),
      });
      const record = await admin().get(authorizationKey(input));
      return {
        ...changeView(result),
        ...(record === undefined ? {} : { record: recordView(record) }),
      };
    },
    narrowClient: async (input) => {
      const result = await admin().narrow({
        key: authorizationKey(input),
        ...(input.maxRole === undefined ? {} : { maxRole: input.maxRole }),
        ...(input.capabilitySet === undefined ? {} : { capabilitySet: input.capabilitySet }),
      });
      const record = await admin().get(authorizationKey(input));
      return {
        ...changeView(result),
        ...(record === undefined ? {} : { record: recordView(record) }),
      };
    },
    revokeClient: async (key) => {
      const result = await admin().revoke(authorizationKey(key));
      const record = await admin().get(authorizationKey(key));
      return {
        ...changeView(result),
        ...(record === undefined ? {} : { record: recordView(record) }),
      };
    },
    // Purge removes the record, so there is nothing left to echo — and echoing a
    // stale copy of a record the owner just deleted would be the one answer an
    // operator could misread as "it is still there".
    purgeClient: async (key) => changeView(await admin().purge(authorizationKey(key))),
    createClientApprovalQr: async (key) => {
      const parsed = authorizationKey(key);
      return identity.crossDeviceApproval.create({
        hubOrigin: parsed.hubOrigin,
        accountId: parsed.accountId,
        clientIdentityFingerprint: parsed.clientIdentityFingerprint,
      });
    },
    openPairingWindow: async (fingerprint) => {
      let parsed: Uint8Array;
      try {
        parsed = parseE2eeKeyFingerprint(fingerprint);
      } catch {
        // §13.6: "A window without one MUST be refused by the CLI; there is no
        // undiscriminated window." An unparseable discriminator is no
        // discriminator, and this is where that refusal lands.
        throw new NodeClientAuthorizationError("client_authorization_invalid");
      }
      await admin().openPairingWindow(parsed);
      return listing();
    },
    closePairingWindow: async () => {
      await admin().closePairingWindow();
      return listing();
    },
    // §13.6: the refusal count is "bounded, owner-clearable", and this is the
    // only thing that clears it. Synchronous in the client — it is an in-memory
    // instrumentation counter, not durable security state — and the listing is
    // read after it so the owner sees the zero they asked for.
    clearRefusedPairingAttempts: async () => {
      admin().clearRefusedPairingAttempts();
      return listing();
    },
    listSessions: () => ({ sessions: options.sessions.list().map(sessionView) }),
    readPolicy: () => policyView(identity.e2eePolicy(), identity.e2eeGeneration()),
    previewPolicy: (proposal) =>
      policyPreviewView(
        identity.previewE2eePolicy(policyProposalOf(proposal)),
        identity.e2eeGeneration(),
      ),
    // Awaited, and the generation read AFTER: §12.6(c) forbids acknowledging
    // before (a) and (b) have completed, and the generation the answer reports
    // is the one step (a) spent.
    applyPolicy: async (proposal) => {
      const result = await identity.applyE2eePolicy(policyProposalOf(proposal));
      await advertisementChanged();
      return policyChangeView(result, identity.e2eeGeneration());
    },
    // §5.7's recovery. Awaited and the generation read after, exactly as a
    // policy change is: the command's whole claim is that the generation now in
    // force is strictly greater than the rolled-back one, and reading it before
    // the commit settled would report the value it was recovering from.
    recoverPolicyGeneration: async () => {
      const result = await identity.recoverE2eeGeneration();
      await advertisementChanged();
      return policyChangeView(result, identity.e2eeGeneration());
    },
    readPrekey: async () =>
      prekeyView(await identity.readStoredE2eePrekey(options.hubOrigin()), now()),
    rotatePrekey: async () => {
      const rotated = await identity.rotateE2eePrekey(options.hubOrigin());
      await advertisementChanged();
      return prekeyView(rotated, now());
    },
    readContinuity: async () =>
      continuityView(await identity.readE2eeContinuity(options.hubOrigin())),
    adoptContinuityId: async (continuityId) => {
      const adopted = await identity.adoptE2eeContinuityId(continuityId);
      await advertisementChanged();
      return { outcome: "adopted", continuityId: adopted };
    },
    remintContinuityId: async () => {
      const reminted = await identity.remintE2eeContinuityId();
      await advertisementChanged();
      return { outcome: "reminted", continuityId: reminted };
    },
    breakContinuityChain: async () => {
      await identity.breakE2eeContinuity();
      await advertisementChanged();
      return { outcome: "chain_broken" };
    },
    readFallback: () => fallbackView(identity.readE2eeFallbackState(), liveUndersizedConnection()),
    resetFallback: async () =>
      // The live §5.5 U1 pair is NOT reset by §12.5's reset authority: the reset
      // zeroes counters and the ring, and this pair is a property of the
      // connection the node is on, which the command does not touch.
      fallbackView(await identity.resetE2eeFallbackState(), liveUndersizedConnection()),
  };
}
