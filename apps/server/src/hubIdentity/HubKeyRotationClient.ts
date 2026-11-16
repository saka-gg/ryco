import { randomBytes } from "node:crypto";

import {
  canonicalizeHubOrigin,
  encodeNodeKeyRotationTranscript,
  type NodePublicKeyDescriptor,
} from "@ryco/shared/nodeIdentity";

import {
  identitySecretsInService,
  type LocalHubIdentityStateStore,
  type NodeRotationContinuityMode,
} from "./LocalHubIdentityState.ts";
import { isWellFormedHubChallenge } from "./HubChallenge.ts";
import type { NodeIdentityKeyRetirementStore } from "./NodeIdentityKeyRetirementStore.ts";
import type { NodeSigningIdentity } from "./NodeSigningIdentity.ts";

export interface HubKeyRotationChallenge {
  readonly rotationRequestId: string;
  readonly newKeyId: string;
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly challenge: Uint8Array;
  readonly challengeExpiresAt: number;
}

export type HubKeyRotationStatus =
  | { readonly status: "proof_required" }
  | { readonly status: "awaiting_owner" }
  | { readonly status: "activated"; readonly activatedAt: number }
  | { readonly status: "rejected" };

export interface HubKeyRotationTransport {
  readonly begin: (request: {
    readonly hubOrigin: string;
    readonly nodeId: string;
    readonly oldActiveKeyId: string;
    readonly newKey: NodePublicKeyDescriptor;
    readonly existingRotationRequestId?: string;
  }) => Promise<HubKeyRotationChallenge>;
  readonly prove: (request: {
    readonly hubOrigin: string;
    readonly rotationRequestId: string;
    readonly challenge: Uint8Array;
    readonly signature: Uint8Array;
  }) => Promise<HubKeyRotationStatus>;
  readonly status: (request: {
    readonly hubOrigin: string;
    readonly rotationRequestId: string;
  }) => Promise<HubKeyRotationStatus>;
}

export type HubKeyRotationClientErrorCode =
  | "rotation_not_available"
  | "rotation_conflict"
  | "rotation_response_invalid"
  | "rotation_transport_failed"
  | "rotation_local_state_failed";

export class HubKeyRotationClientError extends Error {
  readonly code: HubKeyRotationClientErrorCode;

  constructor(code: HubKeyRotationClientErrorCode) {
    super("Hub key rotation client operation failed.");
    this.name = "HubKeyRotationClientError";
    this.code = code;
  }
}

/**
 * What the promotion step must do to the §7.5 continuity chain.
 *
 * The rotation client holds the one moment at which a continuity certificate can
 * exist at all: the outgoing key is still in custody, the incoming key is known,
 * and neither has been promoted yet. §7.5 requires the certificate to be signed
 * by the outgoing key and durably retained *before* that key is destroyed, so
 * `issue` is called ahead of the deletion and its failure aborts the promotion
 * with nothing lost — the operator can retry, or re-stage as a deliberate break.
 */
export interface HubKeyRotationContinuity {
  readonly issue: (input: {
    readonly hubOrigin: string;
    readonly oldKeyId: string;
    readonly oldKeySecretName: string;
    readonly newKeyId: string;
    readonly newKeySecretName: string;
  }) => Promise<void>;
  /** §7.5: a rotation that does not issue a certificate breaks the chain, explicitly. */
  readonly break: (input: { readonly hubOrigin: string }) => Promise<void>;
}

/**
 * What a committed promotion did to the §7.5 chain.
 *
 * `null` when the rotation carried the chain forward — the certificate was
 * issued and durably retained before the promotion, and its failure aborted the
 * promotion, so there is nothing left to report.
 *
 * For a deliberate break the recording happens AFTER the commit and is therefore
 * best-effort, like every other post-commit step: the promotion is durable by
 * then, and reporting a failed follow-up as the promotion's failure would tell
 * the caller the rotation did not happen when it did. `deferred` is how the
 * caller still learns the break did not reach the record — self-healing, because
 * the §7.5 startup cross-check finds the same condition and records it, but a
 * fact an operator surface should be able to show rather than infer.
 */
export type HubKeyRotationContinuityOutcome = "recorded" | "deferred" | null;

export interface HubKeyRotationPromotion {
  readonly continuityBreak: HubKeyRotationContinuityOutcome;
}

export interface HubKeyRotationClient {
  /**
   * §7.5 makes the continuity disposition an operator decision that this client
   * may not infer, so it is a required argument rather than a defaulted option:
   * a compromise rotation MUST break the chain, and only the caller knows.
   */
  readonly stage: (
    hubOrigin: string,
    options: { readonly continuity: NodeRotationContinuityMode },
  ) => Promise<HubKeyRotationStatus>;
  readonly resume: (hubOrigin: string) => Promise<HubKeyRotationStatus>;
  readonly authenticationKey: (hubOrigin: string) => Promise<{
    readonly keyId: string;
    readonly secretName: string;
  }>;
  readonly confirmNewKeyAuthenticated: (
    hubOrigin: string,
    keyId: string,
  ) => Promise<HubKeyRotationPromotion>;
  /**
   * Destroy every identity secret the durable queue holds.
   *
   * The resumable half of a promotion: the queue is written before the promotion
   * commits, so a destruction interrupted by a crash, or refused by a credential
   * store that was briefly unavailable, is finished by the next call rather than
   * lost. Idempotent and safe to call at any time.
   *
   * A queued name that the identity state still calls in service is SKIPPED and
   * left queued: it belongs to a promotion that has not committed, so destroying
   * it would erase the key the node authenticates with, and dequeuing it would
   * orphan that key the moment the promotion did commit. A name whose deletion
   * fails also stays queued.
   */
  readonly destroyRetiredKeys: () => Promise<void>;
}

export interface HubKeyRotationClientDependencies {
  readonly transport: HubKeyRotationTransport;
  readonly signingIdentity: NodeSigningIdentity;
  readonly stateStore: LocalHubIdentityStateStore;
  /** The durable destroy queue (`NodeIdentityKeyRetirementStore`). */
  readonly retirement: NodeIdentityKeyRetirementStore;
  readonly continuity: HubKeyRotationContinuity;
  readonly now?: () => number;
}

const ROTATION_ID = /^nrot_[A-Za-z0-9_-]{22}$/;
const NODE_KEY_ID = /^nkey_[A-Za-z0-9_-]{22}$/;

function rotationError(code: HubKeyRotationClientErrorCode): never {
  throw new HubKeyRotationClientError(code);
}

function validateStatus(status: HubKeyRotationStatus): HubKeyRotationStatus {
  if (
    status.status === "proof_required" ||
    status.status === "awaiting_owner" ||
    status.status === "rejected"
  ) {
    return status;
  }
  if (
    status.status === "activated" &&
    Number.isSafeInteger(status.activatedAt) &&
    status.activatedAt >= 0
  ) {
    return { status: "activated", activatedAt: status.activatedAt };
  }
  return rotationError("rotation_response_invalid");
}

function validateChallenge(challenge: HubKeyRotationChallenge): HubKeyRotationChallenge {
  if (
    !ROTATION_ID.test(challenge.rotationRequestId) ||
    !NODE_KEY_ID.test(challenge.newKeyId) ||
    !Number.isSafeInteger(challenge.protocolMajor) ||
    challenge.protocolMajor < 0 ||
    challenge.protocolMajor > 65_535 ||
    !Number.isSafeInteger(challenge.protocolMinor) ||
    challenge.protocolMinor < 0 ||
    challenge.protocolMinor > 65_535 ||
    !isWellFormedHubChallenge(challenge)
  ) {
    return rotationError("rotation_response_invalid");
  }
  return { ...challenge, challenge: Uint8Array.from(challenge.challenge) };
}

function newSecretName(): string {
  return `node-key.${randomBytes(16).toString("hex")}`;
}

export function makeHubKeyRotationClient(
  dependencies: HubKeyRotationClientDependencies,
): HubKeyRotationClient {
  const now = dependencies.now ?? Date.now;

  const applyStatus = async (
    hubOrigin: string,
    status: HubKeyRotationStatus,
  ): Promise<HubKeyRotationStatus> => {
    const validated = validateStatus(status);
    const current = await dependencies.stateStore.readOrCreate();
    const staged = current.stagedRotation;
    if (staged === null || staged.hubOrigin !== hubOrigin) {
      return rotationError("rotation_local_state_failed");
    }
    if (validated.status === "activated") {
      if (staged.activatedAt !== validated.activatedAt) {
        await dependencies.stateStore.update((state) => {
          if (state.stagedRotation?.rotationRequestId !== staged.rotationRequestId) {
            return rotationError("rotation_local_state_failed");
          }
          return {
            ...state,
            revision: state.revision + 1,
            stagedRotation: { ...state.stagedRotation, activatedAt: validated.activatedAt },
          };
        });
      }
      return validated;
    }
    if (validated.status === "rejected") {
      await dependencies.signingIdentity.delete(staged.newKeySecretName).catch(() => undefined);
      await dependencies.stateStore.update((state) => {
        if (state.stagedRotation?.rotationRequestId !== staged.rotationRequestId) {
          return rotationError("rotation_local_state_failed");
        }
        return { ...state, revision: state.revision + 1, stagedRotation: null };
      });
    }
    return validated;
  };

  const prove = async (
    hubOrigin: string,
    challenge: HubKeyRotationChallenge,
  ): Promise<HubKeyRotationStatus> => {
    const state = await dependencies.stateStore.readOrCreate();
    const active = state.activeNode;
    const staged = state.stagedRotation;
    if (
      active === null ||
      active.hubOrigin !== hubOrigin ||
      staged === null ||
      staged.rotationRequestId !== challenge.rotationRequestId ||
      staged.newKeyId !== challenge.newKeyId
    ) {
      return rotationError("rotation_local_state_failed");
    }
    const newKey = await dependencies.signingIdentity.getPublicDescriptor(staged.newKeySecretName);
    const transcript = encodeNodeKeyRotationTranscript({
      hubOrigin,
      protocolMajor: challenge.protocolMajor,
      protocolMinor: challenge.protocolMinor,
      rotationRequestId: challenge.rotationRequestId,
      nodeId: active.nodeId,
      oldActiveKeyId: active.activeKeyId,
      newKeyId: challenge.newKeyId,
      newKey,
      challengeExpiresAt: challenge.challengeExpiresAt,
      challenge: challenge.challenge,
    });
    const signature = await dependencies.signingIdentity.sign(
      active.activeKeySecretName,
      transcript,
    );
    try {
      return await applyStatus(
        hubOrigin,
        await dependencies.transport.prove({
          hubOrigin,
          rotationRequestId: challenge.rotationRequestId,
          challenge: challenge.challenge,
          signature,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof HubKeyRotationClientError) throw error;
      return rotationError("rotation_transport_failed");
    } finally {
      challenge.challenge.fill(0);
      signature.fill(0);
      transcript.fill(0);
    }
  };

  const stage: HubKeyRotationClient["stage"] = async (rawHubOrigin, options) => {
    let hubOrigin: string;
    try {
      hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
    } catch {
      return rotationError("rotation_not_available");
    }
    const state = await dependencies.stateStore.readOrCreate();
    const active = state.activeNode;
    if (active === null || active.hubOrigin !== hubOrigin) {
      return rotationError("rotation_not_available");
    }
    if (state.stagedRotation !== null) return rotationError("rotation_conflict");

    const newKeySecretName = newSecretName();
    const newKey = await dependencies.signingIdentity.generate(newKeySecretName);
    let challenge: HubKeyRotationChallenge;
    try {
      challenge = validateChallenge(
        await dependencies.transport.begin({
          hubOrigin,
          nodeId: active.nodeId,
          oldActiveKeyId: active.activeKeyId,
          newKey,
        }),
      );
    } catch (error: unknown) {
      await dependencies.signingIdentity.delete(newKeySecretName).catch(() => undefined);
      if (error instanceof HubKeyRotationClientError) throw error;
      return rotationError("rotation_transport_failed");
    }
    try {
      await dependencies.stateStore.update((current) => {
        if (
          current.stagedRotation !== null ||
          current.activeNode?.activeKeyId !== active.activeKeyId
        ) {
          return rotationError("rotation_conflict");
        }
        return {
          ...current,
          revision: current.revision + 1,
          stagedRotation: {
            hubOrigin,
            rotationRequestId: challenge.rotationRequestId,
            newKeyId: challenge.newKeyId,
            newKeySecretName,
            // Recorded now, consumed at promotion. The two are separated by an
            // owner approval that may take days and a restart or three, so the
            // operator's §7.5 choice has to be durable rather than in flight.
            continuityMode: options.continuity,
            stagedAt: now(),
            activatedAt: null,
          },
        };
      });
    } catch (error: unknown) {
      challenge.challenge.fill(0);
      await dependencies.signingIdentity.delete(newKeySecretName).catch(() => undefined);
      throw error;
    }
    return prove(hubOrigin, challenge);
  };

  const resume: HubKeyRotationClient["resume"] = async (rawHubOrigin) => {
    let hubOrigin: string;
    try {
      hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
    } catch {
      return rotationError("rotation_not_available");
    }
    const state = await dependencies.stateStore.readOrCreate();
    const active = state.activeNode;
    const staged = state.stagedRotation;
    if (active === null || staged === null || staged.hubOrigin !== hubOrigin) {
      return rotationError("rotation_not_available");
    }
    let status: HubKeyRotationStatus;
    try {
      status = validateStatus(
        await dependencies.transport.status({
          hubOrigin,
          rotationRequestId: staged.rotationRequestId,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof HubKeyRotationClientError) throw error;
      return rotationError("rotation_transport_failed");
    }
    if (status.status !== "proof_required") return applyStatus(hubOrigin, status);

    const newKey = await dependencies.signingIdentity.getPublicDescriptor(staged.newKeySecretName);
    let challenge: HubKeyRotationChallenge;
    try {
      challenge = validateChallenge(
        await dependencies.transport.begin({
          hubOrigin,
          nodeId: active.nodeId,
          oldActiveKeyId: active.activeKeyId,
          newKey,
          existingRotationRequestId: staged.rotationRequestId,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof HubKeyRotationClientError) throw error;
      return rotationError("rotation_transport_failed");
    }
    if (
      challenge.rotationRequestId !== staged.rotationRequestId ||
      challenge.newKeyId !== staged.newKeyId
    ) {
      challenge.challenge.fill(0);
      return rotationError("rotation_response_invalid");
    }
    return prove(hubOrigin, challenge);
  };

  const authenticationKey: HubKeyRotationClient["authenticationKey"] = async (rawHubOrigin) => {
    const hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
    const state = await dependencies.stateStore.readOrCreate();
    if (state.activeNode?.hubOrigin !== hubOrigin) return rotationError("rotation_not_available");
    if (
      state.stagedRotation?.hubOrigin === hubOrigin &&
      state.stagedRotation.activatedAt !== null
    ) {
      return {
        keyId: state.stagedRotation.newKeyId,
        secretName: state.stagedRotation.newKeySecretName,
      };
    }
    return {
      keyId: state.activeNode.activeKeyId,
      secretName: state.activeNode.activeKeySecretName,
    };
  };

  const destroyRetiredKeys: HubKeyRotationClient["destroyRetiredKeys"] = async () => {
    const queued = await dependencies.retirement.names();
    if (queued.length === 0) return;
    // The queue and the identity state are two records, so an entry means "this
    // key is retired unless the promotion that queued it never committed". This
    // is where that is resolved, against the record that knows.
    const inService = identitySecretsInService(await dependencies.stateStore.readOrCreate());
    const destroyed: string[] = [];
    for (const name of queued) {
      if (inService.has(name)) continue;
      try {
        await dependencies.signingIdentity.delete(name);
        destroyed.push(name);
      } catch {
        // Left queued. A credential store that cannot delete right now must not
        // lose the only handle the node has on the key.
      }
    }
    if (destroyed.length === 0) return;
    // Dequeued only after the key is gone, and never before: the reverse order
    // is exactly the orphaned secret this queue exists to prevent. A failure
    // here leaves the name queued and the next pass deletes an already-absent
    // key, which is a no-op.
    await dependencies.retirement.dequeue(destroyed);
  };

  const confirmNewKeyAuthenticated: HubKeyRotationClient["confirmNewKeyAuthenticated"] = async (
    rawHubOrigin,
    keyId,
  ) => {
    const hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
    const state = await dependencies.stateStore.readOrCreate();
    const active = state.activeNode;
    const staged = state.stagedRotation;
    if (
      active === null ||
      active.hubOrigin !== hubOrigin ||
      staged === null ||
      staged.hubOrigin !== hubOrigin ||
      staged.activatedAt === null ||
      staged.newKeyId !== keyId
    ) {
      return rotationError("rotation_not_available");
    }
    // §7.5, in this exact order and for this exact reason: the certificate is
    // signed by the outgoing key and durably synced BEFORE that key is
    // destroyed and before the promotion it describes completes. A failure here
    // aborts the promotion with the outgoing key intact, which is the fail-closed
    // outcome — the alternative would be a key gone and a link that was never
    // written, i.e. an unannounced chain break.
    //
    // The break case is the mirror image and therefore runs AFTER the promotion,
    // not here: dropping the chain first would spend it on a rotation that may
    // still fail, leaving the old key live and every pinned client facing a
    // re-verification for a rotation that never happened. Deferring it is safe
    // because a promotion that commits without the break recorded is exactly
    // what the §7.5 startup cross-check detects and records — it is the one
    // failure this system already repairs by itself.
    if (staged.continuityMode === "continue") {
      await dependencies.continuity.issue({
        hubOrigin,
        oldKeyId: active.activeKeyId,
        oldKeySecretName: active.activeKeySecretName,
        newKeyId: staged.newKeyId,
        newKeySecretName: staged.newKeySecretName,
      });
    }
    // Drained before anything is queued, so the queue holds at most the one key
    // this promotion retires and its bound is headroom rather than a limit.
    await destroyRetiredKeys().catch(() => undefined);
    // QUEUE, THEN COMMIT, THEN DESTROY — never any other order.
    //
    // The promotion and the destruction of the outgoing key span two stores, so
    // one of them happens first and a crash can land between them. Destroying
    // first is unrecoverable: the key is gone, this record still names it as
    // active, the promotion cannot be completed (nothing can sign as the old
    // key again) and cannot be rolled back (there is no key to roll back to).
    //
    // The queue is what makes the destruction resumable, and it lives in a
    // record of its own so that a downgrade cannot silently delete the only
    // name a live private key still has (`NodeIdentityKeyRetirementStore`).
    // That record is not the one the promotion commits to, so it is written
    // BEFORE the commit rather than with it: a crash in between leaves a queued
    // name that is still in service, which the drain skips and this operation's
    // retry re-queues and commits, while the reverse order leaves an outgoing
    // key that nothing names at all. A failure here therefore aborts the
    // promotion, with the outgoing key intact and nothing spent.
    await dependencies.retirement.enqueue(active.activeKeySecretName);
    await dependencies.stateStore.update((current) => {
      if (
        current.activeNode?.activeKeyId !== active.activeKeyId ||
        current.stagedRotation?.newKeyId !== staged.newKeyId
      ) {
        return rotationError("rotation_local_state_failed");
      }
      return {
        ...current,
        revision: current.revision + 1,
        activeNode: {
          ...current.activeNode,
          activeKeyId: staged.newKeyId,
          activeKeySecretName: staged.newKeySecretName,
        },
        stagedRotation: null,
      };
    });
    // Best effort by design: the promotion has already committed, so reporting a
    // failed deletion as the promotion's failure would be a lie, and the queue
    // is what makes the deletion finish later regardless.
    await destroyRetiredKeys().catch(() => undefined);
    if (staged.continuityMode === "continue") return { continuityBreak: null };
    // The promotion is committed, so the chain now ends at a key this node no
    // longer holds and cannot be advertised. Recording the break here makes it
    // explicit and keeps the generation mark, which is what stops the next
    // rotation from reusing a generation §7.5 forbids reusing.
    //
    // Best effort for the same reason as every other post-commit step, and it
    // was the only one that was not: an unreadable continuity anchor made a
    // promotion that had durably committed report failure, which would send an
    // operator to retry a rotation that already happened. The outcome is
    // returned instead, so the caller can still show that the break did not
    // record — and the §7.5 startup cross-check records the same break by
    // itself, because a committed promotion leaves a chain that reaches no key
    // in custody.
    try {
      await dependencies.continuity.break({ hubOrigin });
      return { continuityBreak: "recorded" };
    } catch {
      return { continuityBreak: "deferred" };
    }
  };

  return { stage, resume, authenticationKey, confirmNewKeyAuthenticated, destroyRetiredKeys };
}
