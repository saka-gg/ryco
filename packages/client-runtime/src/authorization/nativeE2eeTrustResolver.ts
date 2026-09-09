import { Schema } from "effect";
import {
  NativeAccountGrantRelayTicketRequest,
  type NativeAccountGrantRelayTicketResponse,
} from "@ryco/contracts/native-e2ee";
import type { RelayCapability } from "@ryco/contracts";
import { verifyNodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeCapabilityVerify";
import type { NodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeTranscripts";
import { e2eeBytesEqual, e2eeKeyFingerprint, e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import {
  verifyHubDeviceGrant,
  type DecodedHubDeviceGrant,
  type HubDeviceGrantVerificationKey,
} from "@ryco/shared/relayE2eeHubDeviceGrant";
import {
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
} from "@ryco/shared/relayE2eeWire";

import type { NativeE2eeAccountTrustedNode, NativeE2eePlatformService } from "../platform/index.ts";
import { decodeBase64Url } from "../relay/base64url.ts";
import { HostedHubApiError, type HostedHubApi } from "./api.ts";
import type { NativeE2eeReadyEnrollment } from "./nativeE2eeEnrollment.ts";

export interface NativeE2eeVerifiedPin {
  readonly identityFingerprint: Uint8Array;
  readonly acceptedPolicyGeneration: number;
}

export interface NativeE2eeNodeEvidence {
  readonly nodeId: string;
  /** Exact signed capability statement when local pin authorization is being considered. */
  readonly statementBytes?: Uint8Array;
  readonly statement?: NodeE2eeCapabilityStatement;
  readonly accountGrantAllowed: boolean;
}

export type NativeE2eeTrustResolution =
  | {
      readonly kind: "authorized";
      readonly trustSource: "local-trusted-introduction" | "locally-verified";
      readonly suiteId: typeof E2EE_SUITE_25519_CHACHAPOLY_SHA256;
    }
  | {
      readonly kind: "authorized";
      readonly trustSource: "account-enrolled";
      readonly suiteId: typeof E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256;
      readonly ticket: string;
      readonly expiresAt: number;
      readonly grant: DecodedHubDeviceGrant;
      readonly nodeCapabilityStatement: Uint8Array;
      readonly effectiveRole: NativeAccountGrantRelayTicketResponse["effectiveRole"];
      readonly capability: RelayCapability;
      /** Erases transient public grant/statement buffers when an attempt is abandoned. */
      readonly dispose: () => void;
    }
  | {
      readonly kind: "blocked";
      readonly reason:
        | "verified-pin-conflict"
        | "policy-rollback"
        | "enrollment-revoked"
        | "node-update-required"
        | "account-authorization-invalid";
    }
  | {
      readonly kind: "recovery-required";
      readonly reason: "enrollment-unavailable" | "account-authorization-unavailable";
      readonly retryAfterMs?: number;
    };

export interface NativeE2eeTrustResolverInput {
  readonly api: Pick<HostedHubApi, "issueAccountGrantRelayTicket" | "getE2eeGrantVerificationKeys">;
  readonly platform: Pick<
    NativeE2eePlatformService,
    "readAccountTrustedNode" | "writeAccountTrustedNode"
  >;
  readonly now?: () => number;
  /** Test/platform seam; production uses the shared native statement verifier. */
  readonly verifyAccountStatement?: (input: {
    readonly bytes: Uint8Array;
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly now: number;
  }) => NodeE2eeCapabilityStatement | null;
}

export interface ResolveNativeE2eeTrustInput {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly capability: RelayCapability;
  readonly node: NativeE2eeNodeEvidence;
  readonly enrollment: NativeE2eeReadyEnrollment | null;
  readonly localTrustedIntroduction: boolean;
  readonly verifiedPin: NativeE2eeVerifiedPin | null;
}

export class NativeE2eeTrustResolutionError extends Error {
  constructor() {
    super("Native E2EE authorization failed.");
    this.name = "NativeE2eeTrustResolutionError";
  }
}

const decodeTicketRequest = Schema.decodeUnknownSync(NativeAccountGrantRelayTicketRequest);

function invalid(): NativeE2eeTrustResolution {
  return { kind: "blocked", reason: "account-authorization-invalid" };
}

function unavailable(cause: unknown): NativeE2eeTrustResolution {
  return {
    kind: "recovery-required",
    reason: "account-authorization-unavailable",
    ...(cause instanceof HostedHubApiError && cause.retryAfterMs !== undefined
      ? { retryAfterMs: cause.retryAfterMs }
      : {}),
  };
}

function decodeVerificationKeys(
  keys: readonly {
    readonly keyId: string;
    readonly publicKey: string;
    readonly notBefore: number;
    readonly notAfter: number;
  }[],
): readonly HubDeviceGrantVerificationKey[] | null {
  try {
    return keys.map((key) => ({ ...key, publicKey: decodeBase64Url(key.publicKey) }));
  } catch {
    return null;
  }
}

function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * Resolve one native connection authorization. This supplies credentials to the lifecycle owner and
 * never starts, retries, or publishes a connection itself.
 */
export function createNativeE2eeTrustResolver(input: NativeE2eeTrustResolverInput) {
  type Keyset = Awaited<ReturnType<HostedHubApi["getE2eeGrantVerificationKeys"]>>;
  let cachedKeyset: Keyset | null = null;
  let keysetRequest: Promise<Keyset> | null = null;
  const readKeyset = (force = false): Promise<Keyset> => {
    if (keysetRequest !== null) return keysetRequest;
    if (!force && cachedKeyset !== null) return Promise.resolve(cachedKeyset);
    const request = input.api.getE2eeGrantVerificationKeys().then((value) => {
      cachedKeyset = value;
      return value;
    });
    keysetRequest = request;
    const clear = () => {
      if (keysetRequest === request) keysetRequest = null;
    };
    void request.then(clear, clear);
    return request;
  };
  const refreshKeyset = (previous: Keyset): Promise<Keyset> =>
    cachedKeyset !== null && cachedKeyset !== previous
      ? Promise.resolve(cachedKeyset)
      : readKeyset(true);
  const resolveAttempt = async (
    request: ResolveNativeE2eeTrustInput,
    expiryRetried: boolean,
  ): Promise<NativeE2eeTrustResolution> => {
    if (request.localTrustedIntroduction) {
      if (request.node.statement === undefined) return invalid();
      return {
        kind: "authorized",
        trustSource: "local-trusted-introduction",
        suiteId: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
      };
    }

    if (request.verifiedPin) {
      const statement = request.node.statement;
      if (statement === undefined) return invalid();
      if (!e2eeBytesEqual(request.verifiedPin.identityFingerprint, statement.identityFingerprint)) {
        return { kind: "blocked", reason: "verified-pin-conflict" };
      }
      if (statement.policyGeneration < request.verifiedPin.acceptedPolicyGeneration) {
        return { kind: "blocked", reason: "policy-rollback" };
      }
      return {
        kind: "authorized",
        trustSource: "locally-verified",
        suiteId: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
      };
    }

    const ready = request.enrollment;
    if (
      ready === null ||
      ready.namespace.hubOrigin !== request.hubOrigin ||
      ready.namespace.accountId !== request.accountId ||
      ready.enrollment.status !== "active"
    ) {
      return { kind: "recovery-required", reason: "enrollment-unavailable" };
    }
    if (request.node.accountGrantAllowed !== true) {
      return invalid();
    }

    const priorStatement = request.node.statement;
    const priorTrust =
      priorStatement === undefined
        ? null
        : await input.platform.readAccountTrustedNode({
            hubOrigin: request.hubOrigin,
            accountId: request.accountId,
            nodeId: request.node.nodeId,
          });
    if (
      priorTrust !== null &&
      priorStatement !== undefined &&
      priorStatement.policyGeneration < priorTrust.acceptedPolicyGeneration
    ) {
      return { kind: "blocked", reason: "policy-rollback" };
    }

    let ticketRequest: typeof NativeAccountGrantRelayTicketRequest.Type;
    try {
      ticketRequest = decodeTicketRequest({
        protocolVersion: 1,
        nodeId: request.node.nodeId,
        capability: request.capability,
        protocolMajor: 1,
        protocolMinor: 3,
        suiteId: E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
        enrollmentId: ready.enrollment.enrollmentId,
        enrollmentRevision: ready.enrollment.enrollmentRevision,
        clientPrekeyCertificateDigest: ready.enrollment.clientPrekeyCertificateDigest,
      });
    } catch {
      return invalid();
    }

    let response: NativeAccountGrantRelayTicketResponse;
    let keyset: Keyset;
    let keysetRefreshed = false;
    try {
      [response, keyset] = await Promise.all([
        input.api.issueAccountGrantRelayTicket(ticketRequest),
        readKeyset(),
      ]);
      if (response.keysetGeneration !== keyset.generation) {
        keyset = await refreshKeyset(keyset);
        keysetRefreshed = true;
      }
    } catch (cause) {
      if (cause instanceof HostedHubApiError && cause.code === "revoked") {
        return { kind: "blocked", reason: "enrollment-revoked" };
      }
      if (cause instanceof HostedHubApiError && cause.code === "unsupported_version") {
        return { kind: "blocked", reason: "node-update-required" };
      }
      return unavailable(cause);
    }

    let grantEnvelope: Uint8Array;
    let grantDigest: Uint8Array;
    let statementBytes: Uint8Array;
    let statementDigest: Uint8Array;
    try {
      grantEnvelope = decodeBase64Url(response.deviceGrant);
      grantDigest = decodeBase64Url(response.deviceGrantDigest);
      statementBytes = decodeBase64Url(response.nodeCapabilityStatement);
      statementDigest = decodeBase64Url(response.nodeCapabilityStatementDigest);
    } catch {
      return invalid();
    }
    const now = input.now?.() ?? Date.now();
    const accountStatement = input.verifyAccountStatement
      ? input.verifyAccountStatement({
          bytes: statementBytes,
          hubOrigin: request.hubOrigin,
          accountId: request.accountId,
          now,
        })
      : (() => {
          const verification = verifyNodeE2eeCapabilityStatement({
            statement: statementBytes,
            connectedHubOrigin: request.hubOrigin,
            tier: "native",
            trustSource: "account-enrolled",
            localSuitePreference: [E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256],
            now,
            accountId: request.accountId,
          });
          return verification.kind === "verified" &&
            verification.selectedSuite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256
            ? verification.statement
            : null;
        })();
    if (
      accountStatement === null ||
      accountStatement.hubOrigin !== request.hubOrigin ||
      accountStatement.nodeId !== request.node.nodeId ||
      !accountStatement.suiteRegistry.includes(E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256)
    ) {
      zero(grantEnvelope);
      zero(statementBytes);
      return invalid();
    }
    const previous =
      priorTrust ??
      (await input.platform.readAccountTrustedNode({
        hubOrigin: request.hubOrigin,
        accountId: request.accountId,
        nodeId: request.node.nodeId,
      }));
    if (previous && accountStatement.policyGeneration < previous.acceptedPolicyGeneration) {
      zero(grantEnvelope);
      zero(statementBytes);
      return { kind: "blocked", reason: "policy-rollback" };
    }
    let verificationKeys = decodeVerificationKeys(keyset.keys);
    if (
      verificationKeys === null ||
      response.keysetGeneration !== keyset.generation ||
      response.protocolMajor !== 1 ||
      response.protocolMinor !== 3 ||
      response.suiteId !== E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 ||
      response.capability !== request.capability ||
      !e2eeBytesEqual(e2eeSha256(statementBytes), statementDigest) ||
      !e2eeBytesEqual(e2eeSha256(grantEnvelope), grantDigest)
    ) {
      zero(grantEnvelope);
      zero(statementBytes);
      return invalid();
    }

    const verifyGrant = (keys: readonly HubDeviceGrantVerificationKey[]) =>
      verifyHubDeviceGrant({
        envelope: grantEnvelope,
        verificationKeys: keys,
        bindings: {
          issuerHubOrigin: request.hubOrigin,
          accountId: request.accountId,
          accountAuthEpoch: ready.enrollment.accountAuthEpoch,
          enrollmentId: ready.enrollment.enrollmentId,
          enrollmentRevision: ready.enrollment.enrollmentRevision,
          deviceAuthEpoch: ready.enrollment.deviceAuthEpoch,
          enrollmentStatus: ready.enrollment.status,
          deviceIdentityPublicKey: ready.identity.publicKey,
          deviceAgreementPublicKey: ready.prekey.agreementPublicKey,
          clientPrekeyCertificateDigest: ready.prekey.certificateDigest,
          clientPrekeyCertificateExpiresAt: ready.prekey.expiresAt,
          nodeId: request.node.nodeId,
          nodeIdentityPublicKey: accountStatement.identityPublicKey,
          nodeAgreementPublicKey: accountStatement.prekeyCertificate.agreementPublicKey,
          nodeAgreementPrekeyExpiresAt: accountStatement.prekeyCertificate.expiresAt,
          nodeContinuityId: accountStatement.continuityId,
          nodePolicyGeneration: accountStatement.policyGeneration,
          nodeCapabilityStatementDigest: statementDigest,
          nodeCapabilityStatementExpiresAt: accountStatement.expiresAt,
          relayTicketId: response.ticketId,
          relayTicketExpiresAt: response.expiresAt,
          effectiveRole: response.effectiveRole,
          effectiveCapabilities: [response.capability],
          accountGrantAllowed: request.node.accountGrantAllowed,
          now: input.now?.() ?? Date.now(),
        },
      });
    let verified = verifyGrant(verificationKeys);
    if (verified.kind === "error" && verified.reason === "grant_unknown_key" && !keysetRefreshed) {
      // A signing-key rotation can retain the advertised generation. Refresh
      // through the authenticated Hub API once, then verify the same grant and
      // every binding again. A known-key signature failure remains terminal.
      try {
        keyset = await refreshKeyset(keyset);
      } catch (cause) {
        zero(grantEnvelope);
        zero(statementBytes);
        return unavailable(cause);
      }
      verificationKeys = decodeVerificationKeys(keyset.keys);
      if (verificationKeys === null || response.keysetGeneration !== keyset.generation) {
        zero(grantEnvelope);
        zero(statementBytes);
        return invalid();
      }
      verified = verifyGrant(verificationKeys);
    }
    if (verified.kind !== "ok") {
      zero(grantEnvelope);
      zero(statementBytes);
      if (verified.reason === "grant_expired" && !expiryRetried) {
        return resolveAttempt(request, true);
      }
      return invalid();
    }

    const trusted: NativeE2eeAccountTrustedNode = {
      hubOrigin: request.hubOrigin,
      accountId: request.accountId,
      nodeId: request.node.nodeId,
      identityPublicKey: Uint8Array.from(accountStatement.identityPublicKey),
      identityFingerprint: Uint8Array.from(accountStatement.identityFingerprint),
      agreementFingerprint: e2eeKeyFingerprint(
        "agreement",
        accountStatement.prekeyCertificate.agreementPublicKey,
      ),
      continuityId: accountStatement.continuityId,
      acceptedPolicyGeneration: Math.max(
        previous?.acceptedPolicyGeneration ?? 0,
        accountStatement.policyGeneration,
      ),
      firstTrustedAt: previous?.firstTrustedAt ?? now,
      lastTrustedAt: now,
      identityChanges:
        previous &&
        !e2eeBytesEqual(previous.identityFingerprint, accountStatement.identityFingerprint)
          ? [
              ...previous.identityChanges,
              {
                previousIdentityFingerprint: Uint8Array.from(previous.identityFingerprint),
                nextIdentityFingerprint: Uint8Array.from(accountStatement.identityFingerprint),
                changedAt: now,
              },
            ].slice(-16)
          : (previous?.identityChanges ?? []),
    };
    try {
      await input.platform.writeAccountTrustedNode(trusted);
    } catch {
      zero(grantEnvelope);
      zero(statementBytes);
      return invalid();
    }

    let disposed = false;
    return {
      kind: "authorized",
      trustSource: "account-enrolled",
      suiteId: E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
      ticket: response.ticket,
      expiresAt: response.expiresAt,
      grant: verified,
      nodeCapabilityStatement: statementBytes,
      effectiveRole: response.effectiveRole,
      capability: response.capability,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        zero(grantEnvelope);
        zero(statementBytes);
        zero(verified.envelope);
        zero(verified.claimsBytes);
        zero(verified.signature);
        zero(verified.grantDigest);
      },
    };
  };
  return (request: ResolveNativeE2eeTrustInput) => resolveAttempt(request, false);
}
