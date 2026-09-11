import type { HostedHubApi } from "@ryco/client-runtime/authorization";
import { describe, expect, it, vi } from "vite-plus/test";

import { runDesktopAutomaticNodeClaim } from "./automaticNodeClaim.ts";
import type { DesktopHubControlClient } from "./desktopHubControl.ts";

const installationId = `install_${"A".repeat(22)}`;
const fingerprint = `SHA256:${"A".repeat(43)}`;
const descriptor = {
  protocolVersion: 1,
  state: "prepared",
  hubOrigin: "https://hub.example.test",
  environmentId: `env_${"B".repeat(22)}`,
  label: "Ada's Mac",
  platformOs: "darwin",
  platformArch: "arm64",
  clientVersion: "0.1.8",
  algorithm: "ed25519",
  publicKey: "A".repeat(43),
  fingerprint,
} as const;
const claim = {
  protocolVersion: 1,
  transcriptVersion: 1,
  claimId: `nclaim_${"C".repeat(22)}`,
  challenge: "A".repeat(43),
  accountId: `acct_${"D".repeat(22)}`,
  spaceId: `space_${"E".repeat(22)}`,
  sessionId: `sess_${"F".repeat(22)}`,
  dpopKeyThumbprint: "A".repeat(43),
  installationId,
  environmentId: descriptor.environmentId,
  nodeFingerprint: fingerprint,
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_300_000,
} as const;
const result = {
  status: "claimed",
  disposition: "created",
  node: {
    id: `node_${"G".repeat(22)}`,
    activeKeyId: `nkey_${"H".repeat(22)}`,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    fingerprint,
    effectiveRole: "owner",
  },
} as const;

function harness() {
  const api = {
    hasSessionMaterial: true,
    startNativeNodeClaim: vi.fn(async () => claim),
    finishNativeNodeClaim: vi.fn(async () => result),
  } as unknown as HostedHubApi;
  const control = {
    nodeClaimDescriptor: vi.fn(async () => descriptor),
    signNodeClaim: vi.fn(async () => ({ protocolVersion: 1, signature: "A".repeat(86) })),
    commitNodeClaim: vi.fn(async () => ({ protocolVersion: 1, status: "active", result })),
  } as unknown as DesktopHubControlClient;
  return { api, control };
}

describe("automatic Desktop node claim", () => {
  it("binds the Hub claim to exact child metadata and commits it back to that child", async () => {
    const test = harness();
    await expect(
      runDesktopAutomaticNodeClaim({
        ...test,
        installationId,
        expectedHubOrigin: descriptor.hubOrigin,
        expectedAccountId: claim.accountId,
        randomIdempotencyKey: () => "A".repeat(43),
      }),
    ).resolves.toEqual({ claim, result });
    expect(test.api.startNativeNodeClaim).toHaveBeenCalledWith(
      {
        installationId,
        node: expect.objectContaining({ fingerprint, publicKey: descriptor.publicKey }),
      },
      undefined,
    );
    expect(test.control.signNodeClaim).toHaveBeenCalledWith({ claim });
    expect(test.control.commitNodeClaim).toHaveBeenCalledWith({ claim, result });
  });

  it("reconnects the same active node after its account-managed label changes", async () => {
    const test = harness();
    const renamed = {
      ...result,
      disposition: "reconnected" as const,
      node: { ...result.node, label: "Renamed Mac" },
    };
    vi.mocked(test.control.nodeClaimDescriptor).mockResolvedValue({
      ...descriptor,
      state: "active",
    } as never);
    vi.mocked(test.api.finishNativeNodeClaim).mockResolvedValue(renamed as never);
    vi.mocked(test.control.commitNodeClaim).mockResolvedValue({
      protocolVersion: 1,
      status: "active",
      result: renamed,
    } as never);
    await expect(
      runDesktopAutomaticNodeClaim({
        ...test,
        installationId,
        expectedHubOrigin: descriptor.hubOrigin,
        expectedAccountId: claim.accountId,
      }),
    ).resolves.toEqual({ claim, result: renamed });
    expect(test.control.commitNodeClaim).toHaveBeenCalledWith({ claim, result: renamed });
  });

  it("refuses a substituted Hub origin or node result before child promotion", async () => {
    const origin = harness();
    await expect(
      runDesktopAutomaticNodeClaim({
        ...origin,
        installationId,
        expectedHubOrigin: "https://other.example.test",
        expectedAccountId: claim.accountId,
      }),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    expect(origin.api.startNativeNodeClaim).not.toHaveBeenCalled();

    const node = harness();
    node.api.finishNativeNodeClaim = vi.fn(async () => ({
      ...result,
      node: { ...result.node, fingerprint: `SHA256:${"I".repeat(43)}` },
    })) as never;
    await expect(
      runDesktopAutomaticNodeClaim({
        ...node,
        installationId,
        expectedHubOrigin: descriptor.hubOrigin,
        expectedAccountId: claim.accountId,
        randomIdempotencyKey: () => "A".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    expect(node.control.commitNodeClaim).not.toHaveBeenCalled();
  });
});
