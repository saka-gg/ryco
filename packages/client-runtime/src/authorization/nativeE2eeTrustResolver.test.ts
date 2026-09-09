import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { describe, expect, it, vi } from "vite-plus/test";

import type { NativeAccountGrantRelayTicketResponse } from "@ryco/contracts/native-e2ee";
import {
  encodeHubDeviceGrantClaims,
  encodeHubDeviceGrantEnvelope,
  encodeHubDeviceGrantSigningEnvelope,
  type HubDeviceGrantClaimsInput,
} from "@ryco/shared/relayE2eeHubDeviceGrant";
import { e2eeKeyFingerprint, e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import type { NodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeTranscripts";
import type { NativeE2eeAccountTrustedNode, NativeE2eePlatformService } from "../platform/index.ts";
import { encodeBase64Url } from "../relay/base64url.ts";
import { HostedHubApiError, type HostedHubApi } from "./api.ts";
import type { NativeE2eeReadyEnrollment } from "./nativeE2eeEnrollment.ts";
import {
  createNativeE2eeTrustResolver,
  type ResolveNativeE2eeTrustInput,
} from "./nativeE2eeTrustResolver.ts";

const NOW = 2_000_000_000_000;
const HUB_ORIGIN = "https://hub.example.test";
const ACCOUNT_ID = `acct_${"a".repeat(22)}`;
const ENROLLMENT_ID = `enr_${"e".repeat(22)}`;
const NODE_ID = `node_${"n".repeat(22)}`;
const TICKET_ID = `rtk_${"t".repeat(22)}`;
const CONTINUITY_ID = `nct_${"c".repeat(22)}`;
const KEY_ID = `hgk_${"k".repeat(22)}`;
const HUB_SECRET = new Uint8Array(32).fill(1);
const DEVICE_PUBLIC = p256.getPublicKey(new Uint8Array(32).fill(2), false);
const DEVICE_AGREEMENT_PUBLIC = x25519.getPublicKey(new Uint8Array(32).fill(3));
const NODE_PUBLIC = ed25519.getPublicKey(new Uint8Array(32).fill(4));
const NODE_AGREEMENT_PUBLIC = x25519.getPublicKey(new Uint8Array(32).fill(5));
const CERTIFICATE_DIGEST = new Uint8Array(32).fill(6);
const STATEMENT_BYTES = new Uint8Array([1, 2, 3, 4]);
const STATEMENT_DIGEST = e2eeSha256(STATEMENT_BYTES);

const statement = {
  transcript: new Uint8Array([9]),
  signature: new Uint8Array(64).fill(1),
  hubOrigin: HUB_ORIGIN,
  nodeId: NODE_ID,
  identityKeyId: "key",
  identityPublicKey: NODE_PUBLIC,
  identityFingerprint: e2eeKeyFingerprint("node-identity", NODE_PUBLIC),
  e2eeVersionMin: 1,
  e2eeVersionMax: 1,
  suiteRegistry: [1, 2],
  prekeyCertificate: {
    prekeyId: `epk_${"p".repeat(22)}`,
    agreementPublicKey: NODE_AGREEMENT_PUBLIC,
    agreementFingerprint: e2eeKeyFingerprint("agreement", NODE_AGREEMENT_PUBLIC),
    crossSignature: new Uint8Array(64).fill(2),
    createdAt: NOW - 1_000,
    expiresAt: NOW + 120_000,
  },
  continuityChain: [],
  requireE2EE: true,
  requireApprovedClientE2EE: false,
  admittedPatterns: ["IK"],
  policyGeneration: 7,
  issuedAt: NOW - 1_000,
  expiresAt: NOW + 120_000,
  continuityId: CONTINUITY_ID,
} as unknown as NodeE2eeCapabilityStatement;

const enrollment = {
  namespace: { hubOrigin: HUB_ORIGIN, accountId: ACCOUNT_ID },
  enrollment: {
    enrollmentId: ENROLLMENT_ID,
    enrollmentRevision: 4,
    accountAuthEpoch: 3,
    deviceAuthEpoch: 5,
    platform: "ios",
    appVersion: "1.0.0",
    reportedKeyBacking: "secure-enclave",
    deviceLabel: "Phone",
    identityFingerprint: encodeBase64Url(e2eeKeyFingerprint("client-identity", DEVICE_PUBLIC)),
    agreementFingerprint: encodeBase64Url(e2eeKeyFingerprint("agreement", DEVICE_AGREEMENT_PUBLIC)),
    clientPrekeyCertificateDigest: encodeBase64Url(CERTIFICATE_DIGEST),
    certificateExpiresAt: NOW + 120_000,
    status: "active",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    lastUsedAt: null,
    revokedAt: null,
  },
  identity: {
    publicKey: DEVICE_PUBLIC,
    fingerprint: e2eeKeyFingerprint("client-identity", DEVICE_PUBLIC),
    backing: "secure-enclave",
  },
  prekey: {
    agreementPublicKey: DEVICE_AGREEMENT_PUBLIC,
    agreementFingerprint: e2eeKeyFingerprint("agreement", DEVICE_AGREEMENT_PUBLIC),
    transcript: new Uint8Array([1]),
    signature: new Uint8Array(64),
    certificate: new Uint8Array([2]),
    certificateDigest: CERTIFICATE_DIGEST,
    expiresAt: NOW + 120_000,
  },
} as unknown as NativeE2eeReadyEnrollment;

const ROTATED_SIGNER = {
  keyId: `hgk_${"r".repeat(22)}`,
  secretKey: new Uint8Array(32).fill(8),
};

function keyset(signer = { keyId: KEY_ID, secretKey: HUB_SECRET }) {
  return {
    protocolVersion: 1 as const,
    generation: 2,
    keys: [
      {
        keyId: signer.keyId,
        publicKey: encodeBase64Url(ed25519.getPublicKey(signer.secretKey)),
        notBefore: NOW - 60_000,
        notAfter: NOW + 180_000,
      },
    ],
  };
}

function grantEnvelope(
  expiresAt = NOW + 60_000,
  signer = { keyId: KEY_ID, secretKey: HUB_SECRET },
) {
  const claims = encodeHubDeviceGrantClaims({
    issuerHubOrigin: HUB_ORIGIN,
    keyId: signer.keyId,
    grantId: `hgr_${"g".repeat(22)}`,
    accountId: ACCOUNT_ID,
    accountAuthEpoch: 3,
    enrollmentId: ENROLLMENT_ID,
    enrollmentRevision: 4,
    deviceAuthEpoch: 5,
    deviceIdentityPublicKey: DEVICE_PUBLIC,
    deviceAgreementPublicKey: DEVICE_AGREEMENT_PUBLIC,
    clientPrekeyCertificateDigest: CERTIFICATE_DIGEST,
    nodeId: NODE_ID,
    nodeIdentityPublicKey: NODE_PUBLIC,
    nodeAgreementPublicKey: NODE_AGREEMENT_PUBLIC,
    nodeContinuityId: CONTINUITY_ID,
    nodePolicyGeneration: 7,
    nodeCapabilityStatementDigest: STATEMENT_DIGEST,
    relayTicketId: TICKET_ID,
    maximumRole: "operator",
    capabilities: ["ryco.rpc"],
    issuedAt: NOW,
    notBefore: NOW - 1_000,
    expiresAt,
    nonce: new Uint8Array(32).fill(7),
  } as unknown as HubDeviceGrantClaimsInput);
  return encodeHubDeviceGrantEnvelope(
    claims,
    ed25519.sign(encodeHubDeviceGrantSigningEnvelope(claims), signer.secretKey),
  );
}

function ticket(grant = grantEnvelope()): NativeAccountGrantRelayTicketResponse {
  return {
    protocolVersion: 1,
    ticket: "T".repeat(43),
    ticketId: TICKET_ID,
    expiresAt: NOW + 120_000,
    protocolMajor: 1,
    protocolMinor: 3,
    suiteId: 2,
    deviceGrant: encodeBase64Url(grant),
    deviceGrantDigest: encodeBase64Url(e2eeSha256(grant)),
    nodeCapabilityStatement: encodeBase64Url(STATEMENT_BYTES),
    nodeCapabilityStatementDigest: encodeBase64Url(STATEMENT_DIGEST),
    keysetGeneration: 2,
    capability: "ryco.rpc",
    effectiveRole: "operator",
  } as NativeAccountGrantRelayTicketResponse;
}

function harness(
  previous: NativeE2eeAccountTrustedNode | null = null,
  currentTime: number | (() => number) = NOW + 1,
) {
  let stored = previous;
  const api = {
    issueAccountGrantRelayTicket: vi.fn(async () => ticket()),
    getE2eeGrantVerificationKeys: vi.fn(async () => keyset()),
  } as unknown as Pick<
    HostedHubApi,
    "issueAccountGrantRelayTicket" | "getE2eeGrantVerificationKeys"
  >;
  const platform = {
    readAccountTrustedNode: vi.fn(async () => stored),
    writeAccountTrustedNode: vi.fn(async (record) => {
      stored = record;
    }),
  } as Pick<NativeE2eePlatformService, "readAccountTrustedNode" | "writeAccountTrustedNode">;
  const resolve = createNativeE2eeTrustResolver({
    api,
    platform,
    now: () => (typeof currentTime === "function" ? currentTime() : currentTime),
    verifyAccountStatement: () => statement,
  });
  const request: ResolveNativeE2eeTrustInput = {
    hubOrigin: HUB_ORIGIN,
    accountId: ACCOUNT_ID,
    capability: "ryco.rpc" as ResolveNativeE2eeTrustInput["capability"],
    node: {
      nodeId: NODE_ID,
      statementBytes: STATEMENT_BYTES,
      statement,
      accountGrantAllowed: true,
    },
    enrollment,
    localTrustedIntroduction: false,
    verifiedPin: null,
  };
  return { api, platform, resolve, request, stored: () => stored };
}

describe("native E2EE trust resolver", () => {
  it("gives local trusted introduction precedence without contacting the Hub", async () => {
    const { api, resolve, request } = harness();
    const result = await resolve({ ...request, localTrustedIntroduction: true });
    expect(result).toMatchObject({
      kind: "authorized",
      trustSource: "local-trusted-introduction",
      suiteId: 1,
    });
    expect(api.issueAccountGrantRelayTicket).not.toHaveBeenCalled();
  });

  it("blocks a verified-pin conflict instead of repairing it with an account grant", async () => {
    const { api, resolve, request } = harness();
    const result = await resolve({
      ...request,
      verifiedPin: {
        identityFingerprint: new Uint8Array(32).fill(99),
        acceptedPolicyGeneration: 6,
      },
    });
    expect(result).toEqual({ kind: "blocked", reason: "verified-pin-conflict" });
    expect(api.issueAccountGrantRelayTicket).not.toHaveBeenCalled();
  });

  it("verifies every account-grant binding and records public continuity metadata", async () => {
    const { api, platform, resolve, request, stored } = harness();
    const result = await resolve(request);

    expect(result).toMatchObject({
      kind: "authorized",
      trustSource: "account-enrolled",
      suiteId: 2,
      ticket: "T".repeat(43),
      effectiveRole: "operator",
    });
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        enrollmentId: ENROLLMENT_ID,
        enrollmentRevision: 4,
        suiteId: 2,
      }),
    );
    expect(platform.writeAccountTrustedNode).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({
      nodeId: NODE_ID,
      acceptedPolicyGeneration: 7,
      firstTrustedAt: NOW + 1,
      lastTrustedAt: NOW + 1,
    });
  });

  it("preserves the policy high-water mark and blocks rollback before ticket issuance", async () => {
    const previous = {
      hubOrigin: HUB_ORIGIN,
      accountId: ACCOUNT_ID,
      nodeId: NODE_ID,
      identityPublicKey: NODE_PUBLIC,
      identityFingerprint: statement.identityFingerprint,
      agreementFingerprint: e2eeKeyFingerprint("agreement", NODE_AGREEMENT_PUBLIC),
      continuityId: CONTINUITY_ID,
      acceptedPolicyGeneration: 8,
      firstTrustedAt: NOW - 1_000,
      lastTrustedAt: NOW - 500,
      identityChanges: [],
    } satisfies NativeE2eeAccountTrustedNode;
    const { api, resolve, request } = harness(previous);

    await expect(resolve(request)).resolves.toEqual({ kind: "blocked", reason: "policy-rollback" });
    expect(api.issueAccountGrantRelayTicket).not.toHaveBeenCalled();
  });

  it("records a bounded public history when a fresh grant authorizes an identity replacement", async () => {
    const oldPublic = ed25519.getPublicKey(new Uint8Array(32).fill(12));
    const previous = {
      hubOrigin: HUB_ORIGIN,
      accountId: ACCOUNT_ID,
      nodeId: NODE_ID,
      identityPublicKey: oldPublic,
      identityFingerprint: e2eeKeyFingerprint("node-identity", oldPublic),
      agreementFingerprint: e2eeKeyFingerprint("agreement", NODE_AGREEMENT_PUBLIC),
      continuityId: CONTINUITY_ID,
      acceptedPolicyGeneration: 6,
      firstTrustedAt: NOW - 1_000,
      lastTrustedAt: NOW - 500,
      identityChanges: [],
    } satisfies NativeE2eeAccountTrustedNode;
    const { resolve, request, stored } = harness(previous);

    const result = await resolve(request);

    expect(result.kind).toBe("authorized");
    expect(stored()?.firstTrustedAt).toBe(NOW - 1_000);
    expect(stored()?.acceptedPolicyGeneration).toBe(7);
    expect(stored()?.identityChanges).toEqual([
      {
        previousIdentityFingerprint: previous.identityFingerprint,
        nextIdentityFingerprint: statement.identityFingerprint,
        changedAt: NOW + 1,
      },
    ]);
    if (result.kind === "authorized" && result.trustSource === "account-enrolled") {
      result.dispose();
    }
  });

  it("rejects a mismatched statement digest and does not write trust", async () => {
    const { api, platform, resolve, request } = harness();
    vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue({
      ...ticket(),
      nodeCapabilityStatementDigest: encodeBase64Url(new Uint8Array(32).fill(44)),
    } as NativeAccountGrantRelayTicketResponse);

    await expect(resolve(request)).resolves.toEqual({
      kind: "blocked",
      reason: "account-authorization-invalid",
    });
    expect(platform.writeAccountTrustedNode).not.toHaveBeenCalled();
  });

  it("disposes transient grant material idempotently", async () => {
    const { resolve, request } = harness();
    const result = await resolve(request);
    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized" || result.trustSource !== "account-enrolled") return;
    expect(result.grant.envelope.some((byte) => byte !== 0)).toBe(true);
    result.dispose();
    result.dispose();
    expect(result.grant.envelope.every((byte) => byte === 0)).toBe(true);
    expect(result.nodeCapabilityStatement.every((byte) => byte === 0)).toBe(true);
  });

  it("caches the authenticated public keyset across node attempts", async () => {
    const { api, resolve, request } = harness();
    const first = await resolve(request);
    const second = await resolve(request);

    expect(first.kind).toBe("authorized");
    expect(second.kind).toBe("authorized");
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledTimes(2);
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledOnce();
    if (first.kind === "authorized" && first.trustSource === "account-enrolled") first.dispose();
    if (second.kind === "authorized" && second.trustSource === "account-enrolled") second.dispose();
  });

  it("coalesces the verifier-key fetch across a concurrent reconnect burst", async () => {
    const { api, resolve, request } = harness();
    let releaseKeyset!: () => void;
    const keysetReady = new Promise<void>((release) => {
      releaseKeyset = release;
    });
    const originalKeyset = vi.mocked(api.getE2eeGrantVerificationKeys).getMockImplementation();
    vi.mocked(api.getE2eeGrantVerificationKeys).mockImplementationOnce(async () => {
      await keysetReady;
      if (originalKeyset === undefined) throw new Error("missing keyset fixture");
      return originalKeyset();
    });

    const first = resolve(request);
    const second = resolve(request);
    await Promise.resolve();
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledTimes(2);
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledOnce();
    releaseKeyset();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.kind)).toEqual(["authorized", "authorized"]);
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledOnce();
    for (const result of results) {
      if (result.kind === "authorized" && result.trustSource === "account-enrolled") {
        result.dispose();
      }
    }
  });

  it("refreshes cached keys when a restarted Hub signs with a new key at the same generation", async () => {
    const { api, resolve, request } = harness();
    const first = await resolve(request);
    if (first.kind === "authorized" && first.trustSource === "account-enrolled") first.dispose();
    vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue(
      ticket(grantEnvelope(undefined, ROTATED_SIGNER)),
    );
    vi.mocked(api.getE2eeGrantVerificationKeys).mockResolvedValue(keyset(ROTATED_SIGNER));

    const recovered = await resolve(request);

    expect(recovered).toMatchObject({ kind: "authorized", trustSource: "account-enrolled" });
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(2);
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledTimes(2);
    if (recovered.kind === "authorized" && recovered.trustSource === "account-enrolled") {
      recovered.dispose();
    }
  });

  it("coalesces a concurrent unknown-key refresh and verifies both grants", async () => {
    const { api, resolve, request } = harness();
    const first = await resolve(request);
    if (first.kind === "authorized" && first.trustSource === "account-enrolled") first.dispose();
    vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue(
      ticket(grantEnvelope(undefined, ROTATED_SIGNER)),
    );
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.mocked(api.getE2eeGrantVerificationKeys).mockImplementation(async () => {
      await gate;
      return keyset(ROTATED_SIGNER);
    });
    const attempts = [resolve(request), resolve(request)];
    await vi.waitFor(() => expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.all(attempts);

    expect(results.map((result) => result.kind)).toEqual(["authorized", "authorized"]);
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(2);
    for (const result of results) {
      if (result.kind === "authorized" && result.trustSource === "account-enrolled")
        result.dispose();
    }
  });

  it("bounds an unknown-key refresh and persists no trust when the key is still absent", async () => {
    const { api, platform, resolve, request } = harness();
    vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue(
      ticket(grantEnvelope(undefined, ROTATED_SIGNER)),
    );

    await expect(resolve(request)).resolves.toEqual({
      kind: "blocked",
      reason: "account-authorization-invalid",
    });
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(2);
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledOnce();
    expect(platform.writeAccountTrustedNode).not.toHaveBeenCalled();
  });

  it("keeps a failed key refresh recoverable with bounded retry guidance", async () => {
    const { api, platform, resolve, request } = harness();
    vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue(
      ticket(grantEnvelope(undefined, ROTATED_SIGNER)),
    );
    vi.mocked(api.getE2eeGrantVerificationKeys)
      .mockResolvedValueOnce(keyset())
      .mockRejectedValueOnce(new HostedHubApiError("rate_limited", 429, 12_000));

    await expect(resolve(request)).resolves.toEqual({
      kind: "recovery-required",
      reason: "account-authorization-unavailable",
      retryAfterMs: 12_000,
    });
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(2);
    expect(platform.writeAccountTrustedNode).not.toHaveBeenCalled();
  });

  it("does not refresh keys or authorize a grant with an invalid known-key signature", async () => {
    const { api, platform, resolve, request } = harness();
    vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue(
      ticket(grantEnvelope(undefined, { ...ROTATED_SIGNER, keyId: KEY_ID })),
    );

    await expect(resolve(request)).resolves.toEqual({
      kind: "blocked",
      reason: "account-authorization-invalid",
    });
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledOnce();
    expect(platform.writeAccountTrustedNode).not.toHaveBeenCalled();
  });

  it.each(["signature", "ticket-binding"] as const)(
    "still rejects an invalid %s after refreshing an unknown key",
    async (defect) => {
      const { api, platform, resolve, request } = harness();
      const response = ticket(grantEnvelope(undefined, ROTATED_SIGNER));
      vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue({
        ...response,
        ...(defect === "ticket-binding" ? { ticketId: `rtk_${"x".repeat(22)}` } : {}),
      } as NativeAccountGrantRelayTicketResponse);
      vi.mocked(api.getE2eeGrantVerificationKeys)
        .mockResolvedValueOnce(keyset())
        .mockResolvedValueOnce(
          keyset({
            ...ROTATED_SIGNER,
            ...(defect === "signature" ? { secretKey: HUB_SECRET } : {}),
          }),
        );

      await expect(resolve(request)).resolves.toEqual({
        kind: "blocked",
        reason: "account-authorization-invalid",
      });
      expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(2);
      expect(platform.writeAccountTrustedNode).not.toHaveBeenCalled();
    },
  );

  it("rechecks expiry after refreshing keys and reacquires an expired pair once", async () => {
    let currentTime = NOW + 1;
    const { api, resolve, request } = harness(null, () => currentTime);
    vi.mocked(api.issueAccountGrantRelayTicket)
      .mockResolvedValueOnce(ticket(grantEnvelope(NOW + 2, ROTATED_SIGNER)))
      .mockResolvedValueOnce(ticket(grantEnvelope(undefined, ROTATED_SIGNER)));
    vi.mocked(api.getE2eeGrantVerificationKeys)
      .mockResolvedValueOnce(keyset())
      .mockImplementationOnce(async () => {
        currentTime = NOW + 3;
        return keyset(ROTATED_SIGNER);
      });

    const result = await resolve(request);

    expect(result).toMatchObject({ kind: "authorized", trustSource: "account-enrolled" });
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledTimes(2);
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(2);
    if (result.kind === "authorized" && result.trustSource === "account-enrolled") result.dispose();
  });

  it("discards an expired ticket and grant pair and reacquires exactly once", async () => {
    const { api, platform, resolve, request } = harness(null, NOW + 2);
    vi.mocked(api.issueAccountGrantRelayTicket)
      .mockResolvedValueOnce(ticket(grantEnvelope(NOW + 1)))
      .mockResolvedValueOnce(ticket());

    const result = await resolve(request);

    expect(result).toMatchObject({ kind: "authorized", trustSource: "account-enrolled" });
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledTimes(2);
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledOnce();
    expect(platform.writeAccountTrustedNode).toHaveBeenCalledOnce();
    if (result.kind === "authorized" && result.trustSource === "account-enrolled") {
      result.dispose();
    }
  });

  it("bounds expired-pair reacquisition to one retry and persists no trust", async () => {
    const { api, platform, resolve, request } = harness(null, NOW + 2);
    vi.mocked(api.issueAccountGrantRelayTicket).mockResolvedValue(ticket(grantEnvelope(NOW + 1)));

    await expect(resolve(request)).resolves.toEqual({
      kind: "blocked",
      reason: "account-authorization-invalid",
    });
    expect(api.issueAccountGrantRelayTicket).toHaveBeenCalledTimes(2);
    expect(api.getE2eeGrantVerificationKeys).toHaveBeenCalledOnce();
    expect(platform.writeAccountTrustedNode).not.toHaveBeenCalled();
  });

  it("distinguishes a revoked enrollment from temporary authorization loss", async () => {
    const { api, resolve, request } = harness();
    vi.mocked(api.issueAccountGrantRelayTicket).mockRejectedValue(
      new HostedHubApiError("revoked", 403),
    );

    await expect(resolve(request)).resolves.toEqual({
      kind: "blocked",
      reason: "enrollment-revoked",
    });
  });

  it("preserves bounded retry guidance for temporary account authorization loss", async () => {
    const { api, resolve, request } = harness();
    vi.mocked(api.issueAccountGrantRelayTicket).mockRejectedValue(
      new HostedHubApiError("rate_limited", 429, 42_000),
    );

    await expect(resolve(request)).resolves.toEqual({
      kind: "recovery-required",
      reason: "account-authorization-unavailable",
      retryAfterMs: 42_000,
    });
  });

  it("reports an old node as update-required instead of retrying or falling back", async () => {
    const { api, resolve, request } = harness();
    vi.mocked(api.issueAccountGrantRelayTicket).mockRejectedValue(
      new HostedHubApiError("unsupported_version", 409),
    );

    await expect(resolve(request)).resolves.toEqual({
      kind: "blocked",
      reason: "node-update-required",
    });
  });
});
