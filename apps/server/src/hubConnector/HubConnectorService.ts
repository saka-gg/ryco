/**
 * HubConnectorService - the Hub connector as the owner-authenticated routes see it.
 *
 * Kept apart from `HubConnectorLive`, which carries the connector, key custody
 * and the relay E2EE stack: the routes and the server graph depend only on
 * this module, so that stack loads after the HTTP router serves.
 *
 * @module hubConnector/HubConnectorService
 */
import { Context, Effect, Layer } from "effect";
import type { NodeE2eeAdmissionPolicy } from "@ryco/contracts/native-e2ee";

import type { HubConnector } from "./HubConnector.ts";
import type { NodeLocalIntroductionService } from "../hubIdentity/NodeLocalIntroductionService.ts";
import type { NodeNativeClaimService } from "../hubIdentity/NodeNativeClaimService.ts";
import type {
  E2eeAuthorizationChangeView,
  E2eeClientListingView,
  E2eeClientRecordView,
  E2eeContinuityChangeView,
  E2eeCrossDeviceApprovalView,
  E2eeContinuityView,
  E2eeFallbackView,
  E2eePolicyChangeView,
  E2eePolicyPreviewView,
  E2eePolicyView,
  E2eePrekeyView,
  E2eeSessionListView,
} from "./e2eeOperatorContract.ts";

/**
 * One §12.6 policy proposal, as an owner states it.
 *
 * `suiteRegistry` is here because §12.6 makes a suite leaving the advertised
 * registry one of its three withdrawal classes — the one with its own sweep
 * class in step (c) — so an operator surface without it can display a
 * `suiteWithdrawn` count that no command it offers can ever produce.
 */
export interface E2eePolicyProposalInput {
  readonly mode?: NodeE2eeAdmissionPolicy | undefined;
  readonly requireE2EE?: boolean | undefined;
  readonly requireApprovedClientE2EE?: boolean | undefined;
  readonly suiteRegistry?: readonly number[] | undefined;
}

/**
 * The node's E2EE operator surface, as the owner-authenticated routes see it.
 *
 * One namespaced member rather than a dozen siblings on the connector service:
 * these are the §6.4, §7.5, §12.5, §12.6 and §13.6 owner commands, they share a
 * single precondition — an owner session on this node's own origin — and they
 * have nothing to do with the connector's enrollment lifecycle, which is what
 * the rest of this service is.
 *
 * Every mutation below returns only after the transition it names has COMPLETED,
 * including any sweep it owes. That is not a convenience: §12.6(c) and §13.6
 * both forbid acknowledging before the ordered procedure has finished, and this
 * boundary is the last place that ordering can be honoured before the answer
 * becomes an HTTP response the CLI prints as success.
 */
export interface HubConnectorE2eeOperator {
  readonly listClients: () => Promise<E2eeClientListingView>;
  readonly getClient: (key: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly fingerprint: string;
  }) => Promise<E2eeClientRecordView | undefined>;
  readonly approveClient: (input: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly fingerprint: string;
    readonly maxRole: string;
    readonly capabilitySet: readonly string[];
    readonly displayLabel?: string | undefined;
  }) => Promise<E2eeAuthorizationChangeView>;
  readonly narrowClient: (input: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly fingerprint: string;
    readonly maxRole?: string | undefined;
    readonly capabilitySet?: readonly string[] | undefined;
  }) => Promise<E2eeAuthorizationChangeView>;
  readonly revokeClient: (key: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly fingerprint: string;
  }) => Promise<E2eeAuthorizationChangeView>;
  readonly purgeClient: (key: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly fingerprint: string;
  }) => Promise<E2eeAuthorizationChangeView>;
  readonly createClientApprovalQr: (key: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly fingerprint: string;
  }) => Promise<E2eeCrossDeviceApprovalView>;
  readonly openPairingWindow: (fingerprint: string) => Promise<E2eeClientListingView>;
  readonly closePairingWindow: () => Promise<E2eeClientListingView>;
  /**
   * §13.6: the refusal count the listing shows is "bounded, owner-clearable",
   * and this is the clearing. It answers with the listing, because what an owner
   * does next is read the count they just zeroed.
   */
  readonly clearRefusedPairingAttempts: () => Promise<E2eeClientListingView>;
  readonly listSessions: () => E2eeSessionListView;
  readonly readPolicy: () => E2eePolicyView;
  readonly previewPolicy: (proposal: E2eePolicyProposalInput) => E2eePolicyPreviewView;
  readonly applyPolicy: (proposal: E2eePolicyProposalInput) => Promise<E2eePolicyChangeView>;
  /** §5.7's recovery command. Reports the same shape a policy change does. */
  readonly recoverPolicyGeneration: () => Promise<E2eePolicyChangeView>;
  /** §6.4: the prekey this node holds now, without issuing one. */
  readonly readPrekey: () => Promise<E2eePrekeyView>;
  readonly rotatePrekey: () => Promise<E2eePrekeyView>;
  /**
   * §7.5's status. Runs the chain's repairs as it reads, so it is an owner
   * operation; a backend that does not own the identity answers `identity_in_use`.
   */
  readonly readContinuity: () => Promise<E2eeContinuityView>;
  readonly adoptContinuityId: (continuityId: string) => Promise<E2eeContinuityChangeView>;
  readonly remintContinuityId: () => Promise<E2eeContinuityChangeView>;
  readonly breakContinuityChain: () => Promise<E2eeContinuityChangeView>;
  readonly readFallback: () => E2eeFallbackView;
  readonly resetFallback: () => Promise<E2eeFallbackView>;
}

export interface HubConnectorServiceShape {
  /**
   * Whether this backend runs its connector at all. A standby launch resolves
   * to off for an existing identity, or where key custody cannot be built.
   */
  readonly connectorEnabled: boolean;
  readonly status: HubConnector["status"];
  readonly resume: HubConnector["resume"];
  readonly enroll: HubConnector["enroll"];
  readonly readEnrollment: HubConnector["readEnrollment"];
  readonly identitySummary: HubConnector["identitySummary"];
  readonly leave: HubConnector["leave"];
  readonly cancelEnrollment: HubConnector["cancelEnrollment"];
  readonly stop: HubConnector["stop"];
  /** Desktop-main-only trust introduction; never exposed through WS RPC. */
  readonly localIntroduction: NodeLocalIntroductionService;
  /** Desktop-main-only automatic node claim; never exposed through WS RPC. */
  readonly nativeNodeClaim: NodeNativeClaimService;
  readonly e2ee: HubConnectorE2eeOperator;
}

export class HubConnectorService extends Context.Service<
  HubConnectorService,
  HubConnectorServiceShape
>()("ryco/hubConnector/HubConnectorService") {}

/**
 * Access to the connector once its key custody is built.
 *
 * The server builds the connector after the router serves (`HubConnectorDeferred`),
 * so a Hub route that arrives first waits here — the way the startup gate held it
 * before — and nothing uses the identity before custody has completed.
 */
export interface HubConnectorReadyShape {
  readonly await: Effect.Effect<HubConnectorServiceShape>;
}

export class HubConnectorReady extends Context.Service<HubConnectorReady, HubConnectorReadyShape>()(
  "ryco/hubConnector/HubConnectorReady",
) {}

/** The connector, waiting for its construction if it is still under way. */
export const awaitHubConnector: Effect.Effect<HubConnectorServiceShape, never, HubConnectorReady> =
  Effect.gen(function* () {
    const ready = yield* HubConnectorReady;
    return yield* ready.await;
  });

/** Access to a connector that already exists (tests, and composition around a built one). */
export const hubConnectorReadyLayer = (service: HubConnectorServiceShape) =>
  Layer.succeed(HubConnectorReady, { await: Effect.succeed(service) });
