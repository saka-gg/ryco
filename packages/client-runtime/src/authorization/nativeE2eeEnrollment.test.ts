import { p256 } from "@noble/curves/nist.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { e2eeKeyFingerprint, e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import {
  encodeClientE2eePrekeyCertificateCarrier,
  encodeClientE2eePrekeyTranscript,
} from "@ryco/shared/relayE2eeTranscripts";
import type { NativeE2eePlatformService } from "../platform/index.ts";
import { encodeBase64Url } from "../relay/base64url.ts";
import { HostedHubApiError, type HostedHubApi } from "./api.ts";
import {
  createNativeE2eeEnrollmentCoordinator,
  NativeE2eeEnrollmentError,
} from "./nativeE2eeEnrollment.ts";

const NOW = 1_788_451_200_000;
const HUB_ORIGIN = "https://hub.example.test";
const ACCOUNT_ID = `acct_${"a".repeat(22)}`;
const OTHER_ACCOUNT_ID = `acct_${"b".repeat(22)}`;
const ENROLLMENT_ID = `enr_${"e".repeat(22)}`;
const IDENTITY_SECRET = new Uint8Array(32).fill(3);
const IDENTITY_PUBLIC = p256.getPublicKey(IDENTITY_SECRET, false);
const AGREEMENT_PUBLIC = x25519.getPublicKey(new Uint8Array(32).fill(4));

function prekey(accountId = ACCOUNT_ID) {
  const transcript = encodeClientE2eePrekeyTranscript({
    hubOrigin: HUB_ORIGIN,
    accountId,
    identityPublicKey: IDENTITY_PUBLIC,
    agreementPublicKey: AGREEMENT_PUBLIC,
    createdAt: NOW,
    expiresAt: NOW + 120_000,
  });
  const signature = p256.sign(sha256(transcript), IDENTITY_SECRET, {
    prehash: false,
    lowS: false,
    format: "compact",
  });
  const certificate = encodeClientE2eePrekeyCertificateCarrier(transcript, signature);
  return {
    agreementPublicKey: AGREEMENT_PUBLIC,
    agreementFingerprint: e2eeKeyFingerprint("agreement", AGREEMENT_PUBLIC),
    transcript,
    signature,
    certificate,
    certificateDigest: e2eeSha256(certificate),
    expiresAt: NOW + 120_000,
  };
}

function summary(revision = 1, status: "active" | "revoked" = "active") {
  const material = prekey();
  return {
    enrollmentId: ENROLLMENT_ID,
    enrollmentRevision: revision,
    accountAuthEpoch: 1,
    deviceAuthEpoch: status === "active" ? 1 : 2,
    platform: "ios",
    appVersion: "1.0.0",
    reportedKeyBacking: "secure-enclave",
    deviceLabel: "Phone",
    identityFingerprint: encodeBase64Url(e2eeKeyFingerprint("client-identity", IDENTITY_PUBLIC)),
    agreementFingerprint: encodeBase64Url(material.agreementFingerprint),
    clientPrekeyCertificateDigest: encodeBase64Url(material.certificateDigest),
    certificateExpiresAt: material.expiresAt,
    status,
    createdAt: NOW,
    updatedAt: NOW + revision,
    lastUsedAt: null,
    revokedAt: status === "active" ? null : NOW + revision,
  } as const;
}

function harness() {
  const trusted = new Map();
  const platform: NativeE2eePlatformService = {
    platform: "ios",
    appVersion: "1.0.0",
    deviceLabel: () => "Phone",
    randomBytes: vi.fn(async () => new Uint8Array(32).fill(9)),
    ensureIdentity: vi.fn(async () => ({
      publicKey: IDENTITY_PUBLIC,
      fingerprint: e2eeKeyFingerprint("client-identity", IDENTITY_PUBLIC),
      backing: "secure-enclave",
    })),
    ensureClientPrekey: vi.fn(async (namespace) => prekey(namespace.accountId)),
    getOrCreateEnrollmentId: vi.fn(async () => ENROLLMENT_ID),
    clearEnrollment: vi.fn(async () => undefined),
    withAgreementSecret: vi.fn(async (use) => use(new Uint8Array(32).fill(4))),
    readAccountTrustedNode: vi.fn(async ({ nodeId }) => trusted.get(nodeId) ?? null),
    writeAccountTrustedNode: vi.fn(async (record) => void trusted.set(record.nodeId, record)),
  };
  const api = {
    upsertE2eeDeviceEnrollment: vi.fn(async () => summary()),
  } as unknown as Pick<HostedHubApi, "upsertE2eeDeviceEnrollment">;
  const refreshDirectory = vi.fn(async () => undefined);
  const invalidateHostedGeneration = vi.fn();
  const coordinator = createNativeE2eeEnrollmentCoordinator({
    platform,
    api,
    hubOrigin: HUB_ORIGIN,
    requestedMaximumRole: "operator",
    requestedCapabilities: ["ryco.rpc"],
    now: () => NOW + 1,
    refreshDirectory,
    invalidateHostedGeneration,
  });
  return { platform, api, coordinator, refreshDirectory, invalidateHostedGeneration };
}

describe("native E2EE enrollment coordinator", () => {
  it("enrolls after login without pairing and deduplicates concurrent callers", async () => {
    const { coordinator, platform, api, refreshDirectory } = harness();
    const [first, second] = await Promise.all([
      coordinator.ensure(ACCOUNT_ID),
      coordinator.ensure(ACCOUNT_ID),
    ]);

    expect(first).toBe(second);
    expect(platform.ensureIdentity).toHaveBeenCalledOnce();
    expect(api.upsertE2eeDeviceEnrollment).toHaveBeenCalledOnce();
    expect(refreshDirectory).toHaveBeenCalledOnce();
    expect(coordinator.getState()).toMatchObject({
      status: "ready",
      ready: { enrollment: { enrollmentId: ENROLLMENT_ID } },
      errorCode: null,
    });
  });

  it("renews the same enrollment with its current revision", async () => {
    const { coordinator, api } = harness();
    vi.mocked(api.upsertE2eeDeviceEnrollment)
      .mockResolvedValueOnce(summary(1))
      .mockResolvedValueOnce(summary(2));

    await coordinator.ensure(ACCOUNT_ID);
    await coordinator.ensure(ACCOUNT_ID);

    expect(api.upsertE2eeDeviceEnrollment).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedEnrollmentRevision: 1 }),
    );
    expect(coordinator.getState().ready?.enrollment.enrollmentRevision).toBe(2);
  });

  it("never carries an enrollment revision across account scopes", async () => {
    const { coordinator, api } = harness();
    vi.mocked(api.upsertE2eeDeviceEnrollment).mockImplementation(async (request) => ({
      ...summary(),
      identityFingerprint: request.identityFingerprint,
      agreementFingerprint: request.agreementFingerprint,
      clientPrekeyCertificateDigest: request.clientPrekeyCertificateDigest,
      certificateExpiresAt: request.certificateExpiresAt,
    }));

    await coordinator.ensure(ACCOUNT_ID);
    await coordinator.ensure(OTHER_ACCOUNT_ID);

    expect(api.upsertE2eeDeviceEnrollment).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ expectedEnrollmentRevision: expect.anything() }),
    );
    expect(coordinator.getState().ready?.namespace.accountId).toBe(OTHER_ACCOUNT_ID);
  });

  it("fences a completion from an account that was replaced", async () => {
    const { coordinator, platform, api, invalidateHostedGeneration } = harness();
    vi.mocked(api.upsertE2eeDeviceEnrollment).mockImplementation(async (request) => ({
      ...summary(),
      identityFingerprint: request.identityFingerprint,
      agreementFingerprint: request.agreementFingerprint,
      clientPrekeyCertificateDigest: request.clientPrekeyCertificateDigest,
      certificateExpiresAt: request.certificateExpiresAt,
    }));
    let release: (() => void) | null = null;
    vi.mocked(platform.ensureIdentity).mockImplementationOnce(
      () =>
        new Promise(
          (resolve) =>
            void (release = () =>
              resolve({
                publicKey: IDENTITY_PUBLIC,
                fingerprint: e2eeKeyFingerprint("client-identity", IDENTITY_PUBLIC),
                backing: "secure-enclave",
              })),
        ),
    );

    const stale = coordinator.ensure(ACCOUNT_ID);
    const current = coordinator.ensure(OTHER_ACCOUNT_ID);
    release?.();

    await expect(stale).rejects.toBeInstanceOf(NativeE2eeEnrollmentError);
    await expect(current).resolves.toMatchObject({ namespace: { accountId: OTHER_ACCOUNT_ID } });
    expect(invalidateHostedGeneration).toHaveBeenCalled();
    expect(coordinator.getState().ready?.namespace.accountId).toBe(OTHER_ACCOUNT_ID);
  });

  it("publishes revocation before clearing platform enrollment state", async () => {
    const { coordinator, platform, invalidateHostedGeneration } = harness();
    await coordinator.ensure(ACCOUNT_ID);
    let statusDuringClear: string | undefined;
    vi.mocked(platform.clearEnrollment).mockImplementation(async () => {
      statusDuringClear = coordinator.getState().status;
    });

    await coordinator.invalidate("revoked");

    expect(statusDuringClear).toBe("revoked");
    expect(coordinator.getState()).toMatchObject({ status: "revoked", ready: null });
    expect(invalidateHostedGeneration).toHaveBeenCalled();
  });

  it("revokes on the Hub's enrollment frame only for this device's current enrollment", async () => {
    const { coordinator, invalidateHostedGeneration } = harness();
    await coordinator.ensure(ACCOUNT_ID);
    invalidateHostedGeneration.mockClear();

    expect(
      coordinator.applyRevocation({ enrollmentId: `enr_${"f".repeat(22)}`, enrollmentRevision: 1 }),
    ).toBe(false);
    expect(coordinator.getState().status).toBe("ready");
    expect(invalidateHostedGeneration).not.toHaveBeenCalled();

    expect(
      coordinator.applyRevocation({ enrollmentId: ENROLLMENT_ID, enrollmentRevision: 1 }),
    ).toBe(true);
    expect(coordinator.getState()).toMatchObject({ status: "revoked", ready: null });
    expect(invalidateHostedGeneration).toHaveBeenCalledOnce();
  });

  it("ignores an enrollment frame for a revision this device already replaced", async () => {
    const { coordinator, api } = harness();
    vi.mocked(api.upsertE2eeDeviceEnrollment).mockResolvedValueOnce(summary(3));
    await coordinator.ensure(ACCOUNT_ID);

    expect(
      coordinator.applyRevocation({ enrollmentId: ENROLLMENT_ID, enrollmentRevision: 2 }),
    ).toBe(false);
    expect(coordinator.getState().status).toBe("ready");
  });

  it("treats the Hub's 409 enrollment_revoked refusal as revoked, not unavailable", async () => {
    const { coordinator, api, invalidateHostedGeneration } = harness();
    await coordinator.ensure(ACCOUNT_ID);
    invalidateHostedGeneration.mockClear();
    vi.mocked(api.upsertE2eeDeviceEnrollment).mockRejectedValueOnce(
      new HostedHubApiError("enrollment_revoked", 409),
    );

    await expect(coordinator.ensure(ACCOUNT_ID)).rejects.toMatchObject({
      code: "enrollment_revoked",
    });
    expect(coordinator.getState()).toMatchObject({
      status: "revoked",
      ready: null,
      errorCode: "enrollment_revoked",
    });
    expect(invalidateHostedGeneration).toHaveBeenCalledOnce();
  });

  it("treats a non-active summary of this enrollment as the Hub's revocation", async () => {
    const { coordinator, api } = harness();
    vi.mocked(api.upsertE2eeDeviceEnrollment).mockResolvedValueOnce(summary(2, "revoked"));

    await expect(coordinator.ensure(ACCOUNT_ID)).rejects.toMatchObject({
      code: "enrollment_revoked",
    });
    expect(coordinator.getState()).toMatchObject({
      status: "revoked",
      errorCode: "enrollment_revoked",
    });
  });

  it("keeps other Hub conflicts retryable rather than revoked", async () => {
    const { coordinator, api } = harness();
    vi.mocked(api.upsertE2eeDeviceEnrollment).mockRejectedValueOnce(
      new HostedHubApiError("conflict", 409),
    );

    await expect(coordinator.ensure(ACCOUNT_ID)).rejects.toMatchObject({
      code: "enrollment_unavailable",
    });
    expect(coordinator.getState()).toMatchObject({
      status: "unavailable",
      errorCode: "enrollment_unavailable",
    });
  });

  it("rejects mismatched device material without reflecting it in the error", async () => {
    const { coordinator, platform } = harness();
    vi.mocked(platform.ensureIdentity).mockResolvedValue({
      publicKey: IDENTITY_PUBLIC,
      fingerprint: new Uint8Array(32).fill(99),
      backing: "secure-enclave",
    });

    await expect(coordinator.ensure(ACCOUNT_ID)).rejects.toMatchObject({
      message: "Native E2EE enrollment failed.",
      code: "device_material_invalid",
    });
    expect(coordinator.getState()).toMatchObject({
      status: "unavailable",
      errorCode: "device_material_invalid",
    });
  });
});
