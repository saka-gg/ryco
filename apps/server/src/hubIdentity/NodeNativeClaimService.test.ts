import { createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import type {
  NativeNodeClaimFinishResponse,
  NativeNodeClaimStartResponse,
} from "@ryco/contracts/hosted-identity";
import {
  encodeNativeNodeClaimTranscript,
  formatNodePublicKeyFingerprint,
} from "@ryco/shared/nodeIdentity";

import type { LocalHubIdentityState, LocalHubIdentityStateStore } from "./LocalHubIdentityState.ts";
import { makeNodeNativeClaimService, NodeNativeClaimError } from "./NodeNativeClaimService.ts";
import { makeNodeSigningIdentity } from "./NodeSigningIdentity.ts";
import type { ProtectedSecretStore } from "./ProtectedSecretStore.ts";

const HUB_ORIGIN = "https://hub.example.test";
const NOW = 1_752_710_400_000;
const ENVIRONMENT_ID = "env_aaaaaaaaaaaaaaaaaaaaaa";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function memoryStore(): ProtectedSecretStore & { readonly values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    backend: "permissioned-file",
    values,
    get: async (name) => {
      const value = values.get(name);
      return value === undefined ? null : Uint8Array.from(value);
    },
    create: async (name, value) => {
      if (values.has(name)) throw new Error("conflict");
      values.set(name, Uint8Array.from(value));
    },
    remove: async (name) => {
      values.delete(name);
    },
  };
}

function stateStore(initial?: Partial<LocalHubIdentityState>): LocalHubIdentityStateStore & {
  readonly current: () => LocalHubIdentityState;
} {
  let value: LocalHubIdentityState = {
    version: 1,
    revision: 0,
    environmentId: ENVIRONMENT_ID,
    protectedStoreBackend: "permissioned-file",
    pendingEnrollment: null,
    activeNode: null,
    stagedRotation: null,
    pendingTeardown: null,
    ...initial,
  };
  return {
    current: () => value,
    readOrCreate: async () => value,
    update: async (change) => {
      const previous = value;
      const proposed = change(previous);
      if (proposed.revision !== previous.revision + 1) {
        throw new Error("state update must advance the revision");
      }
      value = proposed;
      return value;
    },
    reset: async () => value,
  };
}

function claimFor(fingerprint: string): NativeNodeClaimStartResponse {
  return {
    protocolVersion: 1,
    transcriptVersion: 1,
    claimId: "nclaim_aaaaaaaaaaaaaaaaaaaaaa",
    challenge: Buffer.alloc(32, 1).toString("base64url"),
    accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    spaceId: "space_aaaaaaaaaaaaaaaaaaaaaa",
    sessionId: "sess_aaaaaaaaaaaaaaaaaaaaaa",
    dpopKeyThumbprint: Buffer.alloc(32, 2).toString("base64url"),
    installationId: "install_aaaaaaaaaaaaaaaaaaaaaa",
    environmentId: ENVIRONMENT_ID,
    nodeFingerprint: fingerprint,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
  } as unknown as NativeNodeClaimStartResponse;
}

function resultFor(fingerprint: string): NativeNodeClaimFinishResponse {
  return {
    status: "claimed",
    disposition: "created",
    node: {
      id: "node_aaaaaaaaaaaaaaaaaaaaaa",
      activeKeyId: "nkey_aaaaaaaaaaaaaaaaaaaaaa",
      environmentId: ENVIRONMENT_ID,
      label: "Studio Mac",
      fingerprint,
      effectiveRole: "owner",
    },
  } as unknown as NativeNodeClaimFinishResponse;
}

describe("NodeNativeClaimService", () => {
  it("prepares one resumable node key, signs the Hub transcript, and commits it active", async () => {
    const secrets = memoryStore();
    const states = stateStore();
    const service = makeNodeNativeClaimService({
      stateStore: states,
      signingIdentity: makeNodeSigningIdentity(secrets),
      now: () => NOW,
    });

    const first = await service.prepare(HUB_ORIGIN);
    const resumed = await service.prepare(HUB_ORIGIN);
    expect(first.state).toBe("prepared");
    expect(resumed.publicKey).toEqual(first.publicKey);
    expect(secrets.values.size).toBe(1);

    const fingerprint = formatNodePublicKeyFingerprint(first.fingerprint);
    const claim = claimFor(fingerprint);
    const signature = await service.sign({ hubOrigin: HUB_ORIGIN, claim });
    const transcript = encodeNativeNodeClaimTranscript({
      hubOrigin: HUB_ORIGIN,
      protocolVersion: claim.protocolVersion,
      transcriptVersion: claim.transcriptVersion,
      claimId: claim.claimId,
      accountId: claim.accountId,
      spaceId: claim.spaceId,
      sessionId: claim.sessionId,
      dpopKeyThumbprint: Buffer.from(claim.dpopKeyThumbprint, "base64url"),
      installationId: claim.installationId,
      environmentId: claim.environmentId,
      nodeKey: { algorithm: "ed25519", publicKey: first.publicKey },
      claimExpiresAt: claim.expiresAt,
      challenge: Buffer.from(claim.challenge, "base64url"),
    });
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(first.publicKey)]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, transcript, publicKey, signature)).toBe(true);

    const result = resultFor(fingerprint);
    const committed = await service.commit({
      hubOrigin: HUB_ORIGIN,
      expectedLabel: "Studio Mac",
      claim,
      result,
    });
    expect(committed).toMatchObject({
      nodeId: result.node.id,
      activeKeyId: result.node.activeKeyId,
      hubOrigin: HUB_ORIGIN,
    });
    expect(states.current().pendingEnrollment).toBeNull();
    expect((await service.prepare(HUB_ORIGIN)).state).toBe("active");

    await expect(
      service.commit({
        hubOrigin: HUB_ORIGIN,
        expectedLabel: "Studio Mac",
        claim,
        result,
      }),
    ).resolves.toMatchObject({ nodeId: result.node.id });
    expect(states.current().revision).toBe(3);
    const renamed = {
      ...result,
      disposition: "reconnected" as const,
      node: { ...result.node, label: "Renamed Mac" },
    };
    await expect(
      service.commit({
        hubOrigin: HUB_ORIGIN,
        expectedLabel: "Studio Mac",
        claim,
        result: renamed,
      }),
    ).resolves.toMatchObject({ nodeId: result.node.id, activeKeyId: result.node.activeKeyId });
    expect(states.current().revision).toBe(4);
    await expect(
      service.commit({
        hubOrigin: HUB_ORIGIN,
        expectedLabel: "Studio Mac",
        claim,
        result: {
          ...renamed,
          node: { ...renamed.node, id: "node_bbbbbbbbbbbbbbbbbbbbbb" as never },
        },
      }),
    ).rejects.toMatchObject({ code: "native_node_claim_conflict" });
  });

  it("fails closed on another origin, stale claims, or a changed Hub result", async () => {
    const states = stateStore();
    const service = makeNodeNativeClaimService({
      stateStore: states,
      signingIdentity: makeNodeSigningIdentity(memoryStore()),
      now: () => NOW,
    });
    const descriptor = await service.prepare(HUB_ORIGIN);
    const fingerprint = formatNodePublicKeyFingerprint(descriptor.fingerprint);
    const claim = claimFor(fingerprint);

    await expect(service.prepare("https://other.example.test")).rejects.toBeInstanceOf(
      NodeNativeClaimError,
    );
    await expect(
      service.sign({
        hubOrigin: HUB_ORIGIN,
        claim: { ...claim, expiresAt: NOW - 1 },
      }),
    ).rejects.toMatchObject({ code: "native_node_claim_expired" });
    await expect(
      service.commit({
        hubOrigin: HUB_ORIGIN,
        expectedLabel: "Studio Mac",
        claim,
        result: {
          ...resultFor(fingerprint),
          node: { ...resultFor(fingerprint).node, label: "Substituted" },
        },
      }),
    ).rejects.toMatchObject({ code: "native_node_claim_conflict" });
    expect(states.current().activeNode).toBeNull();
  });

  it("does not take over a pending device-code enrollment key", async () => {
    const states = stateStore({
      pendingEnrollment: {
        kind: "device-code",
        hubOrigin: HUB_ORIGIN,
        keySecretName: "node-key.manual",
        pollingSecretName: "enrollment-poll.manual",
        label: "Studio Mac",
        deviceCode: "AAAA-BBBB",
        createdAt: NOW,
        expiresAt: NOW + 60_000,
        pollIntervalMs: 1_000,
        cleanupRequested: false,
      },
    });
    const service = makeNodeNativeClaimService({
      stateStore: states,
      signingIdentity: makeNodeSigningIdentity(memoryStore()),
      now: () => NOW,
    });
    await expect(service.prepare(HUB_ORIGIN)).rejects.toMatchObject({
      code: "native_node_claim_conflict",
    });
  });
});
