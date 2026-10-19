import { hostedEnvironmentSessionsMode, hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  relayE2eeUnresolvedAttemptFailure,
  type RelayE2eeChannel,
  type RelayE2eeHost,
  type RelayE2eeProvider,
} from "@ryco/client-runtime/relay";
import type {
  RelayE2eeInitiatorAttempt,
  RelayE2eeSelectionClass,
} from "@ryco/client-runtime/relay/e2ee";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import { E2EE_SUITE_25519_CHACHAPOLY_SHA256 } from "@ryco/shared/relayE2eeWire";
import type { EnvironmentId } from "@ryco/contracts";

import { getMobileDeviceIdentityPublicKey } from "../platform/deviceKey";
import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { mobileE2eeAgreementKey } from "../platform/e2eeAgreementKey";
import { mobileClientE2eePrekey } from "../platform/e2eeClientPrekey";
import { makeMobileRelayE2eeProvider } from "../platform/e2eeRelayProvider";
import {
  isE2eePairingRecord,
  isE2eeVerifiedPinRecord,
  type E2eeTrustClassification,
  type E2eeVerifiedPinRecord,
} from "../platform/e2eeTrustModel";
import { mobileE2eeTrustStore } from "../platform/e2eeTrustStore";
import {
  beginMobileE2eeChannel,
  beginMobileE2eeChannelAttempt,
  beginMobileE2eeFailClosedSelection,
  deriveMobileE2eeIdentityDisplay,
  endMobileE2eeChannel,
  lockMobileE2eeChannelMode,
  markMobileE2eeKeyCustodyUnavailable,
  mobileE2eeLocalRecordContext,
  observeMobileE2eeStatement,
  raiseMobileE2eeUnexpectedNode,
  recordMobileE2eeInitiatorDiagnostic,
  resetMobileE2eeSession,
  getMobileE2eeSessionState,
  type MobileE2eeIdentityDisplay,
} from "./e2eeSession";
import { getMobileHostedConfig } from "./runtimeConfig";

// Where the native tier's §4.4 mode machine is actually WIRED to the relay —
// docs/relay-e2ee-protocol.md §4.4 (every selection guard resolved before the
// channel receives any payload), §12.1.1 (the classification), §13.1 (the pin and
// the release gate), §8.5 (the credentials the hello carries).
//
// THE TIMING IS THE WHOLE PROBLEM THIS MODULE SOLVES. `createRelaySocket` is
// synchronous — the shared transport calls it the instant a ticket resolves — and
// §4.4 requires the pin, the classification, the device marker and the owner's
// consent to be "evaluable before it has received any payload". Reading a
// keychain and a secure store is not synchronous, so the attempt is resolved
// AHEAD of the socket and read from a slot at socket construction.
//
// THE SLOT KEY IS THE SELECTION *AND* THE TRUST DOCUMENT'S REVISION. Keying it on
// the selection alone made the cache outlive the owner's decisions: §13.2 step 5's
// promotion, §13.3's re-pair and §12.1.1's consent all change exactly the inputs
// resolved here, and none of them changes the account or the node. Every channel
// after such a decision then evaluated §12.1's latch, §12.1.1's class and §13.1's
// pin against pre-decision state — a forgotten node still reporting a verified pin,
// a freshly verified one still reporting none. The revision is bumped by the store
// on every commit, so a committed decision invalidates this slot by construction.
//
// ONE SLOT PER ENVIRONMENT, NOT ONE FOR THE SELECTION. Several environments can
// hold live channels at once, and a channel may reconnect while another node is
// selected or while none is. Each environment therefore owns its own slot, keyed
// by the node, the environment and the lifecycle generation its channel belongs
// to. A caller that knows the channel's target passes it, and the attempt is then
// resolved for that target's node and fenced by that target's generation, never
// by whatever happens to be selected. Without a target the current selection is
// the target, which is all a single-session client ever passes.
//
// THREE OUTCOMES, AND ONLY ONE OF THEM IS LEGACY:
//
//   1. A resolved attempt for this selection → the §4.4 machine, which decides
//      `e2ee`, `legacy`, or FATAL-PRE from the rows and the classification.
//   2. Certificate or device-identity preparation fails — §6.3 admits no
//      fallback credential — → NO provider only for an explicitly
//      legacy-eligible selection. Issuance, renewal, or invalid-record repair may
//      transiently derive or generate the agreement public key and retains that
//      existing rule. A valid reusable certificate restores public-only; on that
//      common path the scalar is first borrowed at K1 after validated evidence,
//      so its failure is FATAL-PRE and can never create plaintext eligibility.
//   3. Anything else that is not ready — including an unreadable trust document —
//      → a channel that closes without releasing anything. NOT a legacy channel:
//      the classification is exactly what has not been read, and §12.1.1 admits
//      nothing into the legacy-eligible class on absence of evidence.

/** §8.2: this client's fixed local suite-preference order. One suite is defined. */
const LOCAL_SUITE_PREFERENCE: readonly number[] = [E2EE_SUITE_25519_CHACHAPOLY_SHA256];

/**
 * How many times one preparation re-reads the live selection before giving up.
 *
 * A pass that lands on a selection or a trust revision that has since moved
 * cannot assign its result — it would be an attempt about state that is no longer
 * current — so it starts over. The bound exists because the inputs it re-reads
 * are owner-driven and can in principle change faster than a keychain read: after
 * it, the slot is simply left empty and the next channel fails closed and
 * re-primes, which is the same answer one pass further on.
 */
const PREPARATION_MAX_PASSES = 4;

/**
 * The channel one attempt is resolved for, taken from the environment-bound
 * relay binding that will open it rather than from the selection.
 */
export interface MobileE2eeAttemptTarget {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly environmentId: EnvironmentId;
  /** The environment record's generation the channel belongs to. */
  readonly generation: number;
  /** Whether that record generation is still the environment's current one. */
  readonly isCurrent: () => boolean;
}

interface SelectionScope {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly nodeId: string;
  readonly environmentId: EnvironmentId | null;
}

interface CurrentSelection extends SelectionScope {
  readonly nodeLabel: string;
  /**
   * Which lifecycle `generation` counts: the shared selection's, or the
   * environment record's a target carries. The two counters are unrelated, so an
   * attempt resolved under one is never handed to a channel of the other.
   */
  readonly lifecycle: "selection" | "environment";
  readonly generation: number;
}

/**
 * Where one preparation or provider resolution reads the selection it acts for.
 *
 * `current` answers `null` when there is nothing to act for any more: signed
 * out, no node selected, or a target whose record generation was replaced.
 */
interface AttemptSource {
  readonly current: () => CurrentSelection | null;
  /** Only the selection itself owns the global "nothing selected" outcome. */
  readonly followsSelection: boolean;
}

interface AttemptSlot {
  readonly selection: SelectionScope;
  readonly lifecycle: CurrentSelection["lifecycle"];
  readonly generation: number;
  readonly trustRevision: number;
}

interface PreparedAttempt {
  readonly slot: AttemptSlot;
  readonly attempt: RelayE2eeInitiatorAttempt;
  /** Revoked when its environment's slot is replaced or disposed. */
  readonly lifetime: { active: boolean };
}

/** Every slot below is kept per environment: the selection's, or the target's. */
type EnvironmentKey = EnvironmentId | null;

const prepared = new Map<EnvironmentKey, PreparedAttempt>();

interface Preparation {
  /** The newest current request for this environment; every pass reads it. */
  source: AttemptSource;
  done: Promise<void>;
}

/**
 * The preparation running for each environment. Environments never wait for or
 * cancel each other; two requests for the same environment share one.
 */
const preparing = new Map<EnvironmentKey, Preparation>();
/**
 * The slot whose §6.3 key custody this device does not have, which is the ONLY
 * state that answers `undefined` — an unchanged legacy channel.
 *
 * It is keyed by slot rather than kept as a flag so that a custody failure for
 * one node cannot silently make a different node legacy too, and it is cleared on
 * every fresh preparation of its environment, so the answer is retried rather
 * than latched for the session.
 */
const custodyUnavailableFor = new Map<EnvironmentKey, AttemptSlot>();
/** A resolved strict failure whose owner-visible trust context survives retries. */
const strictUnavailableFor = new Map<EnvironmentKey, AttemptSlot>();
/**
 * Underlying authenticated trust mutations, keyed independently of cache
 * revision and lifecycle generation. A deadline closes only the channel that
 * was waiting; it never clears this fence or pretends the OS write was cancelled.
 */
type PendingCommitsByNode = Map<string, Promise<void>>;
type PendingCommitsByAccount = Map<string, PendingCommitsByNode>;
const pendingTrustCommits = new Map<string, PendingCommitsByAccount>();

function sameSelection(left: SelectionScope, right: SelectionScope): boolean {
  return (
    left.hubOrigin === right.hubOrigin &&
    left.accountId === right.accountId &&
    left.nodeId === right.nodeId &&
    left.environmentId === right.environmentId
  );
}

/** The selection, lifecycle owner, and trust document it was resolved against. */
function attemptSlot(selection: CurrentSelection): AttemptSlot {
  return {
    selection: {
      hubOrigin: selection.hubOrigin,
      accountId: selection.accountId,
      nodeId: selection.nodeId,
      environmentId: selection.environmentId,
    },
    lifecycle: selection.lifecycle,
    generation: selection.generation,
    trustRevision: mobileE2eeTrustStore.revision(),
  };
}

function sameAttemptSlot(left: AttemptSlot, right: AttemptSlot): boolean {
  return (
    sameSelection(left.selection, right.selection) &&
    left.lifecycle === right.lifecycle &&
    left.generation === right.generation &&
    left.trustRevision === right.trustRevision
  );
}

/** Whether `slot` still describes what `source` would resolve right now. */
function slotIsLive(source: AttemptSource, slot: AttemptSlot): boolean {
  const live = source.current();
  return live !== null && sameAttemptSlot(attemptSlot(live), slot);
}

function pendingTrustCommit(selection: SelectionScope): Promise<void> | undefined {
  return pendingTrustCommits
    .get(selection.hubOrigin)
    ?.get(selection.accountId)
    ?.get(selection.nodeId);
}

function setPendingTrustCommit(selection: SelectionScope, operation: Promise<void>): void {
  let byAccount = pendingTrustCommits.get(selection.hubOrigin);
  if (byAccount === undefined) {
    byAccount = new Map();
    pendingTrustCommits.set(selection.hubOrigin, byAccount);
  }
  let byNode = byAccount.get(selection.accountId);
  if (byNode === undefined) {
    byNode = new Map();
    byAccount.set(selection.accountId, byNode);
  }
  byNode.set(selection.nodeId, operation);
}

function clearPendingTrustCommit(selection: SelectionScope, operation: Promise<void>): void {
  const byAccount = pendingTrustCommits.get(selection.hubOrigin);
  const byNode = byAccount?.get(selection.accountId);
  if (byNode?.get(selection.nodeId) !== operation) return;
  byNode.delete(selection.nodeId);
  // A late settlement may run after another operation rebuilt either branch.
  // Prune only the exact child maps captured above, never a replacement.
  if (byNode.size === 0 && byAccount?.get(selection.accountId) === byNode) {
    byAccount.delete(selection.accountId);
  }
  if (byAccount?.size === 0 && pendingTrustCommits.get(selection.hubOrigin) === byAccount) {
    pendingTrustCommits.delete(selection.hubOrigin);
  }
}

/** The signed-in Hub account, or `null`. */
function currentAccount(): { readonly hubOrigin: string; readonly accountId: string } | null {
  const config = getMobileHostedConfig();
  if (config === null) return null;
  const state = hostedHubStore.getState();
  if (state.accountStatus !== "authenticated" || state.account === null) return null;
  return { hubOrigin: config.hubOrigin, accountId: state.account.id };
}

/** The hosted selection a channel would be opened for, or `null`. */
function currentSelection(): CurrentSelection | null {
  const account = currentAccount();
  if (account === null) return null;
  const state = hostedHubStore.getState();
  const node = state.selectedNode;
  if (node === null) return null;
  return {
    ...account,
    nodeId: node.id,
    nodeLabel: node.label,
    environmentId: node.environmentId,
    lifecycle: "selection",
    generation: state.generation,
  };
}

/**
 * The signed-in account's view of `target`, or `null` once the target's record
 * generation was replaced. The node and the environment are the target's own,
 * whatever is selected — including nothing.
 */
function selectionForTarget(target: MobileE2eeAttemptTarget): CurrentSelection | null {
  const account = currentAccount();
  if (account === null || !target.isCurrent()) return null;
  return {
    ...account,
    nodeId: target.nodeId,
    nodeLabel: target.nodeLabel,
    environmentId: target.environmentId,
    lifecycle: "environment",
    generation: target.generation,
  };
}

const selectedSource: AttemptSource = { current: currentSelection, followsSelection: true };

function attemptSource(target: MobileE2eeAttemptTarget | undefined): AttemptSource {
  if (target === undefined) return selectedSource;
  return { current: () => selectionForTarget(target), followsSelection: false };
}

/**
 * Whether a channel resolved for `selection` may still act for it: the same
 * account, node and environment, under the same lifecycle generation.
 */
function owns(source: AttemptSource, selection: CurrentSelection): boolean {
  const live = source.current();
  return (
    live !== null &&
    live.lifecycle === selection.lifecycle &&
    live.generation === selection.generation &&
    sameSelection(live, selection)
  );
}

/** §12.1.1's coarse class, which is all the §4.4 machine consumes. */
function selectionClassOf(classification: E2eeTrustClassification): RelayE2eeSelectionClass {
  return classification.class;
}

/**
 * §13.2.1 situation 2's other half: the §13.4 pair for the identity the presented
 * one is being COMPARED AGAINST.
 *
 * It is the pin this selection resolves to, and where the selection resolves to
 * none it is the account's single verified pin — which is the only case in which
 * "the previously verified fingerprint" names one identity. An account holding
 * several is deliberately shown NOTHING rather than an arbitrary sibling: §13.2.1
 * asks the owner to compare two values that are supposed to match, and a
 * mismatch against a node that was never the subject carries no information and
 * trains exactly the click-through the surface exists to prevent.
 *
 * It is recomputed here from the stored public key rather than read from a
 * stored display value, so §13.4's "only the pending-record copy of §13.2 is
 * persisted" stays true of this client. `null` whenever the account holds no
 * verified pin, which is every situation except 2 — and §13.2.1 forbids showing
 * one in situation 3.
 */
function previouslyVerifiedDisplay(
  selection: CurrentSelection,
  resolved: E2eeVerifiedPinRecord | null,
  clientIdentityPublicKey: Uint8Array,
): MobileE2eeIdentityDisplay | null {
  const underAccount = mobileE2eeTrustStore.verifiedRecordsForAccount(
    selection.hubOrigin,
    selection.accountId,
  );
  const record = resolved ?? (underAccount.length === 1 ? (underAccount[0] ?? null) : null);
  if (record === null) return null;
  try {
    return deriveMobileE2eeIdentityDisplay({
      nodeIdentityPublicKey: record.verifiedIdentityPublicKey,
      clientIdentityPublicKey,
      hubOrigin: selection.hubOrigin,
      accountId: selection.accountId,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve everything one channel attempt needs, for `target` — or, without one,
 * for the CURRENT selection.
 *
 * Idempotent per slot and serialized per environment: two callers racing at
 * launch resolve once, and preparations for different environments never wait
 * for or supersede each other. A failure leaves the slot empty rather than
 * half-filled, so the next channel either gets a complete attempt, gets no
 * provider at all (§6.3), or fails closed.
 */
export function prepareMobileRelayE2eeAttempt(target?: MobileE2eeAttemptTarget): Promise<void> {
  const source = attemptSource(target);
  const selection = source.current();
  if (selection === null) {
    // Nothing to act for: a superseded target simply has nothing to prepare,
    // and only the selection itself may clear what "nothing selected" clears.
    if (source.followsSelection) releaseForNoSelection();
    return Promise.resolve();
  }
  const key = selection.environmentId;
  const running = preparing.get(key);
  if (running !== undefined) {
    running.source = source;
    return running.done;
  }
  // Registered BEFORE it runs. A preparation that settled without suspending
  // and was only then assigned into the map would leave a settled entry behind,
  // every later call would join it, and the attempt would never be re-resolved
  // again.
  const preparation: Preparation = { source, done: Promise.resolve() };
  preparing.set(key, preparation);
  preparation.done = runPreparation(key, preparation);
  return preparation.done;
}

/**
 * The global outcome of "no hosted node is selected": every warm attempt is
 * revoked and every projection cleared.
 *
 * Only a client with one environment session at a time takes it. With retained
 * environment sessions an empty selection is just the home screen, and the
 * environments still connected keep their own attempts and projections.
 */
function releaseForNoSelection(): void {
  if (hostedEnvironmentSessionsMode() !== "single") return;
  disposeMobileRelayE2eeAttempt();
  custodyUnavailableFor.clear();
  strictUnavailableFor.clear();
  resetMobileE2eeSession();
}

/**
 * Passes, not one shot.
 *
 * Requests for the same environment de-duplicate by "a preparation is running",
 * so a change that arrives while one is in flight joins it rather than
 * scheduling its own. Each pass therefore re-reads the newest request after its
 * awaits and starts over when it moved, instead of settling an attempt for the
 * node the owner just left — which is deterministic, not a race: switching
 * nodes inside one preparation window always produced it.
 */
async function runPreparation(key: EnvironmentKey, preparation: Preparation): Promise<void> {
  try {
    for (let pass = 0; pass < PREPARATION_MAX_PASSES; pass += 1) {
      const source = preparation.source;
      // A request that joined while this pass ran gets a pass of its own.
      if ((await runPreparationPass(key, source)) && preparation.source === source) return;
    }
  } finally {
    if (preparing.get(key) === preparation) preparing.delete(key);
  }
}

/** One pass. `true` when the environment's slot now describes the live request. */
async function runPreparationPass(key: EnvironmentKey, source: AttemptSource): Promise<boolean> {
  const selection = source.current();
  if (selection === null) {
    if (source.followsSelection) releaseForNoSelection();
    return true;
  }
  // The selection moved to another environment, whose own preparation resolves
  // it; this one has nothing left to settle.
  if (selection.environmentId !== key) return true;
  // A previous channel authenticated a durable trust advance for this same
  // selection. Until the underlying OS-backed write settles, no attempt may
  // classify the old generation or borrow the old pin. Keep the complete cached
  // attempt intact for the callback that still owns the channel, but mark this
  // preparation complete and let provider resolution close new channels.
  if (pendingTrustCommit(selection) !== undefined) return true;
  const slot = attemptSlot(selection);
  const held = prepared.get(key);
  if (held !== undefined && sameAttemptSlot(held.slot, slot)) return true;
  const custodyClaim = custodyUnavailableFor.get(key);
  const strictClaim = strictUnavailableFor.get(key);
  const retainsCurrentFailureClaim =
    (custodyClaim !== undefined && sameAttemptSlot(custodyClaim, slot)) ||
    (strictClaim !== undefined && sameAttemptSlot(strictClaim, slot));
  disposePreparedAttempt(key);
  // The old projection belongs to the disposed slot just as surely as its
  // lifetime token does. Clear it before any awaited guard or credential operation so
  // a failure for the new selection cannot leave the previous channel's
  // `verified` or `legacy` claim visible beside a channel that failed closed.
  // A successful pass publishes the complete replacement below; a permitted
  // no-custody legacy result publishes its bounded legacy claim explicitly.
  // A same-slot retry after either resolved failure keeps that bounded claim
  // while the key stores are retried. Clearing it here would let
  // `resolveMobileRelayE2eeProvider` erase the legacy label or unexpected-node
  // ceremony merely by scheduling the retry it promises to perform.
  if (!retainsCurrentFailureClaim) resetMobileE2eeSession(selection.environmentId);
  custodyUnavailableFor.delete(key);
  strictUnavailableFor.delete(key);

  // §4.4: the client-anchored guards are resolved HERE, before any channel
  // exists and BEFORE any custody call, and `classify` runs §13.1's marker
  // reconciliation first. A store that cannot answer them throws, and that is
  // NOT the §6.3 no-custody outcome: §4.4 forbids treating unobtainable evidence
  // as an unset latch or an unset marker, so the slot is left empty and the
  // channel fails closed.
  let guards: ResolvedGuards;
  try {
    guards = await resolveGuards(selection);
  } catch {
    // A moved selection needs another pass. A current selection whose guards
    // are unobtainable is already a complete fail-closed result; retry it on
    // the next channel, not four times inside this preparation.
    return slotIsLive(source, slot);
  }

  // §7.4 / §6.4 and §6.3's key custody. A failure here is outcome 2 — but only
  // where §12.1.1 classified this exact selection as legacy-eligible and local
  // policy still permits a legacy channel. `unexpected`, `latched`, and
  // unobtainable evidence are all strict local classes: no credential failure
  // may convert any of them into plaintext eligibility.
  let credentials: ResolvedCredentials;
  try {
    credentials = await resolveCredentials(selection);
  } catch {
    if (!slotIsLive(source, slot)) return false;
    // §6.3: no software fallback and no degraded mode. The device has no E2EE
    // for this selection; the channel runs legacy and every surface says legacy
    // only for the exact legacy-eligible/permitted conjunction. A local failure
    // cannot talk an unexpected, latched, or policy-forbidden selection out of
    // its fail-closed result.
    if (guards.classification.class !== "legacy-eligible" || !guards.legacyPermitted) {
      strictUnavailableFor.set(key, slot);
      beginMobileE2eeFailClosedSelection({
        selection: {
          hubOrigin: selection.hubOrigin,
          accountId: selection.accountId,
          nodeId: selection.nodeId,
          nodeLabel: selection.nodeLabel,
          environmentId: selection.environmentId,
          ...mobileE2eeLocalRecordContext(guards.record),
        },
        classification: guards.classification,
        legacyPermitted: guards.legacyPermitted,
        markerSet: guards.markerSet,
        pinVerified: guards.verified !== null,
      });
      // This keyed strict result is complete. The unresolved provider retries
      // once for the next channel; the preparation loop must not hammer secure
      // storage four times for the same persistent failure.
      return true;
    }
    custodyUnavailableFor.set(key, slot);
    markMobileE2eeKeyCustodyUnavailable(selection.environmentId);
    return true;
  }

  // The selection, the account, or the trust document may all have moved while
  // credential state was prepared. A reusable certificate stays public-only;
  // issuance or renewal may transiently derive the agreement public key. An
  // attempt describes the state it was resolved from, so one that no longer
  // matches is dropped rather than assigned.
  if (!slotIsLive(source, slot)) return false;

  const record = guards.record;
  const verified = guards.verified;
  beginMobileE2eeChannel({
    selection: {
      hubOrigin: selection.hubOrigin,
      accountId: selection.accountId,
      nodeId: selection.nodeId,
      nodeLabel: selection.nodeLabel,
      environmentId: selection.environmentId,
      ...mobileE2eeLocalRecordContext(record),
      clientIdentityPublicKey: credentials.clientIdentityPublicKey,
    },
    classification: guards.classification,
    legacyPermitted: guards.legacyPermitted,
    markerSet: guards.markerSet,
    // §13.1: the release gate's own input, published with the guards it was
    // resolved beside rather than carried into the lock by a closure the suite
    // cannot see — `e2ee` alone is not §2.2's bottom row, and the pin decides.
    pinVerified: verified !== null,
    previouslyVerified: previouslyVerifiedDisplay(
      selection,
      verified,
      credentials.clientIdentityPublicKey,
    ),
  });

  const lifetime = { active: true };
  // The slot revision may advance once because this channel authenticated and
  // durably recorded its own statement. Track that exact advance separately
  // from the immutable preparation slot so unrelated trust mutations still
  // revoke a late scalar borrow even in runtimes without the selection watcher.
  let acceptedTrustRevision = slot.trustRevision;
  const attempt: RelayE2eeInitiatorAttempt = {
    hubOrigin: selection.hubOrigin,
    selectionClass: selectionClassOf(guards.classification),
    legacyPermitted: guards.legacyPermitted,
    // §13.2 step 2's flag, which closes BOTH valves: a ceremony channel flushes
    // no buffered application send and locks no mode at all, whatever the node
    // answers. §13.1's release gate is the other valve and is not this flag —
    // the initiator refuses the `e2ee` lock to any native attempt that resolved
    // to no verified pin, so genuine first contact is still free to fall back to
    // legacy under §12.1.1 branch (a) while releasing nothing over E2EE.
    pairingOnly: isE2eePairingRecord(record),
    localSuitePreference: LOCAL_SUITE_PREFERENCE,
    credentials: {
      tier: "native",
      accountId: selection.accountId,
      identityPublicKey: credentials.certificate.identityPublicKey,
      agreementPublicKey: credentials.certificate.agreementPublicKey,
      prekeyTranscript: credentials.certificate.transcript,
      prekeySignature: credentials.certificate.signature,
    },
    // K1 is the first point that needs the Noise `s`. Keep the warm reconnect
    // slot public-only and borrow the scalar for the one synchronous hello
    // construction/send operation after the carrier and durable trust commit.
    withNativeAgreementSecretKey: (use) =>
      mobileE2eeAgreementKey.withSecretKey((secretKey) => {
        // `lifetime` is the trust-revision fence. The authenticated statement
        // this channel just persisted advances the revision too, but its pending
        // commit deliberately keeps this lifetime alive so K1 can finish. Any
        // external trust mutation re-prepares the slot and revokes it here.
        if (
          !lifetime.active ||
          !owns(source, selection) ||
          mobileE2eeTrustStore.revision() !== acceptedTrustRevision
        ) {
          throw new Error("Mobile E2EE selection was superseded.");
        }
        return use(secretKey);
      }),
    // §8.3 elements 9 and 17 come from the RESOLVED VERIFIED PIN, never from
    // a statement: "a key merely carried by a self-signed first-contact
    // statement is not a trust anchor". An `unverified` record anchors
    // nothing and is deliberately not passed.
    ...(verified === null
      ? {}
      : {
          verifiedPin: {
            // §7.1 fingerprint BYTES, recomputed from the pinned key rather
            // than parsed back out of its display form.
            identityFingerprint: e2eeKeyFingerprint(
              "node-identity",
              verified.verifiedIdentityPublicKey,
            ),
            continuityId: verified.recordedContinuityId,
          },
          acceptedPolicyGeneration: verified.acceptedPolicyGeneration,
        }),
    accountId: selection.accountId,
    onStatement: async (verification) => {
      if (!owns(source, selection)) throw new Error("Mobile E2EE selection was superseded.");
      const trustRevisionBeforeStatement = mobileE2eeTrustStore.revision();
      if (trustRevisionBeforeStatement !== acceptedTrustRevision) {
        throw new Error("Mobile E2EE selection was superseded.");
      }
      // Establish the per-selection fence before publishing to session
      // listeners. A listener may synchronously open another channel; it must
      // observe the pending mutation and fail closed, never borrow stale trust.
      const persistence = recordAuthenticatedStatement(
        selection,
        record?.index.localNodeHandle ?? null,
        verification,
      );
      observeMobileE2eeStatement(verification, selection.environmentId);
      if (
        selection.environmentId !== null &&
        getMobileE2eeSessionState(selection.environmentId).event?.kind === "identity-change"
      ) {
        // The retained snapshot remains available only through the locked-stale
        // workspace projection. Close exactly this environment immediately so
        // no mutation can survive a native identity conflict.
        try {
          await getMobileHostedConnectionCoordinator().releaseEnvironment(selection.environmentId);
        } catch {
          // Cold unit/runtime setup can observe the security projection before
          // the connection coordinator exists. The channel is already fatal;
          // the workspace trust gate remains locked fail-closed.
        }
      }
      await persistence;
      // The authenticated old selection may still tighten its own durable
      // record after a deadline or navigation. It cannot resume or project into
      // a lifecycle generation that did not own this callback.
      if (!lifetime.active || !owns(source, selection)) {
        throw new Error("Mobile E2EE selection was superseded.");
      }
      acceptedTrustRevision = mobileE2eeTrustStore.revision();
    },
    onUnexpectedNode: (evidence) =>
      raiseMobileE2eeUnexpectedNode(evidence, selection.environmentId),
    onDiagnostic: (diagnostic) =>
      recordMobileE2eeInitiatorDiagnostic(diagnostic, selection.environmentId),
  };
  prepared.set(key, {
    slot,
    attempt,
    lifetime,
  });
  return true;
}

/** §12.1.1's class, §13.1's pin and marker, and §12.1.1's strict-legacy policy. */
interface ResolvedGuards {
  readonly classification: E2eeTrustClassification;
  readonly record: ReturnType<typeof mobileE2eeTrustStore.resolve>;
  readonly verified: E2eeVerifiedPinRecord | null;
  readonly markerSet: boolean | null;
  readonly legacyPermitted: boolean;
}

async function resolveGuards(selection: CurrentSelection): Promise<ResolvedGuards> {
  const trustSelection = {
    kind: "node-id-hint",
    hubOrigin: selection.hubOrigin,
    accountId: selection.accountId,
    nodeId: selection.nodeId,
  } as const;
  const classification = await mobileE2eeTrustStore.classify(trustSelection);
  const record = mobileE2eeTrustStore.resolve(trustSelection);
  const marker = mobileE2eeTrustStore.marker(selection.hubOrigin);
  return {
    classification,
    record,
    verified: record !== null && isE2eeVerifiedPinRecord(record) ? record : null,
    markerSet: marker.kind === "unobtainable" ? null : marker.kind === "set",
    legacyPermitted:
      mobileE2eeTrustStore.strictLegacyPolicy(selection.hubOrigin).kind === "permitted",
  };
}

interface ResolvedCredentials {
  readonly certificate: Awaited<ReturnType<typeof mobileClientE2eePrekey.ensure>>;
  readonly clientIdentityPublicKey: Uint8Array;
}

async function resolveCredentials(selection: CurrentSelection): Promise<ResolvedCredentials> {
  const certificate = await mobileClientE2eePrekey.ensure({
    hubOrigin: selection.hubOrigin,
    accountId: selection.accountId,
  });
  const clientIdentityPublicKey = await getMobileDeviceIdentityPublicKey();
  return { certificate, clientIdentityPublicKey };
}

/**
 * §12.1's latch and §13.3's silent pin update, applied to durable state.
 *
 * Only the two anchors that AUTHENTICATED to the pin have a mutator to reach:
 * §13.3's chain failure updates no pin, and §5.7's policy-generation regression
 * is a local diagnostic that "MUST NOT by itself launch the §13.2 ceremony or the
 * §13.3 re-verification UI". `resolveE2eeTrustStatementOutcome` is what separates
 * them, and this call site can express nothing else.
 */
async function recordAuthenticatedStatement(
  selection: CurrentSelection,
  localNodeHandle: string | null,
  verification: Parameters<typeof observeMobileE2eeStatement>[0],
): Promise<void> {
  if (localNodeHandle === null) return;
  if (verification.kind !== "verified") return;
  if (verification.anchor === "none") return;
  if (pendingTrustCommit(selection) !== undefined) {
    throw new Error("Mobile E2EE trust commit is already pending.");
  }
  const operation = mobileE2eeTrustStore.recordAuthenticatedStatement({
    index: {
      hubOrigin: selection.hubOrigin,
      accountId: selection.accountId,
      localNodeHandle,
    },
    anchor: verification.anchor,
    identityFingerprint: formatStatementFingerprint(verification.statement.identityPublicKey),
    identityPublicKey: verification.statement.identityPublicKey,
    policyGeneration: verification.statement.policyGeneration,
    observedAt: Date.now(),
  });
  setPendingTrustCommit(selection, operation);
  const clear = (): void => {
    clearPendingTrustCommit(selection, operation);
  };
  // Attach both arms immediately. A channel deadline does not cancel the store
  // promise, and a late rejection must remain handled even if its initiator has
  // already closed and released its own wait.
  void operation.then(clear, clear);
  await operation;
}

/** §7.1's display form of one node identity key. No namespace is involved. */
function formatStatementFingerprint(identityPublicKey: Uint8Array): string {
  return formatE2eeKeyFingerprint(e2eeKeyFingerprint("node-identity", identityPublicKey));
}

function disposePreparedAttempt(key: EnvironmentKey): void {
  const held = prepared.get(key);
  if (held === undefined) return;
  held.lifetime.active = false;
  prepared.delete(key);
}

/**
 * Revoke and drop every environment's public-only warm attempt: sign-out,
 * enrollment revocation, nothing selected. Idempotent.
 */
export function disposeMobileRelayE2eeAttempt(): void {
  for (const key of prepared.keys()) disposePreparedAttempt(key);
}

/**
 * Revoke and drop one environment's warm attempt, leaving every other
 * environment's attempt usable. Idempotent.
 */
export function disposeMobileRelayE2eeAttemptFor(environmentId: EnvironmentId): void {
  disposePreparedAttempt(environmentId);
}

/**
 * A channel that closes without releasing anything and without a record (§11.2:
 * "a client executing FATAL-PRE sends nothing and closes").
 *
 * This is what an unresolved attempt gets. It is deliberately NOT a legacy
 * channel: the thing that has not been read IS the classification, and §12.1.1
 * admits nothing into the legacy-eligible class on absent evidence.
 *
 * The close is the RETRYABLE one. On the wire it is §11.5's uniform observable,
 * identical to every other pre-key close; locally it must not be the
 * non-retryable disposition an actual cryptographic failure carries, because
 * that drives the transport to `terminal-failure` and stops reconnection
 * altogether — a warm-up race would take the whole hosted session down instead
 * of costing one channel.
 */
function unresolvedAttemptChannel(host: RelayE2eeHost): RelayE2eeChannel {
  host.close(relayE2eeUnresolvedAttemptFailure());
  return {
    intercept: async () => ({ kind: "rejected" }),
    submit: () => false,
    beginClose: async () => "refused",
    dispose: () => undefined,
  };
}

/**
 * The `RelayE2eeProvider` the hosted socket is built with, resolved
 * synchronously at `createRelaySocket` — for `target`, or without one for the
 * current selection.
 *
 * `undefined` means outcome 2 above and nothing else: this device could not
 * prepare the public certificate/identity state for a selection §12.1.1 still
 * permits legacy for, so the engine runs the unchanged legacy channel. A late
 * agreement-scalar failure is already past validated evidence and closes inside
 * the initiator. Every other unresolved state — including no selection and a
 * superseded target — closes.
 */
export function resolveMobileRelayE2eeProvider(
  target?: MobileE2eeAttemptTarget,
): RelayE2eeProvider | undefined {
  const selection = attemptSource(target).current();
  // Nothing to secure and nothing to classify. The store can move between the
  // transport's reconnect gate and this synchronous construction — a sign-out or
  // a Hub-profile change during backoff, or a record generation the target no
  // longer owns — so this is unresolved evidence like any other, never a
  // plaintext channel nobody decided on.
  if (selection === null) return unresolvedAttemptChannel;
  if (pendingTrustCommit(selection) !== undefined) return unresolvedAttemptChannel;
  const key = selection.environmentId;
  const slot = attemptSlot(selection);
  // §6.3's one legacy answer, and the only `undefined` this function returns —
  // and only for THIS environment's own custody slot. The preparation is
  // re-primed either way, so the answer is retried on the next channel rather
  // than latched for the session.
  const custodyClaim = custodyUnavailableFor.get(key);
  if (custodyClaim !== undefined && sameAttemptSlot(custodyClaim, slot)) {
    void prepareMobileRelayE2eeAttempt(target);
    return undefined;
  }
  const held = prepared.get(key);
  if (held === undefined || !sameAttemptSlot(held.slot, slot)) {
    // Not ready, or resolved against a selection or a trust document that has
    // since moved. Re-prime for the next attempt and fail this one closed.
    void prepareMobileRelayE2eeAttempt(target);
    return unresolvedAttemptChannel;
  }
  const provider = makeMobileRelayE2eeProvider({ attempt: held.attempt });
  const environmentId = held.slot.selection.environmentId;
  return (host) => {
    // §13's projection is PER CHANNEL, not per preparation: a claim earned by one
    // channel may not describe the next one. Publishing `negotiating` here is
    // what keeps a verified label from surviving the socket that earned it, and
    // naming the channel is what keeps a replaced one from claiming anything in
    // the entry afterwards.
    const channel = {};
    beginMobileE2eeChannelAttempt(environmentId, channel);
    const machine = provider(host);
    // §4.4's mode lock has no callback — it is a state the machine holds — so
    // the pill is synced after every operation that can cause one. Publishing is
    // idempotent, and a mode that never locks (an abort, a FATAL-PRE) leaves the
    // store holding `negotiating`, which claims nothing.
    const sync = () => {
      const mode = machine.mode();
      if (mode === "e2ee" || mode === "legacy") {
        lockMobileE2eeChannelMode(mode, environmentId, channel);
      }
    };
    return {
      ...machine,
      intercept: async (payload) => {
        const disposition = await machine.intercept(payload);
        sync();
        return disposition;
      },
      submit: (message) => {
        const submitted = machine.submit(message);
        sync();
        return submitted;
      },
      dispose: (options) => {
        endMobileE2eeChannel(environmentId, channel);
        machine.dispose(options);
      },
    };
  };
}

/**
 * The resolved attempt, for the suite that asserts what it carries.
 *
 * Every field below is a §4.4 guard, a §13.1 anchor, or §13.2's release flag, and
 * none of them is observable through the provider the engine receives — which is
 * how five separate mutations of them once survived the whole suite. It is a
 * BOUNDED PROJECTION rather than the attempt: no credential, no scalar, no
 * transcript and no signature is exposed, and the pin is reported as presence
 * plus its §7.1 display form, never as key material.
 */
export function inspectMobileRelayE2eeAttemptForTests(
  /** Defaults to the selected node's environment. */
  environmentId?: EnvironmentId,
): {
  readonly selectionClass: RelayE2eeSelectionClass;
  readonly legacyPermitted: boolean;
  readonly pairingOnly: boolean;
  readonly verifiedPinFingerprint: string | null;
  readonly acceptedPolicyGeneration: number | undefined;
} | null {
  const key = environmentId ?? currentSelection()?.environmentId;
  const held = key === undefined ? undefined : prepared.get(key);
  if (held === undefined) return null;
  const pin = held.attempt.verifiedPin;
  return {
    selectionClass: held.attempt.selectionClass,
    legacyPermitted: held.attempt.legacyPermitted,
    pairingOnly: held.attempt.pairingOnly,
    verifiedPinFingerprint:
      pin === undefined ? null : formatE2eeKeyFingerprint(pin.identityFingerprint),
    acceptedPolicyGeneration: held.attempt.acceptedPolicyGeneration,
  };
}

/** Test seam: exercise the production disposal path, then clear other module state. */
export function resetMobileRelayE2eeAttemptForTests(): void {
  disposeMobileRelayE2eeAttempt();
  preparing.clear();
  custodyUnavailableFor.clear();
  strictUnavailableFor.clear();
  pendingTrustCommits.clear();
}
