import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeCrossDeviceApprovalQr,
  decodeCrossDeviceApprovalTbs,
  verifyCrossDeviceApprovalQr,
} from "@ryco/shared/relayE2eeCrossDeviceApproval";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";

import type { NodeClientAuthorizationRecord } from "./NodeClientAuthorizationClient.ts";
import {
  makeNodeCrossDeviceApprovalService,
  NodeCrossDeviceApprovalError,
} from "./NodeCrossDeviceApprovalService.ts";

const ED25519_SPKI_PREFIX_BYTES = 12;
const rawEd25519Public = (key: KeyObject): Uint8Array =>
  Uint8Array.from(
    (key.export({ format: "der", type: "spki" }) as Buffer).subarray(ED25519_SPKI_PREFIX_BYTES),
  );
const rawP256Public = (key: KeyObject): Uint8Array => {
  const jwk = key.export({ format: "jwk" });
  return Uint8Array.from([
    0x04,
    ...Buffer.from(jwk.x!, "base64url"),
    ...Buffer.from(jwk.y!, "base64url"),
  ]);
};
const NODE_KEYS = generateKeyPairSync("ed25519");
const CLIENT_KEYS = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const NODE_PUBLIC = rawEd25519Public(NODE_KEYS.publicKey);
const CLIENT_PUBLIC = rawP256Public(CLIENT_KEYS.publicKey);
const CLIENT_FINGERPRINT = e2eeKeyFingerprint("client-identity", CLIENT_PUBLIC);
const NOW = 1_800_000_000_000;

const record = (
  overrides: Partial<NodeClientAuthorizationRecord> = {},
): NodeClientAuthorizationRecord => ({
  status: "approved",
  hubOrigin: "https://hub.example.test",
  accountId: `acct_${"A".repeat(22)}`,
  fingerprintDisplay: formatE2eeKeyFingerprint(CLIENT_FINGERPRINT),
  maxRole: "owner",
  capabilitySet: ["ryco.rpc"],
  createdAt: NOW - 2_000,
  approvedAt: NOW - 1_000,
  revokedAt: undefined,
  lastSeenAt: undefined,
  safetyNumber: "11111 22222 33333 44444 55555",
  displayLabel: "Laurin's iPhone",
  pairingReserved: false,
  observedRole: "owner",
  ...overrides,
});

const active = () => ({
  hubOrigin: "https://hub.example.test",
  nodeId: `node_${"B".repeat(22)}`,
  nodeIdentityPublicKey: NODE_PUBLIC,
  nodeContinuityId: `nct_${"C".repeat(22)}`,
  nodePolicyGeneration: 7,
  signApproval: async (tbs: Uint8Array) =>
    Uint8Array.from(signBytes(null, tbs, NODE_KEYS.privateKey)),
});

describe("NodeCrossDeviceApprovalService", () => {
  it("signs a short-lived QR only from the exact durable approved record", async () => {
    const service = makeNodeCrossDeviceApprovalService({
      active: async () => active(),
      authorization: { get: async () => record() },
      now: () => NOW,
      randomBytes: () => new Uint8Array(32).fill(0x5a),
    });
    const result = await service.create({
      hubOrigin: record().hubOrigin,
      accountId: record().accountId,
      clientIdentityFingerprint: CLIENT_FINGERPRINT,
    });
    expect(result).toMatchObject({
      approvedAt: NOW - 1_000,
      issuedAt: NOW,
      expiresAt: NOW + 300_000,
    });
    const envelope = decodeCrossDeviceApprovalQr(result.payload);
    expect(decodeCrossDeviceApprovalTbs(envelope.tbs)).toMatchObject({
      nodeId: active().nodeId,
      maxRole: "owner",
      capabilitySet: ["ryco.rpc"],
      nodeContinuityId: active().nodeContinuityId,
      nodePolicyGeneration: 7,
      approvalId: new Uint8Array(32).fill(0x5a),
    });
    expect(
      verifyCrossDeviceApprovalQr({
        payload: result.payload,
        hubOrigin: record().hubOrigin,
        accountId: record().accountId,
        nodeId: active().nodeId,
        nodeIdentityPublicKey: NODE_PUBLIC,
        clientIdentityPublicKey: CLIENT_PUBLIC,
        nodeContinuityId: active().nodeContinuityId,
        nodePolicyGeneration: 7,
        now: NOW,
      }),
    ).toBeDefined();
  });

  it("refuses pending, revoked, and missing authorization records before signing", async () => {
    for (const value of [
      record({ status: "pending", approvedAt: undefined }),
      record({ status: "revoked" }),
      undefined,
    ]) {
      let signed = false;
      const service = makeNodeCrossDeviceApprovalService({
        active: async () => ({
          ...active(),
          signApproval: async (tbs) => {
            signed = true;
            return Uint8Array.from(signBytes(null, tbs, NODE_KEYS.privateKey));
          },
        }),
        authorization: { get: async () => value },
        now: () => NOW,
      });
      await expect(
        service.create({
          hubOrigin: record().hubOrigin,
          accountId: record().accountId,
          clientIdentityFingerprint: CLIENT_FINGERPRINT,
        }),
      ).rejects.toMatchObject({
        code: "cross_device_approval_not_approved",
      } satisfies Partial<NodeCrossDeviceApprovalError>);
      expect(signed).toBe(false);
    }
  });

  it("refuses an origin/key disagreement and a clock rollback", async () => {
    const cases = [
      {
        active: async () => ({ ...active(), hubOrigin: "https://other.example.test" }),
        now: () => NOW,
        code: "cross_device_approval_conflict",
      },
      {
        active: async () => active(),
        now: () => NOW - 2_000,
        code: "cross_device_approval_unavailable",
      },
    ] as const;
    for (const testCase of cases) {
      const service = makeNodeCrossDeviceApprovalService({
        active: testCase.active,
        authorization: { get: async () => record() },
        now: testCase.now,
      });
      await expect(
        service.create({
          hubOrigin: record().hubOrigin,
          accountId: record().accountId,
          clientIdentityFingerprint: CLIENT_FINGERPRINT,
        }),
      ).rejects.toMatchObject({ code: testCase.code });
    }
  });

  it("contains signing failures and never returns an unverifiable payload", async () => {
    const service = makeNodeCrossDeviceApprovalService({
      active: async () => ({
        ...active(),
        signApproval: async () => new Uint8Array(64),
      }),
      authorization: { get: async () => record() },
      now: () => NOW,
    });
    await expect(
      service.create({
        hubOrigin: record().hubOrigin,
        accountId: record().accountId,
        clientIdentityFingerprint: CLIENT_FINGERPRINT,
      }),
    ).rejects.toMatchObject({ code: "cross_device_approval_unavailable" });
  });
});
