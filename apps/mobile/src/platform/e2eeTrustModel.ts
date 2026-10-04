import type {
  NodeE2eeCapabilityAnchor,
  NodeE2eeCapabilityIdentityEvent,
  NodeE2eeCapabilityVerification,
} from "@ryco/shared/relayE2eeCapabilityVerify";

// The client-side trust model — docs/relay-e2ee-protocol.md §13.1 (node pins and
// the device-level verification marker), §12.1 (the latch), §12.1.1 (selection
// classification), §13.2.1 (the unexpected-node surface), and §13.3 (rotation).
//
// PURE. Nothing here reads or writes storage; `./e2eeTrustStore` owns custody and
// is the only caller that hands this module a loaded state. The split exists so
// the §4.4 guards — "evaluated against the pin the client resolves from its own
// channel selection … before it has received any payload" — have one place to be
// decided, and that place has no way to reach the network or the Hub.
//
// THREE SHAPES, NOT ONE SHAPE WITH OPTIONAL FIELDS. §13.1 states normatively what
// an `unverified` record holds — the index, the state, the node-id hints, and an
// owner legacy consent where one was taken — and that it holds "**no** verified
// fingerprint, **no** recorded continuity id, no accepted policy generation, no
// latch, and no approval state: every one of those is written by the promotion at
// step 5". That is expressed here as separate types rather than as documentation
// on one type, so a guard cannot read first-contact display material as a
// recorded value: there is no field to read it from.
//
// NO BOOLEAN REACHES THE CLASSIFIER. §4.4 requires that a client "MUST NOT treat
// unobtainable evidence as an unset latch or an unset marker", and a boolean has
// no room to say "I could not find out". Every input `classifyE2eeTrustSnapshot`
// consumes is a tagged union, and the snapshot itself carries a fourth variant,
// `unobtainable`, that a store which has not completed a load produces and that
// classifies UNEXPECTED.

/** The §13.1 index. `localNodeHandle` is client-minted and never Hub-supplied. */
export interface E2eeTrustRecordIndex {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly localNodeHandle: string;
}

/**
 * §12.1.1's selection, in the two forms a client actually holds it.
 *
 * `handle` is the client-anchored form §8.3 element 9 presumes. `node-id-hint` is
 * the form a freshly accepted channel arrives in, and it is named for what it is:
 * §13.1 stores those ids "explicitly as **untrusted** selection-resolution hints",
 * so nothing downstream can mistake a resolution by hint for evidence. §12.1.1's
 * safety argument is that misresolution releases nothing — a suppressed hint
 * produces no resolution and lands in the unexpected class, and an induced
 * resolution to the wrong pin produces a statement that cannot authenticate to
 * that pin, which is §13.3 fatal.
 */
export type E2eeTrustSelection =
  | {
      readonly kind: "handle";
      readonly hubOrigin: string;
      readonly accountId: string;
      readonly localNodeHandle: string;
    }
  | {
      readonly kind: "node-id-hint";
      readonly hubOrigin: string;
      readonly accountId: string;
      readonly nodeId: string;
    };

/**
 * §12.1.1's owner legacy consent: "explicit, per selection, and durable … never
 * inferred from a timeout, a retry, a dismissed dialog, or a repeat occurrence".
 * A tagged union rather than a flag so that the recorded time travels with the
 * fact and no caller can compute the fact from anything else.
 */
export type E2eeLegacyConsent =
  | { readonly kind: "absent" }
  | { readonly kind: "recorded"; readonly recordedAt: number };

/**
 * §12.1's latch.
 *
 * The latched VALUE is the record's `verifiedFingerprint`, by construction: §12.1
 * carries the latch "on a pin record … whose latched value is the pin's verified
 * node identity fingerprint", and §13.3 carries it over to the new fingerprint on
 * a silent rotation. Storing a second copy of that fingerprint here would create
 * a pair that can disagree, and the disagreement would be a downgrade guard
 * resting on stale bytes, so the latch stores only whether and when it was set.
 */
export type E2eeLatch =
  | { readonly kind: "unset" }
  | { readonly kind: "set"; readonly setAt: number };

/** §13.1's approval state, the client-side record of the owner's §13.2 decision. */
export interface E2eeApproval {
  /** §7.1 `ryco.client-key.v1` display form of the approved client identity key. */
  readonly clientIdentityFingerprint: string;
  readonly approvedAt: number;
}

interface E2eeTrustRecordBase {
  readonly index: E2eeTrustRecordIndex;
  /** §13.1 untrusted selection-resolution hints, oldest first. */
  readonly nodeIdHints: readonly string[];
  readonly legacyConsent: E2eeLegacyConsent;
  /**
   * A LOCAL CLEANUP ASSOCIATION AND NOTHING ELSE. It exists so the owner's
   * "forget this node" action in the connection list can reach this record; no
   * resolution, classification, latch, or promotion reads it, because it is not
   * client-anchored in §12.1.1's sense.
   */
  readonly environmentId: string | null;
}

/** §13.1's third shape: the index, the hints, and an owner legacy consent only. */
export interface E2eeUnpinnedRecord extends E2eeTrustRecordBase {
  readonly state: "none";
}

/** §13.1 between §13.2 step 2 and step 5. It carries the pairing flow, and nothing more. */
export interface E2eeUnverifiedPinRecord extends E2eeTrustRecordBase {
  readonly state: "unverified";
}

/** §13.1 after §13.2 step 5. Every field below is written by the promotion. */
export interface E2eeVerifiedPinRecord extends E2eeTrustRecordBase {
  readonly state: "verified";
  /** §7.1 `ryco.node-key.v1` display form of the owner-verified identity key. */
  readonly verifiedFingerprint: string;
  /**
   * The raw Ed25519 identity key that fingerprint was computed from (§7.1).
   *
   * THE KEY, NOT THE SAFETY NUMBER. §13.2.1 situation 2 requires the previously
   * verified fingerprint AND its §13.4 safety number to be displayed beside the
   * newly presented pair, and the safety number is not recomputable from a
   * fingerprint. §13.4 nevertheless says the value "never travels in any
   * protocol message, log, or analytics surface" and that "only the
   * pending-record copy of §13.2 is persisted" — the node's — so this record
   * keeps the public key the value is derived FROM and recomputes the display
   * form on demand. The key is not a secret; it is the same one the statement
   * carries in the clear.
   */
  readonly verifiedIdentityPublicKey: Uint8Array;
  /** §7.5, recorded at promotion. An anchor for classification, never a proof. */
  readonly recordedContinuityId: string;
  /** §5.7's highest accepted generation, which §13.3 carries across a rotation. */
  readonly acceptedPolicyGeneration: number;
  readonly latch: E2eeLatch;
  readonly approval: E2eeApproval;
}

export type E2eeTrustRecord = E2eeUnpinnedRecord | E2eeUnverifiedPinRecord | E2eeVerifiedPinRecord;

export function isE2eeVerifiedPinRecord(record: E2eeTrustRecord): record is E2eeVerifiedPinRecord {
  return record.state === "verified";
}

/**
 * §13.1 between §13.2 step 2 and step 5: the record "Request approval" opened.
 *
 * Every channel to its selection is pairing-only — one suite-0x01 hello so the
 * node lists this phone for approval, then a close, and nothing released —
 * whatever the classification or a legacy consent says. The relay routing, the
 * attempt and Home's workspace eligibility all read it here, so no surface can
 * call a node usable while its channels are ceremony-only.
 */
export function isE2eePairingRecord(
  record: E2eeTrustRecord | null,
): record is E2eeUnverifiedPinRecord {
  return record !== null && record.state === "unverified";
}

/**
 * §13.1's device-level `anyNodeVerified(hubOrigin)` marker, read under the Hub
 * origin ALONE. `unobtainable` is not `unset`: §4.4 forbids treating one as the
 * other, and the marker is exactly the guard that rule protects.
 */
export type E2eeVerificationMarker =
  | { readonly kind: "set" }
  | { readonly kind: "unset" }
  | { readonly kind: "unobtainable" };

/**
 * §12.1.1's "never legacy on this Hub", recorded and evaluated under `hubOrigin`
 * alone. §12.1.1 forbids keying it on `(hubOrigin, accountId)`: that pair is half
 * Hub-chosen, so a pair-keyed strict mode is a downgrade guard the Hub sheds by
 * re-minting the account scope.
 */
export type E2eeStrictLegacyPolicy =
  | { readonly kind: "permitted" }
  | { readonly kind: "forbidden"; readonly recordedAt: number }
  | { readonly kind: "unobtainable" };

/**
 * What a completed load holds. A store hands this in; `null` means the load has
 * not completed, which is `unobtainable` below and never "fresh install".
 */
export interface E2eeLoadedTrustState {
  readonly records: readonly E2eeTrustRecord[];
  readonly verifiedMarkerOrigins: ReadonlySet<string>;
}

/** Which of §13.1's three record shapes a selection resolved to. */
export type E2eeResolvedRecordState = "verified" | "unverified" | "unpinned";

export function e2eeResolvedRecordState(record: E2eeTrustRecord): E2eeResolvedRecordState {
  return record.state === "none" ? "unpinned" : record.state;
}

/**
 * §12.1.1's three unresolved cases, in the order the specification evaluates
 * them: the pair's own verified pins first, then the origin-wide marker.
 */
export type E2eeUnresolvedScope =
  | { readonly kind: "fresh" }
  | { readonly kind: "account-verified" }
  | { readonly kind: "origin-verified" };

declare const trustSnapshotBrand: unique symbol;

type E2eeTrustSnapshotBody =
  | { readonly kind: "latched" }
  | {
      readonly kind: "pinned-unlatched";
      readonly record: E2eeResolvedRecordState;
      readonly consent: E2eeLegacyConsent;
      /**
       * What the pair and the Hub origin hold, evaluated exactly as for an
       * unresolved selection. A resolution does not make the rest of the device's
       * state irrelevant: §5.2 requires a first-contact statement "arriving under
       * a `(hubOrigin, accountId)` pair that already holds a verified pin" to be
       * presented as a possible node substitution whether or not the selection
       * resolved — §13.2.1 says that copy "will fire on every genuine additional
       * node", which is precisely a selection that resolves to its own pairing
       * record — and §13.2.1 situation 3 is defined from this state alone.
       */
      readonly scope: E2eeUnresolvedScope;
    }
  | { readonly kind: "none"; readonly scope: E2eeUnresolvedScope }
  | { readonly kind: "unobtainable" };

/**
 * The classifier's only input.
 *
 * BRANDED SO IT CANNOT BE WRITTEN AS A LITERAL. `snapshotE2eeSelection` is the
 * one constructor, and it produces every variant other than `unobtainable` only
 * from a completed load. That is what stops a not-yet-hydrated store from
 * presenting itself as unset state: there is no way to name a `latched` or
 * `none` snapshot without one.
 */
export type E2eeTrustSnapshot = { readonly [trustSnapshotBrand]: true } & E2eeTrustSnapshotBody;

function seal(body: E2eeTrustSnapshotBody): E2eeTrustSnapshot {
  return body as E2eeTrustSnapshot;
}

function matchesSelection(record: E2eeTrustRecord, selection: E2eeTrustSelection): boolean {
  if (record.index.hubOrigin !== selection.hubOrigin) return false;
  if (record.index.accountId !== selection.accountId) return false;
  if (selection.kind === "handle")
    return record.index.localNodeHandle === selection.localNodeHandle;
  return record.nodeIdHints.includes(selection.nodeId);
}

/**
 * Resolve a selection to at most one record (§12.1.1).
 *
 * An AMBIGUOUS hint resolves to nothing. Two records carrying the same
 * Hub-minted id is a state only the Hub can produce, and picking either would let
 * it choose which strict guard applies; no resolution lands the channel in the
 * unexpected class, which is the direction §12.1.1 already relies on for a
 * suppressed hint.
 */
export function resolveE2eeTrustRecord(
  loaded: E2eeLoadedTrustState,
  selection: E2eeTrustSelection,
): E2eeTrustRecord | null {
  const matches = loaded.records.filter((record) => matchesSelection(record, selection));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * §12.1.1's late resolution: a validated statement matching its continuity id
 * against a pin under the same pair. Only a `verified` record carries a recorded
 * continuity id, so only one can be reached this way — an `unverified` record has
 * none by §13.1, and the first-contact statement's own id is display material.
 */
export function resolveE2eeTrustRecordByContinuityId(
  loaded: E2eeLoadedTrustState,
  input: { readonly hubOrigin: string; readonly accountId: string; readonly continuityId: string },
): E2eeVerifiedPinRecord | null {
  const matches = loaded.records.filter(
    (record): record is E2eeVerifiedPinRecord =>
      isE2eeVerifiedPinRecord(record) &&
      record.index.hubOrigin === input.hubOrigin &&
      record.index.accountId === input.accountId &&
      record.recordedContinuityId === input.continuityId,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function unresolvedScope(
  loaded: E2eeLoadedTrustState,
  hubOrigin: string,
  accountId: string,
): E2eeUnresolvedScope {
  const accountHoldsVerified = loaded.records.some(
    (record) =>
      isE2eeVerifiedPinRecord(record) &&
      record.index.hubOrigin === hubOrigin &&
      record.index.accountId === accountId,
  );
  if (accountHoldsVerified) return { kind: "account-verified" };
  if (loaded.verifiedMarkerOrigins.has(hubOrigin)) return { kind: "origin-verified" };
  return { kind: "fresh" };
}

function snapshotForRecord(
  record: E2eeTrustRecord,
  scope: E2eeUnresolvedScope,
  consent: E2eeLegacyConsent,
): E2eeTrustSnapshot {
  if (isE2eeVerifiedPinRecord(record) && record.latch.kind === "set")
    return seal({ kind: "latched" });
  return seal({
    kind: "pinned-unlatched",
    record: e2eeResolvedRecordState(record),
    consent,
    scope,
  });
}

/**
 * The only way to obtain a snapshot.
 *
 * `loaded === null` is the store saying its load has not completed — a cold
 * start, a keychain that refused, or a durable document that would not parse. It
 * produces `unobtainable`, which classifies UNEXPECTED, so a latched selection on
 * the first channel after a cold start can never take the legacy branch.
 */
export function snapshotE2eeSelection(
  loaded: E2eeLoadedTrustState | null,
  selection: E2eeTrustSelection,
): E2eeTrustSnapshot {
  if (loaded === null) return seal({ kind: "unobtainable" });
  const scope = unresolvedScope(loaded, selection.hubOrigin, selection.accountId);
  const record = resolveE2eeTrustRecord(loaded, selection);
  if (record === null) return seal({ kind: "none", scope });
  // §11.2: "No Hub-supplied value may move a selection _into_ the legacy-eligible
  // class: not the `nodeId`, which the Hub re-mints at will." §12.1.1's safety
  // argument for an untrusted hint covers a resolution to a PIN — a wrong pin
  // produces a statement that cannot authenticate to it, which is §13.3 fatal —
  // and a recorded consent needs no statement at all: with the carrier withheld it
  // releases at `T_ADV` on row K13. So a hint resolves onto the pin, and carries
  // the owner's per-selection consent only where the device's own state already
  // reaches the legacy-eligible class without it. A handle is client-anchored and
  // carries it unconditionally: it is the selection the owner chose.
  const consent: E2eeLegacyConsent =
    selection.kind === "handle" || scope.kind === "fresh"
      ? record.legacyConsent
      : { kind: "absent" };
  return snapshotForRecord(record, scope, consent);
}

/**
 * The late-resolution counterpart of `snapshotE2eeSelection` (§12.1.1).
 *
 * The continuity id is Hub-carried too, but it needs no consent suppression here:
 * §12.1.1 admits this resolution only as one that "can only **tighten** the
 * classification …, never move a channel into the legacy-eligible class", and
 * `tightenE2eeTrustClassification` is where that bound is applied. Suppressing the
 * consent as well would let a statement the Hub chose to deliver take a channel
 * AWAY from the class the owner's own consent put it in.
 */
export function snapshotE2eeContinuityIdResolution(
  loaded: E2eeLoadedTrustState | null,
  input: { readonly hubOrigin: string; readonly accountId: string; readonly continuityId: string },
): E2eeTrustSnapshot {
  if (loaded === null) return seal({ kind: "unobtainable" });
  const scope = unresolvedScope(loaded, input.hubOrigin, input.accountId);
  const record = resolveE2eeTrustRecordByContinuityId(loaded, input);
  if (record === null) return seal({ kind: "none", scope });
  return snapshotForRecord(record, scope, record.legacyConsent);
}

export type E2eeTrustClass = "latched" | "legacy-eligible" | "unexpected";

/**
 * §12.1.1's classification, with the branch or clause that produced it.
 *
 * The branch is carried because §12.1.1 gives the two legacy-eligible branches
 * different provenance — (a) is "this install has never verified any node on this
 * Hub origin", (b) is the owner's own recorded consent — and because §13.1.1
 * requires a client that has lost its durable state to reach the class only under
 * (a). The clause is carried because §13.2.1 presents its three situations
 * differently and "conflating them re-creates exactly the click-through training
 * §13.3 opens by forbidding". Clause (i) carries the scope for the same reason:
 * clauses (ii) and (iii) ARE their scope, and a resolved selection would otherwise
 * be the one case whose surface could not tell the three apart.
 */
export type E2eeTrustClassification =
  | { readonly class: "latched" }
  | { readonly class: "legacy-eligible"; readonly branch: "a" | "b" }
  | {
      readonly class: "unexpected";
      readonly clause: "i";
      readonly record: E2eeResolvedRecordState;
      readonly scope: E2eeUnresolvedScope;
    }
  | { readonly class: "unexpected"; readonly clause: "ii" | "iii" | "unobtainable" };

/**
 * §12.1.1, evaluated in the specification's order: latched, then legacy-eligible,
 * then unexpected.
 *
 * `unobtainable` is not one of §12.1.1's three illustrative clauses; it is this
 * implementation's name for the state §4.4 addresses directly — "a client … MUST
 * NOT treat unobtainable evidence as an unset latch or an unset marker" — and it
 * falls to §12.1.1's "everything else".
 */
function classifyUnresolved(scope: E2eeUnresolvedScope): E2eeTrustClassification {
  switch (scope.kind) {
    case "fresh":
      return { class: "legacy-eligible", branch: "a" };
    case "account-verified":
      return { class: "unexpected", clause: "ii" };
    case "origin-verified":
      return { class: "unexpected", clause: "iii" };
  }
}

export function classifyE2eeTrustSnapshot(snapshot: E2eeTrustSnapshot): E2eeTrustClassification {
  switch (snapshot.kind) {
    case "latched":
      return { class: "latched" };
    case "pinned-unlatched":
      // §12.1.1 branch (b) claims a resolved-but-unlatched selection the owner
      // consented to; branch (a) cannot apply here, because a record did resolve.
      return snapshot.consent.kind === "recorded"
        ? { class: "legacy-eligible", branch: "b" }
        : { class: "unexpected", clause: "i", record: snapshot.record, scope: snapshot.scope };
    case "none":
      return classifyUnresolved(snapshot.scope);
    case "unobtainable":
      return { class: "unexpected", clause: "unobtainable" };
  }
}

/**
 * How tightly a class binds the channel. Legacy-eligible is the only class that
 * can release plaintext (rows K9/K13), unexpected closes FATAL-PRE, and latched
 * additionally refuses the owner the legacy-consent resolution (§13.2.1).
 */
const CLASS_RANK: Record<E2eeTrustClass, number> = {
  "legacy-eligible": 0,
  unexpected: 1,
  latched: 2,
};

/**
 * §12.1.1: a late continuity-id resolution "can only **tighten** the
 * classification …, never move a channel into the legacy-eligible class". A
 * monotone maximum is that rule with no room for an exception, so no statement —
 * whose continuity id is public and copyable (§13.3) — can loosen a channel.
 */
export function tightenE2eeTrustClassification(
  initial: E2eeTrustClassification,
  late: E2eeTrustClassification,
): E2eeTrustClassification {
  return CLASS_RANK[late.class] > CLASS_RANK[initial.class] ? late : initial;
}

/**
 * What the client holds about the node when the §13.2.1 surface is raised.
 * `none` is rows K23/K24 — the carrier never arrived, or `T_ADV` expired.
 */
export type E2eeUnexpectedNodeEvidence =
  | { readonly kind: "none" }
  | { readonly kind: "first-contact-statement" };

/** §13.2.1's three situations, which the presentation MUST distinguish. */
export type E2eeUnexpectedNodeSituation = 1 | 2 | 3;

/**
 * What the pair and the origin hold, for every unexpected clause. Clauses (ii) and
 * (iii) ARE §12.1.1's second and third unresolved cases, so their scope is their
 * definition; `unobtainable` has none, because nothing about the device's own pin
 * set is readable in that state (§4.4).
 */
function unexpectedScope(
  classification: Extract<E2eeTrustClassification, { readonly class: "unexpected" }>,
): E2eeUnresolvedScope | null {
  switch (classification.clause) {
    case "i":
      return classification.scope;
    case "ii":
      return { kind: "account-verified" };
    case "iii":
      return { kind: "origin-verified" };
    case "unobtainable":
      return null;
  }
}

/**
 * Choose §13.2.1's situation, or `null` when the surface does not apply.
 *
 * THE SITUATION IS THE SCOPE, NOT THE RESOLUTION. §13.2.1 situation 3 is defined
 * from local state alone — "a selection under an account scope that holds no
 * verified pin, on a Hub origin whose `anyNodeVerified` marker is set" — and it is
 * classified under rows K23/K24, which ARE the no-evidence rows, so withheld
 * evidence selects it rather than suppressing it. Situation 2 is §5.2's rule, which
 * binds "under a `(hubOrigin, accountId)` pair that already holds a verified pin"
 * whether or not the selection resolved: §13.2.1 says its copy "will fire on every
 * genuine additional node", and adding one resolves to the pairing record §13.2
 * step 2 just wrote.
 *
 * `null` for a selection that resolved to an `unverified` record with a
 * first-contact statement, and with nothing else under the pair or the origin, is
 * deliberate and is not a gap: that record IS the §13.2 ceremony the owner already
 * started for this selection, so continuing it is correct. Nothing is released
 * either way — §13.1's release gate restricts an `unverified` pin to the ceremony.
 */
export function resolveE2eeUnexpectedNodeSituation(
  classification: E2eeTrustClassification,
  evidence: E2eeUnexpectedNodeEvidence,
): E2eeUnexpectedNodeSituation | null {
  if (classification.class !== "unexpected") return null;
  const scope = unexpectedScope(classification);
  if (scope?.kind === "origin-verified") return 3;
  if (evidence.kind === "none") return 1;
  if (scope?.kind === "account-verified") return 2;
  if (classification.clause === "i" && classification.record === "unverified") return null;
  return 1;
}

/** The resolutions §13.2.1 offers the owner. Neither is a default. */
export type E2eeUnexpectedNodeResolution = "pair" | "record-legacy-consent";

/**
 * §13.2.1: "Where local policy forbids legacy the same selection closes under
 * rows K10/K14 instead, and the surface offers pairing alone — the consent
 * resolution is unavailable, not defaulted". An `unobtainable` policy is answered
 * the same way as a forbidding one: the offer is withheld rather than guessed.
 */
export function e2eeUnexpectedNodeResolutions(
  policy: E2eeStrictLegacyPolicy,
): readonly E2eeUnexpectedNodeResolution[] {
  return policy.kind === "permitted" ? ["pair", "record-legacy-consent"] : ["pair"];
}

/**
 * What a §5.2 verdict means for the client's durable trust state.
 *
 * `diagnostic-only` is the whole reason this mapping is written out. §13.3 lists
 * what takes the re-verification path and then excludes one case by name: "A
 * **policy-generation** regression is deliberately _not_ on this list: it is an
 * invalid statement with a local-only diagnostic (§5.7, §11.4), because a Hub can
 * replay a genuine older statement on demand." A client that folded it into the
 * chain-failure arm would train the owner to click through the one warning a real
 * substitution raises.
 */
export type E2eeTrustStatementOutcome =
  /** §5.2 authenticated to the pin unchanged. §12.1's native latch set condition. */
  | { readonly kind: "pin-authenticated" }
  /** §13.3 silent update: the chain verified to the pin. No prompt, no ceremony. */
  | { readonly kind: "pin-rotated" }
  /** Self-signed first contact. Sets no pin and no latch (§5.2 step 6, §12.1, §13.1). */
  | { readonly kind: "first-contact" }
  /** §13.3 chain failure: channel-fatal, raises the re-verification UI, updates no pin. */
  | { readonly kind: "re-verification-required"; readonly event: NodeE2eeCapabilityIdentityEvent }
  /** §5.7 / §11.4: neither the ceremony nor the re-verification path. */
  | { readonly kind: "diagnostic-only"; readonly diagnostic: "e2ee_policy_generation_regressed" }
  /** Every other refusal, and every valid-but-unusable statement. Nothing is written. */
  | { readonly kind: "no-trust-change" };

function outcomeForAnchor(anchor: NodeE2eeCapabilityAnchor): E2eeTrustStatementOutcome {
  switch (anchor) {
    case "pin-unchanged":
      return { kind: "pin-authenticated" };
    case "pin-updated":
      return { kind: "pin-rotated" };
    case "none":
      return { kind: "first-contact" };
  }
}

export function resolveE2eeTrustStatementOutcome(
  verification: NodeE2eeCapabilityVerification,
): E2eeTrustStatementOutcome {
  switch (verification.kind) {
    case "verified":
      return outcomeForAnchor(verification.anchor);
    case "identity-event":
      return { kind: "re-verification-required", event: verification.event };
    case "invalid":
      return verification.reason === "policy_generation_regressed"
        ? { kind: "diagnostic-only", diagnostic: "e2ee_policy_generation_regressed" }
        : { kind: "no-trust-change" };
    case "unusable":
      return { kind: "no-trust-change" };
  }
}
