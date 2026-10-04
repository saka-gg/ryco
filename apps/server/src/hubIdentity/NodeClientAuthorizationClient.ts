import {
  E2EE_APPROVED_CLIENTS_MAX,
  E2EE_KEY_FINGERPRINT_BYTES,
  E2EE_LAST_SEEN_WRITE_INTERVAL,
  E2EE_PAIRING_RESERVATION_LIFETIME,
  E2EE_PAIRING_WINDOW,
  E2EE_PENDING_CLIENT_RETENTION,
  E2EE_PENDING_CLIENTS_MAX_GLOBAL,
  E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
  E2EE_REVOKED_CLIENTS_RETAINED_MAX,
  E2EE_SAFETY_NUMBER_DIGITS,
} from "@ryco/shared/relayE2eeConstants";
import {
  type E2eeAdmittedAuthoritySnapshot,
  type E2eeClientAuthorization,
  type E2eeClientAuthorizationKey,
  type E2eeClientAuthorizationStatus,
  e2eeAuthorizationWithdrawn,
  e2eeRoleRank,
  e2eeSecretBytesEqual,
} from "@ryco/shared/relayE2eeHandshake";
import { formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import {
  assertE2eeAccountId,
  assertRelayCapabilityLiteral,
  assertRelayEffectiveRoleLiteral,
  canonicalizeE2eeHubOrigin,
} from "@ryco/shared/relayE2eeTranscripts";

import {
  clientAuthorizationIndexKey,
  clientAuthorizationPartitionKey,
  initialClientAuthorizationRecord,
  isValidClientDisplayLabel,
  type NodeClientAuthorizationRecordFile,
  type NodeClientAuthorizationStore,
  NodeClientAuthorizationStoreError,
  type StoredClientAuthorizationEntry,
  type StoredClientPairingWindow,
} from "./NodeClientAuthorizationStore.ts";

// The §13.6 Branch A authorization policy —
// docs/relay-e2ee-protocol.md §13.6 (records, caps, retention, eviction, the
// owner-opened pairing window, and authorization withdrawal), §13.2 (the
// pairing ceremony and its ordering), §8.6 step 6 (the authorization read),
// §8.9 (the implicit-finish re-check), and §15 (the bounds).
//
// WHAT THIS OWNS: every decision the record set implies. The store owns the
// bytes; this owns which record may be evicted, when a window grants its
// reservation, what the handshake is told, and the ordered withdrawal
// procedure.
//
// ─── THE THREE SEAMS THIS EXPOSES, AND WHY THEY HAVE THESE SHAPES ───────────
//
// 1. `lookupClientAuthorization` and `reReadAuthorization` are SYNCHRONOUS, and
//    not because that was convenient: `E2eeNodeHandshakeOptions` and
//    `authenticateImplicitFinish` declare them
//    `(key) => E2eeClientAuthorization | undefined`, so the authoritative answer
//    has to be in memory before §8.6 step 6 runs. That is what makes §8.6's
//    "this read and the row N3 transition MUST be atomic with respect to the
//    §13.6 authorization-withdrawal write" hold for free HERE: `receiveHello`
//    runs steps 1–8 in one synchronous turn, and this module publishes a
//    committed change to the in-memory index in the same turn the durable write
//    resolves. No withdrawal can land between the read and the transition
//    because nothing can run between them.
//
//    The cost is that a mutation performed by ANOTHER PROCESS is not visible
//    until `reload`. That is a real limit and it is why `withdraw`-shaped
//    operations must run in the process that owns the live channels — see the
//    note on `applyOwnerChange`.
//
// 2. `admitActiveChannel` is the row N3 seam. Registration for the sweep and the
//    final withdrawal test happen in one call, so a channel cannot exist in the
//    `e2ee` state while being invisible to a sweep. That is the other half of
//    the §13.6 ordering argument: a handshake that reaches N3 after a commit
//    either fails the test here or is registered before the sweep runs.
//
//    ONE REGISTRATION PER CHANNEL, CARRYING A MUTABLE PHASE — never an in-flight
//    set and a live-channel set with nothing linking them. §13.6's sweep has to
//    reach an in-flight handshake and an active channel, and a channel crossing
//    row N3 is both in succession. With two collections, admitting the channel
//    into one does not retire it from the other, so the two enumerations can
//    each conclude the channel is the other's: not yet `e2ee` for the first, no
//    longer in flight for the second. It is then swept by neither and stays open
//    behind an acknowledgement that says no such channel is — the failure §12.6
//    names explicitly, and §13.6's sweep has exactly the same shape. One object
//    whose phase the row-N3 transition mutates makes "exactly one enumeration"
//    a property of the structure: `Array.from` over the set IS the single
//    consistent snapshot, and the dispatch reads the phase it froze.
//
// 3. Pairing admission is TWO calls. §13.2 step 3 requires the caps and the
//    window reservation to be evaluated before anything is emitted and entirely
//    in memory, and the durable mutation to happen only after the reject and the
//    close — leaving the fsync on the response path would make "this key is not
//    on file", and "the owner has a pairing window open", measurable by latency
//    alone. `evaluatePairingAdmission` is the in-memory half; the caller emits
//    and closes, then calls `commitPairingAdmission`.

export type NodeClientAuthorizationErrorCode =
  /** Malformed owner input: a key, role, capability, label, or safety number. */
  | "client_authorization_invalid"
  /** No record under this full key (§13.6 key is all three fields). */
  | "client_authorization_not_found"
  /** The command requires an `approved` record and this one is not. */
  | "client_authorization_not_approved"
  /** A narrowing command was handed a change that widens or leaves authority. */
  | "client_authorization_not_narrowing"
  /** LTI may reconcile only the exact same non-revoked record and authority. */
  | "client_authorization_conflict"
  /** §13.6: `E2EE_APPROVED_CLIENTS_MAX` — approval fails explicitly and evicts nothing. */
  | "client_authorization_approved_cap"
  /** The durable record could not be read or committed. */
  | "client_authorization_state_failed"
  /**
   * The record was committed but a live channel could not be closed.
   *
   * §13.6 forbids acknowledging a withdrawal before the sweep completes, so a
   * sweep that could not finish MUST NOT return success. The commit stands and
   * the operation is idempotent, so the owner's retry re-runs the sweep alone.
   */
  | "client_authorization_sweep_failed";

export class NodeClientAuthorizationError extends Error {
  readonly code: NodeClientAuthorizationErrorCode;

  constructor(code: NodeClientAuthorizationErrorCode) {
    super("Node client authorization operation failed.");
    this.name = "NodeClientAuthorizationError";
    this.code = code;
  }
}

function authorizationError(code: NodeClientAuthorizationErrorCode): never {
  throw new NodeClientAuthorizationError(code);
}

/** One record as the §13.6 display surfaces need it. Never a raw key. */
export interface NodeClientAuthorizationRecord {
  readonly status: E2eeClientAuthorizationStatus;
  readonly hubOrigin: string;
  readonly accountId: string;
  /** §7.1 `SHA256:` display form of the `ryco.client-key.v1` fingerprint. */
  readonly fingerprintDisplay: string;
  readonly maxRole: string;
  readonly capabilitySet: readonly string[];
  readonly createdAt: number;
  readonly approvedAt: number | undefined;
  readonly revokedAt: number | undefined;
  readonly lastSeenAt: number | undefined;
  readonly safetyNumber: string;
  readonly displayLabel: string | undefined;
  /** §13.6: whether this record still HOLDS its pairing reservation right now. */
  readonly pairingReserved: boolean;
  /**
   * The `channel.open` role the node received when this device introduced
   * itself, or `undefined` for a record that predates the field or was created
   * by a Local Trusted Introduction. Display metadata only — see the stored
   * field. It is the one ceiling an approval can name that both admits the
   * device and does not exceed what the Hub assigned it.
   *
   * On a PENDING record it is the role of the device's latest attempt this
   * process saw, which may be newer than the one on disk: a peer's hello writes
   * the role durably at most once per record, and any later move is held in
   * memory (see `PendingObservedRoleRefresh`).
   */
  readonly observedRole: string | undefined;
}

/** §13.6: what the CLI must be able to say about an owner-opened window. */
export interface NodeClientPairingWindowState {
  readonly fingerprintDisplay: string;
  readonly openedAt: number;
  readonly expiresAt: number;
  /**
   * The single reservation has been taken by the attempt that matched the
   * discriminator. §13.6 requires this to be distinguishable from "no window is
   * open", so the owner can tell "my device has not reached the node" from
   * "some other attempt consumed the window" — the latter being impossible
   * without the owner's own client key.
   */
  readonly spent: boolean;
}

/** §13.6's display surface, assembled once so no caller re-derives saturation. */
export interface NodeClientAuthorizationListing {
  readonly records: readonly NodeClientAuthorizationRecord[];
  /** §13.6: the listing MUST flag when either pending cap is saturated. */
  readonly pendingGlobalSaturated: boolean;
  readonly saturatedAccounts: readonly { readonly hubOrigin: string; readonly accountId: string }[];
  /**
   * §13.6: a bounded, owner-clearable count of pairing attempts refused for
   * pending-cap.
   *
   * IN MEMORY, deliberately. §15 forbids a bound-exceeding attempt from touching
   * any instrumentation entry other than §12.5's fallback counter, and the
   * pending caps are §15 bounds. An in-memory saturating count discharges
   * §13.6's display duty without adding a durable write to a refusal path — and
   * without adding a write to the path whose timing §13.6 claims is
   * indistinguishable.
   */
  readonly refusedPairingAttempts: number;
  readonly pairingWindow: NodeClientPairingWindowState | undefined;
}

/**
 * WHICH window this decision spent its reservation on, or `undefined` for none.
 *
 * AN IDENTITY AND NOT A FLAG, because the durable spend rides a commit that
 * §13.2 step 3 defers past the reject and the close, and the owner can open a
 * NEW window in that gap — from the CLI in this process or in another one. A
 * bare boolean tells the commit only that SOME window was spent, so it stamps
 * `spentAt` on whichever window is open when it lands: a window this attempt
 * never matched is marked spent, which is precisely §13.6's "some other attempt
 * consumed the window — impossible without the owner's own client key" signal
 * raised falsely, and the device the owner just named silently loses the
 * reservation that is its only way past a saturated pending cap.
 *
 * The value is `windowLatch`'s, so a window that expired, was closed, or was
 * re-opened in the gap simply loses the durable spend — which §13.2 already
 * classifies as a benign best-effort loss.
 */
export type SpentPairingWindow = string | undefined;

/**
 * A pending record's observed role, moved by a later attempt under its key.
 *
 * DURABLE AT MOST ONCE PER RECORD. Every attempt under a key already on file is
 * a peer's hello, and a malicious Hub can open those at the relay's rate while
 * alternating the role it assigns — so a durable rewrite per move would let the
 * party opening channels drive full, fsync'd rewrites of the record file, and
 * contend its lock with the owner's own commands, without bound. That is the
 * rate §12.5 coalesces its fallback writes against, and this path is bounded
 * harder still: a BACKFILL — the record on disk carries no role at all, because
 * it predates the field or arrived under one this node cannot rank — is the
 * only move written to disk, and a backfilled record has a role, so it is never
 * written from here again. Every other move lives in memory, where the owner
 * surfaces read it, and is gone at restart until the device's next attempt.
 */
export interface PendingObservedRoleRefresh {
  readonly indexKey: string;
  /** Which record under the key: one re-created after a purge or expiry is another. */
  readonly createdAt: number;
  readonly observedRole: string;
}

/** The §13.2 step 3 decision, taken entirely in memory before anything is emitted. */
export type NodeClientPendingAdmission =
  /**
   * A record already exists under this key; §13.2 creates nothing.
   *
   * The one thing it may refresh is a PENDING record's observed role, and only
   * when this attempt arrived under a different one — so a request recorded
   * before the field existed, or before the Hub changed the account's role, is
   * offered to the owner at the role the device now connects with. Display
   * metadata on the pending class only, and on disk at most once per record
   * (see `PendingObservedRoleRefresh`): `approved` and `revoked` records are
   * never touched from a peer's hello.
   */
  | {
      readonly kind: "existing";
      readonly status: E2eeClientAuthorizationStatus;
      readonly spentPairingWindow: SpentPairingWindow;
      readonly observedRoleRefresh: PendingObservedRoleRefresh | undefined;
    }
  | {
      readonly kind: "refused";
      readonly reason: "pending_cap_global" | "pending_cap_per_account";
      readonly spentPairingWindow: SpentPairingWindow;
    }
  | {
      readonly kind: "admit";
      readonly entry: StoredClientAuthorizationEntry;
      /** The eviction target SELECTED here and removed only at commit (§13.2 step 3). */
      readonly evictIndexKey: string | undefined;
      readonly spentPairingWindow: SpentPairingWindow;
    };

/** What a §13.6 withdrawal actually terminated, for the operator acknowledgement. */
export interface NodeClientAuthorizationChangeResult {
  readonly closedChannels: number;
  readonly abortedHandshakes: number;
}

export interface NodeClientIntroductionResult {
  readonly disposition: "created" | "promoted" | "reconciled";
  readonly record: NodeClientAuthorizationRecord;
}

/**
 * The row N3 seam: the withdrawal test, then — through `established` — the
 * phase change that makes the channel an ACTIVE E2EE channel for the sweep.
 *
 * §13.6 defines that term as "a channel whose node-side mode machine is in the
 * `e2ee` state of §4.4", so the phase may not change while the accept is still
 * being built: the test has to be decided first, because a refusal must stop the
 * accept existing at all, but between it and the completed row N3 the §8.6 step
 * 8 work can still fail — and that failure lands in a later turn than the test.
 * Until `established` is called the entry stays in the `in_flight` phase, where
 * the sweep's FATAL-PRE abort with the generic reject is the truthful
 * disposition for a peer that has received no accept.
 *
 * `established` MUST be called in the same synchronous turn as the `establish`
 * that returned it — row N3 is one transition — and is idempotent. It never
 * resurrects a registration a sweep or a release has already retired.
 */
export type NodeClientChannelAdmission =
  | { readonly kind: "entered"; readonly release: () => void; readonly established: () => void }
  | { readonly kind: "refused"; readonly reason: "authorization_withdrawn" };

/**
 * One channel's handle on the §13.6 sweep, from its §8.6 step 6 snapshot
 * onwards.
 *
 * `establish` is row N3 on the SAME registration the in-flight abort would have
 * reached, so the crossing is a phase change rather than a move between two
 * collections.
 */
export interface NodeClientHandshakeRegistration {
  /** Row N3 (§4.4, §8.6 step 8): the withdrawal test, and the phase change on its result. */
  readonly establish: (input: {
    /** FATAL-POST with error code `policy` (§11.3 Q9). */
    readonly close: () => void | Promise<void>;
  }) => NodeClientChannelAdmission;
  /** Retire it: authenticated finish, any fatal outcome, or channel close. */
  readonly release: () => void;
}

export interface NodeClientAuthorizationClient {
  /** §8.6 step 6. Synchronous by contract; see the seam note at the top. */
  readonly lookupClientAuthorization: (
    key: E2eeClientAuthorizationKey,
  ) => E2eeClientAuthorization | undefined;
  /** §8.9's IK re-check, read under the snapshot's FULL key. Same answer, named for its caller. */
  readonly reReadAuthorization: (
    key: E2eeClientAuthorizationKey,
  ) => E2eeClientAuthorization | undefined;
  /**
   * Row N3 for a channel that was never on the in-flight list.
   *
   * Equivalent to `registerInFlightHandshake(...).establish(...)` with no window
   * in between, and it creates the same single registration — already in the
   * `e2ee` phase — so it can never be a second entry for a channel that is
   * already registered. It throws `client_authorization_invalid` on a snapshot
   * this node could not have stored, for the same reason and with the same
   * meaning as `registerInFlightHandshake`.
   */
  readonly admitActiveChannel: (input: {
    readonly admittedAuthority: E2eeAdmittedAuthoritySnapshot;
    /** FATAL-POST with error code `policy` (§11.3 Q9). */
    readonly close: () => void | Promise<void>;
  }) => NodeClientChannelAdmission;
  /**
   * A handshake that has taken its §8.6 step 6 snapshot but has not yet reached
   * row N3, for the §13.6 in-flight abort (FATAL-PRE, generic reject).
   *
   * The returned handle carries row N3, so the channel stays ONE registration
   * across the transition and is dispatched by exactly one enumeration.
   *
   * Throws `client_authorization_invalid` rather than registering a snapshot
   * whose key this node cannot encode: the sweep is keyed, so such an entry
   * would be one it could never act on.
   */
  readonly registerInFlightHandshake: (input: {
    readonly admittedAuthority: E2eeAdmittedAuthoritySnapshot;
    readonly abort: () => void | Promise<void>;
  }) => NodeClientHandshakeRegistration;
  /** §13.2 step 3, in memory: caps and the window reservation, before any emission. */
  readonly evaluatePairingAdmission: (input: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly clientIdentityFingerprint: Uint8Array;
    /** The derived §13.4 display string. Raw keys never enter this module. */
    readonly safetyNumber: string;
    /**
     * The `channel.open.effectiveRole` this attempt arrived under (§8.3 element
     * 14), which §8.6 step 5 has already made equal to the client's intended
     * role. Stored as display metadata on the pending record; never authority.
     */
    readonly observedRole: string;
  }) => NodeClientPendingAdmission;
  /** §13.2 step 3, after the reject and the close: the pending-class mutation. */
  readonly commitPairingAdmission: (admission: NodeClientPendingAdmission) => Promise<void>;
  readonly list: () => Promise<NodeClientAuthorizationListing>;
  readonly get: (
    key: E2eeClientAuthorizationKey,
  ) => Promise<NodeClientAuthorizationRecord | undefined>;
  readonly approve: (input: {
    readonly key: E2eeClientAuthorizationKey;
    readonly maxRole: string;
    readonly capabilitySet: readonly string[];
    readonly displayLabel?: string | undefined;
  }) => Promise<NodeClientAuthorizationChangeResult>;
  /**
   * Local Trusted Introduction only: create/promote the exact approved record,
   * or reconcile an already identical one. Revocations and mismatches fail
   * closed; this is not an owner-command widening primitive.
   */
  readonly introduce: (input: {
    readonly key: E2eeClientAuthorizationKey;
    readonly maxRole: string;
    readonly capabilitySet: readonly string[];
    readonly safetyNumber: string;
    readonly displayLabel?: string | undefined;
  }) => Promise<NodeClientIntroductionResult>;
  /** §13.6 narrow: reduce `maxRole`, remove capabilities, or both. Never widens. */
  readonly narrow: (input: {
    readonly key: E2eeClientAuthorizationKey;
    readonly maxRole?: string | undefined;
    readonly capabilitySet?: readonly string[] | undefined;
  }) => Promise<NodeClientAuthorizationChangeResult>;
  readonly revoke: (
    key: E2eeClientAuthorizationKey,
  ) => Promise<NodeClientAuthorizationChangeResult>;
  readonly purge: (key: E2eeClientAuthorizationKey) => Promise<NodeClientAuthorizationChangeResult>;
  readonly setDisplayLabel: (input: {
    readonly key: E2eeClientAuthorizationKey;
    readonly displayLabel: string | undefined;
  }) => Promise<void>;
  /** §13.6 `lastSeenAt`, coalesced to one durable write per `E2EE_LAST_SEEN_WRITE_INTERVAL`. */
  readonly touch: (key: E2eeClientAuthorizationKey) => Promise<boolean>;
  /** §13.6: open the owner-bound window. The discriminator is REQUIRED. */
  readonly openPairingWindow: (
    clientIdentityFingerprint: Uint8Array,
  ) => Promise<NodeClientPairingWindowState>;
  readonly closePairingWindow: () => Promise<void>;
  /** §13.6 retention: drop pending records past `E2EE_PENDING_CLIENT_RETENTION`. */
  readonly sweepExpired: () => Promise<number>;
  readonly clearRefusedPairingAttempts: () => void;
  /** Re-read the durable record into the in-memory index (see seam note 1). */
  readonly reload: () => Promise<void>;
}

/**
 * The saturating bound on the in-memory refusal count.
 *
 * §13.6 asks for a bounded count. The number the owner needs is "is this
 * happening at all, and is it still happening"; an exact total under a flood is
 * not more informative and an unbounded counter is one more thing peer traffic
 * can drive.
 */
const MAX_REFUSED_PAIRING_ATTEMPTS = 9_999;

/**
 * The two phases §13.6's sweep dispatches on.
 *
 * `in_flight` is past §8.6 step 6 and before row N3 — the FATAL-PRE abort with
 * the generic reject. `e2ee` is the active channel of §13.6 — FATAL-POST with
 * error code `policy`. They are a field on one object rather than two sets, so
 * the transition between them cannot lose a channel.
 */
type RegistrationPhase = "in_flight" | "e2ee";

interface Registration {
  phase: RegistrationPhase;
  readonly snapshot: E2eeAdmittedAuthoritySnapshot;
  /**
   * Never `undefined`: a registration whose key this node could not encode is
   * refused at creation rather than admitted here, because the sweep is keyed
   * and an unkeyed entry is one the sweep could never act on.
   */
  readonly indexKey: string;
  abort: (() => void | Promise<void>) | undefined;
  close: (() => void | Promise<void>) | undefined;
  /**
   * A sweep selected this registration for termination and the termination did
   * not happen — the callback threw, or was missing.
   *
   * It is the outstanding half of §13.6's ordered procedure, carried on the
   * registration because the record no longer carries it: the durable commit
   * landed, so the record already reads as the owner asked, and only this flag
   * remembers that the channel admitted under the withdrawn authority is still
   * open. Every later owner command on this key discharges it, INCLUDING a
   * widening one — §13.6 makes an approval effective "only on a fresh ticket,
   * channel, and handshake, and never retroactively on an open one", so a
   * re-approval does not license the survivor; it just stops the withdrawal test
   * from naming it.
   */
  owedTermination: boolean;
}

interface ClassifiedEntry {
  readonly status: E2eeClientAuthorizationStatus;
  readonly entry: StoredClientAuthorizationEntry;
}

/** The record key in its stored form, or `undefined` when it is not a key at all. */
function encodeKey(key: E2eeClientAuthorizationKey): string | undefined {
  if (
    !(key.clientIdentityFingerprint instanceof Uint8Array) ||
    key.clientIdentityFingerprint.byteLength !== E2EE_KEY_FINGERPRINT_BYTES
  ) {
    return undefined;
  }
  try {
    return clientAuthorizationIndexKey({
      hubOrigin: canonicalizeE2eeHubOrigin(key.hubOrigin),
      accountId: assertE2eeAccountId(key.accountId),
      clientIdentityFingerprint: Buffer.from(key.clientIdentityFingerprint).toString("base64url"),
    });
  } catch {
    return undefined;
  }
}

function requireKey(key: E2eeClientAuthorizationKey): string {
  return encodeKey(key) ?? authorizationError("client_authorization_invalid");
}

function requireRole(role: string): string {
  try {
    // Ranked as well as validated: §8.3's ordering is what every ceiling check
    // uses, and a literal the relay vocabulary admits but the ordering does not
    // must be refused at the owner's command rather than at a later comparison.
    const validated = assertRelayEffectiveRoleLiteral(role);
    e2eeRoleRank(validated);
    return validated;
  } catch {
    return authorizationError("client_authorization_invalid");
  }
}

/**
 * The observed role in its stored form, or `undefined` when it is not one.
 *
 * Soft rather than `requireRole`'s throw: this runs inside §13.2 step 3, where a
 * throw costs the whole pending record, and a role the node cannot rank is a
 * reason to record no role — never a reason to record no request.
 */
function observedRoleOf(role: string): string | undefined {
  try {
    const validated = assertRelayEffectiveRoleLiteral(role);
    e2eeRoleRank(validated);
    return validated;
  } catch {
    return undefined;
  }
}

function requireCapabilitySet(capabilities: readonly string[]): readonly string[] {
  if (!Array.isArray(capabilities)) return authorizationError("client_authorization_invalid");
  try {
    const validated = capabilities.map((capability) => assertRelayCapabilityLiteral(capability));
    // Sorted and deduplicated once, here, so the stored form is canonical and
    // every superset test downstream compares like with like.
    return [...new Set(validated)].toSorted();
  } catch {
    return authorizationError("client_authorization_invalid");
  }
}

function requireDisplayLabel(label: string | undefined): string | undefined {
  if (label === undefined || label === "") return undefined;
  if (!isValidClientDisplayLabel(label)) authorizationError("client_authorization_invalid");
  return label;
}

function requireLocalIntroductionDisplayLabel(label: string | undefined): string | undefined {
  const validated = requireDisplayLabel(label);
  if (validated !== undefined && validated.trim() !== validated) {
    return authorizationError("client_authorization_invalid");
  }
  return validated;
}

const SAFETY_NUMBER_PATTERN = new RegExp(
  `^\\d{${E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup}}(?:${E2EE_SAFETY_NUMBER_DIGITS.separator.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  )}\\d{${E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup}}){${E2EE_SAFETY_NUMBER_DIGITS.groups - 1}}$`,
);

function requireSafetyNumber(value: string): string {
  if (typeof value !== "string" || !SAFETY_NUMBER_PATTERN.test(value)) {
    return authorizationError("client_authorization_invalid");
  }
  return value;
}

/**
 * Place an entry in its class.
 *
 * Written out rather than indexed by a computed key so the three arrays stay
 * three distinct fields to the type checker — the whole point of the store's
 * partition is that a class is never a value a caller can compute wrongly.
 */
function withEntryIn(
  file: NodeClientAuthorizationRecordFile,
  status: E2eeClientAuthorizationStatus,
  entry: StoredClientAuthorizationEntry,
): NodeClientAuthorizationRecordFile {
  if (status === "pending") return { ...file, pending: [...file.pending, entry] };
  if (status === "approved") return { ...file, approved: [...file.approved, entry] };
  return { ...file, revoked: [...file.revoked, entry] };
}

function authorityOf(classified: ClassifiedEntry): E2eeClientAuthorization {
  return {
    status: classified.status,
    maxRole: classified.entry.maxRole,
    capabilitySet: classified.entry.capabilitySet,
  };
}

function isExpiredPending(entry: StoredClientAuthorizationEntry, now: number): boolean {
  return now - entry.createdAt > E2EE_PENDING_CLIENT_RETENTION;
}

/**
 * §13.6: a pending record HOLDS its reservation while
 * `now - pairingReservedAt <= E2EE_PAIRING_RESERVATION_LIFETIME`, and has spent
 * it thereafter.
 *
 * The bound is the whole point. An unbounded reservation would let a flood
 * convert every pending slot into an un-evictable one and permanently disable
 * the owner's escape hatch — the self-poisoning an earlier draft of §13.6 had.
 */
function holdsReservation(entry: StoredClientAuthorizationEntry, now: number): boolean {
  return (
    entry.pairingReservedAt !== undefined &&
    now - entry.pairingReservedAt <= E2EE_PAIRING_RESERVATION_LIFETIME
  );
}

/**
 * §13.6's pending eviction: the oldest ELIGIBLE record, deterministically.
 *
 * TAKES ONLY PENDING ENTRIES, and that is the structural half of §13.6's
 * unconditional invariant: this function has no way to name an `approved` or
 * `revoked` record, so no caller of it can evict one. The caller narrows the
 * list to the partition of the cap that was exceeded before calling.
 *
 * `createdAt` ties break on the record key so two nodes — and one node twice —
 * choose the same victim.
 */
function selectPendingEviction(
  pending: readonly StoredClientAuthorizationEntry[],
  now: number,
): StoredClientAuthorizationEntry | undefined {
  let victim: StoredClientAuthorizationEntry | undefined;
  let victimKey = "";
  for (const entry of pending) {
    if (holdsReservation(entry, now)) continue;
    const key = clientAuthorizationIndexKey(entry);
    if (
      victim === undefined ||
      entry.createdAt < victim.createdAt ||
      (entry.createdAt === victim.createdAt && key < victimKey)
    ) {
      victim = entry;
      victimKey = key;
    }
  }
  return victim;
}

function openWindow(
  file: NodeClientAuthorizationRecordFile,
  now: number,
): StoredClientPairingWindow | undefined {
  const window = file.pairingWindow;
  if (window === null) return undefined;
  return now - window.openedAt <= E2EE_PAIRING_WINDOW ? window : undefined;
}

/**
 * Identity of one window, for the in-memory spent latch.
 *
 * The latch has to survive a `reload`, because the durable spend rides the
 * post-close commit of §13.2 step 3 and an unrelated read in between must not be
 * able to hand the same reservation out twice. Two windows opened in the same
 * millisecond for the same fingerprint are the same window for this purpose, and
 * `openPairingWindow` clears the latch explicitly so a genuine re-open is never
 * born spent.
 */
function windowLatch(window: StoredClientPairingWindow): string {
  return `${window.openedAt}:${window.clientIdentityFingerprint}`;
}

/** A stored base64url fingerprint, back in the raw digest form §7.1 compares. */
function storedFingerprintBytes(stored: string): Uint8Array {
  return Uint8Array.from(Buffer.from(stored, "base64url"));
}

function fingerprintDisplayOf(stored: string): string {
  return formatE2eeKeyFingerprint(storedFingerprintBytes(stored));
}

function toRecord(
  classified: ClassifiedEntry,
  now: number,
  observedRole: string | undefined,
): NodeClientAuthorizationRecord {
  const { entry } = classified;
  return {
    status: classified.status,
    hubOrigin: entry.hubOrigin,
    accountId: entry.accountId,
    fingerprintDisplay: fingerprintDisplayOf(entry.clientIdentityFingerprint),
    maxRole: entry.maxRole,
    capabilitySet: entry.capabilitySet,
    createdAt: entry.createdAt,
    approvedAt: entry.approvedAt,
    revokedAt: entry.revokedAt,
    lastSeenAt: entry.lastSeenAt,
    safetyNumber: entry.safetyNumber,
    displayLabel: entry.displayLabel,
    pairingReserved: classified.status === "pending" && holdsReservation(entry, now),
    observedRole,
  };
}

/** Every record, with expired pending records already gone (§13.6 retention). */
function classify(
  file: NodeClientAuthorizationRecordFile,
  now: number,
): readonly ClassifiedEntry[] {
  return [
    ...file.pending
      .filter((entry) => !isExpiredPending(entry, now))
      .map((entry): ClassifiedEntry => ({ status: "pending", entry })),
    ...file.approved.map((entry): ClassifiedEntry => ({ status: "approved", entry })),
    ...file.revoked.map((entry): ClassifiedEntry => ({ status: "revoked", entry })),
  ];
}

/** Drop pending records past `E2EE_PENDING_CLIENT_RETENTION`; touches nothing else. */
function withExpiredPendingRemoved(
  file: NodeClientAuthorizationRecordFile,
  now: number,
): NodeClientAuthorizationRecordFile {
  const pending = file.pending.filter((entry) => !isExpiredPending(entry, now));
  return pending.length === file.pending.length ? file : { ...file, pending };
}

/**
 * A pending record that carries no observed role given one, or `file` itself
 * when there is nothing to fill in.
 *
 * ONLY EVER A BACKFILL. A record that already carries a role is left alone
 * whatever this refresh says — including one another attempt backfilled between
 * this decision and its commit — so a peer's hello writes a record's role to
 * disk at most once (see `PendingObservedRoleRefresh`).
 *
 * Reaches `file.pending` and nothing else, for the reason
 * `selectPendingEviction` takes only pending entries: this runs from a peer's
 * hello, and the structural guarantee that peer action cannot name an
 * `approved` or `revoked` record is worth more than a status check. A record
 * the owner approved or revoked between the decision and this commit is simply
 * not found here, and nor is one re-created under the same key since.
 */
function withPendingObservedRoleBackfilled(
  file: NodeClientAuthorizationRecordFile,
  refresh: PendingObservedRoleRefresh,
): NodeClientAuthorizationRecordFile {
  let changed = false;
  const pending = file.pending.map((entry) => {
    if (
      entry.observedRole !== undefined ||
      entry.createdAt !== refresh.createdAt ||
      clientAuthorizationIndexKey(entry) !== refresh.indexKey
    ) {
      return entry;
    }
    changed = true;
    return { ...entry, observedRole: refresh.observedRole };
  });
  return changed ? { ...file, pending } : file;
}

function withoutKey(
  file: NodeClientAuthorizationRecordFile,
  indexKey: string,
): NodeClientAuthorizationRecordFile {
  const drop = (entries: readonly StoredClientAuthorizationEntry[]) =>
    entries.filter((entry) => clientAuthorizationIndexKey(entry) !== indexKey);
  return {
    ...file,
    pending: drop(file.pending),
    approved: drop(file.approved),
    revoked: drop(file.revoked),
  };
}

function findEntry(
  file: NodeClientAuthorizationRecordFile,
  indexKey: string,
  now: number,
): ClassifiedEntry | undefined {
  for (const classified of classify(file, now)) {
    if (clientAuthorizationIndexKey(classified.entry) === indexKey) return classified;
  }
  return undefined;
}

/** §13.6: past `E2EE_REVOKED_CLIENTS_RETAINED_MAX`, only the OLDEST revoked records go. */
function withRevokedCapApplied(
  revoked: readonly StoredClientAuthorizationEntry[],
): readonly StoredClientAuthorizationEntry[] {
  if (revoked.length <= E2EE_REVOKED_CLIENTS_RETAINED_MAX) return revoked;
  const ordered = revoked.toSorted((left, right) => {
    const byTime = (left.revokedAt ?? 0) - (right.revokedAt ?? 0);
    if (byTime !== 0) return byTime;
    return clientAuthorizationIndexKey(left) < clientAuthorizationIndexKey(right) ? -1 : 1;
  });
  return ordered.slice(ordered.length - E2EE_REVOKED_CLIENTS_RETAINED_MAX);
}

export async function makeNodeClientAuthorizationClient(options: {
  readonly store: NodeClientAuthorizationStore;
  readonly now?: () => number;
}): Promise<NodeClientAuthorizationClient> {
  const now = options.now ?? (() => Date.now());
  const store = options.store;

  /**
   * The in-memory authority for the synchronous §8.6 step 6 read.
   *
   * Republished in the same turn a durable commit resolves, which is what makes
   * the step-6 read and the row N3 transition atomic with respect to the §13.6
   * write without a generation counter.
   */
  let file: NodeClientAuthorizationRecordFile = initialClientAuthorizationRecord();
  let index = new Map<string, ClassifiedEntry>();
  let refusedPairingAttempts = 0;
  let spentWindowLatch: string | undefined;
  /**
   * Every channel the node is carrying past §8.6 step 6, in one collection.
   *
   * One entry per channel, whatever phase it is in. See seam note 2: two
   * collections is how a channel crossing row N3 ends up in neither sweep.
   */
  const registrations = new Set<Registration>();
  /**
   * The role a pending record's latest attempt arrived under, where it moved
   * after the role on disk was written — see `PendingObservedRoleRefresh` for
   * why it is not written there.
   *
   * Bound to one RECORD, not one key, by its `createdAt`: a key purged or
   * expired and introduced again is a new request, and must not inherit a role
   * an earlier one was seen under. Pruned on every publish to the records still
   * pending, so it never outgrows the pending caps.
   */
  const movedObservedRoles = new Map<
    string,
    { readonly createdAt: number; readonly observedRole: string }
  >();

  /** The observed role an owner surface shows, and an owner action settles. */
  const observedRoleFor = (classified: ClassifiedEntry): string | undefined => {
    if (classified.status !== "pending") return classified.entry.observedRole;
    const moved = movedObservedRoles.get(clientAuthorizationIndexKey(classified.entry));
    return moved !== undefined && moved.createdAt === classified.entry.createdAt
      ? moved.observedRole
      : classified.entry.observedRole;
  };

  const currentWindowState = (
    source: NodeClientAuthorizationRecordFile,
    at: number,
  ): NodeClientPairingWindowState | undefined => {
    const window = openWindow(source, at);
    if (window === undefined) return undefined;
    return {
      fingerprintDisplay: fingerprintDisplayOf(window.clientIdentityFingerprint),
      openedAt: window.openedAt,
      expiresAt: window.openedAt + E2EE_PAIRING_WINDOW,
      spent: window.spentAt !== undefined || spentWindowLatch === windowLatch(window),
    };
  };

  const publish = (next: NodeClientAuthorizationRecordFile): void => {
    file = next;
    const rebuilt = new Map<string, ClassifiedEntry>();
    for (const classified of classify(next, now())) {
      rebuilt.set(clientAuthorizationIndexKey(classified.entry), classified);
    }
    index = rebuilt;
    for (const [indexKey, moved] of movedObservedRoles) {
      const classified = rebuilt.get(indexKey);
      if (
        classified?.status !== "pending" ||
        classified.entry.createdAt !== moved.createdAt ||
        classified.entry.observedRole === moved.observedRole
      ) {
        movedObservedRoles.delete(indexKey);
      }
    }
  };

  const asStateFailure = <A>(operation: () => Promise<A>): Promise<A> =>
    operation().catch((error: unknown) => {
      if (error instanceof NodeClientAuthorizationStoreError) {
        return authorizationError("client_authorization_state_failed");
      }
      throw error;
    });

  const reload = (): Promise<void> => asStateFailure(async () => publish(await store.read()));
  await reload();

  /**
   * Bring the index back in step with the disk after a failed write.
   *
   * Never throws: it runs on a path that is already reporting a failure, and its
   * job is to make sure the failure cannot leave memory granting more than disk.
   */
  const resyncIndex = async (): Promise<void> => {
    try {
      publish(await store.read());
    } catch {
      publish(initialClientAuthorizationRecord());
    }
  };

  /**
   * The in-memory record under a key, with §13.6 retention applied at read.
   *
   * The index is rebuilt on every publish, but the clock keeps moving between
   * publishes: a pending record that expired since the last commit must already
   * be gone here, or a client re-pairing after `E2EE_PENDING_CLIENT_RETENTION`
   * would be told a record exists that the durable purge is about to drop.
   */
  const lookupClassified = (indexKey: string, at: number): ClassifiedEntry | undefined => {
    const classified = index.get(indexKey);
    if (classified === undefined) return undefined;
    if (classified.status === "pending" && isExpiredPending(classified.entry, at)) return undefined;
    return classified;
  };

  const currentAuthority = (indexKey: string): E2eeClientAuthorization | undefined => {
    const classified = lookupClassified(indexKey, now());
    return classified === undefined ? undefined : authorityOf(classified);
  };

  const lookupClientAuthorization = (
    key: E2eeClientAuthorizationKey,
  ): E2eeClientAuthorization | undefined => {
    const indexKey = encodeKey(key);
    // A key this node could never have stored has no record. Refusing rather
    // than throwing matters: this runs inside `receiveHello`, where a throw is a
    // local failure rather than the §11.2 P12 the absent record deserves.
    return indexKey === undefined ? undefined : currentAuthority(indexKey);
  };

  /**
   * The §13.6 sweep, run AFTER the durable commit and BEFORE acknowledgement.
   *
   * ONE PASS OVER ONE CONSISTENT SNAPSHOT. The capture is synchronous and
   * happens before the first await, so no channel can change phase inside it,
   * and each entry is dispatched by the phase the snapshot froze. A channel
   * crossing row N3 while this runs takes the disposition its snapshot phase
   * selects and is counted once; it cannot slip between two passes, because
   * there is one. A registration created during the awaits is absent from the
   * snapshot, and that is correct: it was admitted after the commit, so
   * `establish` already tested it against the narrowed record and refused it
   * there.
   *
   * TWO THINGS SELECT AN ENTRY, not one: the withdrawal test against the record
   * now in force, and an unpaid termination this key already owes. The second is
   * not redundant — the record is what the withdrawal test reads, and a later
   * owner command can move it back to a state under which the test says nothing
   * at all while the survivor of the failed sweep is still open. See
   * `Registration.owedTermination`.
   */
  const sweep = async (
    changed: ReadonlySet<string>,
  ): Promise<NodeClientAuthorizationChangeResult> => {
    const snapshot = Array.from(registrations, (registration) => ({
      registration,
      phase: registration.phase,
    }));
    const failures: unknown[] = [];
    let abortedHandshakes = 0;
    let closedChannels = 0;
    for (const entry of snapshot) {
      const { registration } = entry;
      // Still the node's to terminate. The snapshot is a list of objects, not a
      // claim that each is still live: the awaits below give a channel room to
      // release itself, and row N3 room to refuse and retire a handshake. Either
      // way the owner has nothing left owed on it, and terminating it again
      // would both act on a channel that is already gone and add it to the
      // counts — which are what the §13.6 acknowledgement means.
      if (!registrations.has(registration)) continue;
      if (!changed.has(registration.indexKey)) continue;
      if (
        !registration.owedTermination &&
        !e2eeAuthorizationWithdrawn(registration.snapshot, currentAuthority(registration.indexKey))
      ) {
        continue;
      }
      const terminate = entry.phase === "in_flight" ? registration.abort : registration.close;
      if (terminate === undefined) {
        // Unreachable by construction — every phase has its callback set by the
        // transition that put it there. Counted as a failure rather than skipped
        // anyway, because reporting a channel as terminated without having
        // terminated it is exactly the lie the acknowledgement must not tell.
        registration.owedTermination = true;
        failures.push(new NodeClientAuthorizationError("client_authorization_sweep_failed"));
        continue;
      }
      try {
        await terminate();
      } catch (error: unknown) {
        // Deliberately left registered, and marked. A close that failed may not
        // have happened, and §13.6's acknowledgement means "no channel admitted
        // under the withdrawn authority is still open" — so the owner's retry
        // has to be able to find this channel again, and so does a later command
        // whose own withdrawal test would no longer name it.
        registration.owedTermination = true;
        failures.push(error);
        continue;
      }
      registrations.delete(registration);
      if (entry.phase === "in_flight") abortedHandshakes += 1;
      else closedChannels += 1;
    }
    if (failures.length > 0) authorizationError("client_authorization_sweep_failed");
    return { closedChannels, abortedHandshakes };
  };

  /**
   * A durable commit with no sweep.
   *
   * For the operations that provably cannot narrow an admitted authority: the
   * pending-class mutations (no snapshot is ever taken from a `pending` record —
   * §8.6 step 6 refuses on `status` before it snapshots), the window, retention
   * expiry, the display label, and `lastSeenAt`.
   */
  const commit = (
    change: (
      current: NodeClientAuthorizationRecordFile,
    ) => NodeClientAuthorizationRecordFile | null,
    /**
     * Whether a FAILED commit must fail closed by re-reading, and — if that read
     * also fails — by publishing the empty record.
     *
     * TRUE FOR EVERY CHANGE THAT CAN WIDEN AUTHORITY, which is every owner
     * change: the durable write can land while the operation still rejects, and
     * a stale published index would then let §8.6 step 6 grant an authority the
     * record on disk no longer holds.
     *
     * FALSE IS FOR §13.2 STEP 3's PENDING CLASS ALONE. That change only appends
     * a pending record — which grants nothing, because step 6 refuses on
     * `status` before it reads a role or a capability — spends the owner's
     * window, or drops a pending entry, so no failure of it can leave memory
     * granting more than disk, and the fail-closed direction buys nothing there.
     * What it would cost is severe and silent: an empty publish refuses every
     * APPROVED client until an owner command republishes disk state, and this
     * path is reached from an unauthenticated peer's hello with its failures
     * deliberately swallowed (§13.2 makes the commit best-effort).
     */
    options: { readonly resyncOnFailure: boolean } = { resyncOnFailure: true },
  ): Promise<NodeClientAuthorizationRecordFile> =>
    asStateFailure(async () => {
      let next: NodeClientAuthorizationRecordFile;
      try {
        next = await store.update((current) => {
          const proposed = change(withExpiredPendingRemoved(current, now()));
          return proposed === null ? null : { ...proposed, revision: current.revision + 1 };
        });
      } catch (error: unknown) {
        // The in-memory index is the authority the SYNCHRONOUS §8.6 step 6 read
        // answers from, and a durable write can land and the operation still
        // reject. Leaving the pre-commit index published would then let step 6
        // grant an authority the record on disk no longer holds. Re-read before
        // reporting the failure, and if that also fails publish the empty
        // record: no record is no authority, which is the fail-closed direction
        // §8.6 step 6 already takes for an absent key.
        if (options.resyncOnFailure) await resyncIndex();
        throw error;
      }
      publish(next);
      return next;
    });

  /**
   * The §13.6 ORDERED PROCEDURE, and the only path that may change a record's
   * class or its authority fields.
   *
   * (a) durably commit; (b) sweep — close every active E2EE channel that fails
   * the withdrawal test as FATAL-POST `policy`, and abort every in-flight
   * handshake that fails it as FATAL-PRE; (c) only then return, which is the
   * operator acknowledgement. The order is the load-bearing part: committing
   * first means any handshake that reaches §8.6 step 6 afterwards reads the
   * narrowed record, so the window a sweep-then-commit implementation would
   * leave — the sweep's own duration — does not exist.
   *
   * It is uniform across revoke, purge, demote, capability removal, and approve,
   * because §13.6 defines all of them as one transition with one procedure: the
   * withdrawal test is applied per channel against that channel's own §8.6 step
   * 6 snapshot, so a widening change simply sweeps nothing. A command that both
   * narrows and widens needs no special case for the same reason.
   *
   * MUST RUN IN THE PROCESS THAT OWNS THE LIVE CHANNELS. Step (b) can only
   * reach the channels this client has registrations for; an out-of-process
   * caller commits (a) and acknowledges a sweep it never performed.
   *
   * STEP (b) RUNS WHETHER OR NOT STEP (a) HAD ANYTHING TO WRITE. "Nothing left
   * to commit" is not "nothing left to do": a command whose commit landed and
   * whose sweep then failed is not acknowledgeable, and the owner's retry
   * arrives with the record already in its target state. A `change` that returns
   * `null` says exactly that — the durable state already satisfies this command
   * — and the sweep it still owes is what makes the retry's acknowledgement
   * mean "no channel admitted under the withdrawn authority is still open".
   * Sweeping unconditionally is safe for the same reason it is necessary: the
   * per-channel test is evaluated against the record now in force, so a widening
   * closes nothing by construction — nothing, that is, EXCEPT a termination this
   * key already owes.
   *
   * WHY A WIDENING DISCHARGES THAT DEBT RATHER THAN REFUSING WHILE IT STANDS.
   * The alternative — refuse `approve` while a sweep is outstanding — leaves the
   * channel open either way, so it buys no safety, and it makes the record
   * un-approvable for as long as a close keeps failing on a channel the owner
   * cannot reach from the CLI at all. Discharging is also what §13.6 already
   * says the outcome must be: an approval "takes effect only on a fresh ticket,
   * channel, and handshake, and never retroactively on an open one", so the
   * survivor of the failed revocation is not a channel the re-approval licenses;
   * it is still a channel admitted under the withdrawn authority, and §13.6's
   * acknowledgement may not be given while one is open. The client re-handshakes
   * and is admitted under the new grant, which is exactly the "fresh channel"
   * §13.6 requires of a widening.
   */
  const applyOwnerChange = async (input: {
    readonly indexKey: string;
    readonly change: (
      current: NodeClientAuthorizationRecordFile,
    ) => NodeClientAuthorizationRecordFile | null;
  }): Promise<NodeClientAuthorizationChangeResult> => {
    await commit(input.change);
    return sweep(new Set([input.indexKey]));
  };

  const evaluatePairingAdmission: NodeClientAuthorizationClient["evaluatePairingAdmission"] = (
    input,
  ) => {
    const at = now();
    // A throw here is a local mistake, not a peer-input failure: §8.6 step 5 has
    // already validated the origin, the account id, and the fingerprint by the
    // time §13.2 step 3 runs, so an unencodable key means this node called it
    // with something it never authenticated.
    const indexKey = requireKey(input);
    const hubOrigin = canonicalizeE2eeHubOrigin(input.hubOrigin);
    const accountId = assertE2eeAccountId(input.accountId);
    const fingerprint = Buffer.from(input.clientIdentityFingerprint).toString("base64url");

    // §13.6: the reservation is granted only to an attempt whose AUTHENTICATED
    // fingerprint equals the owner-named discriminator — a value §8.6 step 5 has
    // already bound to a certificate self-signed by that client identity key. A
    // flood of fabricated identities never matches it, so no party the owner has
    // not named can cause an eviction at all.
    //
    // MATCHED BEFORE ANYTHING ELSE ABOUT THIS ATTEMPT IS CONSIDERED, because
    // §13.6 spends the reservation on "the first attempt that matches the
    // discriminator, whatever that attempt's outcome". The owner's own device
    // reaching a node that already holds its record is such an attempt: it
    // matches, and the window closes. Deciding the outcome first and the match
    // second would leave the window open after the device it names has arrived,
    // and the CLI would show the owner a window still waiting for a device that
    // is already on file.
    const window = openWindow(file, at);
    const latch = window === undefined ? undefined : windowLatch(window);
    const reserved =
      window !== undefined &&
      window.spentAt === undefined &&
      spentWindowLatch !== latch &&
      // §11.2 names key and fingerprint equality (§7.1) among the comparisons
      // that MUST be constant-time, and §13.2 step 3 now reaches this one from
      // an unauthenticated peer's hello: it is the same digest equality
      // `e2eeAuthorizationKeysEqual` performs, so it uses the same primitive
      // rather than `===` over the stored base64url form, which short-circuits
      // at the first differing character.
      e2eeSecretBytesEqual(
        storedFingerprintBytes(window.clientIdentityFingerprint),
        input.clientIdentityFingerprint,
      );
    // Spent the moment it is granted, whatever this attempt's outcome (§13.6),
    // and spent in memory because §13.2 step 3 keeps every durable write off the
    // response path. Two attempts cannot both receive it; the durable spend
    // rides the post-close commit, and carries the window's identity so that it
    // can only ever land on the window this decision actually matched.
    const spentPairingWindow: SpentPairingWindow = reserved ? latch : undefined;
    if (spentPairingWindow !== undefined) spentWindowLatch = spentPairingWindow;

    const observedRole = observedRoleOf(input.observedRole);
    const existing = lookupClassified(indexKey, at);
    // §13.6: a first-seen key produces a pending record. A key that already has
    // one — in ANY class — is not first-seen, and re-creating it would both
    // reset its retention and resurrect a record the owner revoked.
    if (existing !== undefined) {
      // Only a PENDING record's display metadata may follow the device, and
      // only when it actually moved: the request an owner approves has to name
      // the role the device connects with NOW, or the approval refuses it.
      const observedRoleRefresh: PendingObservedRoleRefresh | undefined =
        existing.status === "pending" &&
        observedRole !== undefined &&
        observedRoleFor(existing) !== observedRole
          ? { indexKey, createdAt: existing.entry.createdAt, observedRole }
          : undefined;
      return {
        kind: "existing",
        status: existing.status,
        spentPairingWindow,
        observedRoleRefresh,
      };
    }

    const partition = clientAuthorizationPartitionKey({ hubOrigin, accountId });
    const pending = file.pending.filter((entry) => !isExpiredPending(entry, at));
    const inPartition = pending.filter(
      (entry) => clientAuthorizationPartitionKey(entry) === partition,
    );

    const refuse = (
      reason: "pending_cap_global" | "pending_cap_per_account",
    ): NodeClientPendingAdmission => {
      refusedPairingAttempts = Math.min(refusedPairingAttempts + 1, MAX_REFUSED_PAIRING_ATTEMPTS);
      return { kind: "refused", reason, spentPairingWindow };
    };

    let evict: StoredClientAuthorizationEntry | undefined;
    // §13.6: when both caps are exceeded the per-account partition GOVERNS, and
    // one eviction suffices — a record removed from that partition frees a slot
    // against both caps, whereas a globally chosen victim outside the partition
    // relieves only the global one and would leave the owner refused.
    if (inPartition.length >= E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT) {
      if (!reserved) return refuse("pending_cap_per_account");
      evict = selectPendingEviction(inPartition, at);
      if (evict === undefined) return refuse("pending_cap_per_account");
    } else if (pending.length >= E2EE_PENDING_CLIENTS_MAX_GLOBAL) {
      if (!reserved) return refuse("pending_cap_global");
      evict = selectPendingEviction(pending, at);
      if (evict === undefined) return refuse("pending_cap_global");
    }

    return {
      kind: "admit",
      entry: {
        hubOrigin,
        accountId,
        clientIdentityFingerprint: fingerprint,
        // The least authority the §8.3 vocabulary can express. A pending record
        // grants nothing (§8.6 step 6 refuses on `status`), and if this value
        // were ever read it must not be the reason a channel was admitted.
        maxRole: "viewer",
        capabilitySet: [],
        createdAt: at,
        safetyNumber: input.safetyNumber,
        ...(reserved ? { pairingReservedAt: at } : {}),
        // Display metadata for the owner's approval — never `maxRole` above. The
        // Hub assigns this value; only an owner action may turn it into a grant.
        ...(observedRole === undefined ? {} : { observedRole }),
      },
      evictIndexKey: evict === undefined ? undefined : clientAuthorizationIndexKey(evict),
      spentPairingWindow,
    };
  };

  /**
   * Follow a pending record's moved role in memory, and say whether its one
   * durable backfill is still owed.
   *
   * Runs here rather than in the decision because §13.2 step 3 keeps every
   * pending-class mutation behind the reject and the close, and against the
   * record as it stands NOW: one the owner approved or revoked in between, or
   * re-created under the same key, is not the record this attempt was decided
   * against, and nothing about it moves.
   */
  const followObservedRole = (refresh: PendingObservedRoleRefresh): boolean => {
    const classified = lookupClassified(refresh.indexKey, now());
    if (classified?.status !== "pending" || classified.entry.createdAt !== refresh.createdAt) {
      return false;
    }
    if (classified.entry.observedRole === refresh.observedRole) {
      movedObservedRoles.delete(refresh.indexKey);
    } else {
      movedObservedRoles.set(refresh.indexKey, {
        createdAt: refresh.createdAt,
        observedRole: refresh.observedRole,
      });
    }
    return classified.entry.observedRole === undefined;
  };

  const commitPairingAdmission: NodeClientAuthorizationClient["commitPairingAdmission"] = async (
    admission,
  ) => {
    // Only the durable spend — and, for an existing pending record that carries
    // no observed role, its one backfill — is owed for an outcome that creates
    // nothing, and an attempt that owes neither and was not admitted writes
    // nothing at all: §13.2 step 3's refusal path must stay free of durable
    // writes, and so must the role of a request already on file moving again.
    const observedRoleRefresh =
      admission.kind === "existing" ? admission.observedRoleRefresh : undefined;
    const backfill =
      observedRoleRefresh !== undefined && followObservedRole(observedRoleRefresh)
        ? observedRoleRefresh
        : undefined;
    if (
      admission.kind !== "admit" &&
      admission.spentPairingWindow === undefined &&
      backfill === undefined
    ) {
      return;
    }
    const at = now();
    await commit(
      (current) => {
        let next = current;
        if (admission.spentPairingWindow !== undefined) {
          const window = openWindow(next, at);
          // THE WINDOW THIS DECISION MATCHED, and never merely the one open now.
          // The owner may have opened a new window between the §8.6 step 6
          // decision and this commit, and stamping `spentAt` on that one would
          // report §13.6's "some other attempt consumed the window" for an attempt
          // that never named its device — and strip that device of the
          // reservation, which is the owner's only way past a saturated pending
          // cap. A window that expired, closed, or was re-opened in the gap
          // therefore loses the durable spend, which §13.2 already makes a benign
          // best-effort loss.
          if (
            window !== undefined &&
            window.spentAt === undefined &&
            windowLatch(window) === admission.spentPairingWindow
          ) {
            next = { ...next, pairingWindow: { ...window, spentAt: at } };
          }
        }
        if (backfill !== undefined) next = withPendingObservedRoleBackfilled(next, backfill);
        if (admission.kind !== "admit") return next === current ? null : next;
        const indexKey = clientAuthorizationIndexKey(admission.entry);
        // Re-evaluated against the state actually on disk, which another writer
        // may have moved since the in-memory decision. §13.2 makes this commit
        // best-effort — a pending-class mutation lost here is a benign
        // availability event and the client re-pairs — but it may never breach a
        // cap, so the caps are re-checked rather than assumed.
        if (findEntry(next, indexKey, at) !== undefined) return next;
        let pending = next.pending;
        const partition = clientAuthorizationPartitionKey(admission.entry);
        const inPartition = pending.filter(
          (entry) => clientAuthorizationPartitionKey(entry) === partition,
        );
        const overPartition = inPartition.length >= E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT;
        if (overPartition || pending.length >= E2EE_PENDING_CLIENTS_MAX_GLOBAL) {
          // An eviction is licensed by the owner's window and by nothing else, and
          // only while a cap is still breached: a slot freed between the decision
          // and here means the selected victim is simply not evicted. The license
          // is the RESERVATION this decision was granted, not the window's present
          // state — §13.2 selects the victim before emission, so a window re-opened
          // in the gap neither grants nor withdraws it.
          const scope = overPartition ? inPartition : pending;
          const selected =
            admission.evictIndexKey === undefined
              ? undefined
              : scope.find(
                  (entry) =>
                    clientAuthorizationIndexKey(entry) === admission.evictIndexKey &&
                    !holdsReservation(entry, at),
                );
          const victim =
            selected ??
            (admission.spentPairingWindow === undefined
              ? undefined
              : selectPendingEviction(scope, at));
          if (victim === undefined) return next;
          const victimKey = clientAuthorizationIndexKey(victim);
          pending = pending.filter((entry) => clientAuthorizationIndexKey(entry) !== victimKey);
        }
        return { ...next, pending: [...pending, admission.entry] };
      },
      // §13.2 step 3's pending class never widens authority, so it opts out of
      // the fail-closed resync `commit` performs for owner changes — see that
      // option's note. This path is reached from an unauthenticated peer's hello
      // and its failure is deliberately swallowed, so an empty publish here
      // would refuse every approved client until an owner command republished
      // disk state, with nothing at all to report it.
      { resyncOnFailure: false },
    );
  };

  const list: NodeClientAuthorizationClient["list"] = async () => {
    await reload();
    const at = now();
    const records = classify(file, at)
      .map((classified) => toRecord(classified, at, observedRoleFor(classified)))
      .toSorted((left, right) => {
        const byTime = left.createdAt - right.createdAt;
        if (byTime !== 0) return byTime;
        return left.fingerprintDisplay < right.fingerprintDisplay ? -1 : 1;
      });
    const pending = file.pending.filter((entry) => !isExpiredPending(entry, at));
    const perAccount = new Map<string, { hubOrigin: string; accountId: string; count: number }>();
    for (const entry of pending) {
      const key = clientAuthorizationPartitionKey(entry);
      const bucket = perAccount.get(key) ?? {
        hubOrigin: entry.hubOrigin,
        accountId: entry.accountId,
        count: 0,
      };
      bucket.count += 1;
      perAccount.set(key, bucket);
    }
    return {
      records,
      pendingGlobalSaturated: pending.length >= E2EE_PENDING_CLIENTS_MAX_GLOBAL,
      saturatedAccounts: [...perAccount.values()]
        .filter((bucket) => bucket.count >= E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT)
        .map(({ hubOrigin, accountId }) => ({ hubOrigin, accountId })),
      refusedPairingAttempts,
      pairingWindow: currentWindowState(file, at),
    };
  };

  const get: NodeClientAuthorizationClient["get"] = async (key) => {
    await reload();
    const at = now();
    const classified = findEntry(file, requireKey(key), at);
    return classified === undefined
      ? undefined
      : toRecord(classified, at, observedRoleFor(classified));
  };

  const approve: NodeClientAuthorizationClient["approve"] = async (input) => {
    const indexKey = requireKey(input.key);
    const maxRole = requireRole(input.maxRole);
    const capabilitySet = requireCapabilitySet(input.capabilitySet);
    const requested = requireDisplayLabel(input.displayLabel);
    const at = now();
    return applyOwnerChange({
      indexKey,
      change: (current) => {
        const found = findEntry(current, indexKey, at);
        if (found === undefined) return authorizationError("client_authorization_not_found");
        // §13.6: exceeding `E2EE_APPROVED_CLIENTS_MAX` fails the approval
        // explicitly — approval never evicts anything.
        if (found.status !== "approved" && current.approved.length >= E2EE_APPROVED_CLIENTS_MAX) {
          return authorizationError("client_authorization_approved_cap");
        }
        const label = requested ?? found.entry.displayLabel;
        const observedRole = observedRoleFor(found);
        const approved: StoredClientAuthorizationEntry = {
          hubOrigin: found.entry.hubOrigin,
          accountId: found.entry.accountId,
          clientIdentityFingerprint: found.entry.clientIdentityFingerprint,
          maxRole,
          capabilitySet,
          createdAt: found.entry.createdAt,
          approvedAt: at,
          ...(found.entry.lastSeenAt === undefined ? {} : { lastSeenAt: found.entry.lastSeenAt }),
          safetyNumber: found.entry.safetyNumber,
          ...(label === undefined ? {} : { displayLabel: label }),
          // Carried — the role the owner was shown, which for a pending record
          // may be newer than the one on disk — so an owner surface can still
          // tell later whether a narrowing would limit this device or refuse it
          // outright.
          ...(observedRole === undefined ? {} : { observedRole }),
          // The reservation is dropped rather than carried: once a record is
          // `approved` no eviction rule reaches it, so the field would only be
          // dead state on a record that no longer occupies the reserved class.
          //
          // A newer binary's own keys are NOT dropped. This constructor names
          // every field it means to set, which is what makes the transition
          // legible — and is exactly how a field this binary does not know about
          // would be silently deleted by an owner action.
          ...(found.entry.forwardFields === undefined
            ? {}
            : { forwardFields: found.entry.forwardFields }),
        };
        const stripped = withoutKey(current, indexKey);
        return { ...stripped, approved: [...stripped.approved, approved] };
      },
    });
  };

  const introduce: NodeClientAuthorizationClient["introduce"] = async (input) => {
    const indexKey = requireKey(input.key);
    const hubOrigin = canonicalizeE2eeHubOrigin(input.key.hubOrigin);
    const accountId = assertE2eeAccountId(input.key.accountId);
    const clientIdentityFingerprint = Buffer.from(input.key.clientIdentityFingerprint).toString(
      "base64url",
    );
    const maxRole = requireRole(input.maxRole);
    const capabilitySet = requireCapabilitySet(input.capabilitySet);
    const safetyNumber = requireSafetyNumber(input.safetyNumber);
    const displayLabel = requireLocalIntroductionDisplayLabel(input.displayLabel);
    const at = now();
    let disposition: NodeClientIntroductionResult["disposition"] = "reconciled";

    await applyOwnerChange({
      indexKey,
      change: (current) => {
        const found = findEntry(current, indexKey, at);
        if (found?.status === "revoked") {
          return authorizationError("client_authorization_conflict");
        }
        if (found?.status === "approved") {
          const sameCapabilities =
            found.entry.capabilitySet.length === capabilitySet.length &&
            found.entry.capabilitySet.every(
              (capability, index) => capability === capabilitySet[index],
            );
          if (
            found.entry.maxRole !== maxRole ||
            !sameCapabilities ||
            found.entry.safetyNumber !== safetyNumber ||
            found.entry.displayLabel !== displayLabel
          ) {
            return authorizationError("client_authorization_conflict");
          }
          disposition = "reconciled";
          return null;
        }
        if (current.approved.length >= E2EE_APPROVED_CLIENTS_MAX) {
          return authorizationError("client_authorization_approved_cap");
        }
        disposition = found === undefined ? "created" : "promoted";
        const observedRole = found === undefined ? undefined : observedRoleFor(found);
        const approved: StoredClientAuthorizationEntry = {
          hubOrigin,
          accountId,
          clientIdentityFingerprint,
          maxRole,
          capabilitySet,
          createdAt: found?.entry.createdAt ?? at,
          approvedAt: at,
          ...(found?.entry.lastSeenAt === undefined ? {} : { lastSeenAt: found.entry.lastSeenAt }),
          safetyNumber,
          ...(displayLabel === undefined ? {} : { displayLabel }),
          ...(observedRole === undefined ? {} : { observedRole }),
          ...(found?.entry.forwardFields === undefined
            ? {}
            : { forwardFields: found.entry.forwardFields }),
        };
        const stripped = withoutKey(current, indexKey);
        return { ...stripped, approved: [...stripped.approved, approved] };
      },
    });

    const record = await get(input.key);
    if (record?.status !== "approved") {
      return authorizationError("client_authorization_state_failed");
    }
    return { disposition, record };
  };

  const narrow: NodeClientAuthorizationClient["narrow"] = async (input) => {
    const indexKey = requireKey(input.key);
    const maxRole = input.maxRole === undefined ? undefined : requireRole(input.maxRole);
    const capabilitySet =
      input.capabilitySet === undefined ? undefined : requireCapabilitySet(input.capabilitySet);
    const at = now();
    return applyOwnerChange({
      indexKey,
      change: (current) => {
        const found = findEntry(current, indexKey, at);
        if (found === undefined) return authorizationError("client_authorization_not_found");
        if (found.status !== "approved") {
          return authorizationError("client_authorization_not_approved");
        }
        const granted = authorityOf(found);
        const proposed: E2eeClientAuthorization = {
          status: "approved",
          maxRole: maxRole ?? found.entry.maxRole,
          capabilitySet: capabilitySet ?? found.entry.capabilitySet,
        };
        // Already in force: the narrowing this command names is durable, so
        // there is nothing left to commit. It is NOT nothing left to do — this
        // is what the owner's retry after a failed sweep looks like, and
        // refusing it here would leave the channel open with no command able to
        // reach it. `null` commits nothing and still owes step (b).
        if (
          proposed.maxRole === granted.maxRole &&
          proposed.capabilitySet.length === granted.capabilitySet.length &&
          proposed.capabilitySet.every((entry, index) => granted.capabilitySet[index] === entry)
        ) {
          return null;
        }
        // The command is named for what it does. A change that WIDENS authority
        // is refused rather than quietly applied, so `narrow` can never be the
        // path an authority increase takes — the increase belongs to `approve`,
        // which §13.6 makes effective only on a fresh ticket, channel, and
        // handshake.
        if (!e2eeAuthorizationWithdrawn(granted, proposed)) {
          return authorizationError("client_authorization_not_narrowing");
        }
        const narrowed: StoredClientAuthorizationEntry = {
          ...found.entry,
          maxRole: proposed.maxRole,
          capabilitySet: proposed.capabilitySet,
        };
        const stripped = withoutKey(current, indexKey);
        return { ...stripped, approved: [...stripped.approved, narrowed] };
      },
    });
  };

  const revoke: NodeClientAuthorizationClient["revoke"] = async (key) => {
    const indexKey = requireKey(key);
    const at = now();
    return applyOwnerChange({
      indexKey,
      change: (current) => {
        const found = findEntry(current, indexKey, at);
        if (found === undefined) return authorizationError("client_authorization_not_found");
        // Already revoked: nothing left to commit, and re-writing the record
        // would move `revokedAt` and with it the record's place in the §13.6
        // oldest-first retention order. The sweep is still owed — this is the
        // retry path after a close that failed.
        if (found.status === "revoked") return null;
        const observedRole = observedRoleFor(found);
        const revoked: StoredClientAuthorizationEntry = {
          hubOrigin: found.entry.hubOrigin,
          accountId: found.entry.accountId,
          clientIdentityFingerprint: found.entry.clientIdentityFingerprint,
          maxRole: found.entry.maxRole,
          capabilitySet: found.entry.capabilitySet,
          createdAt: found.entry.createdAt,
          ...(found.entry.approvedAt === undefined ? {} : { approvedAt: found.entry.approvedAt }),
          revokedAt: at,
          ...(found.entry.lastSeenAt === undefined ? {} : { lastSeenAt: found.entry.lastSeenAt }),
          safetyNumber: found.entry.safetyNumber,
          ...(found.entry.displayLabel === undefined
            ? {}
            : { displayLabel: found.entry.displayLabel }),
          ...(observedRole === undefined ? {} : { observedRole }),
          ...(found.entry.forwardFields === undefined
            ? {}
            : { forwardFields: found.entry.forwardFields }),
        };
        const stripped = withoutKey(current, indexKey);
        return {
          ...stripped,
          revoked: withRevokedCapApplied([...stripped.revoked, revoked]),
        };
      },
    });
  };

  const purge: NodeClientAuthorizationClient["purge"] = async (key) => {
    const indexKey = requireKey(key);
    const at = now();
    return applyOwnerChange({
      indexKey,
      change: (current) => {
        // A purge states a postcondition — no record under this key — rather
        // than a transition, so a key that is already absent has nothing left to
        // commit and is not an error. It is the retry after a sweep that failed,
        // and refusing it would leave the channel open with nothing able to
        // close it: `revoke` and `narrow` both need the record that purge
        // deleted, so purge is the only command that can still reach it.
        if (findEntry(current, indexKey, at) === undefined) return null;
        // §13.6 treats deletion as `status` leaving `approved`, so this takes
        // the same ordered procedure as a revocation.
        return withoutKey(current, indexKey);
      },
    });
  };

  const setDisplayLabel: NodeClientAuthorizationClient["setDisplayLabel"] = async (input) => {
    const indexKey = requireKey(input.key);
    const label = requireDisplayLabel(input.displayLabel);
    const at = now();
    await commit((current) => {
      const found = findEntry(current, indexKey, at);
      if (found === undefined) return authorizationError("client_authorization_not_found");
      const relabelled: StoredClientAuthorizationEntry = {
        hubOrigin: found.entry.hubOrigin,
        accountId: found.entry.accountId,
        clientIdentityFingerprint: found.entry.clientIdentityFingerprint,
        maxRole: found.entry.maxRole,
        capabilitySet: found.entry.capabilitySet,
        createdAt: found.entry.createdAt,
        ...(found.entry.approvedAt === undefined ? {} : { approvedAt: found.entry.approvedAt }),
        ...(found.entry.revokedAt === undefined ? {} : { revokedAt: found.entry.revokedAt }),
        ...(found.entry.lastSeenAt === undefined ? {} : { lastSeenAt: found.entry.lastSeenAt }),
        safetyNumber: found.entry.safetyNumber,
        ...(label === undefined ? {} : { displayLabel: label }),
        ...(found.entry.pairingReservedAt === undefined
          ? {}
          : { pairingReservedAt: found.entry.pairingReservedAt }),
        ...(found.entry.observedRole === undefined
          ? {}
          : { observedRole: found.entry.observedRole }),
        ...(found.entry.forwardFields === undefined
          ? {}
          : { forwardFields: found.entry.forwardFields }),
      };
      return withEntryIn(withoutKey(current, indexKey), found.status, relabelled);
    });
  };

  const touch: NodeClientAuthorizationClient["touch"] = async (key) => {
    const indexKey = requireKey(key);
    const at = now();
    const found = findEntry(file, indexKey, at);
    if (found === undefined) return false;
    // §13.6: at most one durable write per `E2EE_LAST_SEEN_WRITE_INTERVAL` per
    // record. The coalescing decision is taken against the in-memory copy, so a
    // channel that is merely alive costs no lock acquisition.
    if (
      found.entry.lastSeenAt !== undefined &&
      at - found.entry.lastSeenAt < E2EE_LAST_SEEN_WRITE_INTERVAL
    ) {
      return false;
    }
    await commit((current) => {
      const entry = findEntry(current, indexKey, at);
      if (entry === undefined) return current;
      return withEntryIn(withoutKey(current, indexKey), entry.status, {
        ...entry.entry,
        lastSeenAt: at,
      });
    });
    return true;
  };

  const openPairingWindow: NodeClientAuthorizationClient["openPairingWindow"] = async (
    fingerprint,
  ) => {
    if (
      !(fingerprint instanceof Uint8Array) ||
      fingerprint.byteLength !== E2EE_KEY_FINGERPRINT_BYTES
    ) {
      return authorizationError("client_authorization_invalid");
    }
    const at = now();
    // §13.6: opening a window MUST name a discriminator, and there is no
    // undiscriminated window. The parameter makes that unavoidable rather than
    // checked. A fresh window is unspent, so the in-memory latch is cleared with
    // it rather than left to a coincidence of timestamps.
    spentWindowLatch = undefined;
    const next = await commit((current) => ({
      ...current,
      pairingWindow: {
        clientIdentityFingerprint: Buffer.from(fingerprint).toString("base64url"),
        openedAt: at,
      },
    }));
    return currentWindowState(next, at) ?? authorizationError("client_authorization_invalid");
  };

  const closePairingWindow: NodeClientAuthorizationClient["closePairingWindow"] = async () => {
    spentWindowLatch = undefined;
    if (file.pairingWindow === null) return;
    await commit((current) => ({ ...current, pairingWindow: null }));
  };

  const sweepExpired: NodeClientAuthorizationClient["sweepExpired"] = async () => {
    await reload();
    const before = file.pending.length;
    const at = now();
    if (file.pending.every((entry) => !isExpiredPending(entry, at))) return 0;
    const next = await commit((current) => current);
    return before - next.pending.length;
  };

  /**
   * Row N3 on one registration: the withdrawal test, then the phase change.
   *
   * The test is re-applied against the already published index, which is the
   * cheap second line §13.6's ordering argument asks for: a handshake that read
   * the record before a commit and reaches N3 after it is refused here rather
   * than admitted and left to a sweep that has already walked past.
   *
   * An outstanding termination refuses it just as a withdrawal does, and for the
   * same reason a sweep still selects one: the node has already decided this
   * registration ends, and a later widening does not undo that decision
   * retroactively. It also keeps the sweep's frozen dispatch honest — an entry
   * snapshotted `in_flight` that crossed row N3 during the pass would be handed
   * the FATAL-PRE abort while sitting in `e2ee`.
   */
  const establishOn = (registration: Registration): NodeClientChannelAdmission => {
    if (
      registration.owedTermination ||
      e2eeAuthorizationWithdrawn(registration.snapshot, currentAuthority(registration.indexKey))
    ) {
      return { kind: "refused", reason: "authorization_withdrawn" };
    }
    return {
      kind: "entered",
      release: () => {
        registrations.delete(registration);
      },
      // The phase change is the caller's to make, once the accept is on the send
      // path and the mode machine is in `e2ee` — §13.6's own definition of an
      // active E2EE channel. See `NodeClientChannelAdmission`.
      established: () => {
        if (!registrations.has(registration)) return;
        registration.phase = "e2ee";
      },
    };
  };

  const admitActiveChannel: NodeClientAuthorizationClient["admitActiveChannel"] = (input) => {
    const registration: Registration = {
      phase: "in_flight",
      snapshot: input.admittedAuthority,
      indexKey: requireKey(input.admittedAuthority),
      abort: undefined,
      close: input.close,
      owedTermination: false,
    };
    const admission = establishOn(registration);
    // Registered only once the test has passed, so a refused channel never
    // appears in a snapshot at all — there is nothing to close and nothing to
    // count. The phase change follows immediately: this seam's caller holds a
    // channel that IS in `e2ee` already, which is the whole difference between
    // it and `registerInFlightHandshake`.
    if (admission.kind === "entered") {
      registrations.add(registration);
      admission.established();
    }
    return admission;
  };

  const registerInFlightHandshake: NodeClientAuthorizationClient["registerInFlightHandshake"] = (
    input,
  ) => {
    const registration: Registration = {
      phase: "in_flight",
      snapshot: input.admittedAuthority,
      // Refused, not admitted. A snapshot this node cannot encode is one the
      // keyed sweep could never select, so registering it would put a channel on
      // the list that no owner command can ever reach — neither swept nor
      // visibly rejected. It is also a local mistake rather than peer input:
      // §8.6 step 5 validated the origin, the account id, and the fingerprint
      // before step 6 took this snapshot, and step 6's own read answers
      // `undefined` for a key it cannot encode, so no channel reaches this call
      // with one.
      indexKey: requireKey(input.admittedAuthority),
      abort: input.abort,
      close: undefined,
      owedTermination: false,
    };
    registrations.add(registration);
    return {
      establish: (transition) => {
        registration.close = transition.close;
        const admission = establishOn(registration);
        // A refusal retires the registration: the caller takes the FATAL-PRE
        // disposition itself, and leaving it on the list would let a later
        // sweep abort a handshake that is already gone.
        if (admission.kind === "refused") registrations.delete(registration);
        return admission;
      },
      release: () => {
        registrations.delete(registration);
      },
    };
  };

  return {
    lookupClientAuthorization,
    reReadAuthorization: lookupClientAuthorization,
    admitActiveChannel,
    registerInFlightHandshake,
    evaluatePairingAdmission,
    commitPairingAdmission,
    list,
    get,
    approve,
    introduce,
    narrow,
    revoke,
    purge,
    setDisplayLabel,
    touch,
    openPairingWindow,
    closePairingWindow,
    sweepExpired,
    clearRefusedPairingAttempts: () => {
      refusedPairingAttempts = 0;
    },
    reload,
  };
}
