import {
  E2EE_APPROVED_CLIENTS_MAX,
  E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS,
  E2EE_KEY_FINGERPRINT_BYTES,
  E2EE_PENDING_CLIENTS_MAX_GLOBAL,
  E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
  E2EE_REVOKED_CLIENTS_RETAINED_MAX,
  E2EE_SAFETY_NUMBER_DIGITS,
} from "@ryco/shared/relayE2eeConstants";
import {
  assertE2eeAccountId,
  assertRelayCapabilityLiteral,
  assertRelayEffectiveRoleLiteral,
  canonicalizeE2eeHubOrigin,
} from "@ryco/shared/relayE2eeTranscripts";

import { openProtectedStateFile, type ProtectedStateFileFailure } from "./ProtectedStateFile.ts";

// The node's durable §13.6 Branch A client-authorization records —
// docs/relay-e2ee-protocol.md §13.6 (record shape, lifecycle, caps, retention,
// eviction, the owner-opened pairing window, and authorization withdrawal),
// §13.2 (the ceremony that creates a pending record), and §15 (the bounds).
//
// WHAT THIS OWNS: the file rules, the schema, the class partition, and the
// structural bounds. Every policy decision — which record may be evicted, when a
// window grants its reservation, what a withdrawal sweeps — belongs to
// `NodeClientAuthorizationClient`, which is the only intended caller.
//
// ─── WHY THE THREE CLASSES ARE THREE ARRAYS ─────────────────────────────────
//
// §13.6's unconditional invariant is that an unapproved flood can never evict
// `approved` or `revoked` security state. A single record list with a `status`
// field makes that invariant a property of every eviction predicate ever
// written: one missing `status === "pending"` guard and an anonymous peer
// deletes an owner's grant. Partitioning the classes into three arrays makes it
// a property of the TYPE instead — the pairing-admission path is handed
// `record.pending` and cannot name the other two, so there is no code path from
// unauthenticated peer action to approved or revoked state to review, test, or
// regress.
//
// The class an entry lives in IS its status; no entry carries a `status` field.
// Two encodings of one fact is one chance for them to disagree, and the
// direction that disagreement runs — a `revoked` entry in the `approved` array
// or the reverse — is authority.
//
// ─── WHY THIS IS ITS OWN RECORD ─────────────────────────────────────────────
//
// The same reason the §6.4 prekey slots and the §7.5 continuity lineage are
// (`NodeE2eePrekeyStore`, `NodeIdentityContinuityStore`): `parseState`
// reconstructs `hub-identity.json` from its known keys alone, so a binary older
// than this feature deletes every field it does not recognize on its next write,
// and a downgrade to a release that predates E2EE is an ordinary operator
// action. Here that would silently discard the owner's approvals and — worse —
// the owner's REVOCATIONS, which are durable authority state a downgrade must
// never be able to clear. This record's own parser preserves unknown keys, so
// the same trap is not rebuilt one version later.
//
// AT EVERY LEVEL THAT PERSISTS, not only at the top. A parser that forwards
// unknown top-level keys and then rebuilds each entry from its known fields has
// moved the trap one nesting level down and nowhere else: the field a newer
// binary added is on the RECORD — a scope qualifier on a revocation, a second
// authority dimension — and it is the record whose loss is an authority change.
// So `parseEntry` and `parsePairingWindow` carry their own unknown keys too, and
// `encodeEntry` and `encodePairingWindow` put them back.

export type NodeClientAuthorizationStoreErrorCode =
  | "client_authorization_state_unavailable"
  | "client_authorization_state_locked"
  | "client_authorization_state_corrupt"
  | "client_authorization_state_operation_failed";

export class NodeClientAuthorizationStoreError extends Error {
  readonly code: NodeClientAuthorizationStoreErrorCode;

  constructor(code: NodeClientAuthorizationStoreErrorCode) {
    super("Node client authorization state operation failed.");
    this.name = "NodeClientAuthorizationStoreError";
    this.code = code;
  }
}

function stateError(code: NodeClientAuthorizationStoreErrorCode): never {
  throw new NodeClientAuthorizationStoreError(code);
}

/**
 * One §13.6 record, minus its `status`.
 *
 * `clientIdentityFingerprint` is the `ryco.client-key.v1` digest of §7.1 in
 * unpadded base64url — NEVER a raw key. `safetyNumber` is the derived §13.4
 * display string, which is the only key-derived pairing display metadata §13.6
 * admits; `observedRole` is the other, relay-visible, one.
 *
 * `maxRole` and `capabilitySet` are carried in every class rather than only in
 * `approved`, so the shape a lookup returns is uniform. A `pending` entry
 * carries the LEAST authority the vocabulary can express — §8.6 step 6 refuses
 * on `status` before it ever ranks the role, and the least-authority default is
 * what makes that ordering safe rather than merely conventional.
 */
export interface StoredClientAuthorizationEntry {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly clientIdentityFingerprint: string;
  readonly maxRole: string;
  readonly capabilitySet: readonly string[];
  readonly createdAt: number;
  readonly approvedAt?: number;
  readonly revokedAt?: number;
  readonly lastSeenAt?: number;
  readonly safetyNumber: string;
  readonly displayLabel?: string;
  /**
   * §13.6: set when this `pending` entry was the single record an owner-opened
   * pairing window admitted. Consulted by the pending eviction rule and by
   * nothing else; the reservation it records is HELD only while
   * `now - pairingReservedAt <= E2EE_PAIRING_RESERVATION_LIFETIME`.
   */
  readonly pairingReservedAt?: number;
  /**
   * The `channel.open.effectiveRole` (§8.3 element 14) the node received on the
   * pairing attempt that created this record — or, for a `pending` record that
   * carried none, on the first later attempt that did. A peer's hello writes it
   * at most once per record; a later move is the client's in-memory state until
   * an owner action settles the record at the role it showed.
   *
   * DISPLAY METADATA, NEVER AUTHORITY. §8.6 step 6 and the §13.6 withdrawal test
   * read `maxRole` alone, and nothing copies this into `maxRole`: the Hub
   * assigns the value, so it may only ever be what an owner surface OFFERS as
   * the role to approve, and the owner still names it. It exists because §8.3
   * makes the native intended role equal the `channel.open` role, so a ceiling
   * below it refuses the device rather than limiting it — and without the value
   * an owner surface cannot tell which ceiling is the usable one.
   */
  readonly observedRole?: string;
  /**
   * Keys INSIDE this record that a newer binary wrote, carried verbatim.
   *
   * Never interpreted, never compared, and never a key this binary owns —
   * `parseEntry` refuses to collect one of its own names into here, so a stored
   * `forwardFields` object can never shadow a field that decides authority. It
   * is spread back out by `encodeEntry`, so it is a nesting level in memory and
   * flat on disk.
   */
  readonly forwardFields?: Readonly<Record<string, unknown>>;
}

/**
 * The owner-opened §13.6 pairing window.
 *
 * Durable because the command that opens it and the channel that spends it need
 * not run in the same process, and because an owner who opened a window and then
 * restarted the node should not silently lose it inside `E2EE_PAIRING_WINDOW`.
 * `spentAt` is retained rather than cleared: §13.6 requires the CLI to show
 * "some other attempt consumed the window" as a state distinct from "no window
 * is open", and an erased window cannot say which happened.
 */
export interface StoredClientPairingWindow {
  readonly clientIdentityFingerprint: string;
  readonly openedAt: number;
  readonly spentAt?: number;
  /** Keys inside the window object a newer binary wrote. See the entry field. */
  readonly forwardFields?: Readonly<Record<string, unknown>>;
}

export interface NodeClientAuthorizationRecordFile {
  readonly version: 1;
  readonly revision: number;
  readonly pending: readonly StoredClientAuthorizationEntry[];
  readonly approved: readonly StoredClientAuthorizationEntry[];
  readonly revoked: readonly StoredClientAuthorizationEntry[];
  readonly pairingWindow: StoredClientPairingWindow | null;
}

export interface NodeClientAuthorizationStore {
  readonly read: () => Promise<NodeClientAuthorizationRecordFile>;
  /**
   * Compare and update under this record's single-writer lock.
   *
   * `change` must bump `revision`; a proposal that does not is refused, which is
   * what keeps a caller from committing a decision it made against a snapshot
   * another writer has already replaced.
   *
   * A `change` that returns `null` states that the durable record already
   * satisfies the command: nothing is written, no revision is spent, and the
   * current record is returned. That is a distinct answer from an error, and the
   * distinction is load-bearing — §13.6's ordered procedure owes its sweep after
   * a commit that had nothing left to commit exactly as much as after one that
   * did, because "already committed" is the state a retry after a failed sweep
   * finds.
   */
  readonly update: (
    change: (
      current: NodeClientAuthorizationRecordFile,
    ) => NodeClientAuthorizationRecordFile | null,
  ) => Promise<NodeClientAuthorizationRecordFile>;
  /** Discard every record. Part of what a `leave` erases (§6.3). */
  readonly reset: () => Promise<NodeClientAuthorizationRecordFile>;
}

/**
 * A worst-case JSON bound for one entry, not a target.
 *
 * An `accountId` is opaque UTF-8 up to `E2EE_ACCOUNT_ID_MAX_BYTES` and a display
 * label is owner-authored, so both can escape to six JSON characters per byte.
 * The realistic entry is under 300 bytes; this exists so the file bound below is
 * derived from the caps rather than guessed.
 */
const MAX_ENTRY_BYTES = 4 * 1024;

const MAX_CLIENT_AUTHORIZATION_STATE_BYTES =
  16 * 1024 +
  MAX_ENTRY_BYTES *
    (E2EE_PENDING_CLIENTS_MAX_GLOBAL +
      E2EE_APPROVED_CLIENTS_MAX +
      E2EE_REVOKED_CLIENTS_RETAINED_MAX);

/**
 * Headroom over `RELAY_CAPABILITY_LITERALS`, whose only member today is
 * `ryco.rpc`. Membership is checked through the relay contract
 * (`assertRelayCapabilityLiteral`); this bounds the LENGTH, so one entry cannot
 * be made unbounded by repetition.
 */
const MAX_CAPABILITIES_PER_ENTRY = 8;

/** Bytes, bounding the escape expansion `E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS` allows. */
const MAX_DISPLAY_LABEL_BYTES = E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS * 4;

const FINGERPRINT_CHARS = Math.ceil((E2EE_KEY_FINGERPRINT_BYTES * 4) / 3);

/**
 * The §13.4 display form: 12 groups of 5 decimal digits, single-space separated.
 *
 * Built from `E2EE_SAFETY_NUMBER_DIGITS` rather than written out, so a §3.2
 * format change cannot leave a stale pattern still accepting the old one.
 */
const SAFETY_NUMBER_PATTERN = new RegExp(
  `^\\d{${E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup}}(${E2EE_SAFETY_NUMBER_DIGITS.separator.replace(
    /[^A-Za-z0-9]/g,
    "\\$&",
  )}\\d{${E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup}}){${E2EE_SAFETY_NUMBER_DIGITS.groups - 1}}$`,
);

/**
 * Control characters are not display metadata.
 *
 * §13.6 lists labels on a node CLI, and a label that can move a cursor or open
 * an escape sequence is a way to rewrite the rest of the listing — including
 * another record's status. The owner authors labels, so this bounds a mistake
 * rather than an attacker, but the listing is the surface an owner makes
 * authority decisions from.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "version",
  "revision",
  "pending",
  "approved",
  "revoked",
  "pairingWindow",
]);

const KNOWN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "hubOrigin",
  "accountId",
  "clientIdentityFingerprint",
  "maxRole",
  "capabilitySet",
  "createdAt",
  "approvedAt",
  "revokedAt",
  "lastSeenAt",
  "safetyNumber",
  "displayLabel",
  "pairingReservedAt",
  "observedRole",
]);

const KNOWN_WINDOW_KEYS: ReadonlySet<string> = new Set([
  "clientIdentityFingerprint",
  "openedAt",
  "spentAt",
]);

const FORBIDDEN_FORWARD_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  // The in-memory carrier's own name. A stored key called `forwardFields` would
  // otherwise be collected into the carrier and then spread back out over the
  // very fields the carrier is not allowed to reach.
  "forwardFields",
]);

/**
 * The keys of `candidate` this binary does not own, or `undefined` when there
 * are none.
 *
 * `undefined` rather than an empty object so an ordinary record carries no
 * empty container through every copy, and so `toEqual` in a test compares the
 * shape a node actually writes.
 */
function collectForwardFields(
  candidate: Record<string, unknown>,
  known: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  let collected: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(candidate)) {
    if (known.has(key) || FORBIDDEN_FORWARD_KEYS.has(key)) continue;
    collected ??= {};
    collected[key] = value;
  }
  return collected;
}

interface StoredClientAuthorizationFile {
  readonly record: NodeClientAuthorizationRecordFile;
  readonly forwardFields: Readonly<Record<string, unknown>>;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Exactly `E2EE_KEY_FINGERPRINT_BYTES` in canonical unpadded base64url.
 *
 * The re-encode equality is the point: a value whose final character carries
 * non-zero padding bits decodes to the right length but is not the encoding this
 * node wrote, and admitting it would let two distinct strings name one client —
 * which, in a key-to-authority map, is an authority bug.
 */
function isFingerprint(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== FINGERPRINT_CHARS) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.byteLength === E2EE_KEY_FINGERPRINT_BYTES && decoded.toString("base64url") === value
  );
}

function parseCapabilitySet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES_PER_ENTRY) {
    return stateError("client_authorization_state_corrupt");
  }
  const capabilities = value.map((entry) => {
    if (typeof entry !== "string") return stateError("client_authorization_state_corrupt");
    try {
      return assertRelayCapabilityLiteral(entry);
    } catch {
      return stateError("client_authorization_state_corrupt");
    }
  });
  // Strictly ascending, so one granted set has exactly one encoding and a
  // superset test never has to normalize first.
  for (let index = 1; index < capabilities.length; index += 1) {
    if (capabilities[index - 1]! >= capabilities[index]!) {
      return stateError("client_authorization_state_corrupt");
    }
  }
  return capabilities;
}

function parseOptionalTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isTimestamp(value)) return stateError("client_authorization_state_corrupt");
  return value;
}

/**
 * The §13.6 display-label rule, exported so the owner command that sets a label
 * refuses it as invalid input rather than discovering it as a corrupt write.
 */
export function isValidClientDisplayLabel(value: string): boolean {
  return (
    typeof value === "string" &&
    [...value].length <= E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS &&
    Buffer.byteLength(value, "utf8") <= MAX_DISPLAY_LABEL_BYTES &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function parseDisplayLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !isValidClientDisplayLabel(value)) {
    return stateError("client_authorization_state_corrupt");
  }
  return value;
}

/** A relay role literal, or absent. Never a value `maxRole` could not also hold. */
function parseObservedRole(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return stateError("client_authorization_state_corrupt");
  try {
    return assertRelayEffectiveRoleLiteral(value);
  } catch {
    return stateError("client_authorization_state_corrupt");
  }
}

/** The status class an entry was read from, which is what fixes its invariants. */
type EntryClass = "pending" | "approved" | "revoked";

function parseEntry(value: unknown, entryClass: EntryClass): StoredClientAuthorizationEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return stateError("client_authorization_state_corrupt");
  }
  const candidate = value as Partial<StoredClientAuthorizationEntry> & Record<string, unknown>;
  if (
    !isFingerprint(candidate.clientIdentityFingerprint) ||
    typeof candidate.safetyNumber !== "string" ||
    !SAFETY_NUMBER_PATTERN.test(candidate.safetyNumber) ||
    !isTimestamp(candidate.createdAt)
  ) {
    return stateError("client_authorization_state_corrupt");
  }
  let hubOrigin: string;
  let accountId: string;
  let maxRole: string;
  try {
    hubOrigin = canonicalizeE2eeHubOrigin(candidate.hubOrigin ?? "");
    accountId = assertE2eeAccountId(candidate.accountId ?? "");
    maxRole = assertRelayEffectiveRoleLiteral(candidate.maxRole ?? "");
  } catch {
    return stateError("client_authorization_state_corrupt");
  }
  const approvedAt = parseOptionalTimestamp(candidate.approvedAt);
  const revokedAt = parseOptionalTimestamp(candidate.revokedAt);
  const lastSeenAt = parseOptionalTimestamp(candidate.lastSeenAt);
  const displayLabel = parseDisplayLabel(candidate.displayLabel);
  const pairingReservedAt = parseOptionalTimestamp(candidate.pairingReservedAt);
  const observedRole = parseObservedRole(candidate.observedRole);
  // The class fixes the transition timestamps, so a file cannot claim a record
  // reached a state it never took, and cannot park a reservation — which only
  // the pending eviction rule reads — on a record no eviction rule may reach.
  if (entryClass === "pending" && (approvedAt !== undefined || revokedAt !== undefined)) {
    return stateError("client_authorization_state_corrupt");
  }
  if (entryClass === "approved" && (approvedAt === undefined || revokedAt !== undefined)) {
    return stateError("client_authorization_state_corrupt");
  }
  if (entryClass === "revoked" && revokedAt === undefined) {
    return stateError("client_authorization_state_corrupt");
  }
  if (entryClass !== "pending" && pairingReservedAt !== undefined) {
    return stateError("client_authorization_state_corrupt");
  }
  const forwardFields = collectForwardFields(candidate, KNOWN_ENTRY_KEYS);
  return {
    hubOrigin,
    accountId,
    clientIdentityFingerprint: candidate.clientIdentityFingerprint,
    maxRole,
    capabilitySet: parseCapabilitySet(candidate.capabilitySet ?? []),
    createdAt: candidate.createdAt,
    ...(approvedAt === undefined ? {} : { approvedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    safetyNumber: candidate.safetyNumber,
    ...(displayLabel === undefined ? {} : { displayLabel }),
    ...(pairingReservedAt === undefined ? {} : { pairingReservedAt }),
    ...(observedRole === undefined ? {} : { observedRole }),
    ...(forwardFields === undefined ? {} : { forwardFields }),
  };
}

/**
 * One entry as it is written: the carrier flattened back, this binary's fields
 * last so a stale value under a name this binary owns can never shadow them.
 */
function encodeEntry(entry: StoredClientAuthorizationEntry): unknown {
  const { forwardFields, ...known } = entry;
  return forwardFields === undefined ? known : { ...forwardFields, ...known };
}

/**
 * The full record key, length-prefixed.
 *
 * NOT a separator-joined string: `accountId` is opaque UTF-8 (§7.1) and may
 * contain any byte a separator could be, so a joined key is ambiguous and two
 * distinct records could collide onto one index entry — in a map from key to
 * authority, a collision is an authorization answer for the wrong client. Length
 * prefixes make the encoding injective.
 */
export function clientAuthorizationIndexKey(key: {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly clientIdentityFingerprint: string;
}): string {
  return `${key.hubOrigin.length}:${key.hubOrigin}${key.accountId.length}:${key.accountId}${key.clientIdentityFingerprint}`;
}

/** The per-account partition key of §13.6, under the same injective encoding. */
export function clientAuthorizationPartitionKey(key: {
  readonly hubOrigin: string;
  readonly accountId: string;
}): string {
  return `${key.hubOrigin.length}:${key.hubOrigin}${key.accountId.length}:${key.accountId}`;
}

function parseEntries(
  value: unknown,
  entryClass: EntryClass,
  maximum: number,
): readonly StoredClientAuthorizationEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    return stateError("client_authorization_state_corrupt");
  }
  return value.map((entry) => parseEntry(entry, entryClass));
}

function parsePairingWindow(value: unknown): StoredClientPairingWindow | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return stateError("client_authorization_state_corrupt");
  }
  const candidate = value as Partial<StoredClientPairingWindow> & Record<string, unknown>;
  if (!isFingerprint(candidate.clientIdentityFingerprint) || !isTimestamp(candidate.openedAt)) {
    return stateError("client_authorization_state_corrupt");
  }
  const spentAt = parseOptionalTimestamp(candidate.spentAt);
  const forwardFields = collectForwardFields(candidate, KNOWN_WINDOW_KEYS);
  return {
    clientIdentityFingerprint: candidate.clientIdentityFingerprint,
    openedAt: candidate.openedAt,
    ...(spentAt === undefined ? {} : { spentAt }),
    ...(forwardFields === undefined ? {} : { forwardFields }),
  };
}

function encodePairingWindow(window: StoredClientPairingWindow | null): unknown {
  if (window === null) return null;
  const { forwardFields, ...known } = window;
  return forwardFields === undefined ? known : { ...forwardFields, ...known };
}

function parseFile(value: unknown): StoredClientAuthorizationFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return stateError("client_authorization_state_corrupt");
  }
  const candidate = value as Partial<NodeClientAuthorizationRecordFile> & Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.revision) ||
    Number(candidate.revision) < 0
  ) {
    return stateError("client_authorization_state_corrupt");
  }
  const record: NodeClientAuthorizationRecordFile = {
    version: 1,
    revision: candidate.revision as number,
    pending: parseEntries(candidate.pending, "pending", E2EE_PENDING_CLIENTS_MAX_GLOBAL),
    approved: parseEntries(candidate.approved, "approved", E2EE_APPROVED_CLIENTS_MAX),
    revoked: parseEntries(candidate.revoked, "revoked", E2EE_REVOKED_CLIENTS_RETAINED_MAX),
    pairingWindow: parsePairingWindow(candidate.pairingWindow),
  };
  // One key, one record, one class. A key present twice would let a lookup
  // answer with either one, and the answer that matters — approved or revoked —
  // would then depend on iteration order.
  const seen = new Set<string>();
  for (const entry of [...record.pending, ...record.approved, ...record.revoked]) {
    const key = clientAuthorizationIndexKey(entry);
    if (seen.has(key)) return stateError("client_authorization_state_corrupt");
    seen.add(key);
  }
  // The §13.6 per-account pending partition is enforced here as well as in the
  // admission policy, so no bug above this line can persist a partition over
  // cap, and no file handed to this node can claim one.
  const perAccount = new Map<string, number>();
  for (const entry of record.pending) {
    const partition = clientAuthorizationPartitionKey(entry);
    const count = (perAccount.get(partition) ?? 0) + 1;
    if (count > E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT) {
      return stateError("client_authorization_state_corrupt");
    }
    perAccount.set(partition, count);
  }
  return { record, forwardFields: collectForwardFields(candidate, KNOWN_KEYS) ?? {} };
}

function encodeFile(file: StoredClientAuthorizationFile): unknown {
  return {
    ...file.forwardFields,
    ...file.record,
    pending: file.record.pending.map(encodeEntry),
    approved: file.record.approved.map(encodeEntry),
    revoked: file.record.revoked.map(encodeEntry),
    pairingWindow: encodePairingWindow(file.record.pairingWindow),
  };
}

export function initialClientAuthorizationRecord(): NodeClientAuthorizationRecordFile {
  return {
    version: 1,
    revision: 0,
    pending: [],
    approved: [],
    revoked: [],
    pairingWindow: null,
  };
}

const FAILURE_CODES: Readonly<
  Record<ProtectedStateFileFailure, NodeClientAuthorizationStoreErrorCode>
> = {
  unavailable: "client_authorization_state_unavailable",
  locked: "client_authorization_state_locked",
  corrupt: "client_authorization_state_corrupt",
  operation_failed: "client_authorization_state_operation_failed",
};

export async function makeNodeClientAuthorizationStore(options: {
  readonly path: string;
}): Promise<NodeClientAuthorizationStore> {
  const file = await openProtectedStateFile({
    path: options.path,
    maxBytes: MAX_CLIENT_AUTHORIZATION_STATE_BYTES,
    fail: (failure) => stateError(FAILURE_CODES[failure]),
  });

  const load = async (): Promise<StoredClientAuthorizationFile> => {
    const raw = await file.readJson();
    if (raw !== null) return parseFile(raw);
    const initial: StoredClientAuthorizationFile = {
      record: initialClientAuthorizationRecord(),
      forwardFields: {},
    };
    await file.writeJson(encodeFile(initial));
    return initial;
  };

  const write = (proposed: StoredClientAuthorizationFile): Promise<void> =>
    // Re-parsing on the way out is what makes a value a caller mutated into an
    // impossible shape fail before it reaches the disk.
    file.writeJson(encodeFile(parseFile(encodeFile(proposed))));

  const read: NodeClientAuthorizationStore["read"] = () =>
    file.withLock(async () => (await load()).record);

  const update: NodeClientAuthorizationStore["update"] = (change) =>
    file.withLock(async () => {
      const current = await load();
      const requested = change(current.record);
      if (requested === null) return current.record;
      const proposed = parseFile(encodeFile({ ...current, record: requested })).record;
      if (proposed.revision <= current.record.revision) {
        return stateError("client_authorization_state_operation_failed");
      }
      await write({ record: proposed, forwardFields: current.forwardFields });
      return proposed;
    });

  const reset: NodeClientAuthorizationStore["reset"] = () =>
    file.withLock(async () => {
      const current = await load();
      const record: NodeClientAuthorizationRecordFile = {
        ...initialClientAuthorizationRecord(),
        revision: current.record.revision + 1,
      };
      await write({ record, forwardFields: current.forwardFields });
      return record;
    });

  return { read, update, reset };
}
