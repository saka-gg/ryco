import type { HostedE2eeChannelStatus } from "@ryco/client-runtime/authorization";
import type {
  RelayE2eeInitiatorDiagnostic,
  RelayE2eeUnexpectedNodeEvidence,
} from "@ryco/client-runtime/relay";
import type { NodeE2eeCapabilityVerification } from "@ryco/shared/relayE2eeCapabilityVerify";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import type { NodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeTranscripts";
import { deriveE2eeSafetyNumber } from "@ryco/shared/relayE2eeVerificationDisplay";

import {
  e2eeResolvedRecordState,
  resolveE2eeTrustStatementOutcome,
  resolveE2eeUnexpectedNodeSituation,
  type E2eeResolvedRecordState,
  type E2eeTrustClassification,
  type E2eeTrustRecord,
  type E2eeUnexpectedNodeSituation,
} from "../platform/e2eeTrustModel";

// The owner-visible projection of one channel's §13 state —
// docs/relay-e2ee-protocol.md §12.1.1 (classification), §13.1.1 (what a device
// holding no verified pin must be shown), §13.2.1 (the three unexpected
// situations), §13.3 (rotation and the re-verification event), §13.4 (the safety
// number) and §11.4 (the sender-local diagnostics).
//
// IT IS A PROJECTION AND NOTHING ELSE. Every guard is decided before this module
// hears about it: the §4.4 mode machine locks the mode, `e2eeTrustStore` owns
// custody, and `e2eeAttempt` resolves the classification before the channel
// exists. Nothing here can release payload, loosen a class, or promote a pin.
//
// FREE OF `react-native` AND OF REACT, for the reason `hostedAuthModel.ts` gives:
// react-native ships untranspiled Flow that the vp/node runner cannot parse, so a
// decision written inside a `.tsx` is untestable. The `.tsx` files read this
// store and lay it out.
//
// WHAT IT MAY HOLD, AND WHAT IT MAY NOT. The §13.4 safety number and the §7.1
// fingerprints are display material this specification REQUIRES the client to
// show (§13.4 "Surfaces"), so they live here, in memory, for exactly as long as
// the screen that renders them. They are never persisted here, never logged,
// never put in an error, and never sent: §13.4 is explicit that the value "never
// travels in any protocol message, log, or analytics surface". No handshake key,
// no session secret, no transcript, and no statement signature is held at all —
// only the node's advertised public identity key, which the ceremony needs to
// re-derive the value the owner compares and which the statement carried in the
// clear.

/** §13.4 display material for one identity, both halves derived on this device. */
export interface MobileE2eeIdentityDisplay {
  /** §7.1 `ryco.node-key.v1` display fingerprint. */
  readonly fingerprint: string;
  /** §13.4's rendered value: `E2EE_SAFETY_NUMBER_DIGITS` groups, derivation order. */
  readonly safetyNumber: string;
}

/**
 * The identity a channel actually presented, plus the two statement fields the
 * §13.2 step 5 promotion records. Present only where a statement validated;
 * rows K23/K24 with no carrier have none, and §13.2.1 situation 1 is defined for
 * exactly that case.
 */
export interface MobileE2eePresentedNode {
  /** Raw Ed25519 key, as the statement carried it. The minter validates it again. */
  readonly nodeIdentityPublicKey: Uint8Array;
  readonly display: MobileE2eeIdentityDisplay;
  /** §7.6 element 18. An anchor recorded at promotion, never a proof (§7.5). */
  readonly continuityId: string;
  /** §5.7's generation carried by the statement the ceremony ran against. */
  readonly policyGeneration: number;
}

/** The non-secret selection context known before credential custody succeeds. */
export interface MobileE2eeSelectionContext {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly nodeId: string;
  /** The node's Hub-supplied display label. Bounded, and display-only. */
  readonly nodeLabel: string;
  readonly environmentId: string | null;
  /**
   * The client-anchored §13.1 handle, when this selection already has a record.
   * `null` is a selection that resolved to nothing — §13.2.1 situation 1's usual
   * shape — and the store mints the handle when the owner starts the ceremony.
   */
  readonly localNodeHandle: string | null;
  /**
   * The §13.1 shape of the record behind {@link localNodeHandle}, `null` exactly
   * when the handle is. Only `unverified` means this phone asked the node for
   * approval: a legacy consent's no-pin record and a verified pin carry a handle
   * too, and neither sent a pairing hello.
   */
  readonly localRecordState: E2eeResolvedRecordState | null;
}

/** The client-anchored half of a selection context, from the record it resolved to. */
export function mobileE2eeLocalRecordContext(
  record: E2eeTrustRecord | null,
): Pick<MobileE2eeSelectionContext, "localNodeHandle" | "localRecordState"> {
  return record === null
    ? { localNodeHandle: null, localRecordState: null }
    : {
        localNodeHandle: record.index.localNodeHandle,
        localRecordState: e2eeResolvedRecordState(record),
      };
}

/** The selection projection, including credential material only when available. */
export interface MobileE2eeSelection extends MobileE2eeSelectionContext {
  /**
   * This device's public P-256 identity key, the client half of §13.4.
   *
   * `null` is a strict, fail-closed credential-custody result. The selection
   * and its unexpected classification remain owner-visible, but no safety
   * number or verification decision can be derived until a fresh preparation
   * obtains the real key. No placeholder key is ever fabricated.
   */
  readonly clientIdentityPublicKey: Uint8Array | null;
}

/**
 * §11.4's sender-local diagnostics, as the closed set this app can raise.
 *
 * LOCAL-ONLY, AND THE COPY HAS TO SAY SO. §11.4 ends with "Local diagnostic codes
 * MUST NOT alter wire behavior: two failures with different local codes are
 * indistinguishable on the wire", and §11.2's uniform observable means the client
 * cannot learn a cause from the node at all. Every member below is therefore
 * something this device concluded about ITSELF.
 */
export type MobileE2eeDiagnosticId =
  /** §4.5: an inner-record body over `plaintextCeiling`. Channel unaffected. */
  | "e2ee_message_too_large"
  /** §9.3 / §4.4: no transmission admission, or a full negotiation buffer. */
  | "e2ee_send_unavailable"
  /** §6.4: this device's own prekey validity failed. */
  | "e2ee_prekey_expired"
  /** §5.7: a statement carrying a generation below the one already accepted. */
  | "e2ee_policy_generation_regressed";

/**
 * A §11.2 row this client enumerated for itself, or the local conditions above.
 *
 * The initiator's diagnostic carries a row label and nothing else; it is kept
 * here as the operator-facing half of a pre-key failure and is bounded by
 * construction — no statement bytes, no fingerprint, no key.
 */
export interface MobileE2eeLocalDiagnostic {
  readonly id: MobileE2eeDiagnosticId | "pre_key_local";
  /** A §11.2 row, or `local`. Never a cause the node supplied — there is none. */
  readonly row: string;
}

/** §13.2.1's surface, or §13.3's. They are four different messages, never one. */
export type MobileE2eeTrustEvent =
  | {
      readonly kind: "unexpected-node";
      readonly situation: E2eeUnexpectedNodeSituation;
      readonly evidence: RelayE2eeUnexpectedNodeEvidence;
    }
  /** §13.3: a chain that did not verify to the pin. Channel-fatal, re-verify. */
  | { readonly kind: "identity-change" };

export interface MobileE2eeSessionState {
  /** What the pill is entitled to say. Folded into the shared status derivation. */
  readonly channel: HostedE2eeChannelStatus;
  readonly trustSource: "none" | "locally-verified" | "account-enrolled";
  readonly selection: MobileE2eeSelection | null;
  /**
   * §12.1.1's verdict WITH its clause and scope, not the coarse class the §4.4
   * machine consumes. §13.2.1 selects its situation from exactly that detail —
   * clauses (ii) and (iii) ARE their scope — so narrowing it at this seam would
   * make the three situations indistinguishable on the one surface that must
   * distinguish them.
   */
  readonly classification: E2eeTrustClassification | null;
  /** §12.1.1's strict-legacy policy for this Hub origin: `false` unless permitted. */
  readonly legacyPermitted: boolean;
  /**
   * §13.1's `anyNodeVerified(hubOrigin)` marker AFTER the reconciliation §13.1
   * requires. `null` is `unobtainable` and is NEVER read as `false` in a guard —
   * §4.4 forbids it — but for §13.1.1's persistent indication the two are the
   * same owner-visible fact: this device can show no verified node on this Hub.
   */
  readonly markerSet: boolean | null;
  /**
   * §13.1: whether this selection resolved to a VERIFIED pin.
   *
   * It is the release gate's own input and the second half of §2.2's bottom row,
   * so it is state rather than a flag a call site carries: `e2ee` alone is not
   * the verified row, and a lock that had to be told which row it was in could
   * be told the wrong one — where this cannot, because the same value the
   * §12.1.1 guards were resolved from decides it.
   */
  readonly pinVerified: boolean;
  /** The identity this channel advertised, when a statement validated. */
  readonly presented: MobileE2eePresentedNode | null;
  /** §13.2.1 situation 2's other half: the pin this account already holds. */
  readonly previouslyVerified: MobileE2eeIdentityDisplay | null;
  readonly event: MobileE2eeTrustEvent | null;
  /**
   * §6.3's "a device that cannot hold the key simply has no E2EE", as the fact it
   * is rather than as the fallback it looks like.
   *
   * A §12.2 fallback and this produce the same plaintext channel, but they are
   * not the same thing to the owner: pairing the node removes the first and can
   * never remove the second, so a surface that offered the same remedy for both
   * would be pointing at an action that cannot deliver what it implies.
   */
  readonly keyCustodyUnavailable: boolean;
  readonly diagnostics: readonly MobileE2eeLocalDiagnostic[];
}

const INITIAL: MobileE2eeSessionState = {
  channel: "unavailable",
  trustSource: "none",
  selection: null,
  classification: null,
  legacyPermitted: false,
  markerSet: null,
  pinVerified: false,
  presented: null,
  previouslyVerified: null,
  event: null,
  keyCustodyUnavailable: false,
  diagnostics: [],
};

/** How many local diagnostics the screen keeps. Bounded, oldest evicted. */
const DIAGNOSTICS_MAX = 8;

let fallbackState: MobileE2eeSessionState = INITIAL;
let activeEnvironmentId: string | null = null;
const states = new Map<string, MobileE2eeSessionState>();
const listeners = new Set<() => void>();
const environmentListeners = new Map<string, Set<() => void>>();

function stateFor(environmentId?: string | null): MobileE2eeSessionState {
  const key = environmentId === undefined ? activeEnvironmentId : environmentId;
  return key === null ? fallbackState : (states.get(key) ?? INITIAL);
}

function publish(next: MobileE2eeSessionState, environmentId?: string | null): void {
  const key =
    environmentId === undefined
      ? (next.selection?.environmentId ?? activeEnvironmentId)
      : environmentId;
  const current = stateFor(key);
  if (next === current) return;
  if (key === null) fallbackState = next;
  else {
    states.set(key, next);
    activeEnvironmentId = key;
  }
  for (const listener of listeners) listener();
  if (key !== null) {
    for (const listener of environmentListeners.get(key) ?? []) listener();
  }
}

export function getMobileE2eeSessionState(environmentId?: string | null): MobileE2eeSessionState {
  return stateFor(environmentId);
}

export function subscribeMobileE2eeSession(listener: () => void): () => void;
export function subscribeMobileE2eeSession(environmentId: string, listener: () => void): () => void;
export function subscribeMobileE2eeSession(
  environmentIdOrListener: string | (() => void),
  maybeListener?: () => void,
): () => void {
  if (typeof environmentIdOrListener === "function") {
    listeners.add(environmentIdOrListener);
    return () => listeners.delete(environmentIdOrListener);
  }
  const scoped = environmentListeners.get(environmentIdOrListener) ?? new Set<() => void>();
  const listener = maybeListener;
  if (!listener) return () => undefined;
  scoped.add(listener);
  environmentListeners.set(environmentIdOrListener, scoped);
  return () => {
    scoped.delete(listener);
    if (scoped.size === 0) environmentListeners.delete(environmentIdOrListener);
  };
}

/**
 * Derive the §13.4 display pair for one node identity key.
 *
 * LOCAL, ALWAYS. §13.2 step 4 requires the client's copy to be "computed locally
 * from its own keys and the advertised node identity key", and §13.4 fixes the
 * derivation over both keys plus the Hub origin and account id. Nothing about
 * this reads a value the Hub or the node sent, so a substituted node cannot make
 * two devices agree by sending them a number.
 */
export function deriveMobileE2eeIdentityDisplay(input: {
  readonly nodeIdentityPublicKey: Uint8Array;
  readonly clientIdentityPublicKey: Uint8Array;
  readonly hubOrigin: string;
  readonly accountId: string;
}): MobileE2eeIdentityDisplay {
  return {
    fingerprint: formatE2eeKeyFingerprint(
      e2eeKeyFingerprint("node-identity", input.nodeIdentityPublicKey),
    ),
    safetyNumber: deriveE2eeSafetyNumber(input).display,
  };
}

/**
 * A channel attempt is starting. Everything the guards decided arrives here at
 * once, because §4.4 requires all of it to be resolvable before any payload.
 */
export function beginMobileE2eeChannel(input: {
  readonly selection: MobileE2eeSelectionContext & {
    readonly clientIdentityPublicKey: Uint8Array;
  };
  readonly classification: E2eeTrustClassification;
  readonly legacyPermitted: boolean;
  readonly markerSet: boolean | null;
  readonly pinVerified: boolean;
  readonly previouslyVerified: MobileE2eeIdentityDisplay | null;
  readonly trustSource?: "locally-verified" | "account-enrolled";
}): void {
  publish(
    {
      ...INITIAL,
      channel: "negotiating",
      trustSource: input.trustSource ?? "locally-verified",
      selection: input.selection,
      classification: input.classification,
      legacyPermitted: input.legacyPermitted,
      markerSet: input.markerSet,
      pinVerified: input.pinVerified,
      previouslyVerified: input.previouslyVerified,
    },
    input.selection.environmentId,
  );
}

/**
 * A current selection whose guards resolved but whose credentials did not.
 *
 * Transport remains unavailable and therefore releases nothing. The resolved
 * trust context is still published so an `unexpected` selection keeps its
 * §13.2.1 surface. Because no node statement was processed, the event carries
 * the honest `none` evidence and the ceremony withholds every operation that
 * requires this device's unavailable identity key.
 */
export function beginMobileE2eeFailClosedSelection(input: {
  readonly selection: MobileE2eeSelectionContext;
  readonly classification: E2eeTrustClassification;
  readonly legacyPermitted: boolean;
  readonly markerSet: boolean | null;
  readonly pinVerified: boolean;
}): void {
  const situation = resolveE2eeUnexpectedNodeSituation(input.classification, { kind: "none" });
  publish(
    {
      ...INITIAL,
      selection: { ...input.selection, clientIdentityPublicKey: null },
      classification: input.classification,
      legacyPermitted: input.legacyPermitted,
      markerSet: input.markerSet,
      pinVerified: input.pinVerified,
      event: situation === null ? null : { kind: "unexpected-node", situation, evidence: "none" },
    },
    input.selection.environmentId,
  );
}

/**
 * This device could not build handshake credentials at all (§6.3: "a device that
 * cannot hold the key simply has no E2EE"). The channel is legacy from the
 * start, and §12.2 requires it to be labeled so everywhere — with the copy that
 * says which of the two legacy channels this is.
 */
export function markMobileE2eeKeyCustodyUnavailable(environmentId?: string | null): void {
  publish({ ...INITIAL, channel: "legacy", keyCustodyUnavailable: true }, environmentId);
}

/**
 * A CHANNEL is starting, on a context this device already resolved.
 *
 * §4.4's mode lock is a property of one channel, so the claim it produces is
 * too: publishing it per preparation left a `verified` label standing over every
 * later channel of the same selection — including one closing FATAL-PRE under a
 * §13.3 substitution attempt, which is the exact moment the label is worst. The
 * §13.2.1 and §13.3 EVENT is deliberately not cleared here, nor is the identity
 * the last channel presented: both are the owner's to resolve on the ceremony
 * surface (§13.1.1's dismissal rule), and a reconnect must not silently empty
 * the comparison they are standing in front of.
 */
export function beginMobileE2eeChannelAttempt(environmentId?: string | null): void {
  const state = stateFor(environmentId);
  if (state.selection === null) return;
  publish({ ...state, channel: "negotiating" }, environmentId);
}

/** No hosted channel at all — signed out, no node selected, or none open yet. */
export function resetMobileE2eeSession(environmentId?: string | null): void {
  if (environmentId === undefined) {
    const changed = states.size > 0 || fallbackState !== INITIAL || activeEnvironmentId !== null;
    states.clear();
    fallbackState = INITIAL;
    activeEnvironmentId = null;
    if (!changed) return;
    for (const listener of listeners) listener();
    for (const scoped of environmentListeners.values()) {
      for (const listener of scoped) listener();
    }
    return;
  }
  publish(INITIAL, environmentId);
}

/**
 * §4.4 locked a mode.
 *
 * `e2ee` alone is NOT the verified row of §2.2. The pin decides: a channel that
 * locked `e2ee` while its selection resolved to no verified pin is §13.1's
 * release-gated pairing channel, and it is reported `unverified` so no surface
 * can spell it the way the verified row is spelled.
 */
export function lockMobileE2eeChannelMode(
  mode: "e2ee" | "legacy",
  environmentId?: string | null,
): void {
  const state = stateFor(environmentId);
  publish(
    {
      ...state,
      channel:
        mode === "legacy"
          ? "legacy"
          : state.trustSource === "account-enrolled"
            ? "account-trusted"
            : state.pinVerified
              ? "verified"
              : "unverified",
    },
    environmentId,
  );
}

/** Publish public identity display material learned on an account-authorized channel. */
export function observeMobileAccountE2eeStatement(
  verification: NodeE2eeCapabilityVerification,
  environmentId?: string | null,
): void {
  if (verification.kind !== "verified") return;
  const state = stateFor(environmentId);
  const selection = state.selection;
  if (selection?.clientIdentityPublicKey === null || selection === null) return;
  const statement = verification.statement;
  publish(
    {
      ...state,
      presented: {
        nodeIdentityPublicKey: Uint8Array.from(statement.identityPublicKey),
        display: deriveMobileE2eeIdentityDisplay({
          nodeIdentityPublicKey: statement.identityPublicKey,
          clientIdentityPublicKey: selection.clientIdentityPublicKey,
          hubOrigin: selection.hubOrigin,
          accountId: selection.accountId,
        }),
        continuityId: statement.continuityId,
        policyGeneration: statement.policyGeneration,
      },
      event: null,
    },
    environmentId,
  );
}

/** A §11.4 local diagnostic, bounded and oldest-evicted. Never a wire effect. */
export function recordMobileE2eeDiagnostic(
  diagnostic: MobileE2eeLocalDiagnostic,
  environmentId?: string | null,
): void {
  const state = stateFor(environmentId);
  const next = [...state.diagnostics, diagnostic];
  publish(
    { ...state, diagnostics: next.slice(Math.max(0, next.length - DIAGNOSTICS_MAX)) },
    environmentId,
  );
}

/** The initiator's own pre-key row, in the shape this store keeps. */
export function recordMobileE2eeInitiatorDiagnostic(
  diagnostic: RelayE2eeInitiatorDiagnostic,
  environmentId?: string | null,
): void {
  recordMobileE2eeDiagnostic({ id: "pre_key_local", row: diagnostic.row }, environmentId);
}

/**
 * §13.2.1: the unexpected-node surface, raised locally on rows K23/K24.
 *
 * The situation is CHOSEN BY THE MODEL, from the classification and the evidence
 * — never by this call site and never from anything the channel carried. §13.2.1
 * is explicit that conflating the three "re-creates exactly the click-through
 * training §13.3 opens by forbidding".
 */
export function raiseMobileE2eeUnexpectedNode(
  evidence: RelayE2eeUnexpectedNodeEvidence,
  environmentId?: string | null,
): void {
  const state = stateFor(environmentId);
  const classification = state.classification;
  if (classification === null) return;
  const situation = resolveE2eeUnexpectedNodeSituation(
    classification,
    evidence === "none" ? { kind: "none" } : { kind: "first-contact-statement" },
  );
  if (situation === null) return;
  publish({ ...state, event: { kind: "unexpected-node", situation, evidence } }, environmentId);
}

/**
 * §5.2's verdict for one statement, projected for the owner.
 *
 * The three arms §13.3 separates are separated HERE and nowhere else:
 *
 *  - a chain that verified — unchanged or rotated — surfaces NOTHING. §13.3:
 *    "Legitimate node identity rotation MUST NOT surface a re-verification
 *    prompt: training owners to click through 'identity changed' warnings
 *    destroys the only signal a real substitution raises."
 *  - a chain FAILURE raises the re-verification event.
 *  - a §5.7 policy-generation regression raises NEITHER: §11.4 says the
 *    diagnostic "MUST NOT by itself launch the §13.2 ceremony or the §13.3
 *    re-verification UI".
 */
export function observeMobileE2eeStatement(
  verification: NodeE2eeCapabilityVerification,
  environmentId?: string | null,
): void {
  const state = stateFor(environmentId);
  const outcome = resolveE2eeTrustStatementOutcome(verification);
  const presented =
    "statement" in verification
      ? presentedFor(verification.statement, environmentId)
      : state.presented;
  switch (outcome.kind) {
    case "diagnostic-only":
      publish({ ...state, presented }, environmentId);
      recordMobileE2eeDiagnostic({ id: outcome.diagnostic, row: "local" }, environmentId);
      return;
    case "re-verification-required":
      publish({ ...state, presented, event: { kind: "identity-change" } }, environmentId);
      return;
    case "pin-authenticated":
    case "pin-rotated":
    case "first-contact":
    case "no-trust-change":
      publish({ ...state, presented }, environmentId);
      return;
  }
}

function presentedFor(
  statement: NodeE2eeCapabilityStatement,
  environmentId?: string | null,
): MobileE2eePresentedNode | null {
  const selection = stateFor(environmentId).selection;
  if (selection === null || selection.clientIdentityPublicKey === null) return null;
  let display: MobileE2eeIdentityDisplay;
  try {
    display = deriveMobileE2eeIdentityDisplay({
      nodeIdentityPublicKey: statement.identityPublicKey,
      clientIdentityPublicKey: selection.clientIdentityPublicKey,
      hubOrigin: selection.hubOrigin,
      accountId: selection.accountId,
    });
  } catch {
    // A key, origin, or account scope the §13.4 encoder refuses. There is then
    // no value for the owner to compare, which is the honest answer: the
    // ceremony cannot proceed, and nothing about the refusal may travel.
    return null;
  }
  return {
    nodeIdentityPublicKey: statement.identityPublicKey,
    display,
    continuityId: statement.continuityId,
    policyGeneration: statement.policyGeneration,
  };
}

/**
 * Record the handle a ceremony minted, so the promotion has an index, together
 * with the shape of the record it names.
 *
 * §13.2 step 2 mints it; §12.1.1 records consent "per selection", and the
 * selection is the client-anchored handle rather than the `nodeId` that raised
 * the surface.
 */
export function attachMobileE2eeLocalNodeHandle(
  localNodeHandle: string,
  localRecordState: E2eeResolvedRecordState,
  environmentId?: string | null,
): void {
  const state = stateFor(environmentId);
  const selection = state.selection;
  if (selection === null) return;
  publish(
    { ...state, selection: { ...selection, localNodeHandle, localRecordState } },
    environmentId,
  );
}

/**
 * The owner finished with the surface: the ceremony completed, or the resolution
 * was recorded. Clearing the EVENT is all this does — it changes no channel
 * label and unlocks no guarantee, which §13.1.1 requires of every dismissal.
 */
export function clearMobileE2eeTrustEvent(environmentId?: string | null): void {
  const state = stateFor(environmentId);
  if (state.event === null) return;
  publish({ ...state, event: null }, environmentId);
}

/** Test seam: drop every subscriber and return to the initial state. */
export function resetMobileE2eeSessionForTests(): void {
  listeners.clear();
  environmentListeners.clear();
  states.clear();
  fallbackState = INITIAL;
  activeEnvironmentId = null;
}
