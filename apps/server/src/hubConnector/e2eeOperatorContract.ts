import { Schema } from "effect";
import { NodeE2eeAdmissionPolicy } from "@ryco/contracts/native-e2ee";

import {
  E2EE_APPROVED_CLIENTS_MAX,
  E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS,
  E2EE_FALLBACK_RING_SIZE,
  E2EE_PENDING_CLIENTS_MAX_GLOBAL,
} from "@ryco/shared/relayE2eeConstants";

// The wire shape of the node's E2EE OPERATOR surface —
// docs/relay-e2ee-protocol.md §6.4, §7.5, §12.3–§12.6, §13.4, §13.5, and §13.6.
//
// WHAT THIS OWNS: the schemas the local HTTP routes answer with and the node CLI
// decodes. Nothing else consumes them.
//
// ─── WHY THESE ARE NOT IN `@ryco/contracts` ─────────────────────────────────
//
// `@ryco/contracts` is the shared vocabulary of the node, the Hub, and the web
// client. These structures are read by exactly one caller — this node's own CLI,
// over this node's own loopback origin, under an owner session — and §13.6 is
// explicit that the Branch A record set is node-side state that is "never
// relay-operator (Hub) persistence". Publishing its shape as a shared contract
// would invite a second consumer for a surface whose whole point is that it has
// one, so it lives beside the routes that serve it.
//
// ─── WHAT MAY NEVER APPEAR IN ANY SCHEMA HERE ───────────────────────────────
//
// No raw key of any kind (§13.6: "Raw keys are never displayed and never
// stored"), no §13.5 derivation input, no relay channel id, and — in the §12.5
// report — no account, channel, session, or key identifier at all, because none
// is stored. The bounds below are not decoration: every list is capped at the
// §3.2 constant that bounds the state it reflects, so a corrupted or hostile
// record cannot make a response unbounded.

/** §7.1's display form, the one the enrollment fingerprint already prints. */
export const E2eeKeyFingerprintDisplay = Schema.String.check(
  Schema.isPattern(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
);

/** §13.4's rendered value: five groups of five digits, separated by spaces. */
export const E2eeSafetyNumberDisplay = Schema.String.check(Schema.isPattern(/^\d{5}(?: \d{5})*$/));

const BoundedOrigin = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));
const BoundedAccountId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const BoundedCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const EpochMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const E2eeClientAuthorizationStatusSchema = Schema.Literals([
  "pending",
  "approved",
  "revoked",
]);

/**
 * One Branch A record, in exactly the fields §13.6's display duty enumerates.
 *
 * `safetyNumber` is the §13.4 value the record already stores — the only
 * key-derived pairing display metadata §13.6 admits — so the verification surface is a read of this
 * record rather than a second derivation that could disagree with it.
 */
export const E2eeClientRecordView = Schema.Struct({
  status: E2eeClientAuthorizationStatusSchema,
  hubOrigin: BoundedOrigin,
  accountId: BoundedAccountId,
  fingerprint: E2eeKeyFingerprintDisplay,
  maxRole: Schema.String.check(Schema.isMaxLength(32)),
  capabilitySet: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
    Schema.isMaxLength(32),
  ),
  createdAt: EpochMillis,
  approvedAt: Schema.optional(EpochMillis),
  revokedAt: Schema.optional(EpochMillis),
  lastSeenAt: Schema.optional(EpochMillis),
  safetyNumber: E2eeSafetyNumberDisplay,
  displayLabel: Schema.optional(
    Schema.String.check(Schema.isMaxLength(E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS)),
  ),
  pairingReserved: Schema.Boolean,
  /**
   * The `channel.open` role the device introduced itself under. Display
   * metadata the owner approves FROM, never authority: §8.3 makes a native
   * client's intended role equal it, so a ceiling below it refuses the device
   * rather than limiting it. Absent on records that predate it.
   */
  observedRole: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
});
export type E2eeClientRecordView = typeof E2eeClientRecordView.Type;

/** §13.6: while a window is open the CLI must show all three of these. */
export const E2eePairingWindowView = Schema.Struct({
  fingerprint: E2eeKeyFingerprintDisplay,
  openedAt: EpochMillis,
  expiresAt: EpochMillis,
  spent: Schema.Boolean,
});

/**
 * §13.6's listing, including the three instrumentation duties it imposes:
 * flag pending-cap saturation, show the owner-clearable refusal count, and show
 * an open window's discriminator and whether its one reservation is spent.
 */
export const E2eeClientListingView = Schema.Struct({
  records: Schema.Array(E2eeClientRecordView).check(
    Schema.isMaxLength(E2EE_APPROVED_CLIENTS_MAX + E2EE_PENDING_CLIENTS_MAX_GLOBAL + 256),
  ),
  pendingGlobalSaturated: Schema.Boolean,
  saturatedAccounts: Schema.Array(
    Schema.Struct({ hubOrigin: BoundedOrigin, accountId: BoundedAccountId }),
  ).check(Schema.isMaxLength(256)),
  refusedPairingAttempts: BoundedCount,
  pairingWindow: Schema.optional(E2eePairingWindowView),
});
export type E2eeClientListingView = typeof E2eeClientListingView.Type;

/**
 * §13.6: what a withdrawal terminated.
 *
 * Present on EVERY authorization command's response, including the widening
 * ones, because the numbers are what the acknowledgement is about and a command
 * that reports none is one an owner cannot distinguish from a command that swept
 * nothing.
 */
export const E2eeAuthorizationChangeView = Schema.Struct({
  record: Schema.optional(E2eeClientRecordView),
  closedChannels: BoundedCount,
  abortedHandshakes: BoundedCount,
});
export type E2eeAuthorizationChangeView = typeof E2eeAuthorizationChangeView.Type;

/** Public, short-lived node attestation rendered by the local owner surface. */
export const E2eeCrossDeviceApprovalView = Schema.Struct({
  payload: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  approvedAt: EpochMillis,
  issuedAt: EpochMillis,
  expiresAt: EpochMillis,
});
export type E2eeCrossDeviceApprovalView = typeof E2eeCrossDeviceApprovalView.Type;

/**
 * §13.5's node-side half of the comparison, for the sessions established now.
 *
 * No channel id, no account, no origin: the ordinal exists only so an operator
 * can tell two concurrent sessions apart while reading codes off two screens.
 */
export const E2eeSessionView = Schema.Struct({
  sessionIndex: BoundedCount,
  tier: Schema.Literals(["native", "web"]),
  /** §3.4's suite id, as the registry numbers it. */
  suite: BoundedCount,
  establishedAt: EpochMillis,
  verificationCode: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});

export type E2eeSessionView = typeof E2eeSessionView.Type;

export const E2eeSessionListView = Schema.Struct({
  sessions: Schema.Array(E2eeSessionView).check(Schema.isMaxLength(1_024)),
});
export type E2eeSessionListView = typeof E2eeSessionListView.Type;

/**
 * §12.3/§12.4's raw values, §12.4's effective one, and §5.7's generation.
 *
 * Raw and effective are both present because §12.4's implication makes them
 * differ — `requireApprovedClientE2EE` implies effective `requireE2EE` while the
 * raw value is still false — and a display that showed only one would either
 * understate the guarantee or misreport the configuration.
 */
export const E2eePolicyView = Schema.Struct({
  mode: NodeE2eeAdmissionPolicy,
  requireE2EE: Schema.Boolean,
  requireApprovedClientE2EE: Schema.Boolean,
  effectiveRequireE2EE: Schema.Boolean,
  /** §7.6 element 14: the Noise patterns this policy actually admits. */
  admittedPatterns: Schema.Array(Schema.Literals(["IK", "NX"])).check(Schema.isMaxLength(8)),
  /** §7.6 element 9: the suite ids, as the §3.4 registry numbers them. */
  suiteRegistry: Schema.Array(BoundedCount).check(Schema.isMaxLength(16)),
  generation: BoundedCount,
});
export type E2eePolicyView = typeof E2eePolicyView.Type;

/** §12.6(c): the counts, broken out by class, plus the in-flight aborts. */
export const E2eePolicyWithdrawalCountsView = Schema.Struct({
  legacy: BoundedCount,
  nxE2ee: BoundedCount,
  suiteWithdrawn: BoundedCount,
  abortedHandshakes: BoundedCount,
});

export const E2eePolicyChangeView = Schema.Struct({
  policy: E2eePolicyView,
  /** True when §12.6's test found a reduction in this transition. */
  withdrawal: Schema.Boolean,
  changed: Schema.Boolean,
  counts: E2eePolicyWithdrawalCountsView,
});
export type E2eePolicyChangeView = typeof E2eePolicyChangeView.Type;

/**
 * §12.6's warning input: what the change WOULD do, before it is run.
 *
 * Approximate by nature — channels open and close while the operator reads it —
 * and §12.6 says so ("roughly how many currently match").
 */
export const E2eePolicyPreviewView = Schema.Struct({
  policy: E2eePolicyView,
  withdrawal: Schema.Boolean,
  changed: Schema.Boolean,
  counts: E2eePolicyWithdrawalCountsView,
});
export type E2eePolicyPreviewView = typeof E2eePolicyPreviewView.Type;

/**
 * §6.4: the agreement prekey this node holds, or what a forced rotation
 * produced. The agreement key itself never appears.
 *
 * `present: false` is a node that holds no prekey for this origin at all, which
 * is a different state from an expired one and must not be displayed as one.
 * `remedy` carries §6.4's own repair sentence for the `expired` state, from the
 * module that defines the diagnostic — the same pattern §7.5's unresolvable
 * lineage uses, and for the same reason: a surface that restated it could drift
 * from the condition that raises it.
 */
export const E2eePrekeyView = Schema.Struct({
  present: Schema.Boolean,
  prekeyId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  fingerprint: Schema.optional(E2eeKeyFingerprintDisplay),
  createdAt: Schema.optional(EpochMillis),
  expiresAt: Schema.optional(EpochMillis),
  validity: Schema.optional(Schema.Literals(["usable", "renewable", "expired"])),
  remedy: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
});
export type E2eePrekeyView = typeof E2eePrekeyView.Type;

/**
 * §7.5's lineage, as an operator must be able to read it.
 *
 * `unresolvable` carries the remedy string §7.5 writes for exactly this state,
 * so the surface that prints it cannot drift from the condition that raised it.
 */
export const E2eeContinuityView = Schema.Struct({
  status: Schema.Literals(["advertisable", "unavailable"]),
  continuityId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  generation: Schema.optional(BoundedCount),
  chainLength: Schema.optional(BoundedCount),
  repair: Schema.optional(Schema.Literals(["restored_from_anchor", "anchor_adopted"])),
  chainBreak: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  lastBreakReason: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  lastBreakAt: Schema.optional(EpochMillis),
  reason: Schema.optional(Schema.Literals(["anchor_disagrees", "anchor_unreadable"])),
  remedy: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
});
export type E2eeContinuityView = typeof E2eeContinuityView.Type;

/** What a §7.5 recovery or deliberate break did, and to which lineage. */
export const E2eeContinuityChangeView = Schema.Struct({
  outcome: Schema.Literals(["adopted", "reminted", "chain_broken"]),
  continuityId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type E2eeContinuityChangeView = typeof E2eeContinuityChangeView.Type;

export const E2eeFallbackReasonSchema = Schema.Literals([
  "peer-legacy",
  "undersized-connection",
  "statement-unavailable",
]);

/**
 * One §12.5 ring entry, minus its `originHash`.
 *
 * The stored entry has three fields and this view has two, deliberately. §12.5
 * requires the display to make the SHAPE legible — the entries in time order
 * with their reason labels — and requires the CLI not to display account,
 * channel, session, or key identifiers. The origin hash is none of those, but it
 * is also not part of the shape §12.3 reads, and it is the one retained field
 * that correlates entries across a report; leaving it out of the display keeps
 * the report to what its consumer actually uses.
 */
export const E2eeFallbackRingEntryView = Schema.Struct({
  occurredAt: EpochMillis,
  reason: E2eeFallbackReasonSchema,
});

export const E2eeFallbackClassView = Schema.Struct({
  occurrences: BoundedCount,
  ringOverflows: BoundedCount,
  lastOccurrenceAt: Schema.optional(EpochMillis),
});

/**
 * §12.5 Display: "For a live `undersized-connection` condition it MUST also
 * display the asserted `maxDataChunkBytes` and `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`."
 *
 * Present only while the condition is live, and read from the current relay
 * connection rather than from the ring — §12.5 says in as many words that the
 * pair is not retained there. Absent means the node is not on an undersized
 * connection now, which is not the same as "never was": the ring's
 * `undersized-connection` entries are the historical half.
 */
export const E2eeUndersizedConnectionView = Schema.Struct({
  assertedMaxDataChunkBytes: BoundedCount,
  advertisementMinChunkBytes: BoundedCount,
});

export const E2eeFallbackView = Schema.Struct({
  windowStartedAt: Schema.optional(EpochMillis),
  peerLegacy: E2eeFallbackClassView,
  advertisementUnavailable: E2eeFallbackClassView,
  ring: Schema.Array(E2eeFallbackRingEntryView).check(Schema.isMaxLength(E2EE_FALLBACK_RING_SIZE)),
  undersizedConnection: Schema.optional(E2eeUndersizedConnectionView),
});
export type E2eeFallbackView = typeof E2eeFallbackView.Type;
