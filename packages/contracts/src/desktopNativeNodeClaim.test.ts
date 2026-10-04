import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  DESKTOP_HUB_REACHABILITY_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH,
  DesktopHubReachabilityResponse,
  DesktopNativeNodeClaimCommitRequest,
  DesktopNativeNodeClaimDescriptorResponse,
  DesktopNativeNodeClaimSignRequest,
} from "./desktopNativeNodeClaim.ts";

const strictDecode = <S extends Schema.Top>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Decoder<unknown>)(input, {
    onExcessProperty: "error",
  }) as S["Type"];

const claim = {
  protocolVersion: 1,
  transcriptVersion: 1,
  claimId: "nclaim_aaaaaaaaaaaaaaaaaaaaaa",
  challenge: "A".repeat(43),
  accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  spaceId: "space_aaaaaaaaaaaaaaaaaaaaaa",
  sessionId: "sess_aaaaaaaaaaaaaaaaaaaaaa",
  dpopKeyThumbprint: "B".repeat(43),
  installationId: "install_aaaaaaaaaaaaaaaaaaaaaa",
  environmentId: "env_aaaaaaaaaaaaaaaaaaaaaa",
  nodeFingerprint: `SHA256:${"C".repeat(42)}E`,
  issuedAt: 1_752_710_400_000,
  expiresAt: 1_752_710_700_000,
} as const;

const result = {
  status: "claimed",
  disposition: "created",
  node: {
    id: "node_aaaaaaaaaaaaaaaaaaaaaa",
    activeKeyId: "nkey_aaaaaaaaaaaaaaaaaaaaaa",
    environmentId: claim.environmentId,
    label: "Studio Mac",
    fingerprint: claim.nodeFingerprint,
    effectiveRole: "owner",
  },
} as const;

describe("Desktop automatic node-claim local-control contracts", () => {
  it("pins the three Desktop-main-only paths", () => {
    expect([
      DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH,
      DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH,
      DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH,
    ]).toEqual([
      "/api/desktop/hub/native-node-claim/descriptor",
      "/api/desktop/hub/native-node-claim/sign",
      "/api/desktop/hub/native-node-claim/commit",
    ]);
  });

  it("pins the reachability probe to the same local-control prefix with a bare answer", () => {
    expect(DESKTOP_HUB_REACHABILITY_PATH).toBe("/api/desktop/hub/reachability");
    expect(
      strictDecode(DesktopHubReachabilityResponse, { protocolVersion: 1, reachable: true }),
    ).toEqual({ protocolVersion: 1, reachable: true });
    expect(() =>
      strictDecode(DesktopHubReachabilityResponse, {
        protocolVersion: 1,
        reachable: true,
        hubOrigin: "https://hub.example.test",
      }),
    ).toThrow();
  });

  it("accepts the exact prepared descriptor and claim envelopes", () => {
    expect(
      strictDecode(DesktopNativeNodeClaimDescriptorResponse, {
        protocolVersion: 1,
        state: "prepared",
        hubOrigin: "https://hub.example.test",
        environmentId: claim.environmentId,
        label: "Studio Mac",
        platformOs: "darwin",
        platformArch: "arm64",
        clientVersion: "0.1.8",
        algorithm: "ed25519",
        publicKey: `${"D".repeat(42)}E`,
        fingerprint: claim.nodeFingerprint,
      }),
    ).toBeTruthy();
    expect(strictDecode(DesktopNativeNodeClaimSignRequest, { claim })).toBeTruthy();
    expect(strictDecode(DesktopNativeNodeClaimCommitRequest, { claim, result })).toBeTruthy();
  });

  it("rejects hidden authority and mismatched result shapes", () => {
    expect(() =>
      strictDecode(DesktopNativeNodeClaimSignRequest, {
        claim: { ...claim, credential: "must-not-survive" },
      }),
    ).toThrow();
    expect(() =>
      strictDecode(DesktopNativeNodeClaimCommitRequest, {
        claim,
        result: { ...result, node: { ...result.node, activeKeyId: "missing" } },
      }),
    ).toThrow();
  });
});
