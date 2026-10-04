import { basename, dirname, join } from "node:path";

import { Context, Effect, Layer } from "effect";

import type { RelayNodeAuthHandshake } from "@ryco/contracts/relay";
import { canonicalizeHubOrigin, formatNodePublicKeyFingerprint } from "@ryco/shared/nodeIdentity";
import type { NodeIdentityContinuityChainEntry } from "@ryco/shared/relayE2eeTranscripts";

import { ServerConfig } from "../config.ts";
import {
  makeHubEnrollmentClient,
  type HubEnrollmentMetadata,
  type HubEnrollmentPollResponse,
  type StartedHubEnrollment,
} from "../hubIdentity/HubEnrollmentClient.ts";
import { makeHubEnrollmentHttpTransport } from "../hubIdentity/HubEnrollmentHttpTransport.ts";
import {
  type HubKeyRotationContinuity,
  type HubKeyRotationPromotion,
  makeHubKeyRotationClient,
  type HubKeyRotationStatus,
} from "../hubIdentity/HubKeyRotationClient.ts";
import { makeHubKeyRotationHttpTransport } from "../hubIdentity/HubKeyRotationHttpTransport.ts";
import {
  HubNodeProofClientError,
  type HubNodeProofFailure,
  makeHubNodeChallengeHttpTransport,
  makeHubNodeProofClient,
} from "../hubIdentity/HubNodeProofClient.ts";
import {
  type HubProtectedStoreBackend,
  type LocalHubIdentityState,
  makeLocalHubIdentityStateStore,
  type NodeRotationContinuityMode,
} from "../hubIdentity/LocalHubIdentityState.ts";
import { makeNodeAgreementIdentity } from "../hubIdentity/NodeAgreementIdentity.ts";
import { makeNodeContinuityAnchor } from "../hubIdentity/NodeContinuityAnchor.ts";
import {
  makeNodeClientAuthorizationClient,
  type NodeClientAuthorizationClient,
} from "../hubIdentity/NodeClientAuthorizationClient.ts";
import { makeNodeClientAuthorizationStore } from "../hubIdentity/NodeClientAuthorizationStore.ts";
import {
  makeNodeCrossDeviceApprovalService,
  type NodeCrossDeviceApprovalService,
} from "../hubIdentity/NodeCrossDeviceApprovalService.ts";
import { makeNodeLocalIntroductionLedger } from "../hubIdentity/NodeLocalIntroductionLedger.ts";
import {
  makeNodeLocalIntroductionService,
  type NodeLocalIntroductionService,
} from "../hubIdentity/NodeLocalIntroductionService.ts";
import {
  makeNodeNativeClaimService,
  type NodeNativeClaimService,
} from "../hubIdentity/NodeNativeClaimService.ts";
import type { NodeE2eeChannelAuthorization } from "./NodeE2eeChannelSession.ts";
import {
  makeNodeE2eeCapabilityStatementClient,
  type NodeE2eeAdvertisementResult,
} from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import {
  type E2eeFallbackReason,
  makeNodeE2eeFallbackCounter,
  type NodeE2eeFallbackState,
} from "../hubIdentity/NodeE2eeFallbackCounter.ts";
import {
  makeNodeE2eePolicyClient,
  type NodeE2eeChannelRegistration,
  type NodeE2eePolicyChangeResult,
  type NodeE2eePolicyPreview,
} from "../hubIdentity/NodeE2eePolicyClient.ts";
import {
  type EffectiveNodeE2eePolicy,
  makeNodeE2eePolicyStore,
  type NodeE2eePolicyProposal,
} from "../hubIdentity/NodeE2eePolicyStore.ts";
import {
  makeNodeE2eePrekeyClient,
  type NodeE2eePrekeyCertificate,
} from "../hubIdentity/NodeE2eePrekeyClient.ts";
import { makeNodeE2eePrekeyStore } from "../hubIdentity/NodeE2eePrekeyStore.ts";
import {
  makeNodeIdentityContinuityStore,
  newestRetainedContinuityCertificate,
  type NodeIdentityContinuityBreak,
  type NodeIdentityContinuityChainBreak,
  nodeIdentityContinuityChainStatus,
  NodeIdentityContinuityError,
  type NodeIdentityContinuityRepair,
  type NodeIdentityContinuityUnresolvable,
} from "../hubIdentity/NodeIdentityContinuityStore.ts";
import { makeNodeIdentityKeyRetirementStore } from "../hubIdentity/NodeIdentityKeyRetirementStore.ts";
import { makeNodeSigningIdentity } from "../hubIdentity/NodeSigningIdentity.ts";
import {
  makeOsProtectedSecretStore,
  NODE_IDENTITY_SECRET_SERVICE,
  makePermissionedFileSecretStore,
  type ProtectedSecretStore,
  type ProtectedSecretStoreBackend,
  ProtectedSecretStoreError,
} from "../hubIdentity/ProtectedSecretStore.ts";

export type HubIdentityRuntimeErrorCode =
  | "identity_unavailable"
  | "identity_store_unavailable"
  | "enrollment_failed"
  | "node_proof_failed"
  | "rotation_failed";

export class HubIdentityRuntimeError extends Error {
  readonly code: HubIdentityRuntimeErrorCode;

  constructor(code: HubIdentityRuntimeErrorCode) {
    super("Hub identity operation failed.");
    this.name = "HubIdentityRuntimeError";
    this.code = code;
  }
}

export type HubRelayAuthenticationFailure = HubNodeProofFailure;

export class HubRelayAuthenticationError extends Error {
  readonly failure: HubRelayAuthenticationFailure;

  constructor(failure: HubRelayAuthenticationFailure) {
    super("Hub relay authentication preparation failed.");
    this.name = "HubRelayAuthenticationError";
    this.failure = failure;
  }
}

/**
 * A pending ceremony, re-readable after the start response has been lost.
 *
 * The fingerprint is recomputed from the protected key rather than persisted, so
 * a tampered state file cannot display a fingerprint that differs from the key
 * that will actually sign the authentication transcript.
 */
export interface PendingHubEnrollmentDetail {
  readonly deviceCode: string | null;
  readonly label: string | null;
  readonly fingerprint: Uint8Array;
  readonly algorithm: "ed25519";
  readonly expiresAt: number | null;
  readonly pollIntervalMs: number | null;
}

/**
 * What this node may carry as §7.6 elements 11 and 18 right now.
 *
 * `unavailable` is §5.5 U2 `statement-unavailable`: the node holds no conforming
 * statement because it cannot say which lineage it belongs to, so it declines to
 * advertise rather than assert a fresh one. It is deliberately not an error at
 * this boundary — under effective `requireE2EE` the caller turns it into a
 * FATAL-PRE channel disposition (§11.2 P23), and otherwise it suppresses the
 * advertisement (row N16) — and those are policy decisions, not custody ones.
 */
export type NodeE2eeContinuityStatus =
  | {
      readonly status: "advertisable";
      /** §7.6 element 18. */
      readonly continuityId: string;
      /** §7.6 element 11, in carried order. Empty for a node that has never rotated. */
      readonly chain: readonly NodeIdentityContinuityChainEntry[];
      /** The highest rotation generation this node has issued (§7.5). */
      readonly generation: number;
      /** Set when the startup cross-check repaired the stored continuity id (§7.5, §17.11). */
      readonly repair: NodeIdentityContinuityRepair | null;
      /** Set when this pass found and recorded a chain break. */
      readonly chainBreak: NodeIdentityContinuityChainBreak | null;
      readonly lastBreak: NodeIdentityContinuityBreak | null;
    }
  | {
      readonly status: "unavailable";
      readonly reason: NodeIdentityContinuityUnresolvable;
      readonly remedy: string;
    };

/**
 * The §13.6 owner commands, kept apart from the relay path's narrow read seam.
 *
 * `NodeE2eeChannelAuthorization` is what a channel may reach; this is what an
 * OWNER-AUTHENTICATED operator surface may reach. They are two names for
 * disjoint halves of one client on purpose: a relay path that could reach these
 * is one that could mutate authority from peer input.
 */
export type NodeE2eeAuthorizationAdmin = Pick<
  NodeClientAuthorizationClient,
  | "list"
  | "get"
  | "approve"
  | "narrow"
  | "revoke"
  | "purge"
  | "setDisplayLabel"
  | "openPairingWindow"
  | "closePairingWindow"
  | "clearRefusedPairingAttempts"
  | "sweepExpired"
>;

export interface HubIdentityRuntimeShape {
  readonly backend: ProtectedSecretStoreBackend;
  /**
   * Run the startup work a runtime built with `deferStartup` has not run yet;
   * see that option. Idempotent once it succeeds, and retried by the next call
   * when it fails. Absent, or resolved at once, for a runtime that ran it while
   * it was built.
   */
  readonly completeStartup?: () => Promise<void>;
  readonly readState: () => Promise<LocalHubIdentityState>;
  /** The active public-key fingerprint only; no raw key or custody metadata. */
  readonly readActiveFingerprint?: () => Promise<string | null>;
  /**
   * Erase this node's Hub identity and mint a fresh `EnvironmentId`.
   *
   * Idempotent and resumable: a crash mid-teardown leaves a durable marker that
   * the next start completes.
   *
   * **This deliberately breaks the §7.5 continuity chain, and records that it
   * did.** The chain is authenticated by an identity key a leave destroys, so it
   * cannot survive; what does survive is the continuity id and its anchor, which
   * are node-local lineage and not Hub identity. Keeping them is what leaves the
   * §13.3 path reachable: a client pinned to the old identity resolves the
   * re-enrolled node to its existing pin, finds a chain that no longer reaches
   * it, and takes the re-verification path — rather than seeing an unrecognized
   * node and treating a substitution-shaped event as routine first contact.
   */
  readonly leave: () => Promise<void>;
  /** Null when no ceremony is pending for this origin. */
  readonly readPendingEnrollment: (hubOrigin: string) => Promise<PendingHubEnrollmentDetail | null>;
  readonly startEnrollment: (
    hubOrigin: string,
    metadata: HubEnrollmentMetadata,
  ) => Promise<StartedHubEnrollment>;
  readonly pollEnrollment: (hubOrigin: string) => Promise<HubEnrollmentPollResponse>;
  readonly cancelEnrollment: (hubOrigin: string) => Promise<void>;
  /** Exact-child automatic claim, reachable only from Desktop's private control channel. */
  readonly nativeNodeClaim: NodeNativeClaimService;
  readonly createRelayAuthenticationFrame: (
    hubOrigin: string,
    protocol: { readonly protocolMajor: number; readonly protocolMinor: number },
  ) => Promise<RelayNodeAuthHandshake>;
  /**
   * §7.5 makes the continuity disposition an explicit operator choice that no
   * layer below may infer, so it is a required argument all the way down: a
   * rotation motivated by compromise of the outgoing key MUST be a deliberate
   * break, because a certificate signed by a key an adversary also holds proves
   * nothing (§13.3 custody caveat, §17.12).
   */
  readonly stageKeyRotation: (
    hubOrigin: string,
    options: { readonly continuity: NodeRotationContinuityMode },
  ) => Promise<HubKeyRotationStatus>;
  readonly resumeKeyRotation: (hubOrigin: string) => Promise<HubKeyRotationStatus>;
  /**
   * Promote the rotated-to key and retire the outgoing one.
   *
   * Reports what the committed promotion did to the §7.5 chain. A deliberate
   * break is recorded after the commit and is therefore best-effort, like every
   * other post-commit step; `continuityBreak: "deferred"` is how an operator
   * surface learns it did not record without being told the rotation failed.
   */
  readonly confirmAuthenticatedKey: (
    hubOrigin: string,
    keyId: string,
  ) => Promise<HubKeyRotationPromotion>;
  // ─── OPERATOR SURFACE ─────────────────────────────────────────────────────
  //
  // §6.4, §7.5, and §5.7 each require a node CLI command — forced prekey
  // rotation, continuity recovery with its two deliberate outcomes, the
  // deliberate chain break, and the policy-generation recovery — and every
  // "remedy" string this package exports is written in the words such a command
  // must use. The operations below are those commands' backing implementation;
  // `ryco e2ee` is the surface, assembled in `NodeE2eeOperator` and served over
  // the owner-authenticated routes of `hubConnector/http.ts`. A remedy string
  // reaches an operator only through a surface that prints it, so a condition
  // added here owes a display there in the same change.
  //
  // `stageKeyRotation` and `confirmAuthenticatedKey` are the exception and were
  // already: §7.5 requires the rotation command to make the compromise-versus-
  // continuity distinction explicit at the point of use, and no command offers
  // that choice yet, so the §7.5 continuity argument threaded through
  // `stageKeyRotation` is still unreachable from any operator surface.

  /**
   * The §7.5 material a capability statement carries, after the startup
   * cross-check has run and any repair it mandates has been committed.
   */
  readonly readE2eeContinuity: (hubOrigin: string) => Promise<NodeE2eeContinuityStatus>;
  /**
   * §7.5's deliberate break, for the operator surface.
   *
   * Drops the chain and keeps the lineage: every pinned client takes the §13.3
   * re-verification path, and the generation high-water mark is retained so no
   * generation is ever reused.
   */
  readonly breakE2eeContinuity: () => Promise<void>;
  /**
   * §7.5 recovery, outcome one: re-adopt a continuity id the operator confirms.
   * Restores every existing pin when the confirmed value is the one this node
   * advertised.
   */
  readonly adoptE2eeContinuityId: (continuityId: string) => Promise<string>;
  /**
   * §7.5 recovery, outcome two: deliberately break continuity and mint a fresh
   * id. Equivalent in effect to a deliberate chain break — every paired client
   * needs a fresh §13.2 ceremony — and the operator surface MUST say so at the
   * point of use.
   */
  readonly remintE2eeContinuityId: () => Promise<string>;
  /**
   * The §7.3 prekey certificate to advertise on a new channel (§5.2).
   *
   * These three reject with `NodeE2eePrekeyError` rather than
   * `HubIdentityRuntimeError`: §6.4 gives prekey expiry its own named local
   * diagnostic, and flattening it into the identity error union would erase the
   * distinction the spec asks callers to act on.
   */
  readonly readE2eePrekeyCertificate: (hubOrigin: string) => Promise<NodeE2eePrekeyCertificate>;
  /**
   * The certificate this node HOLDS, for the operator display (§6.4).
   *
   * Distinct from `readE2eePrekeyCertificate`, which re-signs an unusable
   * certificate before returning it: a display built on that could never show
   * the `expired` state §6.4 names a diagnostic and a remedy for.
   */
  readonly readStoredE2eePrekey: (hubOrigin: string) => Promise<NodeE2eePrekeyCertificate | null>;
  /** §6.4's forced rotation, the operation the node CLI command drives. */
  readonly rotateE2eePrekey: (hubOrigin: string) => Promise<NodeE2eePrekeyCertificate>;
  /** Borrow the secret half of the prekey a channel advertised (§6.4, §8). */
  readonly withE2eePrekeySecret: <A>(
    hubOrigin: string,
    prekeyId: string,
    use: (secretKey: Uint8Array) => Promise<A> | A,
  ) => Promise<A>;
  /**
   * The committed admission policy, for §5.5's disposition and every §4.4 row.
   *
   * Synchronous by contract, exactly as `NodeE2eePolicyClient.policy` is: §8.6
   * step 2 requires the policy read and the row-N3 transition to be atomic with
   * respect to §12.6's commit. Before a durable read succeeds this is §12.4's
   * fail-closed policy, so a runtime that cannot read its record admits the
   * least rather than the most.
   */
  readonly e2eePolicy: () => EffectiveNodeE2eePolicy;
  /**
   * The §5.2 statement to advertise on a new channel, or the §5.5 U2 reason
   * there is none.
   *
   * Cheap and cached while §5.7 permits, and NEVER called from the acceptance
   * announcement: it reads key custody and may sign.
   */
  readonly readE2eeAdvertisement: (hubOrigin: string) => Promise<NodeE2eeAdvertisementResult>;
  /**
   * §12.6: one channel's handle on the policy-withdrawal sweep, taken as the
   * channel opens and released when it ends.
   *
   * Handed out per channel rather than exposing the client, because the sweep's
   * correctness rests on every channel being exactly one registration: two
   * collections, or a second registration for one channel, is how a channel
   * crossing row N3 ends up in neither enumeration.
   */
  readonly registerE2eeChannel: () => NodeE2eeChannelRegistration;
  /**
   * §13.6: the Branch A reads and the in-flight registration the relay path
   * needs, and nothing else.
   *
   * Narrowed deliberately. The owner-facing commands — approve, narrow, revoke,
   * the pairing window — are on the same client, and a relay path that could
   * reach them is one that could mutate authority from peer input.
   */
  readonly e2eeClientAuthorization: NodeE2eeChannelAuthorization;
  /**
   * §13.6's owner commands, for the CLI and nothing else.
   *
   * Every mutation here runs the §13.6 ordered procedure inside the client —
   * commit, then sweep — and rejects rather than returning when the sweep could
   * not finish, which is what lets the CLI's acknowledgement mean what §13.6
   * says it means.
   */
  readonly e2eeAuthorizationAdmin: NodeE2eeAuthorizationAdmin;
  /** Owner-scanned, node-signed approval QR for an exact approved client. */
  readonly crossDeviceApproval: NodeCrossDeviceApprovalService;
  /** Desktop-main-only Local Trusted Introduction over its child control channel. */
  readonly localIntroduction: NodeLocalIntroductionService;
  /** §5.7's generation the next advertisement carries, for the policy display. */
  readonly e2eeGeneration: () => number;
  /** §12.6 in full: (a) commit and bump, (b) sweep one snapshot, (c) the counts. */
  readonly applyE2eePolicy: (
    proposal: NodeE2eePolicyProposal,
  ) => Promise<NodeE2eePolicyChangeResult>;
  /** §12.6's display duty: what the change WOULD do, for the warning before it runs. */
  readonly previewE2eePolicy: (proposal: NodeE2eePolicyProposal) => NodeE2eePolicyPreview;
  /**
   * §5.7's recovery command: durably advance the policy generation to a value
   * strictly greater than any this node may previously have advertised.
   *
   * The high-water mark is updated first and the advertised record second, and
   * the store refuses to re-adopt the values of a record the mark says was
   * rolled back — it commits §12.4's fail-closed policy instead, so recovery can
   * NARROW and owes §12.6 step (b) like any other narrowing. Widening back is
   * the owner's own explicit policy command.
   */
  readonly recoverE2eeGeneration: () => Promise<NodeE2eePolicyChangeResult>;
  /**
   * Record one §12.5 fallback occurrence. At most one per channel.
   *
   * Never rejects — instrumentation must not be able to fail a channel — so the
   * returned promise is safe to ignore on the receive path and is awaited only
   * by a caller that wants to observe the durable write.
   */
  readonly recordE2eeFallback: (occurrence: {
    readonly hubOrigin: string;
    readonly reason: E2eeFallbackReason;
  }) => Promise<void>;
  /** The §12.5 counters, for the node CLI's display. */
  readonly readE2eeFallbackState: () => NodeE2eeFallbackState;
  /**
   * §12.5's reset authority, which is an explicit CLI command and nothing else.
   *
   * Zeroes both occurrence counters, both ring-overflow counters, and the ring,
   * and records a new observation-window start. No automatic reset exists.
   */
  readonly resetE2eeFallbackState: () => Promise<NodeE2eeFallbackState>;
  /**
   * §12.5's clean-shutdown flush: commit anything still coalesced and cancel
   * the write interval. Idempotent, and never rejects.
   *
   * Called from the connector's release rather than left to the process exiting:
   * §12.5 names clean shutdown as one of the two flush points, and an armed
   * interval timer outliving the runtime that owns it is a handle nothing can
   * reach to cancel.
   */
  readonly stopE2eeInstrumentation: () => Promise<void>;
}

export class HubIdentityRuntime extends Context.Service<
  HubIdentityRuntime,
  HubIdentityRuntimeShape
>()("ryco/hubConnector/HubIdentityRuntime") {}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const bounded = async <A>(
  code: HubIdentityRuntimeErrorCode,
  operation: () => Promise<A>,
): Promise<A> => {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof HubIdentityRuntimeError) throw error;
    throw new HubIdentityRuntimeError(code);
  }
};

const protectedStoreClass = (backend: ProtectedSecretStoreBackend): HubProtectedStoreBackend =>
  backend === "permissioned-file" ? "permissioned-file" : "os";

/**
 * Every identity-key name this record owns, whatever its lifecycle stage.
 *
 * Identity keys only. The §6.3 agreement keys are named by a record of their
 * own (`NodeE2eePrekeyStore`) and are added to the leave list from there: they
 * are optional material that a node re-issues freely, so they prove nothing
 * about which store class holds this identity and must not decide the affinity
 * probe. The §7.5 continuity anchor is not in either list — it is node lineage
 * rather than Hub identity, and `leave` explains why keeping it is what leaves
 * the §13.3 path reachable after a re-enrollment.
 */
const allIdentitySecretNames = (
  state: LocalHubIdentityState,
  // Keys a promotion queued for destruction but has not destroyed yet. They are
  // no longer in service and are still in the protected store, so a leave that
  // skipped them would orphan them there with nothing left to name them. They
  // live in a record of their own (`NodeIdentityKeyRetirementStore`) and are
  // therefore passed in rather than read off the state.
  retiringSecretNames: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  [
    state.activeNode?.activeKeySecretName,
    state.activeNode?.cleanupPollingSecretName,
    state.stagedRotation?.newKeySecretName,
    state.pendingEnrollment?.keySecretName,
    state.pendingEnrollment?.pollingSecretName,
    ...retiringSecretNames,
  ].filter((name, index, names): name is string => {
    return typeof name === "string" && names.indexOf(name) === index;
  });

const identitySecretNames = (
  state: LocalHubIdentityState,
  retiringSecretNames: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  [
    ...allIdentitySecretNames(state, retiringSecretNames),
    ...(state.pendingTeardown?.secretNames ?? []),
  ].filter((name, index, names) => names.indexOf(name) === index);

const requiredIdentitySecretNames = (state: LocalHubIdentityState): ReadonlySet<string> => {
  const names = new Set<string>();
  // A committed teardown makes every referenced secret optional: deletion may
  // already have completed before the process crashed. Startup must reopen one
  // unambiguous custody class and finish clearing state, not require a key that
  // the teardown protocol intentionally removed.
  if (state.pendingTeardown !== null) return names;
  // The agreement key cannot appear here at all. §6.4 makes a missing or
  // unusable prekey a re-signing trigger, not a custody failure: a node that
  // lost it can still authenticate, still relay, and simply re-issues. Requiring
  // it would turn an optional capability into an unstartable node.
  if (state.activeNode !== null) names.add(state.activeNode.activeKeySecretName);
  if (state.stagedRotation !== null) names.add(state.stagedRotation.newKeySecretName);
  if (state.pendingEnrollment !== null) {
    names.add(state.pendingEnrollment.keySecretName);
    if (
      state.pendingEnrollment.expiresAt !== null &&
      state.pendingEnrollment.pollIntervalMs !== null
    ) {
      names.add(state.pendingEnrollment.pollingSecretName);
    }
  }
  return names;
};

const inspectProtectedStore = async (
  store: ProtectedSecretStore,
  names: ReadonlyArray<string>,
  requiredNames: ReadonlySet<string>,
): Promise<{ readonly present: number; readonly hasEveryRequired: boolean }> => {
  let present = 0;
  let hasEveryRequired = true;
  for (const name of names) {
    const value = await store.get(name);
    if (value === null) {
      if (requiredNames.has(name)) hasEveryRequired = false;
      continue;
    }
    present += 1;
    value.fill(0);
  }
  return { present, hasEveryRequired };
};

const protectedStoreUnavailable = (): never => {
  throw new HubIdentityRuntimeError("identity_store_unavailable");
};

async function selectProtectedSecretStore(options: {
  readonly stateStore: Awaited<ReturnType<typeof makeLocalHubIdentityStateStore>>;
  /**
   * Identity keys awaiting destruction, read once before selection.
   *
   * They belong in the affinity probe — they are identity keys, held in the same
   * store class as the rest — and nothing can change them before the store is
   * chosen, because every writer of that record is constructed after this.
   */
  readonly retiringSecretNames: ReadonlyArray<string>;
  readonly fileSecretRoot: string;
  readonly allowFileFallback: boolean;
  readonly secretStore?: ProtectedSecretStore;
  readonly makeOsStore?: (service: string) => Promise<ProtectedSecretStore>;
  readonly makeFileStore?: (
    rootDirectory: string,
    options: { readonly explicitlyAllowed: boolean },
  ) => Promise<ProtectedSecretStore>;
}): Promise<ProtectedSecretStore> {
  const state = await options.stateStore.readOrCreate();
  const bindBackend = async (kind: HubProtectedStoreBackend): Promise<void> => {
    const current = await options.stateStore.readOrCreate();
    if (current.protectedStoreBackend === kind) return;
    if (current.protectedStoreBackend !== null) return protectedStoreUnavailable();
    await options.stateStore.update((latest) => {
      if (latest.protectedStoreBackend !== null) {
        if (latest.protectedStoreBackend !== kind) return protectedStoreUnavailable();
        return { ...latest, revision: latest.revision + 1 };
      }
      return {
        ...latest,
        revision: latest.revision + 1,
        protectedStoreBackend: kind,
      };
    });
  };
  const makeOs = () =>
    (options.makeOsStore ?? makeOsProtectedSecretStore)(NODE_IDENTITY_SECRET_SERVICE);
  const makeFile = () => {
    if (!options.allowFileFallback) return protectedStoreUnavailable();
    return (options.makeFileStore ?? makePermissionedFileSecretStore)(options.fileSecretRoot, {
      explicitlyAllowed: true,
    });
  };
  const optionalStore = async (
    make: () => Promise<ProtectedSecretStore>,
  ): Promise<ProtectedSecretStore | null> => {
    try {
      return await make();
    } catch (error: unknown) {
      if (
        error instanceof ProtectedSecretStoreError &&
        error.code === "protected_store_unavailable"
      ) {
        return null;
      }
      return protectedStoreUnavailable();
    }
  };

  let selected: ProtectedSecretStore;
  if (options.secretStore !== undefined) {
    selected = options.secretStore;
    if (
      state.protectedStoreBackend !== null &&
      state.protectedStoreBackend !== protectedStoreClass(selected.backend)
    ) {
      return protectedStoreUnavailable();
    }
  } else if (state.protectedStoreBackend === "os") {
    selected = (await optionalStore(makeOs)) ?? protectedStoreUnavailable();
  } else if (state.protectedStoreBackend === "permissioned-file") {
    selected = (await optionalStore(makeFile)) ?? protectedStoreUnavailable();
  } else {
    const names = identitySecretNames(state, options.retiringSecretNames);
    if (names.length === 0) {
      selected =
        (await optionalStore(makeOs)) ??
        (await optionalStore(makeFile)) ??
        protectedStoreUnavailable();
    } else {
      const requiredNames = requiredIdentitySecretNames(state);
      const osStore = await optionalStore(makeOs);
      const fileStore = options.allowFileFallback ? await optionalStore(makeFile) : null;
      const candidates = await Promise.all(
        [
          osStore === null ? null : { store: osStore, kind: "os" as const },
          fileStore === null ? null : { store: fileStore, kind: "permissioned-file" as const },
        ]
          .filter(
            (
              candidate,
            ): candidate is {
              readonly store: ProtectedSecretStore;
              readonly kind: HubProtectedStoreBackend;
            } => candidate !== null,
          )
          .map(async ({ store, kind }) => ({
            store,
            kind,
            inspection: await bounded("identity_store_unavailable", () =>
              inspectProtectedStore(store, names, requiredNames),
            ),
          })),
      );
      const containingMaterial = candidates.filter(({ inspection }) => inspection.present > 0);
      if (containingMaterial.length > 1) return protectedStoreUnavailable();
      const candidate =
        containingMaterial[0] ??
        (state.pendingTeardown !== null && requiredNames.size === 0 ? candidates[0] : undefined);
      if (candidate === undefined || !candidate.inspection.hasEveryRequired) {
        return protectedStoreUnavailable();
      }
      selected = candidate.store;
      await bindBackend(candidate.kind);
    }
  }

  const latest = await options.stateStore.readOrCreate();
  if (
    latest.protectedStoreBackend === null &&
    identitySecretNames(latest, options.retiringSecretNames).length > 0
  ) {
    const names = identitySecretNames(latest, options.retiringSecretNames);
    const requiredNames = requiredIdentitySecretNames(latest);
    const inspection = await bounded("identity_store_unavailable", () =>
      inspectProtectedStore(selected, names, requiredNames),
    );
    if (
      !inspection.hasEveryRequired ||
      (inspection.present === 0 && latest.pendingTeardown === null)
    ) {
      return protectedStoreUnavailable();
    }
    await bindBackend(protectedStoreClass(selected.backend));
  }

  let bindInFlight: Promise<void> | null = null;
  const ensureBound = (): Promise<void> => {
    if (bindInFlight !== null) return bindInFlight;
    const kind = protectedStoreClass(selected.backend);
    const binding = bindBackend(kind);
    bindInFlight = binding;
    const clearBinding = () => {
      if (bindInFlight === binding) bindInFlight = null;
    };
    void binding.then(clearBinding, clearBinding);
    return binding;
  };

  return {
    backend: selected.backend,
    get: selected.get,
    create: async (name, value) => {
      await ensureBound();
      await selected.create(name, value);
    },
    remove: selected.remove,
  };
}

export async function makeHubIdentityRuntime(options: {
  readonly statePath: string;
  /**
   * The §7.5 continuity record. Defaults to a sibling of the identity state.
   *
   * A sibling and not a section of it: the identity parser reconstructs from its
   * known keys alone, so a binary older than this feature would delete the
   * lineage on its next write, and §7.5's whole purpose is to survive exactly
   * that class of operator action (`NodeIdentityContinuityStore`).
   */
  readonly continuityStatePath?: string;
  /**
   * The §6.4 prekey record. Defaults to a sibling of the identity state.
   *
   * A sibling for the same downgrade reason, applied to the one thing it holds
   * that cannot be regenerated: the protected-store names of live agreement
   * private keys (`NodeE2eePrekeyStore`).
   */
  readonly prekeyStatePath?: string;
  /**
   * The identity-key destroy queue. Defaults to a sibling of the identity state.
   *
   * A sibling for the same downgrade reason, applied to the one thing it holds:
   * the protected-store name of an outgoing identity private key that nothing
   * else references any more (`NodeIdentityKeyRetirementStore`).
   */
  readonly retirementStatePath?: string;
  /**
   * The §5.7 anchor. REQUIRED to be outside the state directory.
   *
   * This is property (b) of §5.7 — residence outside the operator-restorable
   * state and configuration set — and it is a property of the path, so it is
   * the caller's to satisfy and nothing below can check it. The default is a
   * sibling of the state directory rather than a child of it.
   */
  readonly continuityAnchorPath?: string;
  /**
   * The §12.4 admission-policy record. Defaults to a sibling of the identity
   * state, for the reason every other sibling has.
   *
   * It is NOT Hub-scoped and a `leave` does not erase it: it is the operator's
   * own policy, and §12.4's rule is that absence never weakens one
   * (`NodeE2eePolicyStore`).
   */
  readonly e2eePolicyStatePath?: string;
  /** The §12.5 fallback counters. Defaults to a sibling of the identity state. */
  readonly e2eeFallbackStatePath?: string;
  /** The §13.6 Branch A record set. Defaults to a sibling of the identity state. */
  readonly clientAuthorizationStatePath?: string;
  /** The bounded LTI replay ledger. Defaults to a sibling of the identity state. */
  readonly localIntroductionStatePath?: string;
  /**
   * The operator's configured policy for this run (§12.4).
   *
   * An option left unset by every configuration source stays unset all the way
   * to here, where it means "leave the committed value alone" and never "false"
   * — which is what makes a restart in a shell without the environment variable
   * incapable of weakening the policy.
   */
  readonly e2eePolicy?: NodeE2eePolicyProposal;
  /**
   * Leave the startup work — finishing an interrupted leave, destroying retired
   * keys, validating custody, prekey and continuity repair, and committing this
   * run's `e2eePolicy` — to `completeStartup`.
   *
   * For a backend that found the identity owned by another local process
   * (`HubIdentityProcessLock`). Every step of that work writes state the owner
   * relies on, and the policy commit in particular is §12.6's commit-then-sweep:
   * run here it would commit and sweep nothing, leaving the owner's live
   * channels open under a policy that was just narrowed. Until it runs, the
   * policy client is at §12.4's fail-closed default — which is also what this
   * backend enforces, since it serves no channel.
   */
  readonly deferStartup?: boolean;
  readonly fileSecretRoot: string;
  readonly allowFileFallback: boolean;
  readonly secretStore?: ProtectedSecretStore;
  readonly makeOsSecretStore?: (service: string) => Promise<ProtectedSecretStore>;
  readonly makeFileSecretStore?: (
    rootDirectory: string,
    options: { readonly explicitlyAllowed: boolean },
  ) => Promise<ProtectedSecretStore>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<HubIdentityRuntimeShape> {
  const stateStore = await makeLocalHubIdentityStateStore(options.statePath);
  const stateDirectory = dirname(options.statePath);
  // Opened before the protected store is selected, because the names it holds
  // are identity keys and belong to the affinity probe below.
  const retirementStore = await makeNodeIdentityKeyRetirementStore({
    path: options.retirementStatePath ?? join(stateDirectory, "hub-identity-retirement.json"),
  });
  const secretStore = await selectProtectedSecretStore({
    stateStore,
    retiringSecretNames: await retirementStore.names(),
    fileSecretRoot: options.fileSecretRoot,
    allowFileFallback: options.allowFileFallback,
    ...(options.secretStore === undefined ? {} : { secretStore: options.secretStore }),
    ...(options.makeOsSecretStore === undefined ? {} : { makeOsStore: options.makeOsSecretStore }),
    ...(options.makeFileSecretStore === undefined
      ? {}
      : { makeFileStore: options.makeFileSecretStore }),
  });
  const signingIdentity = makeNodeSigningIdentity(secretStore);
  const nativeNodeClaim = makeNodeNativeClaimService({
    stateStore,
    signingIdentity,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const now = options.now ?? (() => Date.now());
  const prekeyStore = await makeNodeE2eePrekeyStore({
    path: options.prekeyStatePath ?? join(stateDirectory, "hub-e2ee-prekey.json"),
  });
  // Outside the state directory by default, because that is the whole
  // requirement §5.7 places on it: a restore of the state directory must not be
  // able to lower either mark it holds. A sibling directory is not immune to an
  // operator who wipes everything — nothing durable is — but it is outside the
  // set §5.7 names, which is the property the cross-checks depend on.
  const continuityAnchor = await makeNodeContinuityAnchor({
    path:
      options.continuityAnchorPath ??
      join(dirname(stateDirectory), "anchors", basename(stateDirectory), "hub-continuity.json"),
  });
  const continuityStore = await makeNodeIdentityContinuityStore({
    path: options.continuityStatePath ?? join(stateDirectory, "hub-continuity.json"),
    anchor: continuityAnchor,
  });
  // Shares the §5.7 anchor with the continuity store: the policy generation and
  // the rotation generation are both high-water marks that an operator restore
  // of the state directory must not be able to lower.
  const policyClient = makeNodeE2eePolicyClient({
    store: await makeNodeE2eePolicyStore({
      path: options.e2eePolicyStatePath ?? join(stateDirectory, "hub-e2ee-policy.json"),
      anchor: continuityAnchor,
    }),
  });
  const fallbackCounter = await makeNodeE2eeFallbackCounter({
    path: options.e2eeFallbackStatePath ?? join(stateDirectory, "hub-e2ee-fallback.json"),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  // §13.6's Branch A record set. Hub-scoped, so a `leave` erases it, and read
  // synchronously from the in-memory index at §8.6 step 6 — which is what makes
  // that read atomic with respect to the withdrawal write.
  const clientAuthorizationStore = await makeNodeClientAuthorizationStore({
    path:
      options.clientAuthorizationStatePath ??
      join(stateDirectory, "hub-e2ee-client-authorization.json"),
  });
  const authorizationClient = await makeNodeClientAuthorizationClient({
    store: clientAuthorizationStore,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const localIntroductionLedger = await makeNodeLocalIntroductionLedger({
    path:
      options.localIntroductionStatePath ??
      join(stateDirectory, "hub-e2ee-local-introductions.json"),
  });

  /**
   * The §7.5 lineage id this node may advertise, or a hard refusal.
   *
   * Every caller that needs the id goes through here, so the startup cross-check
   * and its mint have exactly one implementation and the "unresolvable" state is
   * impossible to route around.
   */
  const requireContinuityId = async (): Promise<string> => {
    const resolution = await continuityStore.resolveContinuityId();
    if (resolution.status === "unresolvable") {
      throw new NodeIdentityContinuityError("continuity_unresolvable");
    }
    return resolution.continuityId;
  };

  /**
   * The outgoing key's PUBLIC half, without requiring that the node still holds
   * the secret half.
   *
   * `append` is idempotent on the old-to-new pair precisely so that a promotion
   * interrupted after the certificate was retained can be retried. Reaching that
   * idempotent path through a descriptor lookup would defeat it: the lookup
   * needs the private key, and the retry that most needs to succeed is the one
   * taken after that key is gone. So custody is tried first — it is the only
   * source for a certificate that does not exist yet — and a chain that already
   * ends at exactly this rotation answers when custody cannot.
   *
   * Both sources are the same 32 bytes. The retained certificate carries the
   * outgoing public key as a signed element and is signature-verified before it
   * is believed, so this is not a weaker answer than the descriptor, only a
   * differently sourced one.
   */
  const outgoingIdentityPublicKey = async (input: {
    readonly hubOrigin: string;
    readonly continuityId: string;
    readonly oldKeyId: string;
    readonly oldKeySecretName: string;
    readonly newKeyId: string;
  }): Promise<Uint8Array> => {
    const held = await signingIdentity
      .getPublicDescriptor(input.oldKeySecretName)
      .catch(() => null);
    if (held !== null) return held.publicKey;
    const retained = newestRetainedContinuityCertificate(await continuityStore.read());
    if (
      retained !== null &&
      retained.hubOrigin === input.hubOrigin &&
      retained.continuityId === input.continuityId &&
      retained.oldKeyId === input.oldKeyId &&
      retained.newKeyId === input.newKeyId
    ) {
      return retained.oldPublicKey;
    }
    // Neither custody nor the retained chain can say what the outgoing key was,
    // and §7.5 forbids synthesizing it. The rotation must be re-staged as a
    // deliberate break.
    throw new NodeIdentityContinuityError("continuity_generation_unavailable");
  };

  const rotationContinuity: HubKeyRotationContinuity = {
    issue: async ({ hubOrigin, oldKeyId, oldKeySecretName, newKeyId, newKeySecretName }) => {
      const continuityId = await requireContinuityId();
      const oldPublicKey = await outgoingIdentityPublicKey({
        hubOrigin,
        continuityId,
        oldKeyId,
        oldKeySecretName,
        newKeyId,
      });
      const newKey = await signingIdentity.getPublicDescriptor(newKeySecretName);
      await continuityStore.append({
        hubOrigin,
        continuityId,
        oldKeyId,
        oldPublicKey,
        newKeyId,
        newPublicKey: newKey.publicKey,
        createdAt: now(),
        // §7.2: the signed bytes come from the named encoder inside the store,
        // and the outgoing key signs the rotation away from itself. Never
        // reached on the idempotent retry above, which returns before signing —
        // and if it is reached without the key, refusing is the only correct
        // outcome.
        sign: (transcript) => signingIdentity.sign(oldKeySecretName, transcript),
      });
    },
    break: async () => {
      await continuityStore.recordBreak({ reason: "rotation_break", at: now() });
    },
  };

  const enrollment = makeHubEnrollmentClient({
    transport: makeHubEnrollmentHttpTransport(options.fetch, { timeoutMs: 10_000 }),
    signingIdentity,
    secretStore,
    stateStore,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const rotation = makeHubKeyRotationClient({
    transport: makeHubKeyRotationHttpTransport(options.fetch, { timeoutMs: 10_000 }),
    signingIdentity,
    stateStore,
    retirement: retirementStore,
    continuity: rotationContinuity,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const prekeys = makeNodeE2eePrekeyClient({
    agreementIdentity: makeNodeAgreementIdentity(secretStore),
    signingIdentity,
    // §7.3 element 4 must name the key that will actually authenticate, so the
    // certificate follows the same selector the relay proof does.
    keySelector: rotation,
    stateStore,
    prekeyStore,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const proof = makeHubNodeProofClient({
    transport: makeHubNodeChallengeHttpTransport(options.fetch, { timeoutMs: 10_000 }),
    stateStore,
    signingIdentity,
    keySelector: rotation,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  /**
   * The §7.5 startup cross-check, and the one place a chain break is detected.
   *
   * Run at startup for its repair side effects and again on every read, because
   * the answer changes with a rotation and the §7.6.1 self-check is required
   * after every one of them. It is cheap — two owner-only files and one anchor
   * read — and a cached copy would be a second source of truth for the exact
   * value §5.2 step 6 makes channel-fatal.
   */
  const evaluateContinuity = async (rawHubOrigin: string): Promise<NodeE2eeContinuityStatus> => {
    let hubOrigin: string;
    let state: LocalHubIdentityState;
    try {
      hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
      state = await stateStore.readOrCreate();
    } catch {
      // Neither an origin this node could serve nor a state it can read is a
      // continuity condition, so neither becomes a continuity error: they are
      // the same "this node has no identity to speak for" the gate below
      // reports, and the two error types this operation documents are the two
      // it may raise.
      throw new HubIdentityRuntimeError("identity_unavailable");
    }
    const active = state.activeNode;
    // Gated on an enrolled identity: §7.5 mints "before the first statement
    // carrying it is advertised", and a node with nothing to advertise must not
    // create an anchor — that would bind the protected-store class for a node
    // that may never enroll.
    if (active === null || active.hubOrigin !== hubOrigin) {
      throw new HubIdentityRuntimeError("identity_unavailable");
    }
    const resolution = await continuityStore.resolveContinuityId();
    if (resolution.status === "unresolvable") {
      return { status: "unavailable", reason: resolution.reason, remedy: resolution.remedy };
    }
    // Neither key is required to be present. §7.5 has an answer for a chain that
    // reaches no key in custody — it is broken, and this pass records it — so a
    // key the state names but the node no longer holds must not surface as a
    // raw signing error to a caller whose contract is `advertisable` or
    // `unavailable`. The active key can be missing after a promotion that was
    // interrupted between its commit and the destruction of the outgoing key,
    // and the staged key after one interrupted anywhere.
    const activeKey = await signingIdentity
      .getPublicDescriptor(active.activeKeySecretName)
      .catch(() => undefined);
    const stagedKey =
      state.stagedRotation === null
        ? undefined
        : await signingIdentity
            .getPublicDescriptor(state.stagedRotation.newKeySecretName)
            .catch(() => undefined);
    // The record the resolution returned, not a second read: one snapshot,
    // taken under the same lock acquisition that performed any repair, so a
    // rotation cannot land between the two and be judged against the lineage
    // the first read saw.
    const record = resolution.record;
    const status = nodeIdentityContinuityChainStatus({
      record,
      continuityId: resolution.continuityId,
      hubOrigin,
      activeIdentityPublicKey: activeKey?.publicKey,
      ...(stagedKey === undefined ? {} : { stagedIdentityPublicKey: stagedKey.publicKey }),
    });
    if (status.status === "broken") {
      // §7.5 backup-rollback rule: never reuse a generation, never synthesize
      // the missing links, treat the chain as broken. Recording it is what makes
      // the break explicit and what keeps the high-water mark, so the next
      // rotation cannot land on a generation this node already issued.
      const broken = await continuityStore.recordBreak({
        reason: status.reason === "rolled_back" ? "rollback_detected" : "cross_check_failed",
        at: now(),
      });
      return {
        status: "advertisable",
        continuityId: resolution.continuityId,
        chain: [],
        generation: broken.generationHighWater,
        repair: resolution.repair,
        chainBreak: status.reason,
        lastBreak: broken.lastBreak,
      };
    }
    return {
      status: "advertisable",
      continuityId: resolution.continuityId,
      chain: status.entries,
      generation: status.generation,
      repair: resolution.repair,
      chainBreak: null,
      lastBreak: record.lastBreak,
    };
  };

  /**
   * The public half of an identity key, by protected-store name.
   *
   * Memoized because the statement builder reads it on every channel open and
   * reading it opens the credential store — a keychain access per channel, in
   * the steady state, for a value that cannot change: a secret name identifies
   * one keypair for its whole life, and a rotation creates a new name rather
   * than replacing the material behind an existing one. A `leave` erases the
   * secret, but it also clears `activeNode`, so the caller below never reaches
   * this for a name that has been erased.
   */
  const identityPublicKeys = new Map<string, Uint8Array>();
  const identityPublicKey = async (secretName: string): Promise<Uint8Array> => {
    const cached = identityPublicKeys.get(secretName);
    if (cached !== undefined) return cached;
    const descriptor = await signingIdentity.getPublicDescriptor(secretName);
    identityPublicKeys.set(secretName, descriptor.publicKey);
    return descriptor.publicKey;
  };

  const activeApprovalDescriptor = async () => {
    const state = await stateStore.readOrCreate();
    const active = state.activeNode;
    if (active === null) throw new HubIdentityRuntimeError("identity_unavailable");
    const continuity = await evaluateContinuity(active.hubOrigin);
    if (continuity.status !== "advertisable") {
      throw new HubIdentityRuntimeError("identity_unavailable");
    }
    const selected = await rotation.authenticationKey(active.hubOrigin);
    return {
      hubOrigin: active.hubOrigin,
      environmentId: state.environmentId,
      nodeId: active.nodeId,
      nodeIdentityPublicKey: await identityPublicKey(selected.secretName),
      nodeContinuityId: continuity.continuityId,
      nodePolicyGeneration: policyClient.generation(),
      signApproval: (approvalTbs: Uint8Array) =>
        signingIdentity.sign(selected.secretName, approvalTbs),
    };
  };

  const localIntroduction = makeNodeLocalIntroductionService({
    active: activeApprovalDescriptor,
    authorization: authorizationClient,
    ledger: localIntroductionLedger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const crossDeviceApproval = makeNodeCrossDeviceApprovalService({
    active: activeApprovalDescriptor,
    authorization: authorizationClient,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  /**
   * The §5.2 statement builder, over this runtime's own custody and stores.
   *
   * Every source is the same one the rest of this runtime already publishes, so
   * there is no second reading of identity, prekey, continuity or policy state
   * that could disagree with the first. The builder owns the §5.7 freshness rule
   * and the §7.6.1 self-check; this runtime owns nothing about the statement
   * except handing it the node's state.
   */
  const statements = makeNodeE2eeCapabilityStatementClient({
    identity: async (hubOrigin) => {
      const state = await stateStore.readOrCreate();
      const active = state.activeNode;
      if (active === null || active.hubOrigin !== hubOrigin) {
        throw new HubIdentityRuntimeError("identity_unavailable");
      }
      // The same selector the relay proof and the prekey certificate use, so a
      // staged rotation that has already activated advertises — and signs under
      // — the key that will actually authenticate.
      const selected = await rotation.authenticationKey(hubOrigin);
      return {
        nodeId: active.nodeId,
        identityKeyId: selected.keyId,
        identityPublicKey: await identityPublicKey(selected.secretName),
        sign: (envelope) => signingIdentity.sign(selected.secretName, envelope),
      };
    },
    prekey: (hubOrigin) => prekeys.advertised(hubOrigin),
    continuity: async (hubOrigin) => {
      const status = await evaluateContinuity(hubOrigin);
      // §5.5 U2: a node that cannot say which lineage it belongs to declines to
      // advertise rather than asserting a fresh one, because asserting one is a
      // fleet-wide re-verification event.
      return status.status === "advertisable"
        ? { continuityId: status.continuityId, chain: status.chain }
        : undefined;
    },
    policy: () => policyClient.policy(),
    generation: () => policyClient.generation(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  /**
   * Collect every protected-store name an identity owns.
   *
   * A leave must erase all of them: the active signing key, a staged rotation
   * key, a pending ceremony's key, any polling secret still awaiting cleanup,
   * and both agreement keys. Missing one orphans key material in the credential
   * store, where nothing can ever collect it — the store has no listing, so a
   * forgotten name is a private key that outlives every reason to hold it.
   */
  const ownedSecretNames = async (state: LocalHubIdentityState): Promise<ReadonlyArray<string>> => {
    const agreement = await prekeyStore.secretNames().catch(() => []);
    const retiring = await retirementStore.names().catch((): ReadonlyArray<string> => []);
    return [...allIdentitySecretNames(state, retiring), ...agreement].filter(
      (name, index, names) => names.indexOf(name) === index,
    );
  };

  /**
   * Phase two and three of the teardown: erase the recorded secrets, then drop
   * the state.
   *
   * Deletion is best-effort per secret. A credential store that cannot delete
   * must not strand the node in a half-left state forever — the marker has
   * already recorded the intent, and an undeletable secret is inert once the
   * state that references it is gone.
   */
  const completeTeardown = async (secretNames: ReadonlyArray<string>): Promise<void> => {
    // §7.5: a leave is a deliberate chain break and must be recorded as one.
    // First, because the chain is authenticated by the key about to be erased —
    // once that key is gone the retained certificates chain to nothing this node
    // holds, and a chain nobody can walk must not be advertised. Best effort for
    // the same reason the deletions are: a failure here is self-healing, since
    // the startup cross-check finds and records the same break.
    await continuityStore.recordBreak({ reason: "left_hub", at: now() }).catch(() => undefined);
    for (const name of secretNames) {
      await signingIdentity.delete(name).catch(() => undefined);
      await secretStore.remove(name).catch(() => undefined);
    }
    // The prekey slots and the destroy queue go with the identity they were
    // bound to; every secret either names is in the list just erased, which is
    // why they are dropped only after it. The continuity id and its anchor
    // survive: they are what this machine's lineage is, not what its Hub
    // enrollment was.
    await prekeyStore.reset().catch(() => undefined);
    await retirementStore.reset().catch(() => undefined);
    // §6.3, §13.6: the Branch A records are Hub-scoped — they say which clients
    // this node's owner approved at THIS Hub — so they go with the enrollment.
    // The admission policy does not, and is deliberately absent here: it is the
    // operator's own, and §12.4's rule is that absence never weakens one.
    await clientAuthorizationStore.reset().catch(() => undefined);
    await localIntroductionLedger.reset().catch(() => undefined);
    // The in-memory index republished, so a synchronous §8.6 step 6 read after a
    // leave cannot answer from a record the disk no longer holds.
    await authorizationClient.reload().catch(() => undefined);
    await stateStore.reset();
  };

  /**
   * Re-issue the prekey whenever the identity it is signed under changes.
   *
   * §7.3 element 4 binds the certificate to one identity key id, so the moment
   * a rotation activates — the selector switches to the incoming key then, not
   * at promotion — the stored certificate stops being advertisable. Enrollment
   * is the same event from the other direction: a node that just gained an
   * identity has no certificate at all.
   *
   * Best effort, and it has to be: the rotation or enrollment that triggered it
   * has already committed, so reporting a prekey failure as that operation's
   * failure would be a lie. What makes the failure non-permanent is that
   * `advertised` re-issues on demand, so the next channel repairs whatever this
   * could not.
   */
  const maintainPrekey = async (): Promise<void> => {
    const state = await stateStore.readOrCreate();
    if (state.activeNode === null) return;
    await prekeys.ensure(state.activeNode.hubOrigin);
  };
  const maintainPrekeyQuietly = (): Promise<void> => maintainPrekey().catch(() => undefined);

  /**
   * Everything a start does to the identity beyond opening it, in order.
   *
   * Run while the runtime is built unless `deferStartup` asks otherwise, in
   * which case `completeStartup` runs it once this process owns the identity.
   */
  const startup = async (): Promise<void> => {
    // Resume an interrupted leave before anything reads key custody: the keys it
    // names may already be gone, which would otherwise fail the validation below
    // and leave the node permanently unstartable.
    await bounded("identity_unavailable", async () => {
      const state = await stateStore.readOrCreate();
      if (state.pendingTeardown !== null) {
        await completeTeardown(state.pendingTeardown.secretNames);
      }
    });

    // Finish a promotion's outstanding destruction. The promotion itself is
    // already committed — that is the ordering rule — so what is left here is a
    // key that is no longer in service and must not be left in the protected
    // store. Best effort: an undeletable key stays queued, and a node must start
    // whether or not its credential store is cooperating this minute.
    await rotation.destroyRetiredKeys().catch(() => undefined);

    await bounded("identity_unavailable", async () => {
      const state = await stateStore.readOrCreate();
      if (state.activeNode !== null) {
        const selected = await rotation.authenticationKey(state.activeNode.hubOrigin);
        await signingIdentity.getPublicDescriptor(selected.secretName);
      }
      if (state.stagedRotation !== null) {
        await signingIdentity.getPublicDescriptor(state.stagedRotation.newKeySecretName);
      }
    });

    // §6.4's node remedy: validate this node's own prekey certificate at startup
    // and re-sign a fresh one when it is expired or would expire within
    // `E2EE_PREKEY_ROTATION_OVERLAP`. This also destroys an outgoing agreement key
    // whose overlap window elapsed while the node was down.
    //
    // A failure here does NOT fail startup. The prekey decides whether this node
    // can SERVE E2EE, not whether it can run: a node that cannot issue one relays
    // exactly as before and simply has nothing to advertise. The condition stays
    // reportable — the forced-rotation command below surfaces the same failure
    // with its §6.4 diagnostic instead of hiding it behind a start-up abort.
    await maintainPrekeyQuietly();

    // §7.5's startup pass, for its repairs: mint the continuity id once if this
    // node has never advertised, restore it from the anchor if a restore rolled
    // the stored copy back, adopt a stored value into a lost anchor, and record a
    // chain break if the retained chain no longer reaches a key this node holds.
    //
    // Like the prekey pass above, a failure here does NOT fail startup. Under
    // effective `requireE2EE` the disposition is a policy decision the caller
    // makes from `readE2eeContinuity` (§5.5 U2, §11.2 P23); custody has nothing to
    // say about whether a node that cannot advertise may still relay.
    await (async () => {
      const state = await stateStore.readOrCreate();
      if (state.activeNode === null) return;
      await evaluateContinuity(state.activeNode.hubOrigin);
    })().catch(() => undefined);

    // §12.4: the effective policy is recomputed deterministically from durable
    // configuration on every start, and an absent configured value leaves the
    // committed one untouched.
    //
    // A failure here does NOT fail startup, and the consequence is deliberate
    // rather than lenient: the client stays at §12.4's fail-closed policy with
    // generation 0, so this node advertises nothing (§5.7) and every channel takes
    // the effective-`requireE2EE` branch of §5.5 — FATAL-PRE with the generic
    // §11.2 surface. That is §7.6.1's "fail rather than start and close every
    // channel one at a time", applied to the connector rather than to the whole
    // server: the alternative reachable here is a process abort whose operator
    // message would name the wrong remedy, and the §5.7 condition this most often
    // is — a generation below the anchor's high-water mark — is repaired by the
    // recovery command, not by a restart.
    await policyClient
      .start(options.e2eePolicy ?? {})
      .then(() => undefined)
      .catch(() => undefined);
  };
  let startupRun: Promise<void> | undefined;
  const completeStartup = (): Promise<void> => {
    startupRun ??= startup().catch((error: unknown) => {
      startupRun = undefined;
      throw error;
    });
    return startupRun;
  };
  if (options.deferStartup !== true) await completeStartup();

  return {
    backend: secretStore.backend,
    completeStartup,
    readState: () => bounded("identity_unavailable", () => stateStore.readOrCreate()),
    readActiveFingerprint: () =>
      bounded("identity_unavailable", async () => {
        const state = await stateStore.readOrCreate();
        if (state.pendingTeardown !== null || state.activeNode === null) return null;
        const descriptor = await signingIdentity.getPublicDescriptor(
          state.activeNode.activeKeySecretName,
        );
        return formatNodePublicKeyFingerprint(descriptor.fingerprint);
      }),
    leave: () =>
      bounded("identity_unavailable", async () => {
        const state = await stateStore.readOrCreate();
        if (state.pendingTeardown !== null) {
          // A previous attempt committed but did not finish. Finish that one
          // rather than starting a second, so its secret list is not lost.
          await completeTeardown(state.pendingTeardown.secretNames);
          return;
        }
        const secretNames = await ownedSecretNames(state);
        if (
          state.activeNode === null &&
          state.pendingEnrollment === null &&
          state.stagedRotation === null
        ) {
          if (state.protectedStoreBackend !== null) {
            await stateStore.reset();
          }
          // Nothing to erase. Idempotent by design: the panel may retry a leave
          // whose response was lost.
          return;
        }
        // Phase one: record the intent, and everything it must erase, before
        // touching either store.
        await stateStore.update((current) => ({
          ...current,
          revision: current.revision + 1,
          pendingTeardown: { secretNames, requestedAt: now() },
        }));
        await completeTeardown(secretNames);
      }),
    readPendingEnrollment: (hubOrigin) =>
      bounded("identity_unavailable", async () => {
        const state = await stateStore.readOrCreate();
        const pending = state.pendingEnrollment;
        // A ceremony being torn down is not one an approver should still be
        // shown, so a cleanup-marked record reads as absent.
        if (
          pending === null ||
          (pending.kind ?? "device-code") !== "device-code" ||
          pending.cleanupRequested
        ) {
          return null;
        }
        if (pending.hubOrigin !== canonicalizeHubOrigin(hubOrigin)) return null;
        const descriptor = await signingIdentity.getPublicDescriptor(pending.keySecretName);
        return {
          deviceCode: pending.deviceCode,
          label: pending.label,
          fingerprint: descriptor.fingerprint,
          algorithm: descriptor.algorithm,
          expiresAt: pending.expiresAt,
          pollIntervalMs: pending.pollIntervalMs,
        };
      }),
    startEnrollment: (hubOrigin, metadata) =>
      bounded("enrollment_failed", () => enrollment.start(hubOrigin, metadata)),
    pollEnrollment: async (hubOrigin) => {
      const result = await bounded("enrollment_failed", () => enrollment.poll(hubOrigin));
      // An enrollment that completed is a node that now has an identity and no
      // certificate bound to it. Issuing here rather than at the next restart
      // is what lets the first channel after enrollment advertise E2EE.
      if (result.status === "approved") await maintainPrekeyQuietly();
      return result;
    },
    cancelEnrollment: (hubOrigin) =>
      bounded("enrollment_failed", () => enrollment.cancel(hubOrigin)),
    nativeNodeClaim: {
      prepare: (hubOrigin) => nativeNodeClaim.prepare(hubOrigin),
      sign: (input) => nativeNodeClaim.sign(input),
      commit: async (input) => {
        const active = await nativeNodeClaim.commit(input);
        // The identity commit is authoritative and has already landed. Prekey
        // issuance is the same best-effort post-commit maintenance used by
        // device-code enrollment; the advertised path repairs it on demand.
        await maintainPrekeyQuietly();
        return active;
      },
    },
    createRelayAuthenticationFrame: async (hubOrigin, protocol) => {
      try {
        return await proof.createRelayAuthenticationFrame(hubOrigin, protocol);
      } catch (error) {
        throw new HubRelayAuthenticationError(
          error instanceof HubNodeProofClientError ? error.failure : "identity_unavailable",
        );
      }
    },
    // Both rotation entry points re-issue the prekey the moment the rotation
    // reaches `activated`, because that is the moment the authentication-key
    // selector starts returning the incoming key and the stored certificate
    // stops matching §7.3 element 4. Waiting for a restart would take the node
    // off E2EE for as long as it keeps running, which under effective
    // `requireE2EE` is a fatal pre-key condition on every channel (§11.2).
    stageKeyRotation: async (hubOrigin, rotationOptions) => {
      const status = await bounded("rotation_failed", () =>
        rotation.stage(hubOrigin, rotationOptions),
      );
      if (status.status === "activated") await maintainPrekeyQuietly();
      return status;
    },
    resumeKeyRotation: async (hubOrigin) => {
      const status = await bounded("rotation_failed", () => rotation.resume(hubOrigin));
      if (status.status === "activated") await maintainPrekeyQuietly();
      return status;
    },
    confirmAuthenticatedKey: (hubOrigin, keyId) =>
      bounded("rotation_failed", () => rotation.confirmNewKeyAuthenticated(hubOrigin, keyId)),
    // These four report `NodeIdentityContinuityError` rather than flattening
    // continuity failures into the identity error union, for the reason the
    // prekey operations do: §7.5's unresolvable state has its own remedy and its
    // own §5.5 U2 disposition, and `identity_unavailable` would erase the
    // distinction the operator has to act on.
    //
    // `readE2eeContinuity` additionally reports `HubIdentityRuntimeError` with
    // `identity_unavailable`, and only that, for the one condition that is not
    // about continuity at all: this node has no identity enrolled at the origin
    // asked about, so there is no lineage question to answer. It never raises a
    // signing or custody error — §7.5's own answer for key material the node no
    // longer holds is a broken chain, which it returns as `advertisable` with a
    // `chainBreak` — and it never raises the unresolvable state as an error,
    // because §5.5 U2 is a status this contract returns.
    readE2eeContinuity: (hubOrigin) => evaluateContinuity(hubOrigin),
    breakE2eeContinuity: async () => {
      await continuityStore.recordBreak({ reason: "operator_break", at: now() });
    },
    adoptE2eeContinuityId: (continuityId) => continuityStore.adoptContinuityId(continuityId, now()),
    remintE2eeContinuityId: () =>
      continuityStore.breakAndRemint({ reason: "operator_break", at: now() }),
    readE2eePrekeyCertificate: (hubOrigin) => prekeys.advertised(hubOrigin),
    readStoredE2eePrekey: (hubOrigin) => prekeys.stored(hubOrigin),
    rotateE2eePrekey: (hubOrigin) => prekeys.rotate(hubOrigin),
    withE2eePrekeySecret: (hubOrigin, prekeyId, use) =>
      prekeys.withPrekeySecret(hubOrigin, prekeyId, use),
    e2eePolicy: () => policyClient.policy(),
    readE2eeAdvertisement: (hubOrigin) => statements.advertised(hubOrigin),
    registerE2eeChannel: () => policyClient.registerChannel(),
    e2eeClientAuthorization: authorizationClient,
    e2eeAuthorizationAdmin: authorizationClient,
    crossDeviceApproval,
    localIntroduction,
    e2eeGeneration: () => policyClient.generation(),
    applyE2eePolicy: (proposal) => policyClient.applyChange(proposal),
    previewE2eePolicy: (proposal) => policyClient.preview(proposal),
    recoverE2eeGeneration: () => policyClient.recoverGeneration(),
    recordE2eeFallback: (occurrence) => fallbackCounter.record(occurrence),
    readE2eeFallbackState: () => fallbackCounter.read(),
    resetE2eeFallbackState: () => fallbackCounter.reset(),
    stopE2eeInstrumentation: () => fallbackCounter.stop().catch(() => undefined),
  };
}

export const HubIdentityRuntimeLive = Layer.effect(
  HubIdentityRuntime,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* Effect.tryPromise({
      try: () =>
        makeHubIdentityRuntime({
          statePath: config.hubIdentityStatePath,
          fileSecretRoot: `${config.secretsDir}/hub-node`,
          allowFileFallback: config.hubConnector?.allowFileSecretStore ?? false,
        }),
      catch: () => new HubIdentityRuntimeError("identity_unavailable"),
    });
  }),
);
