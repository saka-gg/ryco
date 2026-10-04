// The wire shape of the node's E2EE OPERATOR surface, as a CLIENT reads it —
// docs/relay-e2ee-protocol.md §6.4, §7.5, §12.3–§12.6, §13.4, §13.5, §13.6.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THESE ARE STRUCTURAL TYPES AND NOT THE NODE'S SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────
// The node defines these bodies as Effect schemas in
// `apps/server/src/hubConnector/e2eeOperatorContract.ts`, and that module states
// in as many words why they are NOT in `@ryco/contracts`: §13.6 makes the
// Branch A record set node-side state, and publishing its shape as a shared
// contract "would invite a second consumer for a surface whose whole point is
// that it has one".
//
// `apps/web` is now that second consumer, and it cannot import the first: it
// does not depend on `apps/server`, and promoting the schema to
// `@ryco/contracts` would be the publication that module argues against. So the
// declarations below are a READ-ONLY STRUCTURAL MIRROR of the JSON those routes
// already emit — every field optional exactly where the schema marks it
// optional, and no field this client does not render.
//
// WHAT THAT COSTS, STATED PLAINLY: the two can drift, and nothing here catches
// it. Nothing SILENTLY misreads, though — the surfaces treat every optional as
// absent-by-default and render an explicit "unknown" rather than a blank, so a
// field the node stops sending degrades to a stated absence instead of to a
// confident wrong value. Widening a field on the node without widening it here
// is the drift that matters, and it is a review duty rather than a mechanical
// one until the contract has a shared home.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAY NEVER APPEAR HERE
// ─────────────────────────────────────────────────────────────────────────────
// The node's contract module already refuses to serve raw keys, §13.5
// derivation inputs, relay channel ids, and — in the §12.5 report — any account,
// channel, session, or key identifier. This mirror therefore cannot declare
// them, and must never grow a field the node does not send: a declared field is
// a field a surface will try to draw.

/** §13.6's three record states. */
export type NodeE2eeClientStatus = "pending" | "approved" | "revoked";

/**
 * One Branch A record, in the fields §13.6's display duty enumerates.
 *
 * `safetyNumber` is §13.4's rendered value as the record already stores it —
 * the node derives it once at record creation, so a surface reads it rather
 * than deriving a second one that could disagree.
 */
export interface NodeE2eeClientRecord {
  readonly status: NodeE2eeClientStatus;
  readonly hubOrigin: string;
  readonly accountId: string;
  /** §7.1's display form: `SHA256:` and 43 base64url characters. */
  readonly fingerprint: string;
  readonly maxRole: string;
  readonly capabilitySet: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly approvedAt?: number;
  readonly revokedAt?: number;
  readonly lastSeenAt?: number;
  /** §13.4: five groups of five digits, separated by spaces. */
  readonly safetyNumber: string;
  readonly displayLabel?: string;
  readonly pairingReserved: boolean;
  /**
   * The `channel.open` role the device introduced itself under — display
   * metadata the owner approves from, never authority. A native client's
   * intended role must equal it (§8.3), so an approval below it refuses the
   * device rather than limiting it. Absent on records that predate it.
   */
  readonly observedRole?: string;
}

/** §13.6: while a window is open a surface must show all three of these. */
export interface NodeE2eePairingWindow {
  readonly fingerprint: string;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly spent: boolean;
}

/** §13.6's listing, including its three instrumentation duties. */
export interface NodeE2eeClientListing {
  readonly records: ReadonlyArray<NodeE2eeClientRecord>;
  readonly pendingGlobalSaturated: boolean;
  readonly saturatedAccounts: ReadonlyArray<{
    readonly hubOrigin: string;
    readonly accountId: string;
  }>;
  readonly refusedPairingAttempts: number;
  readonly pairingWindow?: NodeE2eePairingWindow;
}

/** §13.6: what a withdrawal terminated. Present on every authorization command. */
export interface NodeE2eeAuthorizationChange {
  readonly record?: NodeE2eeClientRecord;
  readonly closedChannels: number;
  readonly abortedHandshakes: number;
}

/** Public, node-signed attestation rendered as a QR by a local owner surface. */
export interface NodeE2eeCrossDeviceApproval {
  readonly payload: string;
  readonly approvedAt: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * §13.5's node-side half of the comparison, for sessions open now.
 *
 * `verificationCode` is present only for the `web` tier: §13.5 has no native
 * meaning, where the long-term §13.4 value on the record is what gets compared.
 */
export interface NodeE2eeSession {
  readonly sessionIndex: number;
  readonly tier: "native" | "web";
  readonly suite: number;
  readonly establishedAt: number;
  readonly verificationCode?: string;
}

export interface NodeE2eeSessionList {
  readonly sessions: ReadonlyArray<NodeE2eeSession>;
}

/**
 * §12.3/§12.4's raw values, §12.4's effective one, and §5.7's generation.
 *
 * Raw and effective both, because §12.4's implication makes them differ:
 * `requireApprovedClientE2EE` implies effective `requireE2EE` while the raw
 * value is still false.
 */
export interface NodeE2eePolicy {
  readonly requireE2EE: boolean;
  readonly requireApprovedClientE2EE: boolean;
  readonly effectiveRequireE2EE: boolean;
  readonly admittedPatterns: ReadonlyArray<"IK" | "NX">;
  readonly suiteRegistry: ReadonlyArray<number>;
  readonly generation: number;
}

/** §12.6(c): the counts broken out by class, plus the in-flight aborts. */
export interface NodeE2eeWithdrawalCounts {
  readonly legacy: number;
  readonly nxE2ee: number;
  readonly suiteWithdrawn: number;
  readonly abortedHandshakes: number;
}

/**
 * §12.6's warning input — what the change WOULD do — and, from the apply route,
 * what it DID. One shape because the node answers both with the same fields.
 */
export interface NodeE2eePolicyChange {
  readonly policy: NodeE2eePolicy;
  readonly withdrawal: boolean;
  readonly changed: boolean;
  readonly counts: NodeE2eeWithdrawalCounts;
}

/** §12.6's proposal. Every field optional: an absent one is left alone. */
export interface NodeE2eePolicyProposal {
  readonly requireE2EE?: boolean;
  readonly requireApprovedClientE2EE?: boolean;
  readonly suiteRegistry?: ReadonlyArray<number>;
}

/**
 * §6.4: the agreement prekey this node holds. The agreement key never appears.
 *
 * `present: false` is a node holding no prekey for this origin at all, which is
 * a different state from an expired one and must not be drawn as one. `remedy`
 * carries §6.4's own repair sentence from the module that defines the
 * diagnostic, so a surface prints it rather than restating it.
 */
export interface NodeE2eePrekey {
  readonly present: boolean;
  readonly prekeyId?: string;
  readonly fingerprint?: string;
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly validity?: "usable" | "renewable" | "expired";
  readonly remedy?: string;
}

/**
 * §7.5's lineage. `remedy` is §7.5's own sentence for an unresolvable one.
 *
 * `identity_in_use` is no lineage at all: a backend that does not own the
 * identity declines to read a chain that reading can repair, and `remedy` says
 * which copy to ask.
 */
export interface NodeE2eeContinuity {
  readonly status: "advertisable" | "unavailable" | "identity_in_use";
  readonly continuityId?: string;
  readonly generation?: number;
  readonly chainLength?: number;
  readonly repair?: "restored_from_anchor" | "anchor_adopted";
  readonly chainBreak?: string;
  readonly lastBreakReason?: string;
  readonly lastBreakAt?: number;
  readonly reason?: "anchor_disagrees" | "anchor_unreadable";
  readonly remedy?: string;
}

export interface NodeE2eeContinuityChange {
  readonly outcome: "adopted" | "reminted" | "chain_broken";
  readonly continuityId?: string;
}

export type NodeE2eeFallbackReason =
  | "peer-legacy"
  | "undersized-connection"
  | "statement-unavailable";

/** One §12.5 ring entry. The stored entry's origin hash is not served. */
export interface NodeE2eeFallbackRingEntry {
  readonly occurredAt: number;
  readonly reason: NodeE2eeFallbackReason;
}

export interface NodeE2eeFallbackClass {
  readonly occurrences: number;
  readonly ringOverflows: number;
  readonly lastOccurrenceAt?: number;
}

/**
 * §12.5's live undersized-connection pair, present only while the condition
 * holds: §12.5 scopes it to the current connection and forbids retaining it in
 * the ring, so an absent pair means "not undersized now", never "never was".
 */
export interface NodeE2eeUndersizedConnection {
  readonly assertedMaxDataChunkBytes: number;
  readonly advertisementMinChunkBytes: number;
}

export interface NodeE2eeFallback {
  readonly windowStartedAt?: number;
  readonly peerLegacy: NodeE2eeFallbackClass;
  readonly advertisementUnavailable: NodeE2eeFallbackClass;
  readonly ring: ReadonlyArray<NodeE2eeFallbackRingEntry>;
  readonly undersizedConnection?: NodeE2eeUndersizedConnection;
}

/** The record key every per-record command takes (§13.6). */
export interface NodeE2eeClientKey {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly fingerprint: string;
}

/**
 * §13.6's four owner commands, as one discriminated request.
 *
 * One shape because the node exposes one route: the four are one decision about
 * one record, and splitting them here would let a caller build a body the route
 * does not accept.
 */
export type NodeE2eeAuthorizationRequest = NodeE2eeClientKey &
  (
    | {
        readonly action: "approve";
        readonly maxRole: string;
        readonly capabilitySet: ReadonlyArray<string>;
        readonly displayLabel?: string;
      }
    | {
        readonly action: "narrow";
        readonly maxRole?: string;
        readonly capabilitySet?: ReadonlyArray<string>;
      }
    | { readonly action: "revoke" }
    | { readonly action: "purge" }
  );
