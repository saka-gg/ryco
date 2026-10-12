import {
  decodeLocalIntroductionApprovalTbs,
  decodeLocalIntroductionRequestTbs,
  encodeLocalIntroductionApprovalTbs,
  localIntroductionRequestDigest,
  localIntroductionRequestIsCurrent,
  verifyLocalIntroductionApproval,
  verifyLocalIntroductionRequestSignature,
} from "@ryco/shared/relayE2eeLocalIntroduction";
import { e2eeBytesEqual, e2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import { deriveE2eeSafetyNumber } from "@ryco/shared/relayE2eeVerificationDisplay";

import {
  type NodeClientAuthorizationClient,
  NodeClientAuthorizationError,
} from "./NodeClientAuthorizationClient.ts";
import {
  type NodeLocalIntroductionLedger,
  NodeLocalIntroductionLedgerError,
} from "./NodeLocalIntroductionLedger.ts";

export {
  type NodeLocalIntroductionErrorCode,
  NodeLocalIntroductionError,
} from "./NodeLocalIntroductionError.ts";
import {
  type NodeLocalIntroductionErrorCode,
  NodeLocalIntroductionError,
} from "./NodeLocalIntroductionError.ts";

function introductionError(code: NodeLocalIntroductionErrorCode): never {
  throw new NodeLocalIntroductionError(code);
}

export interface NodeLocalIntroductionActiveDescriptor {
  readonly hubOrigin: string;
  readonly environmentId: string;
  readonly nodeId: string;
  readonly nodeIdentityPublicKey: Uint8Array;
  readonly nodeContinuityId: string;
  readonly nodePolicyGeneration: number;
  readonly signApproval: (approvalTbs: Uint8Array) => Promise<Uint8Array>;
}

export interface NodeLocalIntroductionPublicDescriptor extends Omit<
  NodeLocalIntroductionActiveDescriptor,
  "signApproval"
> {
  readonly nodeIdentityFingerprint: Uint8Array;
}

export interface NodeLocalIntroductionResult {
  readonly disposition: "created" | "promoted" | "reconciled";
  readonly approvalTbs: Uint8Array;
  readonly approvalSignature: Uint8Array;
}

export interface NodeLocalIntroductionService {
  readonly descriptor: () => Promise<NodeLocalIntroductionPublicDescriptor>;
  readonly complete: (input: {
    readonly requestTbs: Uint8Array;
    readonly requestSignature: Uint8Array;
  }) => Promise<NodeLocalIntroductionResult>;
}

const FIXED_ROLE = "owner" as const;
const FIXED_CAPABILITIES = ["ryco.rpc"] as const;

function exactAuthority(maxRole: string, capabilitySet: readonly string[]): boolean {
  return (
    maxRole === FIXED_ROLE &&
    capabilitySet.length === FIXED_CAPABILITIES.length &&
    capabilitySet.every((entry, index) => entry === FIXED_CAPABILITIES[index])
  );
}

function mapFailure(error: unknown): never {
  if (error instanceof NodeLocalIntroductionError) throw error;
  if (error instanceof NodeClientAuthorizationError) {
    if (
      error.code === "client_authorization_conflict" ||
      error.code === "client_authorization_approved_cap"
    ) {
      return introductionError("local_introduction_conflict");
    }
    if (error.code === "client_authorization_invalid") {
      return introductionError("local_introduction_rejected");
    }
    return introductionError("local_introduction_unavailable");
  }
  if (error instanceof NodeLocalIntroductionLedgerError) {
    return introductionError(
      error.code === "local_introduction_ledger_conflict"
        ? "local_introduction_conflict"
        : "local_introduction_unavailable",
    );
  }
  return introductionError("local_introduction_unavailable");
}

export function makeNodeLocalIntroductionService(options: {
  readonly active: () => Promise<NodeLocalIntroductionActiveDescriptor>;
  readonly authorization: Pick<NodeClientAuthorizationClient, "introduce">;
  readonly ledger: NodeLocalIntroductionLedger;
  readonly now?: () => number;
}): NodeLocalIntroductionService {
  const now = options.now ?? (() => Date.now());

  const descriptor = async (): Promise<NodeLocalIntroductionPublicDescriptor> => {
    try {
      const active = await options.active();
      return {
        hubOrigin: active.hubOrigin,
        environmentId: active.environmentId,
        nodeId: active.nodeId,
        nodeIdentityPublicKey: Uint8Array.from(active.nodeIdentityPublicKey),
        nodeIdentityFingerprint: e2eeKeyFingerprint("node-identity", active.nodeIdentityPublicKey),
        nodeContinuityId: active.nodeContinuityId,
        nodePolicyGeneration: active.nodePolicyGeneration,
      };
    } catch (error: unknown) {
      return mapFailure(error);
    }
  };

  /**
   * One process-wide serial lane. Authorization and replay state are distinct
   * protected files, so two different requests carrying the same introduction
   * id must not both pass the pre-ledger read and create two grants. The node
   * identity writer lock already enforces one owning backend process; this lane
   * closes the remaining in-process gap.
   */
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const complete: NodeLocalIntroductionService["complete"] = (input) =>
    exclusive(async () => {
      try {
        const request = verifyLocalIntroductionRequestSignature({
          requestTbs: input.requestTbs,
          signature: input.requestSignature,
        });
        if (request === undefined) return introductionError("local_introduction_rejected");
        const requestDigest = localIntroductionRequestDigest(input.requestTbs);
        const replay = await options.ledger.get(request.introductionId);
        if (replay !== undefined) {
          const replayDigest = Uint8Array.from(Buffer.from(replay.requestDigest, "base64url"));
          if (!e2eeBytesEqual(requestDigest, replayDigest)) {
            return introductionError("local_introduction_conflict");
          }
          const approvalTbs = Uint8Array.from(Buffer.from(replay.approvalTbs, "base64url"));
          const approvalSignature = Uint8Array.from(
            Buffer.from(replay.approvalSignature, "base64url"),
          );
          if (
            decodeLocalIntroductionApprovalTbs(approvalTbs).approvedAt !== replay.approvedAt ||
            verifyLocalIntroductionApproval({
              requestTbs: input.requestTbs,
              approvalTbs,
              signature: approvalSignature,
            }) === undefined
          ) {
            return introductionError("local_introduction_unavailable");
          }
          return { disposition: "reconciled", approvalTbs, approvalSignature };
        }

        const at = now();
        if (!localIntroductionRequestIsCurrent(request, at)) {
          return introductionError("local_introduction_expired");
        }
        if (!exactAuthority(request.maxRole, request.capabilitySet)) {
          return introductionError("local_introduction_rejected");
        }

        const active = await options.active();
        if (
          request.hubOrigin !== active.hubOrigin ||
          request.environmentId !== active.environmentId ||
          request.nodeId !== active.nodeId ||
          !e2eeBytesEqual(request.nodeIdentityPublicKey, active.nodeIdentityPublicKey) ||
          request.nodeContinuityId !== active.nodeContinuityId ||
          request.nodePolicyGeneration !== active.nodePolicyGeneration
        ) {
          return introductionError("local_introduction_conflict");
        }

        const introduced = await options.authorization.introduce({
          key: {
            hubOrigin: request.hubOrigin,
            accountId: request.accountId,
            clientIdentityFingerprint: e2eeKeyFingerprint(
              "client-identity",
              request.clientIdentityPublicKey,
            ),
          },
          maxRole: request.maxRole,
          capabilitySet: request.capabilitySet,
          safetyNumber: deriveE2eeSafetyNumber({
            nodeIdentityPublicKey: request.nodeIdentityPublicKey,
            clientIdentityPublicKey: request.clientIdentityPublicKey,
            hubOrigin: request.hubOrigin,
            accountId: request.accountId,
          }).display,
          ...(request.displayLabel === undefined ? {} : { displayLabel: request.displayLabel }),
        });
        const approvedAt = introduced.record.approvedAt;
        if (approvedAt === undefined) {
          return introductionError("local_introduction_unavailable");
        }
        const approvalTbs = encodeLocalIntroductionApprovalTbs({
          requestTbs: input.requestTbs,
          approvedAt,
        });
        const approvalSignature = await active.signApproval(approvalTbs);
        if (
          verifyLocalIntroductionApproval({
            requestTbs: input.requestTbs,
            approvalTbs,
            signature: approvalSignature,
          }) === undefined
        ) {
          return introductionError("local_introduction_unavailable");
        }
        await options.ledger.commit({
          introductionId: request.introductionId,
          requestDigest,
          approvalTbs,
          approvalSignature,
          approvedAt,
          recordedAt: at,
        });
        return { disposition: introduced.disposition, approvalTbs, approvalSignature };
      } catch (error: unknown) {
        return mapFailure(error);
      }
    });

  return { descriptor, complete };
}
