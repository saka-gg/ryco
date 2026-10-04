import { dirname, join } from "node:path";

import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import { WsHostedRpcGroup } from "@ryco/contracts";
import type { NodeE2eeAdmissionPolicy } from "@ryco/contracts/native-e2ee";

import { AgentControlExternalTopologyService } from "../agentControl/Services/AgentControlExternalTopology.ts";
import { DEFAULT_HUB_CONNECTOR_CONFIG, ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  makeRpcByteSession,
  RpcInboundRejectedError,
  RpcOutputRefusedError,
} from "../ws/RpcByteSession.ts";
import { relayRpcPrincipal } from "../ws/RpcPrincipal.ts";
import { makeDeviceWsRpcLayer } from "../ws/index.ts";
import { makeServerWsRpcLayer } from "../ws.ts";
import { HubConnector } from "./HubConnector.ts";
import { hubConnectorConfigWithoutKeyCustody } from "./HubConnectorStandby.ts";
import {
  HubIdentityRuntimeError,
  type HubIdentityRuntimeShape,
  makeHubIdentityRuntime,
} from "./HubIdentityRuntime.ts";
import {
  type HubIdentityProcessLock,
  makeHubIdentityProcessLock,
} from "../hubIdentity/HubIdentityProcessLock.ts";
import { makeLocalHubIdentityStateStore } from "../hubIdentity/LocalHubIdentityState.ts";
import type { NodeE2eeAdvertisementResult } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import type { NodeE2eeFallbackState } from "../hubIdentity/NodeE2eeFallbackCounter.ts";
import type { NodeLocalIntroductionService } from "../hubIdentity/NodeLocalIntroductionService.ts";
import type { NodeNativeClaimService } from "../hubIdentity/NodeNativeClaimService.ts";
import { NODE_E2EE_FAIL_CLOSED_POLICY } from "../hubIdentity/NodeE2eePolicyStore.ts";
import { makeHubRelayTransport } from "./HubRelayTransport.ts";
import {
  makeNodeE2eeChannelAdvertiser,
  nodeE2eeAdvertisementAnnouncement,
} from "./NodeE2eeChannelAdvertiser.ts";
import {
  makeNodeE2eeChannelSession,
  makeNodeE2eeHandshakeRateLimiter,
  type NodeE2eeChannelSession,
} from "./NodeE2eeChannelSession.ts";
import { makeNodeE2eeOperator } from "./NodeE2eeOperator.ts";
import {
  makeNodeE2eeRelayChannelSession,
  nodeE2eeChannelPlaintextCeiling,
} from "./NodeE2eeRelayChannel.ts";
import { makeNodeE2eeSessionDirectory } from "./NodeE2eeSessionDirectory.ts";
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
import type { RelayChannelSessionFactory } from "./RelayChannelRegistry.ts";

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
 * The E2EE surface of a runtime that can never serve a channel.
 *
 * Both stubs below are used in configurations where no relay channel is
 * reachable at all — the connector is switched off, or it is permanently
 * degraded — so nothing here decides a live channel's disposition. It is still
 * §12.4's fail-closed answer rather than a permissive one: a runtime that cannot
 * read its durable policy does not know what it promised, so it promises the
 * most and advertises nothing (§5.5 U2, §5.7).
 */
const e2eeOperatorUnavailable = async (): Promise<never> => {
  throw new HubIdentityRuntimeError("identity_unavailable");
};

const offlineE2eeSurface = {
  e2eePolicy: () => NODE_E2EE_FAIL_CLOSED_POLICY,
  readE2eeAdvertisement: async (): Promise<NodeE2eeAdvertisementResult> => ({
    kind: "unavailable",
    reason: "identity_unavailable",
  }),
  recordE2eeFallback: async () => undefined,
  stopE2eeInstrumentation: async () => undefined,
  readE2eeFallbackState: (): NodeE2eeFallbackState => ({
    windowStartedAt: undefined,
    classes: {
      "peer-legacy": { occurrences: 0, ringOverflows: 0, lastOccurrenceAt: undefined },
      "advertisement-unavailable": {
        occurrences: 0,
        ringOverflows: 0,
        lastOccurrenceAt: undefined,
      },
    },
    ring: [],
  }),
  // A channel that cannot exist needs no sweep registration and no Branch A
  // read. These are the shapes those seams have, answering "nothing is
  // registered" and "no record exists" — which is also §8.6 step 6's refusal.
  registerE2eeChannel: () => ({
    selectHandshake: () => ({
      establish: () => ({ kind: "entered" as const, established: () => undefined }),
    }),
    lockLegacy: () => ({ kind: "entered" as const }),
    release: () => undefined,
  }),
  e2eeClientAuthorization: {
    lookupClientAuthorization: () => undefined,
    reReadAuthorization: () => undefined,
    registerInFlightHandshake: () => ({
      establish: () => ({ kind: "refused" as const, reason: "authorization_withdrawn" as const }),
      release: () => undefined,
    }),
    // §13.2 step 3 for a runtime that holds no record set at all: there is no
    // pending slot for a record to be created in, so the decision is the one
    // that creates nothing and the commit owes nothing. The refusal reason is
    // §13.6 instrumentation for a listing this surface also cannot serve.
    evaluatePairingAdmission: () => ({
      kind: "refused" as const,
      reason: "pending_cap_global" as const,
      spentPairingWindow: undefined,
    }),
    commitPairingAdmission: async () => undefined,
  },
  // The owner commands are the one part of the E2EE surface that is NOT
  // answerable offline. A withdrawal's acknowledgement means "no channel
  // admitted under the withdrawn authority is still open" (§13.6), and a stub
  // that returned success would say exactly that about a record it never
  // committed. Refusing is the only honest answer, and it is the same answer the
  // rest of this runtime gives for an identity it cannot open.
  e2eeAuthorizationAdmin: {
    list: e2eeOperatorUnavailable,
    get: e2eeOperatorUnavailable,
    approve: e2eeOperatorUnavailable,
    narrow: e2eeOperatorUnavailable,
    revoke: e2eeOperatorUnavailable,
    purge: e2eeOperatorUnavailable,
    setDisplayLabel: e2eeOperatorUnavailable,
    openPairingWindow: e2eeOperatorUnavailable,
    closePairingWindow: e2eeOperatorUnavailable,
    clearRefusedPairingAttempts: () => undefined,
    sweepExpired: e2eeOperatorUnavailable,
  },
  crossDeviceApproval: {
    create: e2eeOperatorUnavailable,
  },
  localIntroduction: {
    descriptor: e2eeOperatorUnavailable,
    complete: e2eeOperatorUnavailable,
  },
  nativeNodeClaim: {
    prepare: e2eeOperatorUnavailable,
    sign: e2eeOperatorUnavailable,
    commit: e2eeOperatorUnavailable,
  },
  // 0 is the generation that has never been issued, which is the truthful
  // reading for a runtime that must not advertise at all (§5.7).
  e2eeGeneration: () => 0,
  applyE2eePolicy: e2eeOperatorUnavailable,
  previewE2eePolicy: () => ({
    policy: NODE_E2EE_FAIL_CLOSED_POLICY,
    withdrawal: false,
    changed: false,
    counts: { legacy: 0, nxE2ee: 0, suiteWithdrawn: 0, abortedHandshakes: 0 },
  }),
  // §5.7's recovery advances a DURABLE generation and a durable high-water mark.
  // A runtime with no identity has neither, and answering would report a jump
  // that nothing committed.
  recoverE2eeGeneration: e2eeOperatorUnavailable,
  resetE2eeFallbackState: e2eeOperatorUnavailable,
} as const satisfies Pick<
  HubIdentityRuntimeShape,
  | "e2eePolicy"
  | "readE2eeAdvertisement"
  | "recordE2eeFallback"
  | "readE2eeFallbackState"
  | "resetE2eeFallbackState"
  | "stopE2eeInstrumentation"
  | "registerE2eeChannel"
  | "e2eeClientAuthorization"
  | "e2eeAuthorizationAdmin"
  | "crossDeviceApproval"
  | "localIntroduction"
  | "nativeNodeClaim"
  | "e2eeGeneration"
  | "applyE2eePolicy"
  | "previewE2eePolicy"
  | "recoverE2eeGeneration"
>;

/**
 * The runtime a node gets when key custody could not be constructed at all.
 *
 * Every method throws for the lifetime of the process, so `resume()` provably
 * cannot repair it. It reports `identity_store_unavailable` rather than
 * `identity_unavailable` so the panel can say "restart Ryco" and withhold a
 * Retry button that would do nothing.
 */
const unavailableIdentity = (): HubIdentityRuntimeShape => {
  const unavailable = async (): Promise<never> => {
    throw new HubIdentityRuntimeError("identity_store_unavailable");
  };
  return {
    ...offlineE2eeSurface,
    backend: "permissioned-file",
    readState: unavailable,
    readPendingEnrollment: unavailable,
    leave: unavailable,
    startEnrollment: unavailable,
    pollEnrollment: unavailable,
    cancelEnrollment: unavailable,
    createRelayAuthenticationFrame: unavailable,
    stageKeyRotation: unavailable,
    resumeKeyRotation: unavailable,
    confirmAuthenticatedKey: unavailable,
    readE2eePrekeyCertificate: unavailable,
    readStoredE2eePrekey: unavailable,
    rotateE2eePrekey: unavailable,
    withE2eePrekeySecret: unavailable,
    readE2eeContinuity: unavailable,
    breakE2eeContinuity: unavailable,
    adoptE2eeContinuityId: unavailable,
    remintE2eeContinuityId: unavailable,
  };
};

/**
 * A runtime that can answer "is this node enrolled?" and nothing else.
 *
 * Used when the connector is switched off. Constructing the full runtime would
 * open the platform credential store — a keychain prompt on every launch for
 * users who never touch Hub — but identity *presence* lives in the local state
 * file and needs no key custody to read.
 *
 * Without this, a disabled connector reports `unknown`, which callers must treat
 * as "possibly enrolled". On a fresh install that locks the Hub address field
 * and offers a Leave button, making the feature impossible to configure.
 */
const readOnlyIdentity = (options: {
  readonly statePath: string;
  readonly fileSecretRoot: string;
  readonly allowFileFallback: boolean;
  readonly makeIdentityRuntime: HubConnectorLiveDependencies["makeIdentityRuntime"];
}): HubIdentityRuntimeShape => {
  const unavailable = async (): Promise<never> => {
    throw new HubIdentityRuntimeError("identity_unavailable");
  };
  return {
    ...offlineE2eeSurface,
    backend: "permissioned-file",
    readState: async () => {
      const store = await makeLocalHubIdentityStateStore(options.statePath);
      return store.readOrCreate();
    },
    /**
     * Erasing an identity is the one operation that must still work here.
     *
     * The panel offers "Leave this Hub" precisely in this configuration —
     * enrolled, connector switched off — so a stub that throws would report a
     * fabricated "keychain is locked" and leave the key on disk with no way to
     * remove it. Opening key custody is what the operator just asked for, so the
     * full runtime is built on demand rather than on every launch.
     */
    leave: async () => {
      const runtime = await options.makeIdentityRuntime({
        statePath: options.statePath,
        fileSecretRoot: options.fileSecretRoot,
        allowFileFallback: options.allowFileFallback,
      });
      await runtime.leave();
    },
    readPendingEnrollment: unavailable,
    startEnrollment: unavailable,
    pollEnrollment: unavailable,
    cancelEnrollment: unavailable,
    createRelayAuthenticationFrame: unavailable,
    stageKeyRotation: unavailable,
    resumeKeyRotation: unavailable,
    confirmAuthenticatedKey: unavailable,
    readE2eePrekeyCertificate: unavailable,
    readStoredE2eePrekey: unavailable,
    rotateE2eePrekey: unavailable,
    withE2eePrekeySecret: unavailable,
    readE2eeContinuity: unavailable,
    breakE2eeContinuity: unavailable,
    adoptE2eeContinuityId: unavailable,
    remintE2eeContinuityId: unavailable,
  };
};

/**
 * The two things `HubConnectorLive` opens on this machine: the identity's
 * process lock and its key custody.
 *
 * Injectable so the composition that decides who may use the identity — the
 * lock taken before the runtime is built, startup deferred for a backend that
 * lost it, and every surface that writes what the owner relies on gated behind
 * it — can be tested as it is wired, without a second process or a credential
 * store.
 */
export interface HubConnectorLiveDependencies {
  readonly makeProcessLock: (path: string) => HubIdentityProcessLock;
  readonly makeIdentityRuntime: typeof makeHubIdentityRuntime;
}

const machineDependencies: HubConnectorLiveDependencies = {
  makeProcessLock: (path) => makeHubIdentityProcessLock({ path }),
  makeIdentityRuntime: makeHubIdentityRuntime,
};

const makeHubConnectorService = (dependencies: HubConnectorLiveDependencies) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const externalTopology = yield* AgentControlExternalTopologyService;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromiseWith(runtimeContext as Context.Context<R>)(effect);
    // Beside the identity it guards, so every backend sharing that identity —
    // the desktop's child and a `ryco serve` on the same state directory —
    // contends for the same file.
    const processLock = dependencies.makeProcessLock(
      join(dirname(config.hubIdentityStatePath), "hub-connector.lock"),
    );
    // Taken before the full runtime is built, because building it runs startup
    // work that writes what the identity's owner relies on. A backend that finds
    // the lock held builds the runtime with that work deferred, and its
    // connector runs it once it takes the lock over. The connector hands it back
    // as it stops, before the §12.5 flush below; releasing it here as well
    // covers a layer that failed before the connector existed.
    //
    // An unusable lock is asked once more before startup runs without it: that
    // answer lets this backend do the owner's work, so it has to mean the lock
    // cannot be used, not that one filesystem call lost a race.
    const identityClaim = config.hubConnector?.enabled
      ? yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const claim = await processLock.acquire();
            return claim === "unavailable" ? processLock.acquire() : claim;
          }),
          () => Effect.promise(() => processLock.release()),
        )
      : undefined;
    const readOnly = () =>
      readOnlyIdentity({
        statePath: config.hubIdentityStatePath,
        fileSecretRoot: `${config.secretsDir}/hub-node`,
        allowFileFallback: config.hubConnector?.allowFileSecretStore ?? false,
        makeIdentityRuntime: dependencies.makeIdentityRuntime,
      });
    const custody = config.hubConnector?.enabled
      ? yield* Effect.tryPromise({
          try: () =>
            dependencies.makeIdentityRuntime({
              statePath: config.hubIdentityStatePath,
              fileSecretRoot: `${config.secretsDir}/hub-node`,
              allowFileFallback: config.hubConnector?.allowFileSecretStore ?? false,
              // §12.4: an option no configuration source set stays unset here,
              // where it means "leave the committed value alone" — never
              // "false". The proposal is the operator's statement for this run,
              // and a narrowing one runs the full §12.6 procedure.
              e2eePolicy: {
                mode: config.hubE2eePolicy?.mode,
                requireE2EE: config.hubE2eePolicy?.requireE2EE,
                requireApprovedClientE2EE: config.hubE2eePolicy?.requireApprovedClientE2EE,
              },
              deferStartup: identityClaim === "held",
            }),
          catch: () => new HubIdentityRuntimeError("identity_unavailable"),
        }).pipe(Effect.option)
      : Option.none();
    const hubConfig = config.hubConnector ?? DEFAULT_HUB_CONNECTOR_CONFIG;
    const quietStandby =
      hubConfig.enabled && Option.isNone(custody)
        ? hubConnectorConfigWithoutKeyCustody(hubConfig)
        : null;
    const connectorConfig = quietStandby ?? hubConfig;
    const identity = Option.isSome(custody)
      ? custody.value
      : connectorConfig.enabled
        ? unavailableIdentity()
        : readOnly();

    /**
     * The §5.2 advertiser for this connector's origin.
     *
     * Built even when the connector is disabled or its origin is unset: it is
     * only ever driven from a live relay connection, which neither configuration
     * can reach, and giving it a placeholder origin keeps the factory below one
     * shape rather than two. The statement builder refuses a non-origin at its
     * own boundary (§7.1), so the placeholder cannot become an advertisement.
     */
    const advertiser = makeNodeE2eeChannelAdvertiser({
      hubOrigin: config.hubConnector?.origin ?? "",
      readAdvertisement: (hubOrigin) => identity.readE2eeAdvertisement(hubOrigin),
      policy: () => identity.e2eePolicy(),
      recordFallback: (occurrence) => identity.recordE2eeFallback(occurrence),
      // Node-local and never wire-visible (§5.5, §11.2). It names the condition
      // and, for U1, both figures §5.5 requires; it carries no account, channel,
      // session, key, or payload data, and no statement bytes.
      onDiagnostic: (diagnostic) => {
        void runPromise(Effect.logWarning("relay E2EE advertisement unavailable", diagnostic));
      },
    });

    /**
     * §15 / §8.6 step 1: the pre-authentication handshake-attempt bucket, per
     * Hub origin and therefore per connector rather than per channel.
     */
    const handshakeRateLimiter = makeNodeE2eeHandshakeRateLimiter();

    /**
     * §13.5's node-side reader: the sessions established right now.
     *
     * In memory and per process, because the value it carries is ephemeral
     * display state that §13.5 forbids logging or persisting, and because a
     * session that did not survive a restart has no code left to compare.
     */
    const sessionDirectory = makeNodeE2eeSessionDirectory();

    /**
     * §4.5's `plaintextCeiling`, taken once from the connection's asserted
     * limits through the single derivation `e2eeChannelSizeBudget` owns.
     *
     * A property of the connection and not of a channel, which is exactly what
     * `connectionReady` is for. `undefined` until a `ready` frame settles the
     * limits, which the registry makes unreachable — it calls `connectionReady`
     * as it is constructed, and a channel can only be opened through a
     * constructed registry.
     */
    let plaintextCeiling: number | undefined;
    let connector: HubConnector;

    const channelFactory: RelayChannelSessionFactory = {
      connectionReady: ({ limits }) => {
        plaintextCeiling = nodeE2eeChannelPlaintextCeiling(limits);
        advertiser.connectionReady({ maxDataChunkBytes: limits.maxDataChunkBytes });
      },
      open: async ({
        channelId,
        capability,
        effectiveRole,
        protocolMajor,
        protocolMinor,
        accountGrantContext,
        connection,
        send,
        admit,
        close,
      }) => {
        // Ahead of the announcement hook, deliberately: this reads key custody
        // and may sign, and the hook may do neither (§5.4,
        // `RelayRpcChannelSession.onAccepted`). By the time `onAccepted` runs,
        // the carrier is bytes in hand and the announcement is one `send`.
        const announcement =
          accountGrantContext === undefined
            ? await advertiser.openChannel()
            : (() => {
                const advertisement = connector.accountGrantAdvertisement(accountGrantContext[3]);
                if (advertisement === undefined) {
                  throw new Error("Account-grant statement is not available for this channel.");
                }
                return nodeE2eeAdvertisementAnnouncement(advertisement);
              })();
        const connectionIdentity = connection();
        let e2ee: NodeE2eeChannelSession;
        e2ee = makeNodeE2eeChannelSession({
          // §8.3: the node's own channel state, never a value a peer supplies.
          // The Hub origin is the one this connector is configured for and the
          // one the advertised statement was built for; a channel that opened
          // before the connection authenticated has no node id yet, and the
          // handshake's own context reconstruction refuses such a channel rather
          // than inventing one.
          channel: {
            hubOrigin: connectionIdentity?.hubOrigin ?? config.hubConnector?.origin ?? "",
            channelId,
            relayProtocolMajor: protocolMajor,
            relayProtocolMinor: protocolMinor,
            channelOpenCapability: capability,
            channelOpenEffectiveRole: effectiveRole,
            ...(accountGrantContext === undefined
              ? {}
              : {
                  accountGrantContext: {
                    relayTicketId: accountGrantContext[1],
                    deviceGrantDigest: Uint8Array.from(accountGrantContext[2]),
                    nodeCapabilityStatementDigest: Uint8Array.from(accountGrantContext[3]),
                  },
                }),
          },
          announcement,
          plaintextCeiling: plaintextCeiling ?? 0,
          send,
          admit,
          close,
          policy: () => identity.e2eePolicy(),
          registerPolicyChannel: () => identity.registerE2eeChannel(),
          authorization: identity.e2eeClientAuthorization,
          verifyAccountGrant: (input) => connector.verifyAccountGrant(input),
          withPrekeySecret: (prekeyId, use) =>
            identity.withE2eePrekeySecret(
              connectionIdentity?.hubOrigin ?? config.hubConnector?.origin ?? "",
              prekeyId,
              use,
            ),
          rateLimiter: handshakeRateLimiter,
          registerSession: (session) =>
            sessionDirectory.register({
              ...session,
              terminate: () => {
                void e2ee.revokeAccountGrant();
              },
            }),
          recordPeerLegacyFallback: () => {
            void identity
              .recordE2eeFallback({
                hubOrigin: connectionIdentity?.hubOrigin ?? config.hubConnector?.origin ?? "",
                reason: "peer-legacy",
              })
              .catch(() => undefined);
          },
          // Node-local and never wire-visible (§11.4): a §11 row and a §10.4
          // verdict, both computed here, and no payload, key, or account detail.
          onDiagnostic: (value) => {
            void runPromise(Effect.logDebug("relay E2EE channel terminated", value));
          },
        });
        const scope = await runPromise(Scope.make("sequential"));
        try {
          const session = await runPromise(
            makeRpcByteSession(
              WsHostedRpcGroup,
              Layer.merge(
                makeServerWsRpcLayer(relayRpcPrincipal(effectiveRole, channelId)),
                makeDeviceWsRpcLayer(relayRpcPrincipal(effectiveRole, channelId)),
              ),
              // A refused response is a value carrying its reason, not a defect,
              // which would kill the RPC server fiber and every request on it.
              // The byte session waits out backpressure and fails an oversized
              // response's own request; anything it cannot deliver ends the
              // channel through `onOutputFailure` below. On an `e2ee` channel
              // this is also the §4.2 send pipeline — the ceiling, the §9.3
              // admission, the pair, the AEAD, and the envelope.
              (bytes) =>
                Effect.promise(() => e2ee.emit(bytes)).pipe(
                  Effect.flatMap((result) =>
                    result === "sent"
                      ? Effect.void
                      : Effect.fail(new RpcOutputRefusedError(result)),
                  ),
                ),
              {
                queueCapacity: 64,
                // A lost response would leave its request — or, with acknowledged
                // streams, its whole subscription — waiting forever. Ending the
                // channel makes the client reconnect and resubscribe instead.
                onOutputFailure: (failure) => {
                  void runPromise(Effect.logWarning("relay RPC output failed", { failure }));
                  e2ee.abandon();
                },
                // §4.3: discrimination on the reassembled, prelude-stripped
                // payload, and the only path to the RPC parser.
                interceptor: (message) =>
                  Effect.promise(() => e2ee.intercept(message)).pipe(
                    Effect.flatMap((disposition) =>
                      disposition.kind === "rejected"
                        ? Effect.fail(new RpcInboundRejectedError())
                        : Effect.succeed(disposition),
                    ),
                  ),
                // The channel-fatal verdict has already emitted its §11 record
                // and asked for the close by the time this runs; nothing further
                // is owed here.
                onInboundRejected: () => undefined,
              },
            ).pipe(Effect.provideService(Scope.Scope, scope)),
          );
          // The lifecycle — §10's close, §10.4's truncation input, and the §5.4
          // announcement — belongs to the binding, so the channel's only signal
          // that it is ending cannot silently bypass the authenticated close.
          return makeNodeE2eeRelayChannelSession({
            e2ee,
            rpc: {
              receive: (bytes) => runPromise(session.receive(bytes)),
              queuedBytes: () => runPromise(session.queuedBytes),
              supportsChunkedMessages: session.supportsChunkedMessages,
              incompleteReassembly: session.incompleteReassembly,
            },
            release: () => runPromise(Scope.close(scope, Exit.void)),
          });
        } catch (error: unknown) {
          e2ee.dispose();
          await runPromise(Scope.close(scope, Exit.void));
          throw error;
        }
      },
    };

    connector = new HubConnector({
      config: connectorConfig,
      identity,
      transport: makeHubRelayTransport(),
      channels: channelFactory,
      enrollmentMetadata: {
        label: descriptor.label,
        platformOs: descriptor.platform.os,
        platformArch: descriptor.platform.arch,
        clientVersion: descriptor.serverVersion,
      },
      onE2eeEnrollmentRevoked: async (frame) => {
        await sessionDirectory.revokeEnrollment(frame);
      },
      processLock,
      // Only a lock actually held: past an unusable one the connector asks
      // again each time it needs the identity.
      ownsIdentity: identityClaim === "acquired",
      // A standby connector may gain its identity in this process; external
      // integrations it left running close before this node is reachable.
      beforeConnect: () => runPromise(externalTopology.yieldToHub),
    });
    const asIdentityOwner = <A>(operation: () => Promise<A>) =>
      connector.asIdentityOwner(operation);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        void connector.start();
        return connector;
      }),
      // The connector first, then §12.5's clean-shutdown flush: an occurrence
      // recorded by a channel the teardown closes must be in the commit, not
      // behind it.
      (active) =>
        Effect.promise(async () => {
          await active.stop();
          await identity.stopE2eeInstrumentation();
        }),
    );
    return {
      status: () => connector.status(),
      resume: () => connector.resume(),
      enroll: () => connector.enroll(),
      readEnrollment: () => connector.readEnrollment(),
      identitySummary: (options) => connector.identitySummary(options),
      leave: () => connector.leave(),
      cancelEnrollment: () => connector.cancelEnrollment(),
      stop: () => connector.stop(),
      // Both commit what the identity's owner relies on — an approved client,
      // an active node — so neither runs while another local process owns it.
      localIntroduction: {
        descriptor: () => asIdentityOwner(() => identity.localIntroduction.descriptor()),
        complete: (input) => asIdentityOwner(() => identity.localIntroduction.complete(input)),
      },
      nativeNodeClaim: {
        prepare: (hubOrigin) => asIdentityOwner(() => identity.nativeNodeClaim.prepare(hubOrigin)),
        sign: (input) => asIdentityOwner(() => identity.nativeNodeClaim.sign(input)),
        commit: (input) => asIdentityOwner(() => identity.nativeNodeClaim.commit(input)),
      },
      e2ee: makeNodeE2eeOperator({
        identity,
        sessions: sessionDirectory,
        asIdentityOwner,
        // §12.5 Display: the live §5.5 U1 pair, read from the connection the
        // advertiser is on right now. It is not in the durable counter and must
        // not be — §12.5 says the pair is not retained in the ring.
        undersizedConnection: () => advertiser.undersizedConnection(),
        // Read per call rather than captured: the configured origin is what the
        // prekey and lineage records are keyed by, and a connector that is
        // reconfigured between two operator commands must not answer the second
        // one about the first one's origin.
        hubOrigin: () => config.hubConnector?.origin ?? "",
        onAdvertisementChanged: () => connector.refreshE2eeState(),
      }),
    } satisfies HubConnectorServiceShape;
  });

export const makeHubConnectorLive = (
  dependencies: HubConnectorLiveDependencies = machineDependencies,
) => Layer.effect(HubConnectorService, makeHubConnectorService(dependencies));

export const HubConnectorLive = makeHubConnectorLive();
