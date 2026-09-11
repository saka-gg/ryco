import { randomBytes } from "node:crypto";

import type {
  NativeNodeClaimFinishResponse,
  NativeNodeClaimStartResponse,
} from "@ryco/contracts/hosted-identity";
import {
  canonicalizeHubOrigin,
  encodeNativeNodeClaimTranscript,
  equalNodeIdentityBytes,
  formatNodePublicKeyFingerprint,
} from "@ryco/shared/nodeIdentity";

import type {
  ActiveHubNodeState,
  LocalHubIdentityState,
  LocalHubIdentityStateStore,
  PendingHubEnrollmentState,
} from "./LocalHubIdentityState.ts";
import type { NodeSigningIdentity, NodeSigningPublicDescriptor } from "./NodeSigningIdentity.ts";

export type NodeNativeClaimErrorCode =
  | "native_node_claim_unavailable"
  | "native_node_claim_rejected"
  | "native_node_claim_conflict"
  | "native_node_claim_expired";

export class NodeNativeClaimError extends Error {
  readonly code: NodeNativeClaimErrorCode;

  constructor(code: NodeNativeClaimErrorCode) {
    super("Automatic native node claim failed.");
    this.name = "NodeNativeClaimError";
    this.code = code;
  }
}

export interface NodeNativeClaimDescriptor extends NodeSigningPublicDescriptor {
  readonly state: "prepared" | "active";
  readonly hubOrigin: string;
  readonly environmentId: string;
}

export interface NodeNativeClaimService {
  readonly prepare: (hubOrigin: string) => Promise<NodeNativeClaimDescriptor>;
  readonly sign: (input: {
    readonly hubOrigin: string;
    readonly claim: NativeNodeClaimStartResponse;
  }) => Promise<Uint8Array>;
  readonly commit: (input: {
    readonly hubOrigin: string;
    readonly expectedLabel: string;
    readonly claim: NativeNodeClaimStartResponse;
    readonly result: NativeNodeClaimFinishResponse;
  }) => Promise<ActiveHubNodeState>;
}

const CLAIM_CLOCK_SKEW_MS = 30_000;

function claimError(code: NodeNativeClaimErrorCode): never {
  throw new NodeNativeClaimError(code);
}

function nativePending(state: LocalHubIdentityState, hubOrigin: string): PendingHubEnrollmentState {
  const pending = state.pendingEnrollment;
  if (
    pending === null ||
    (pending.kind ?? "device-code") !== "native-claim" ||
    pending.cleanupRequested ||
    pending.hubOrigin !== hubOrigin
  ) {
    return claimError("native_node_claim_conflict");
  }
  return pending;
}

function boundedLabel(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    value.trim() !== value
  ) {
    return claimError("native_node_claim_rejected");
  }
  return value;
}

function decodeOpaque(value: string, length: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return claimError("native_node_claim_rejected");
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (bytes.byteLength !== length || Buffer.from(bytes).toString("base64url") !== value) {
    return claimError("native_node_claim_rejected");
  }
  return bytes;
}

function claimIsCurrent(claim: NativeNodeClaimStartResponse, now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    claim.issuedAt <= now + CLAIM_CLOCK_SKEW_MS &&
    claim.expiresAt > now &&
    claim.expiresAt - claim.issuedAt <= 5 * 60_000
  );
}

function keyName(): string {
  return `node-key.native-claim.${randomBytes(16).toString("hex")}`;
}

function markerName(): string {
  // The field is intentionally present even though native claim has no polling
  // bearer. Older binaries retain and can erase this pending record instead of
  // dropping an unknown ownership slot and orphaning its private key.
  return `native-claim.marker.${randomBytes(16).toString("hex")}`;
}

export function makeNodeNativeClaimService(options: {
  readonly stateStore: LocalHubIdentityStateStore;
  readonly signingIdentity: NodeSigningIdentity;
  readonly now?: () => number;
}): NodeNativeClaimService {
  const now = options.now ?? Date.now;

  let pendingOperation: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = pendingOperation.then(operation, operation);
    pendingOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const descriptorFor = async (
    state: LocalHubIdentityState,
    hubOrigin: string,
  ): Promise<NodeNativeClaimDescriptor> => {
    const active = state.activeNode;
    if (active !== null) {
      if (active.hubOrigin !== hubOrigin) return claimError("native_node_claim_conflict");
      const descriptor = await options.signingIdentity.getPublicDescriptor(
        active.activeKeySecretName,
      );
      return { ...descriptor, state: "active", hubOrigin, environmentId: state.environmentId };
    }
    const pending = nativePending(state, hubOrigin);
    const descriptor = await options.signingIdentity.getPublicDescriptor(pending.keySecretName);
    return { ...descriptor, state: "prepared", hubOrigin, environmentId: state.environmentId };
  };

  const validateClaim = async (input: {
    readonly hubOrigin: string;
    readonly claim: NativeNodeClaimStartResponse;
    readonly requireCurrent: boolean;
  }): Promise<{
    readonly state: LocalHubIdentityState;
    readonly descriptor: NodeNativeClaimDescriptor;
    readonly secretName: string;
    readonly transcript: Uint8Array;
  }> => {
    let hubOrigin: string;
    try {
      hubOrigin = canonicalizeHubOrigin(input.hubOrigin);
    } catch {
      return claimError("native_node_claim_rejected");
    }
    const state = await options.stateStore.readOrCreate();
    const descriptor = await descriptorFor(state, hubOrigin);
    if (
      input.claim.environmentId !== state.environmentId ||
      input.claim.nodeFingerprint !== formatNodePublicKeyFingerprint(descriptor.fingerprint)
    ) {
      return claimError("native_node_claim_conflict");
    }
    if (input.requireCurrent && !claimIsCurrent(input.claim, now())) {
      return claimError("native_node_claim_expired");
    }
    const secretName =
      state.activeNode?.activeKeySecretName ?? nativePending(state, hubOrigin).keySecretName;
    let transcript: Uint8Array;
    try {
      transcript = encodeNativeNodeClaimTranscript({
        hubOrigin,
        protocolVersion: input.claim.protocolVersion,
        transcriptVersion: input.claim.transcriptVersion,
        claimId: input.claim.claimId,
        accountId: input.claim.accountId,
        spaceId: input.claim.spaceId,
        sessionId: input.claim.sessionId,
        dpopKeyThumbprint: decodeOpaque(input.claim.dpopKeyThumbprint, 32),
        installationId: input.claim.installationId,
        environmentId: input.claim.environmentId,
        nodeKey: { algorithm: descriptor.algorithm, publicKey: descriptor.publicKey },
        claimExpiresAt: input.claim.expiresAt,
        challenge: decodeOpaque(input.claim.challenge, 32),
      });
    } catch (error: unknown) {
      if (error instanceof NodeNativeClaimError) throw error;
      return claimError("native_node_claim_rejected");
    }
    return { state, descriptor, secretName, transcript };
  };

  return {
    prepare: (rawHubOrigin) =>
      exclusive(async () => {
        let hubOrigin: string;
        try {
          hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
        } catch {
          return claimError("native_node_claim_rejected");
        }
        const state = await options.stateStore.readOrCreate();
        if (state.activeNode !== null) return await descriptorFor(state, hubOrigin);
        if (state.pendingEnrollment !== null) return await descriptorFor(state, hubOrigin);

        const secretName = keyName();
        const publicKey = await options.signingIdentity.generate(secretName);
        try {
          const committed = await options.stateStore.update((current) => {
            if (current.activeNode !== null || current.pendingEnrollment !== null) {
              return claimError("native_node_claim_conflict");
            }
            return {
              ...current,
              revision: current.revision + 1,
              pendingEnrollment: {
                kind: "native-claim",
                hubOrigin,
                keySecretName: secretName,
                pollingSecretName: markerName(),
                label: null,
                deviceCode: null,
                createdAt: now(),
                expiresAt: null,
                pollIntervalMs: null,
                cleanupRequested: false,
              },
            };
          });
          return {
            ...publicKey,
            state: "prepared",
            hubOrigin,
            environmentId: committed.environmentId,
          };
        } catch (error: unknown) {
          await options.signingIdentity.delete(secretName).catch(() => undefined);
          throw error;
        }
      }),
    sign: (input) =>
      exclusive(async () => {
        const validated = await validateClaim({ ...input, requireCurrent: true });
        return await options.signingIdentity.sign(validated.secretName, validated.transcript);
      }),
    commit: (input) =>
      exclusive(async () => {
        const expectedLabel = boundedLabel(input.expectedLabel);
        const validated = await validateClaim({
          hubOrigin: input.hubOrigin,
          claim: input.claim,
          requireCurrent: true,
        });
        if (
          input.result.status !== "claimed" ||
          input.result.node.environmentId !== input.claim.environmentId ||
          input.result.node.fingerprint !== input.claim.nodeFingerprint ||
          // An existing node keeps its account-managed name across OS-name changes and restarts.
          (input.result.node.label !== expectedLabel &&
            !(
              validated.descriptor.state === "active" && input.result.disposition === "reconnected"
            )) ||
          input.result.node.effectiveRole !== "owner"
        ) {
          return claimError("native_node_claim_conflict");
        }
        const active: ActiveHubNodeState = {
          hubOrigin: validated.descriptor.hubOrigin,
          nodeId: input.result.node.id,
          activeKeyId: input.result.node.activeKeyId,
          activeKeySecretName: validated.secretName,
          cleanupPollingSecretName: null,
          enrolledAt: now(),
        };
        const committed = await options.stateStore.update((current) => {
          if (current.environmentId !== input.claim.environmentId) {
            return claimError("native_node_claim_conflict");
          }
          if (current.activeNode !== null) {
            const existing = current.activeNode;
            if (
              existing.hubOrigin !== active.hubOrigin ||
              existing.nodeId !== active.nodeId ||
              existing.activeKeyId !== active.activeKeyId ||
              existing.activeKeySecretName !== active.activeKeySecretName
            ) {
              return claimError("native_node_claim_conflict");
            }
            // `LocalHubIdentityStateStore.update` is a durable transaction and
            // requires every accepted proposal to advance the revision. A
            // repeated native claim is semantically idempotent, but returning
            // `current` here makes the real store reject that retry after the
            // Hub has already confirmed the same active node. Persist an exact
            // revision-only acknowledgement so Desktop can continue to its
            // local trusted introduction.
            return { ...current, revision: current.revision + 1 };
          }
          const pending = nativePending(current, active.hubOrigin);
          if (pending.keySecretName !== active.activeKeySecretName) {
            return claimError("native_node_claim_conflict");
          }
          return {
            ...current,
            revision: current.revision + 1,
            pendingEnrollment: null,
            activeNode: active,
          };
        });
        const committedActive = committed.activeNode;
        if (committedActive === null) return claimError("native_node_claim_unavailable");
        const committedDescriptor = await options.signingIdentity.getPublicDescriptor(
          committedActive.activeKeySecretName,
        );
        if (
          !equalNodeIdentityBytes(committedDescriptor.publicKey, validated.descriptor.publicKey)
        ) {
          return claimError("native_node_claim_unavailable");
        }
        return committedActive;
      }),
  };
}
