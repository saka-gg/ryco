import {
  createNativeE2eeTrustResolver,
  getHostedHubApi,
  hostedHubStore,
  type NativeE2eeReadyEnrollment,
} from "@ryco/client-runtime/authorization";
import {
  type RelayE2eeInitiatorAttempt,
  type RelayE2eeProvider,
  HostedRelayPreparationError,
} from "@ryco/client-runtime/relay";
import { E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 } from "@ryco/shared/relayE2eeWire";

import { mobileNativeE2eePlatform } from "../platform/nativeE2ee";
import { isE2eePairingRecord, isE2eeVerifiedPinRecord } from "../platform/e2eeTrustModel";
import { mobileE2eeTrustStore } from "../platform/e2eeTrustStore";
import {
  beginMobileE2eeChannel,
  beginMobileE2eeChannelAttempt,
  lockMobileE2eeChannelMode,
  mobileE2eeLocalRecordContext,
  observeMobileAccountE2eeStatement,
  recordMobileE2eeInitiatorDiagnostic,
} from "./e2eeSession";
import { prepareMobileRelayE2eeAttempt, resolveMobileRelayE2eeProvider } from "./e2eeAttempt";
import { getMobileNativeE2eeEnrollmentCoordinator } from "./e2eeEnrollment";
import { getMobileHostedConfig } from "./runtimeConfig";
import { makeMobileRelayE2eeProvider } from "../platform/e2eeRelayProvider";

let resolver: ReturnType<typeof createNativeE2eeTrustResolver> | null = null;

function mobileTrustResolver(): ReturnType<typeof createNativeE2eeTrustResolver> {
  resolver ??= createNativeE2eeTrustResolver({
    api: getHostedHubApi(),
    platform: mobileNativeE2eePlatform,
  });
  return resolver;
}

interface MobileRelaySelectionSnapshot {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly environmentId: string | null;
  readonly generation: number;
}

export type MobileRelaySocketContext =
  | {
      readonly kind: "local";
      readonly selection: MobileRelaySelectionSnapshot;
      readonly provider: RelayE2eeProvider;
      readonly dispose: () => void;
    }
  | {
      readonly kind: "account";
      readonly selection: MobileRelaySelectionSnapshot;
      readonly enrollment: NativeE2eeReadyEnrollment;
      readonly enrollmentGeneration: number;
      provider?: RelayE2eeProvider;
      dispose: () => void;
    };

function currentSelection(): MobileRelaySelectionSnapshot | null {
  const config = getMobileHostedConfig();
  const state = hostedHubStore.getState();
  const node = state.selectedNode;
  if (
    config === null ||
    state.accountStatus !== "authenticated" ||
    state.account === null ||
    node === null
  ) {
    return null;
  }
  return {
    hubOrigin: config.hubOrigin,
    accountId: state.account.id,
    nodeId: node.id,
    nodeLabel: node.label,
    environmentId: node.environmentId,
    generation: state.generation,
  };
}

function isCurrent(selection: MobileRelaySelectionSnapshot): boolean {
  const current = currentSelection();
  return (
    current !== null &&
    current.hubOrigin === selection.hubOrigin &&
    current.accountId === selection.accountId &&
    current.nodeId === selection.nodeId &&
    current.environmentId === selection.environmentId &&
    current.generation === selection.generation
  );
}

function trustedRecord(selection: MobileRelaySelectionSnapshot) {
  return mobileE2eeTrustStore.resolve({
    kind: "node-id-hint",
    hubOrigin: selection.hubOrigin,
    accountId: selection.accountId,
    nodeId: selection.nodeId,
  });
}

/** Prepare public state only. Ticket and grant are deliberately not issued here. */
export async function prepareMobileRelaySocketContext(): Promise<MobileRelaySocketContext> {
  const selection = currentSelection();
  if (selection === null) throw new Error("No authorized hosted node is selected.");
  const enrollmentState = getMobileNativeE2eeEnrollmentCoordinator()?.getState();
  if (enrollmentState?.status !== "ready" || enrollmentState.ready === null) {
    throw new Error("Native E2EE enrollment is not ready.");
  }
  if (
    enrollmentState.ready.namespace.hubOrigin !== selection.hubOrigin ||
    enrollmentState.ready.namespace.accountId !== selection.accountId
  ) {
    throw new Error("Native E2EE enrollment scope changed.");
  }

  const record = trustedRecord(selection);
  // Suite 0x01 for a verified pin, and for a record "Request approval" moved
  // into §13.2 pairing. Only a 0x01 hello reaches the node's §13.6 admission,
  // so it is the only channel that puts this phone's key on the pending list
  // Desktop approves from; the attempt it resolves to is pairing-only and
  // releases nothing. A 0x02 account-grant channel never creates that record.
  if (record !== null && (isE2eeVerifiedPinRecord(record) || isE2eePairingRecord(record))) {
    await prepareMobileRelayE2eeAttempt();
    if (!isCurrent(selection)) throw new Error("Hosted node selection changed.");
    const provider = resolveMobileRelayE2eeProvider();
    if (provider === undefined) throw new Error("Native E2EE key custody is unavailable.");
    return { kind: "local", selection, provider, dispose: () => undefined };
  }

  return {
    kind: "account",
    selection,
    enrollment: enrollmentState.ready,
    enrollmentGeneration: enrollmentState.generation,
    dispose: () => undefined,
  };
}

function accountProvider(
  context: Extract<MobileRelaySocketContext, { readonly kind: "account" }>,
  resolution: Extract<
    Awaited<ReturnType<ReturnType<typeof createNativeE2eeTrustResolver>>>,
    { readonly kind: "authorized"; readonly trustSource: "account-enrolled" }
  >,
): RelayE2eeProvider {
  const selection = context.selection;
  const ready = context.enrollment;
  const attempt: RelayE2eeInitiatorAttempt = {
    hubOrigin: selection.hubOrigin,
    selectionClass: "latched",
    legacyPermitted: false,
    pairingOnly: false,
    localSuitePreference: [E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256],
    credentials: {
      tier: "native",
      trustSource: "account-enrolled",
      accountId: selection.accountId,
      identityPublicKey: ready.identity.publicKey,
      agreementPublicKey: ready.prekey.agreementPublicKey,
      prekeyTranscript: ready.prekey.transcript,
      prekeySignature: ready.prekey.signature,
      deviceGrant: resolution.grant,
    },
    withNativeAgreementSecretKey: (use) =>
      mobileNativeE2eePlatform.withAgreementSecret((secretKey) => {
        if (!isCurrent(selection)) throw new Error("Hosted node selection changed.");
        const enrollment = getMobileNativeE2eeEnrollmentCoordinator()?.getState();
        if (
          enrollment?.status !== "ready" ||
          enrollment.generation !== context.enrollmentGeneration
        ) {
          throw new Error("Native E2EE enrollment changed.");
        }
        return use(secretKey);
      }),
    accountId: selection.accountId,
    acceptedPolicyGeneration: resolution.grant.claims.nodePolicyGeneration,
    onStatement: (verification) => {
      if (!isCurrent(selection)) throw new Error("Hosted node selection changed.");
      observeMobileAccountE2eeStatement(verification, selection.environmentId);
    },
    onDiagnostic: (diagnostic) =>
      recordMobileE2eeInitiatorDiagnostic(diagnostic, selection.environmentId),
  };
  const provider = makeMobileRelayE2eeProvider({ attempt });
  return (host) => {
    beginMobileE2eeChannelAttempt(selection.environmentId);
    const machine = provider(host);
    const sync = (): void => {
      const mode = machine.mode();
      if (mode === "e2ee" || mode === "legacy") {
        lockMobileE2eeChannelMode(mode, selection.environmentId);
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
    };
  };
}

/** Issue one ticket+grant pair and bind its grant to the one returned socket context. */
export async function issueMobileRelayAttempt(input: {
  readonly nodeId: string;
  readonly preparedSocketContext: unknown;
}): Promise<{
  readonly ticket: string;
  readonly expiresAt: number;
  readonly preparedSocketContext: MobileRelaySocketContext;
}> {
  const context = input.preparedSocketContext as MobileRelaySocketContext;
  if (!context || context.selection.nodeId !== input.nodeId || !isCurrent(context.selection)) {
    throw new Error("Hosted node selection changed.");
  }
  if (context.kind === "local") {
    const issued = await getHostedHubApi().issueRelayTicket(input.nodeId);
    return { ...issued, preparedSocketContext: context };
  }

  const enrollment = getMobileNativeE2eeEnrollmentCoordinator()?.getState();
  if (enrollment?.status !== "ready" || enrollment.generation !== context.enrollmentGeneration) {
    throw new Error("Native E2EE enrollment changed.");
  }
  const resolveTrust = mobileTrustResolver();
  const resolution = await resolveTrust({
    hubOrigin: context.selection.hubOrigin,
    accountId: context.selection.accountId,
    capability: "ryco.rpc",
    node: { nodeId: input.nodeId, accountGrantAllowed: true },
    enrollment: context.enrollment,
    localTrustedIntroduction: false,
    verifiedPin: null,
  });
  if (
    resolution.kind !== "authorized" ||
    resolution.trustSource !== "account-enrolled" ||
    !isCurrent(context.selection)
  ) {
    if (resolution.kind === "authorized" && resolution.trustSource === "account-enrolled") {
      resolution.dispose();
    }
    if (resolution.kind === "blocked" && resolution.reason === "enrollment-revoked") {
      void getMobileNativeE2eeEnrollmentCoordinator()?.invalidate("revoked");
      throw new HostedRelayPreparationError({ kind: "revoked", retryable: false });
    }
    if (resolution.kind === "blocked" && resolution.reason === "node-update-required") {
      throw new HostedRelayPreparationError({ kind: "incompatible", retryable: false });
    }
    throw new HostedRelayPreparationError(
      resolution.kind === "recovery-required"
        ? {
            kind: "network",
            retryable: true,
            ...(resolution.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: resolution.retryAfterMs }),
          }
        : { kind: "protocol", retryable: false, closeReason: "channel_rejected" },
    );
  }

  let disposed = false;
  context.dispose = () => {
    if (disposed) return;
    disposed = true;
    resolution.dispose();
  };
  context.provider = accountProvider(context, resolution);
  const classification = await mobileE2eeTrustStore.classify({
    kind: "node-id-hint",
    hubOrigin: context.selection.hubOrigin,
    accountId: context.selection.accountId,
    nodeId: context.selection.nodeId,
  });
  if (!isCurrent(context.selection)) {
    context.dispose();
    throw new Error("Hosted node selection changed.");
  }
  const localRecord = trustedRecord(context.selection);
  const marker = mobileE2eeTrustStore.marker(context.selection.hubOrigin);
  beginMobileE2eeChannel({
    selection: {
      ...context.selection,
      ...mobileE2eeLocalRecordContext(localRecord),
      clientIdentityPublicKey: context.enrollment.identity.publicKey,
    },
    classification,
    legacyPermitted: false,
    markerSet: marker.kind === "unobtainable" ? null : marker.kind === "set",
    pinVerified: false,
    previouslyVerified: null,
    trustSource: "account-enrolled",
  });
  return {
    ticket: resolution.ticket,
    expiresAt: resolution.expiresAt,
    preparedSocketContext: context,
  };
}

export function disposeMobileRelaySocketContext(context: unknown): void {
  (context as Partial<MobileRelaySocketContext> | null)?.dispose?.();
}

export function resetMobileAccountE2eeAttemptForTests(): void {
  resolver = null;
}

export function providerForMobileRelaySocketContext(context: unknown): RelayE2eeProvider {
  const prepared = context as MobileRelaySocketContext;
  if (!prepared?.provider) throw new Error("Native E2EE relay context is incomplete.");
  return prepared.provider;
}
