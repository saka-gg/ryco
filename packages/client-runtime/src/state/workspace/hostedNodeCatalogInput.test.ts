import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  HostedHubNode,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
} from "../../authorization/types.js";
import {
  cachedHubNodeCatalogInput,
  hostedNodeCatalogInput,
  hostedSessionConnectionState,
} from "./hostedNodeCatalogInput.js";
import { reconcileWorkspaceMachine } from "./machineCatalog.js";

const environmentId = EnvironmentId.make("env-catalog");

function node(overrides: Partial<HostedHubNode> = {}): HostedHubNode {
  return {
    id: "node-1",
    environmentId,
    label: "Studio",
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1.2.3",
    createdAt: 1,
    updatedAt: 2,
    lastAuthenticatedAt: 3,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant-1", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 4 },
    ...overrides,
  };
}

const hostedWeb = {
  clientTier: "hosted-web",
  nativeTrust: "not-required",
  requiresNativeVerification: false,
  deliveryUnknown: false,
  observedAt: 10,
} as const;

describe("hosted node catalog input", () => {
  it("derives one connection state from the session", () => {
    const transports: ReadonlyArray<HostedRelayTransportStatus> = [
      "idle",
      "requesting-ticket",
      "connecting",
      "authenticating",
      "opening-channel",
      "online",
      "reconnecting",
      "draining",
      "terminal-failure",
    ];
    const sessions: ReadonlyArray<HostedRycoSessionStatus> = [
      "synchronizing",
      "ready",
      "stale",
      "replaying",
      "delivery-unknown",
      "closed",
    ];
    const establishing = new Set<HostedRelayTransportStatus>([
      "requesting-ticket",
      "connecting",
      "authenticating",
      "opening-channel",
      "reconnecting",
    ]);
    for (const transportStatus of transports) {
      for (const sessionStatus of sessions) {
        const expected =
          transportStatus === "online" && sessionStatus === "ready"
            ? "connected"
            : establishing.has(transportStatus) ||
                sessionStatus === "synchronizing" ||
                sessionStatus === "replaying"
              ? "connecting"
              : "disconnected";
        expect(
          hostedSessionConnectionState({ transportStatus, sessionStatus }),
          `${transportStatus} / ${sessionStatus}`,
        ).toBe(expected);
      }
    }
    expect(hostedSessionConnectionState(null)).toBe("disconnected");
    expect(hostedSessionConnectionState()).toBe("disconnected");
  });

  it("maps a directory node with the current capability defaults", () => {
    const input = hostedNodeCatalogInput(node(), hostedWeb);
    expect(input).toEqual({
      environmentId,
      nodeId: "node-1",
      label: "Studio",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.2.3",
      // A directory without the settlement flag leaves it unknown, not off.
      capabilities: {
        repositoryIdentity: true,
        nativeClientRequired: false,
      },
      clientTier: "hosted-web",
      nativeTrust: "not-required",
      requiresNativeVerification: false,
      effectiveRole: "operator",
      online: true,
      lastSeenAt: 4,
      observedAt: 10,
      connectionState: "disconnected",
      deliveryUnknown: false,
      revokedAt: null,
    });
    expect(reconcileWorkspaceMachine(input)).toMatchObject({ canConnect: true, canMutate: true });
  });

  it("passes published capabilities, presence and revocation through", () => {
    const input = hostedNodeCatalogInput(
      node({
        capabilities: {
          repositoryIdentity: false,
          nativeClientRequired: true,
          threadSettlement: true,
        },
        presence: { online: false, lastHeartbeatAt: null },
        revokedAt: 9,
      }),
      { ...hostedWeb, deliveryUnknown: true },
    );
    expect(input).toMatchObject({
      capabilities: {
        repositoryIdentity: false,
        nativeClientRequired: true,
        threadSettlement: true,
      },
      online: false,
      lastSeenAt: 3,
      deliveryUnknown: true,
      revokedAt: 9,
    });
    expect(reconcileWorkspaceMachine(input)).toMatchObject({
      canConnect: false,
      accessReasons: ["revoked", "native-client-required", "offline"],
    });
  });

  it("prefers the session's role and state over the directory's", () => {
    const input = hostedNodeCatalogInput(node({ effectiveRole: "owner" }), {
      clientTier: "native",
      nativeTrust: "verified",
      requiresNativeVerification: true,
      session: { transportStatus: "online", sessionStatus: "ready", effectiveRole: "viewer" },
      deliveryUnknown: false,
      observedAt: 20,
    });
    expect(input).toMatchObject({
      clientTier: "native",
      nativeTrust: "verified",
      requiresNativeVerification: true,
      effectiveRole: "viewer",
      connectionState: "connected",
    });

    const withoutRole = hostedNodeCatalogInput(node({ effectiveRole: "owner" }), {
      ...hostedWeb,
      session: { transportStatus: "connecting", sessionStatus: "closed", effectiveRole: null },
    });
    expect(withoutRole).toMatchObject({ effectiveRole: "owner", connectionState: "connecting" });
  });

  it("builds a read-cache preview that never connects or mutates", () => {
    const input = cachedHubNodeCatalogInput({
      environmentId,
      nodeId: "node-1",
      label: "Studio",
      observedAt: 30,
      clientTier: "hosted-web",
    });
    expect(input).toMatchObject({
      online: false,
      effectiveRole: "viewer",
      connectionState: "disconnected",
      lastSeenAt: null,
      revokedAt: null,
    });
    expect(input.capabilities).toBeUndefined();
    expect(reconcileWorkspaceMachine(input)).toMatchObject({
      platform: { os: "unknown", arch: "other" },
      capabilities: {
        repositoryIdentity: false,
        nativeClientRequired: false,
      },
      canReadMetadata: true,
      canConnect: false,
      canMutate: false,
      cacheDisposition: "available",
    });
  });

  it("keeps a native read-cache preview gated by the client's trust", () => {
    const preview = (nativeTrust: "verified" | "unknown" | "unverified") =>
      reconcileWorkspaceMachine(
        cachedHubNodeCatalogInput({
          environmentId,
          nodeId: "node-1",
          label: "Studio",
          observedAt: 30,
          clientTier: "native",
          nativeTrust,
          requiresNativeVerification: true,
        }),
      );
    expect(preview("verified")).toMatchObject({
      nativeTrust: "verified",
      canReadMetadata: true,
      canConnect: false,
      cacheDisposition: "available",
    });
    expect(preview("unknown")).toMatchObject({
      canReadMetadata: false,
      cacheDisposition: "purge",
      accessReasons: expect.arrayContaining(["trust-unknown"]),
    });
    expect(preview("unverified")).toMatchObject({
      canReadMetadata: false,
      cacheDisposition: "purge",
      accessReasons: expect.arrayContaining(["not-verified"]),
    });
  });
});
