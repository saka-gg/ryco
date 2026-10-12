import * as Crypto from "node:crypto";

import {
  type NativeE2eeEnrollmentState,
  type NativeE2eeTrustResolution,
  type ResolveNativeE2eeTrustInput,
} from "@ryco/client-runtime/authorization/e2ee";
import type {
  RelayE2eeInitiatorAttempt,
  RelayE2eeNativeHandshakeStartInput,
  RelayE2eeNativeHandshakeStartResult,
} from "@ryco/client-runtime/relay/e2ee";
import {
  verifyNodeE2eeCapabilityStatement,
  type NodeE2eeVerifiedPin,
} from "@ryco/shared/relayE2eeCapabilityVerify";
import {
  E2eeClientHandshake,
  type E2eeClientEstablishedResult,
} from "@ryco/shared/relayE2eeHandshake";
import {
  e2eeBytesEqual,
  e2eeKeyFingerprint,
  formatE2eeKeyFingerprint,
} from "@ryco/shared/relayE2eeKeys";
import {
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
} from "@ryco/shared/relayE2eeWire";

import { DesktopE2eePrekeyIssuer, type DesktopE2eePrekeyCertificate } from "./desktopE2eePrekey.ts";
import { DesktopE2eeTrustStore, type DesktopVerifiedE2eePin } from "./desktopE2eeTrust.ts";
import type { DesktopHostedIdentityStatus } from "./desktopHostedIdentity.ts";
import type { DesktopLocalIntroductionSecurity } from "./localTrustedIntroduction.ts";
import type { DesktopNativeSecurityHelper } from "./nativeSecurityHelper.ts";
import type { DesktopProtectedRecordStore } from "./protectedRecordStore.ts";

const LOCAL_SUITE_PREFERENCE = [E2EE_SUITE_25519_CHACHAPOLY_SHA256] as const;
const ACCOUNT_SUITE_PREFERENCE = [E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256] as const;
const PREPARED_ATTEMPT_LIFETIME_MS = 2 * 60 * 1_000;
const HANDSHAKE_HANDLE_LIFETIME_MS = 20_000;
const MAX_PREPARED_ATTEMPTS = 8;
const MAX_HANDSHAKES = 16;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;

type DesktopE2eeHandshakeSecurity = DesktopLocalIntroductionSecurity &
  Pick<DesktopNativeSecurityHelper, "withAgreementSecretKey">;

type DesktopAccountAuthorization = Extract<
  NativeE2eeTrustResolution,
  { readonly kind: "authorized"; readonly trustSource: "account-enrolled" }
>;

export interface DesktopNativeE2eeAccountAuthority {
  readonly enrollmentState: () => NativeE2eeEnrollmentState | null;
  readonly resolve: (input: ResolveNativeE2eeTrustInput) => Promise<NativeE2eeTrustResolution>;
  readonly revoked?: () => void;
}

export type DesktopNativeE2eePreparation =
  | { readonly kind: "web-eligible" }
  | { readonly kind: "strict-unavailable" }
  | { readonly kind: "update-required" }
  | {
      readonly kind: "native";
      readonly pairingOnly: boolean;
      readonly attemptHandle: string;
      readonly suiteId: 1 | 2;
      readonly credentials: Extract<
        RelayE2eeInitiatorAttempt["credentials"],
        { readonly tier: "native" }
      >;
      readonly verifiedPin?: NodeE2eeVerifiedPin;
      readonly acceptedPolicyGeneration?: number;
      readonly relayTicket?: {
        readonly ticket: string;
        readonly expiresAt: number;
      };
    };

interface PreparedAttempt {
  readonly accountId: string;
  readonly nodeId: string;
  readonly pin: DesktopVerifiedE2eePin | null;
  readonly certificate: DesktopE2eePrekeyCertificate;
  readonly accountAuthorization: DesktopAccountAuthorization | null;
  readonly expiresAt: number;
}

interface HeldHandshake {
  readonly client: E2eeClientHandshake;
  readonly expiresAt: number;
}

export class DesktopNativeE2eeHandshakeError extends Error {
  readonly code = "native_e2ee_unavailable" as const;

  constructor() {
    super("Desktop native E2EE operation failed.");
    this.name = "DesktopNativeE2eeHandshakeError";
  }
}

function fail(): never {
  throw new DesktopNativeE2eeHandshakeError();
}

function opaqueHandle(): string {
  return Crypto.randomBytes(32).toString("base64url");
}

function samePin(left: DesktopVerifiedE2eePin, right: DesktopVerifiedE2eePin): boolean {
  return (
    left.hubOrigin === right.hubOrigin &&
    left.accountId === right.accountId &&
    left.localNodeHandle === right.localNodeHandle &&
    left.nodeId === right.nodeId &&
    left.environmentId === right.environmentId &&
    left.verifiedFingerprint === right.verifiedFingerprint &&
    e2eeBytesEqual(left.verifiedIdentityPublicKey, right.verifiedIdentityPublicKey) &&
    left.recordedContinuityId === right.recordedContinuityId &&
    left.acceptedPolicyGeneration === right.acceptedPolicyGeneration &&
    left.clientIdentityFingerprint === right.clientIdentityFingerprint &&
    left.approvedAt === right.approvedAt &&
    left.verificationMethod === right.verificationMethod
  );
}

function pinForAttempt(pin: DesktopVerifiedE2eePin): NodeE2eeVerifiedPin {
  return {
    identityFingerprint: e2eeKeyFingerprint("node-identity", pin.verifiedIdentityPublicKey),
    continuityId: pin.recordedContinuityId,
  };
}

function sameCertificate(
  left: DesktopE2eePrekeyCertificate,
  right: DesktopE2eePrekeyCertificate,
): boolean {
  return (
    left.hubOrigin === right.hubOrigin &&
    left.accountId === right.accountId &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt &&
    e2eeBytesEqual(left.identityPublicKey, right.identityPublicKey) &&
    e2eeBytesEqual(left.agreementPublicKey, right.agreementPublicKey) &&
    e2eeBytesEqual(left.transcript, right.transcript) &&
    e2eeBytesEqual(left.signature, right.signature)
  );
}

function nativePreparation(
  attemptHandle: string,
  attempt: PreparedAttempt,
): Extract<DesktopNativeE2eePreparation, { readonly kind: "native" }> {
  const account = attempt.accountAuthorization;
  return {
    kind: "native",
    pairingOnly: attempt.pin === null && account === null,
    attemptHandle,
    suiteId:
      account === null
        ? E2EE_SUITE_25519_CHACHAPOLY_SHA256
        : E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
    credentials:
      account === null
        ? {
            tier: "native",
            accountId: attempt.accountId,
            identityPublicKey: attempt.certificate.identityPublicKey,
            agreementPublicKey: attempt.certificate.agreementPublicKey,
            prekeyTranscript: attempt.certificate.transcript,
            prekeySignature: attempt.certificate.signature,
          }
        : {
            tier: "native",
            trustSource: "account-enrolled",
            accountId: attempt.accountId,
            identityPublicKey: attempt.certificate.identityPublicKey,
            agreementPublicKey: attempt.certificate.agreementPublicKey,
            prekeyTranscript: attempt.certificate.transcript,
            prekeySignature: attempt.certificate.signature,
            deviceGrant: account.grant,
          },
    ...(attempt.pin === null
      ? account === null
        ? {}
        : {
            acceptedPolicyGeneration: account.grant.claims.nodePolicyGeneration,
            relayTicket: {
              ticket: account.ticket,
              expiresAt: account.expiresAt,
            },
          }
      : {
          verifiedPin: pinForAttempt(attempt.pin),
          acceptedPolicyGeneration: attempt.pin.acceptedPolicyGeneration,
        }),
  };
}

export class DesktopNativeE2eeHandshakeService {
  readonly #origin: string;
  readonly #security: DesktopE2eeHandshakeSecurity;
  readonly #trust: DesktopE2eeTrustStore;
  readonly #prekey: DesktopE2eePrekeyIssuer;
  readonly #identityStatus: () => DesktopHostedIdentityStatus;
  readonly #accountAuthority: DesktopNativeE2eeAccountAuthority | undefined;
  readonly #now: () => number;
  readonly #prepared = new Map<string, PreparedAttempt>();
  readonly #handshakes = new Map<string, HeldHandshake>();

  constructor(input: {
    readonly origin: string;
    readonly security: DesktopE2eeHandshakeSecurity;
    readonly records: DesktopProtectedRecordStore;
    readonly identityStatus: () => DesktopHostedIdentityStatus;
    readonly accountAuthority?: DesktopNativeE2eeAccountAuthority;
    readonly trust?: DesktopE2eeTrustStore;
    readonly prekey?: DesktopE2eePrekeyIssuer;
    readonly now?: () => number;
  }) {
    this.#origin = input.origin;
    this.#security = input.security;
    this.#trust = input.trust ?? new DesktopE2eeTrustStore(input.records);
    this.#now = input.now ?? Date.now;
    this.#prekey =
      input.prekey ??
      new DesktopE2eePrekeyIssuer({
        origin: input.origin,
        security: input.security,
        records: input.records,
        now: this.#now,
      });
    this.#identityStatus = input.identityStatus;
    this.#accountAuthority = input.accountAuthority;
  }

  #prune(): void {
    const now = this.#now();
    for (const [handle, attempt] of this.#prepared) {
      if (attempt.expiresAt < now) {
        this.#prepared.delete(handle);
        attempt.accountAuthorization?.dispose();
      }
    }
    for (const [handle, held] of this.#handshakes) {
      if (held.expiresAt >= now) continue;
      this.#handshakes.delete(handle);
      held.client.destroy();
    }
  }

  async prepare(input: {
    readonly accountId: string;
    readonly nodeId: string;
    readonly allowPairing?: boolean;
    readonly expectedTrust?: "verified" | "account-trusted" | "unverified";
  }): Promise<DesktopNativeE2eePreparation> {
    this.#prune();
    const [pin, marker] = await Promise.all([
      this.#trust.read(this.#origin, input.accountId, input.nodeId),
      this.#trust.hasVerifiedOrigin(this.#origin),
    ]);
    const identity = this.#identityStatus();
    if (identity.status !== "ready" || identity.accountId !== input.accountId) {
      return { kind: "strict-unavailable" };
    }
    const pairingOnly = pin === null && input.allowPairing === true;
    if (
      (input.expectedTrust === "verified" && pin === null) ||
      (input.expectedTrust === "account-trusted" && pin !== null) ||
      (input.expectedTrust === "unverified" && !pairingOnly)
    ) {
      return { kind: "strict-unavailable" };
    }
    if (pin === null && !pairingOnly && !this.#accountAuthority) {
      return marker ? { kind: "strict-unavailable" } : { kind: "web-eligible" };
    }
    const certificate = await this.#prekey.ensure(input.accountId);
    if (
      !e2eeBytesEqual(certificate.identityPublicKey, await this.#security.getSigningPublicKey()) ||
      !e2eeBytesEqual(
        certificate.agreementPublicKey,
        await this.#security.ensureAgreementPublicKey(),
      ) ||
      (pin !== null &&
        pin.clientIdentityFingerprint !==
          formatE2eeKeyFingerprint(
            e2eeKeyFingerprint("client-identity", certificate.identityPublicKey),
          ))
    ) {
      return fail();
    }
    if (pin !== null || pairingOnly) {
      for (const [attemptHandle, prepared] of this.#prepared) {
        if (
          prepared.accountAuthorization === null &&
          prepared.accountId === input.accountId &&
          prepared.nodeId === input.nodeId &&
          ((prepared.pin === null && pin === null) ||
            (prepared.pin !== null && pin !== null && samePin(prepared.pin, pin))) &&
          sameCertificate(prepared.certificate, certificate)
        ) {
          return nativePreparation(attemptHandle, prepared);
        }
      }
    }
    if (this.#prepared.size >= MAX_PREPARED_ATTEMPTS) return fail();
    let accountAuthorization: DesktopAccountAuthorization | null = null;
    if (pin === null && !pairingOnly) {
      const accountAuthority = this.#accountAuthority;
      if (accountAuthority === undefined) return { kind: "strict-unavailable" };
      const enrollment = accountAuthority.enrollmentState();
      if (
        enrollment?.status !== "ready" ||
        enrollment.ready === null ||
        enrollment.ready.namespace.accountId !== input.accountId ||
        enrollment.ready.namespace.hubOrigin !== this.#origin
      ) {
        return { kind: "strict-unavailable" };
      }
      const resolution = await accountAuthority.resolve({
        hubOrigin: this.#origin,
        accountId: input.accountId,
        capability: "ryco.rpc",
        node: { nodeId: input.nodeId, accountGrantAllowed: true },
        enrollment: enrollment.ready,
        localTrustedIntroduction: false,
        verifiedPin: null,
      });
      if (resolution.kind !== "authorized" || resolution.trustSource !== "account-enrolled") {
        if (resolution.kind === "blocked" && resolution.reason === "enrollment-revoked") {
          accountAuthority.revoked?.();
        }
        if (resolution.kind === "blocked" && resolution.reason === "node-update-required") {
          return { kind: "update-required" };
        }
        return { kind: "strict-unavailable" };
      }
      accountAuthorization = resolution;
    }
    const attemptHandle = opaqueHandle();
    const prepared: PreparedAttempt = {
      accountId: input.accountId,
      nodeId: input.nodeId,
      pin,
      certificate,
      accountAuthorization,
      expiresAt: this.#now() + PREPARED_ATTEMPT_LIFETIME_MS,
    };
    this.#prepared.set(attemptHandle, prepared);
    return nativePreparation(attemptHandle, prepared);
  }

  async start(
    attemptHandle: string,
    input: RelayE2eeNativeHandshakeStartInput,
  ): Promise<RelayE2eeNativeHandshakeStartResult> {
    this.#prune();
    if (!HANDLE.test(attemptHandle)) return fail();
    const prepared = this.#prepared.get(attemptHandle);
    if (prepared === undefined || prepared.expiresAt < this.#now()) return fail();
    const identity = this.#identityStatus();
    const account = prepared.accountAuthorization;
    const expectedSuite =
      account === null
        ? E2EE_SUITE_25519_CHACHAPOLY_SHA256
        : E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256;
    const grantContext = input.channel.accountGrantContext;
    if (
      identity.status !== "ready" ||
      identity.accountId !== prepared.accountId ||
      input.channel.hubOrigin !== this.#origin ||
      input.intendedCapability !== input.channel.channelOpenCapability ||
      input.intendedRole !== input.channel.channelOpenEffectiveRole ||
      input.selectedSuite !== expectedSuite ||
      input.offeredSuites.length !== 1 ||
      input.offeredSuites[0] !== expectedSuite ||
      (account === null && grantContext !== undefined) ||
      (account !== null &&
        (grantContext === undefined ||
          !e2eeBytesEqual(input.statement, account.nodeCapabilityStatement) ||
          grantContext.relayTicketId !== account.grant.claims.relayTicketId ||
          !e2eeBytesEqual(grantContext.deviceGrantDigest, account.grant.grantDigest) ||
          !e2eeBytesEqual(
            grantContext.nodeCapabilityStatementDigest,
            account.grant.claims.nodeCapabilityStatementDigest,
          )))
    ) {
      return fail();
    }
    const livePin = await this.#trust.read(this.#origin, prepared.accountId, prepared.nodeId);
    if (
      (prepared.pin === null && livePin !== null) ||
      (prepared.pin !== null && (livePin === null || !samePin(livePin, prepared.pin)))
    ) {
      return fail();
    }
    const verification = verifyNodeE2eeCapabilityStatement({
      statement: input.statement,
      connectedHubOrigin: this.#origin,
      tier: "native",
      ...(account === null ? {} : { trustSource: "account-enrolled" as const }),
      localSuitePreference: account === null ? LOCAL_SUITE_PREFERENCE : ACCOUNT_SUITE_PREFERENCE,
      now: this.#now(),
      accountId: prepared.accountId,
      ...(livePin === null
        ? {}
        : {
            pin: pinForAttempt(livePin),
            acceptedPolicyGeneration: livePin.acceptedPolicyGeneration,
          }),
    });
    if (
      verification.kind !== "verified" ||
      verification.statement.nodeId !== prepared.nodeId ||
      verification.selectedSuite !== input.selectedSuite ||
      (livePin === null ? verification.anchor !== "none" : verification.anchor === "none")
    ) {
      return fail();
    }
    const committedPin =
      livePin === null
        ? null
        : await this.#trust.recordAuthenticatedStatement({
            hubOrigin: this.#origin,
            accountId: prepared.accountId,
            nodeId: prepared.nodeId,
            localNodeHandle: livePin.localNodeHandle,
            verification,
          });
    const certificate = prepared.certificate;
    let client: E2eeClientHandshake | undefined;
    const result = await this.#security.withAgreementSecretKey((agreementSecretKey) => {
      client = new E2eeClientHandshake({
        channel: input.channel,
        advertised: {
          nodeId: verification.statement.nodeId,
          nodeIdentityFingerprint:
            committedPin !== null && verification.anchor === "pin-unchanged"
              ? e2eeKeyFingerprint("node-identity", committedPin.verifiedIdentityPublicKey)
              : verification.statement.identityFingerprint,
          prekeyId: verification.statement.prekeyCertificate.prekeyId,
          agreementPublicKey: verification.statement.prekeyCertificate.agreementPublicKey,
          continuityChainTranscripts: verification.statement.continuityChain.map(
            (entry) => entry.transcript,
          ),
          continuityId: committedPin?.recordedContinuityId ?? verification.statement.continuityId,
          ...(account === null
            ? {}
            : {
                policyGeneration: verification.statement.policyGeneration,
                capabilityStatementDigest: account.grant.claims.nodeCapabilityStatementDigest,
              }),
        },
        selectedSuite: input.selectedSuite,
        offeredSuites: input.offeredSuites,
        credentials:
          account === null
            ? {
                tier: "native",
                accountId: prepared.accountId,
                identityPublicKey: certificate.identityPublicKey,
                agreementPublicKey: certificate.agreementPublicKey,
                agreementSecretKey,
                prekeyTranscript: certificate.transcript,
                prekeySignature: certificate.signature,
              }
            : {
                tier: "native",
                trustSource: "account-enrolled",
                accountId: prepared.accountId,
                identityPublicKey: certificate.identityPublicKey,
                agreementPublicKey: certificate.agreementPublicKey,
                agreementSecretKey,
                prekeyTranscript: certificate.transcript,
                prekeySignature: certificate.signature,
                deviceGrant: account.grant,
              },
        intendedCapability: input.intendedCapability,
        intendedRole: input.intendedRole,
      });
      return client.createHello(this.#now());
    });
    if (result.kind !== "hello") {
      client?.destroy();
      return { kind: "fatal", result };
    }
    if (client === undefined || this.#handshakes.size >= MAX_HANDSHAKES) {
      client?.destroy();
      return fail();
    }
    const handle = opaqueHandle();
    this.#handshakes.set(handle, {
      client,
      expiresAt: Math.min(result.deadlineAt, this.#now() + HANDSHAKE_HANDLE_LIFETIME_MS),
    });
    return { kind: "hello", handle, result };
  }

  finish(handle: string, payload: Uint8Array): E2eeClientEstablishedResult {
    this.#prune();
    if (!HANDLE.test(handle)) return fail();
    const held = this.#handshakes.get(handle);
    if (held === undefined) return fail();
    this.#handshakes.delete(handle);
    if (held.expiresAt < this.#now()) {
      held.client.destroy();
      return fail();
    }
    try {
      return held.client.receiveServerAccept(payload, this.#now());
    } catch {
      held.client.destroy();
      return fail();
    }
  }

  destroy(handle: string): void {
    if (!HANDLE.test(handle)) return;
    const prepared = this.#prepared.get(handle);
    this.#prepared.delete(handle);
    prepared?.accountAuthorization?.dispose();
    const held = this.#handshakes.get(handle);
    this.#handshakes.delete(handle);
    held?.client.destroy();
  }

  dispose(): void {
    for (const held of this.#handshakes.values()) held.client.destroy();
    this.#handshakes.clear();
    for (const prepared of this.#prepared.values()) prepared.accountAuthorization?.dispose();
    this.#prepared.clear();
  }
}
