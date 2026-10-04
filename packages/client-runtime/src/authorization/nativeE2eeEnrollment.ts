import { Schema } from "effect";
import {
  NativeE2eeEnrollmentUpsertRequest,
  type AccountE2eeDeviceSummary,
  type NativeE2eeEnrollmentUpsertRequest as NativeE2eeEnrollmentUpsertRequestType,
} from "@ryco/contracts/native-e2ee";
import { e2eeBytesEqual, e2eeKeyFingerprint, e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import { verifyE2eeClientPrekeyCertificate } from "@ryco/shared/relayE2eeHandshake";
import { encodeClientE2eePrekeyCertificateCarrier } from "@ryco/shared/relayE2eeTranscripts";
import { E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 } from "@ryco/shared/relayE2eeWire";

import { encodeBase64Url } from "../relay/base64url.ts";
import type {
  NativeE2eeEnrollmentNamespace,
  NativeE2eeIdentityDescriptor,
  NativeE2eePlatformService,
  NativeE2eePrekeyDescriptor,
} from "../platform/index.ts";
import { HostedHubApiError, type HostedHubApi } from "./api.ts";
import type { HostedRuntimeTimers } from "./runtime.ts";
import type { HostedRelayEnrollmentRevocation } from "./types.ts";

export type NativeE2eeEnrollmentStatus =
  | "idle"
  | "securing"
  | "ready"
  | "retrying"
  | "unavailable"
  | "revoked";

export interface NativeE2eeReadyEnrollment {
  readonly namespace: NativeE2eeEnrollmentNamespace;
  readonly enrollment: AccountE2eeDeviceSummary;
  readonly identity: NativeE2eeIdentityDescriptor;
  readonly prekey: NativeE2eePrekeyDescriptor;
}

export interface NativeE2eeEnrollmentState {
  readonly status: NativeE2eeEnrollmentStatus;
  readonly generation: number;
  readonly ready: NativeE2eeReadyEnrollment | null;
  readonly errorCode: NativeE2eeEnrollmentErrorCode | null;
}

export type NativeE2eeEnrollmentErrorCode =
  | "device_material_unavailable"
  | "device_material_invalid"
  | "enrollment_unavailable"
  | "enrollment_refused"
  /**
   * The Hub answered this installation's enrollment as revoked: an HTTP 409
   * `enrollment_revoked` refusal, or a non-active summary of the same
   * enrollment. Carried by status `revoked`; retrying from the same session
   * cannot succeed, only a fresh sign-in can enroll again.
   */
  | "enrollment_revoked";

/** The Hub's stable refusal code for an upsert of an enrollment it has revoked. */
export const HUB_ENROLLMENT_REVOKED_CODE = "enrollment_revoked";

export class NativeE2eeEnrollmentError extends Error {
  readonly code: NativeE2eeEnrollmentErrorCode;

  constructor(code: NativeE2eeEnrollmentErrorCode) {
    super("Native E2EE enrollment failed.");
    this.name = "NativeE2eeEnrollmentError";
    this.code = code;
  }
}

export interface NativeE2eeEnrollmentCoordinatorInput {
  readonly platform: NativeE2eePlatformService;
  readonly api: Pick<HostedHubApi, "upsertE2eeDeviceEnrollment">;
  readonly hubOrigin: string;
  readonly requestedMaximumRole: NativeE2eeEnrollmentUpsertRequestType["requestedMaximumRole"];
  readonly requestedCapabilities: NativeE2eeEnrollmentUpsertRequestType["requestedCapabilities"];
  readonly now?: () => number;
  /** Starts account/node discovery without making its completion an enrollment signal. */
  readonly refreshDirectory?: () => Promise<void>;
  /** Synchronously invalidates connection/mutation readiness when this coordinator is invalidated. */
  readonly invalidateHostedGeneration?: () => void;
  /**
   * The lifecycle automatic recovery runs on. Absent means none: the caller
   * drives every `ensure`/`retry` itself, which is Desktop's shape.
   */
  readonly recovery?: NativeE2eeEnrollmentRecovery;
}

/**
 * Automatic recovery, owned here so no client grows its own retry policy.
 *
 * - A transient failure — the Hub or the network (`enrollment_unavailable`), or
 *   device key material that could not be read, typically a keychain read while
 *   the device is locked (`device_material_unavailable`) — retries with capped
 *   exponential backoff while foreground, and on the next foreground otherwise.
 * - Device material that failed validation retries ONCE; the retry re-ensures
 *   the prekey, and a second invalid result is not transient.
 * - A revocation is the Hub's to lift. A device revoked by the relay frame
 *   re-ensures once per foreground transition: the Hub either renews it or
 *   answers `enrollment_revoked`, which is final for this session.
 */
export interface NativeE2eeEnrollmentRecovery {
  readonly timers: Pick<HostedRuntimeTimers, "setTimeout" | "clearTimeout">;
  readonly isForeground: () => boolean;
  /** Notifies once, on the next foreground transition. */
  readonly subscribeForeground: (listener: () => void) => () => void;
}

const RECOVERY_BASE_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;

function recoveryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  const backoff = Math.min(
    RECOVERY_MAX_DELAY_MS,
    RECOVERY_BASE_DELAY_MS * 2 ** Math.min(attempt, 5),
  );
  return Math.max(backoff, retryAfterMs ?? 0);
}

export interface NativeE2eeEnrollmentCoordinator {
  readonly getState: () => NativeE2eeEnrollmentState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly ensure: (accountId: string) => Promise<NativeE2eeReadyEnrollment>;
  readonly retry: (accountId: string) => Promise<NativeE2eeReadyEnrollment>;
  readonly invalidate: (reason: "account-switch" | "revoked" | "signed-out") => Promise<void>;
  /**
   * The Hub's `e2ee.enrollment-revoked` relay frame. Revokes only when it names
   * the enrollment this device currently holds, at or after the revision it
   * holds; a frame for another enrollment or an older revision is ignored.
   * Returns whether this device's enrollment was revoked.
   */
  readonly applyRevocation: (revocation: HostedRelayEnrollmentRevocation) => boolean;
}

const decodeEnrollmentRequest = Schema.decodeUnknownSync(NativeE2eeEnrollmentUpsertRequest);

function enrollmentError(code: NativeE2eeEnrollmentErrorCode): never {
  throw new NativeE2eeEnrollmentError(code);
}

/**
 * The Hub refusing this installation's enrollment because it revoked it (HTTP
 * 409 `enrollment_revoked`). Matched on the code the Hub sent, never on the
 * status alone: a 409 `enrollment_revision` race is an ordinary conflict.
 */
export function isHubEnrollmentRevoked(cause: unknown): boolean {
  return (
    cause instanceof HostedHubApiError &&
    !cause.inferred &&
    cause.code === HUB_ENROLLMENT_REVOKED_CODE
  );
}

function sameNamespace(
  left: NativeE2eeEnrollmentNamespace | null,
  right: NativeE2eeEnrollmentNamespace,
): boolean {
  return left?.hubOrigin === right.hubOrigin && left.accountId === right.accountId;
}

function validateMaterial(
  namespace: NativeE2eeEnrollmentNamespace,
  identity: NativeE2eeIdentityDescriptor,
  prekey: NativeE2eePrekeyDescriptor,
  now: number,
): void {
  const certificate = verifyE2eeClientPrekeyCertificate({
    transcript: prekey.transcript,
    signature: prekey.signature,
    hubOrigin: namespace.hubOrigin,
    suite: E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
    now,
  });
  if (
    certificate.kind !== "ok" ||
    !e2eeBytesEqual(certificate.certificate.identityPublicKey, identity.publicKey) ||
    !e2eeBytesEqual(certificate.certificate.identityFingerprint, identity.fingerprint) ||
    !e2eeBytesEqual(certificate.certificate.agreementPublicKey, prekey.agreementPublicKey) ||
    !e2eeBytesEqual(certificate.certificate.agreementFingerprint, prekey.agreementFingerprint) ||
    certificate.certificate.accountId !== namespace.accountId ||
    certificate.certificate.expiresAt !== prekey.expiresAt ||
    !e2eeBytesEqual(
      e2eeKeyFingerprint("client-identity", identity.publicKey),
      identity.fingerprint,
    ) ||
    !e2eeBytesEqual(
      e2eeKeyFingerprint("agreement", prekey.agreementPublicKey),
      prekey.agreementFingerprint,
    )
  ) {
    enrollmentError("device_material_invalid");
  }
  const carrier = encodeClientE2eePrekeyCertificateCarrier(prekey.transcript, prekey.signature);
  if (
    !e2eeBytesEqual(carrier, prekey.certificate) ||
    !e2eeBytesEqual(e2eeSha256(carrier), prekey.certificateDigest)
  ) {
    enrollmentError("device_material_invalid");
  }
}

function exactEnrollmentResponse(
  enrollment: AccountE2eeDeviceSummary,
  request: NativeE2eeEnrollmentUpsertRequestType,
): boolean {
  return (
    enrollment.status === "active" &&
    enrollment.enrollmentId === request.enrollmentId &&
    enrollment.platform === request.platform &&
    enrollment.reportedKeyBacking === request.reportedKeyBacking &&
    enrollment.identityFingerprint === request.identityFingerprint &&
    enrollment.agreementFingerprint === request.agreementFingerprint &&
    enrollment.clientPrekeyCertificateDigest === request.clientPrekeyCertificateDigest &&
    enrollment.certificateExpiresAt === request.certificateExpiresAt
  );
}

export function createNativeE2eeEnrollmentCoordinator(
  input: NativeE2eeEnrollmentCoordinatorInput,
): NativeE2eeEnrollmentCoordinator {
  let generation = 0;
  let state: NativeE2eeEnrollmentState = {
    status: "idle",
    generation,
    ready: null,
    errorCode: null,
  };
  let namespace: NativeE2eeEnrollmentNamespace | null = null;
  let operation: Promise<NativeE2eeReadyEnrollment> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Omit<NativeE2eeEnrollmentState, "generation">) => {
    state = { ...patch, generation };
    listeners.forEach((listener) => listener());
  };
  const invalidateCurrent = (
    status: "idle" | "revoked",
    errorCode: "enrollment_revoked" | null = null,
  ) => {
    generation += 1;
    operation = null;
    publish({ status, ready: null, errorCode });
    input.invalidateHostedGeneration?.();
  };

  // Automatic recovery (see `NativeE2eeEnrollmentRecovery`). At most one wait
  // is pending, and it is bound to the generation that scheduled it: any
  // operation or invalidation since makes it a no-op.
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryForeground: (() => void) | undefined;
  let recoveryAttempt = 0;
  let invalidMaterialRetried = false;
  /** The scope the relay frame revoked; what a foreground re-ensure renews. */
  let revokedNamespace: NativeE2eeEnrollmentNamespace | null = null;

  const cancelRecovery = () => {
    if (recoveryTimer !== undefined) input.recovery?.timers.clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    const unsubscribe = recoveryForeground;
    recoveryForeground = undefined;
    unsubscribe?.();
  };
  const resetRecovery = () => {
    cancelRecovery();
    recoveryAttempt = 0;
    invalidMaterialRetried = false;
  };
  const scheduleRecovery = (when: "backoff" | "foreground", retryAfterMs?: number) => {
    const recovery = input.recovery;
    if (recovery === undefined) return;
    cancelRecovery();
    const scheduled = generation;
    const run = () => {
      cancelRecovery();
      if (generation !== scheduled) return;
      if (state.status === "revoked") {
        const revoked = revokedNamespace;
        if (revoked === null || state.errorCode === "enrollment_revoked") return;
        namespace = revoked;
        void start(revoked.accountId, true, true).catch(() => undefined);
        return;
      }
      if (state.status !== "unavailable" || namespace === null) return;
      recoveryAttempt += 1;
      void start(namespace.accountId, true).catch(() => undefined);
    };
    if (when === "foreground" || !recovery.isForeground()) {
      recoveryForeground = recovery.subscribeForeground(run);
      return;
    }
    recoveryTimer = recovery.timers.setTimeout(run, recoveryDelayMs(recoveryAttempt, retryAfterMs));
  };
  const scheduleFailureRecovery = (code: NativeE2eeEnrollmentErrorCode, cause: unknown) => {
    switch (code) {
      case "enrollment_unavailable":
      case "device_material_unavailable":
        scheduleRecovery(
          "backoff",
          cause instanceof HostedHubApiError ? cause.retryAfterMs : undefined,
        );
        return;
      case "device_material_invalid":
        if (invalidMaterialRetried) return;
        invalidMaterialRetried = true;
        scheduleRecovery("backoff");
        return;
      case "enrollment_refused":
      case "enrollment_revoked":
        return;
    }
  };
  /** The Hub's own revocation answer: final until a new session, so nothing is scheduled. */
  const markHubRevoked = () => {
    resetRecovery();
    revokedNamespace = null;
    invalidateCurrent("revoked", "enrollment_revoked");
  };

  const start = async (
    accountId: string,
    retrying: boolean,
    recoveringRevocation = false,
  ): Promise<NativeE2eeReadyEnrollment> => {
    const nextNamespace = { hubOrigin: input.hubOrigin, accountId };
    if (operation && sameNamespace(namespace, nextNamespace)) return operation;
    cancelRecovery();
    if (!sameNamespace(namespace, nextNamespace)) {
      const previous = namespace;
      namespace = nextNamespace;
      resetRecovery();
      revokedNamespace = null;
      invalidateCurrent("idle");
      if (previous) await input.platform.clearEnrollment(previous).catch(() => undefined);
    }
    const previousReady = state.ready;
    generation += 1;
    const issued = generation;
    publish({ status: retrying ? "retrying" : "securing", ready: null, errorCode: null });

    let pending: Promise<NativeE2eeReadyEnrollment>;
    pending = (async () => {
      let phase: "device" | "enrollment" = "device";
      try {
        const identity = await input.platform.ensureIdentity();
        if (issued !== generation) enrollmentError("enrollment_refused");
        void input.refreshDirectory?.().catch(() => undefined);
        const [prekey, enrollmentId, enrollmentNonce, idempotencyKey] = await Promise.all([
          input.platform.ensureClientPrekey(nextNamespace),
          input.platform.getOrCreateEnrollmentId(),
          input.platform.randomBytes(32),
          input.platform.randomBytes(32),
        ]);
        if (issued !== generation) enrollmentError("enrollment_refused");
        validateMaterial(nextNamespace, identity, prekey, input.now?.() ?? Date.now());
        const previousRevision =
          sameNamespace(previousReady?.namespace ?? null, nextNamespace) &&
          previousReady?.enrollment.enrollmentId === enrollmentId
            ? previousReady.enrollment.enrollmentRevision
            : undefined;
        let request: NativeE2eeEnrollmentUpsertRequestType;
        try {
          request = decodeEnrollmentRequest({
            protocolVersion: 1,
            hubOrigin: nextNamespace.hubOrigin,
            accountId: nextNamespace.accountId,
            enrollmentId,
            ...(previousRevision === undefined
              ? {}
              : { expectedEnrollmentRevision: previousRevision }),
            identityPublicKey: encodeBase64Url(identity.publicKey),
            identityFingerprint: encodeBase64Url(identity.fingerprint),
            agreementPublicKey: encodeBase64Url(prekey.agreementPublicKey),
            agreementFingerprint: encodeBase64Url(prekey.agreementFingerprint),
            clientPrekeyCertificate: encodeBase64Url(prekey.certificate),
            clientPrekeyCertificateDigest: encodeBase64Url(prekey.certificateDigest),
            certificateExpiresAt: prekey.expiresAt,
            platform: input.platform.platform,
            appVersion: input.platform.appVersion,
            reportedKeyBacking: identity.backing,
            deviceLabel: input.platform.deviceLabel(),
            requestedMaximumRole: input.requestedMaximumRole,
            requestedCapabilities: input.requestedCapabilities,
            enrollmentNonce: encodeBase64Url(enrollmentNonce),
            idempotencyKey: encodeBase64Url(idempotencyKey),
          });
        } catch {
          return enrollmentError("device_material_invalid");
        }
        phase = "enrollment";
        let enrollment: AccountE2eeDeviceSummary;
        try {
          enrollment = await input.api.upsertE2eeDeviceEnrollment(request);
        } catch (cause) {
          // The Hub's answer, not an outage: retrying the same upsert from this
          // session can never succeed, so it must not read as `unavailable`
          // and feed a retry loop.
          if (!isHubEnrollmentRevoked(cause)) throw cause;
          if (issued === generation && sameNamespace(namespace, nextNamespace)) markHubRevoked();
          return enrollmentError("enrollment_revoked");
        }
        if (issued !== generation || !sameNamespace(namespace, nextNamespace)) {
          return enrollmentError("enrollment_refused");
        }
        if (!exactEnrollmentResponse(enrollment, request)) {
          if (enrollment.enrollmentId === request.enrollmentId && enrollment.status !== "active") {
            markHubRevoked();
            return enrollmentError("enrollment_revoked");
          }
          return enrollmentError("enrollment_refused");
        }
        const ready = { namespace: nextNamespace, enrollment, identity, prekey };
        resetRecovery();
        revokedNamespace = null;
        publish({ status: "ready", ready, errorCode: null });
        return ready;
      } catch (cause) {
        const error =
          cause instanceof NativeE2eeEnrollmentError
            ? cause
            : new NativeE2eeEnrollmentError(
                phase === "device" ? "device_material_unavailable" : "enrollment_unavailable",
              );
        if (issued === generation && state.status !== "revoked") {
          if (recoveringRevocation) {
            // Re-ensuring could not reach a Hub answer. The revocation stands
            // until the Hub renews this enrollment; try again next foreground.
            publish({ status: "revoked", ready: null, errorCode: null });
            if (issued === generation) scheduleRecovery("foreground");
          } else {
            publish({ status: "unavailable", ready: null, errorCode: error.code });
            if (issued === generation) scheduleFailureRecovery(error.code, cause);
          }
        }
        throw error;
      } finally {
        if (issued === generation) operation = null;
      }
    })();
    operation = pending;
    return pending;
  };

  const invalidate: NativeE2eeEnrollmentCoordinator["invalidate"] = async (reason) => {
    const previous = namespace;
    namespace = null;
    resetRecovery();
    revokedNamespace = reason === "revoked" ? previous : null;
    invalidateCurrent(reason === "revoked" ? "revoked" : "idle");
    if (reason === "revoked" && previous) scheduleRecovery("foreground");
    if (previous) await input.platform.clearEnrollment(previous).catch(() => undefined);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: (accountId) => start(accountId, false),
    retry: (accountId) => start(accountId, true),
    invalidate,
    applyRevocation: (revocation) => {
      const held = state.status === "ready" ? state.ready?.enrollment : undefined;
      if (
        held === undefined ||
        held.enrollmentId !== revocation.enrollmentId ||
        held.enrollmentRevision > revocation.enrollmentRevision
      ) {
        return false;
      }
      void invalidate("revoked");
      return true;
    },
  };
}
