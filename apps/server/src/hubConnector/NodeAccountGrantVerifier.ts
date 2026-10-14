import type { RelayCapability, RelayEffectiveRole } from "@ryco/contracts/relay";
import {
  e2eeRoleWithinCeiling,
  type E2eeAccountGrantNodeVerificationInput,
  type E2eeAdmittedAuthoritySnapshot,
} from "@ryco/shared/relayE2eeHandshake";
import {
  verifyHubDeviceGrant,
  type HubDeviceGrantFailureReason,
} from "@ryco/shared/relayE2eeHubDeviceGrant";
import { e2eeBytesEqual } from "@ryco/shared/relayE2eeKeys";
import { E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 } from "@ryco/shared/relayE2eeWire";

import type { NodeClientAuthorizationClient } from "../hubIdentity/NodeClientAuthorizationClient.ts";
import type { EffectiveNodeE2eePolicy } from "../hubIdentity/NodeE2eePolicyStore.ts";
import type { HubConnectorE2eeStateMachine } from "./HubConnectorState.ts";

export type NodeAccountGrantVerificationResult =
  | {
      readonly accepted: true;
      /** A pre-existing local record can only narrow this account grant. */
      readonly localAuthority: E2eeAdmittedAuthoritySnapshot | undefined;
    }
  | { readonly accepted: false; readonly reason: HubDeviceGrantFailureReason };

export interface NodeAccountGrantVerifier {
  readonly verify: (
    input: E2eeAccountGrantNodeVerificationInput,
  ) => NodeAccountGrantVerificationResult;
}

const relayRole = (value: string): RelayEffectiveRole | undefined =>
  value === "viewer" || value === "operator" || value === "owner" ? value : undefined;

const relayCapability = (value: string): RelayCapability | undefined =>
  value === "ryco.rpc" ? value : undefined;

/**
 * The node-side authorization boundary for suite 0x02.
 *
 * Every source is synchronous and connector-generation scoped, so the grant,
 * current policy, optional local restriction, statement acknowledgement,
 * retained prekey statement, keyset, and revocation state are one row-N3
 * decision. This function performs no fetch and no durable write.
 */
export function makeNodeAccountGrantVerifier(options: {
  readonly state: HubConnectorE2eeStateMachine;
  readonly connectorGeneration: () => number;
  readonly policy: () => EffectiveNodeE2eePolicy;
  readonly authorization: Pick<NodeClientAuthorizationClient, "lookupClientAuthorization">;
  readonly onRejected?: (reason: HubDeviceGrantFailureReason) => void;
}): NodeAccountGrantVerifier {
  const reject = (reason: HubDeviceGrantFailureReason): NodeAccountGrantVerificationResult => {
    options.onRejected?.(reason);
    return { accepted: false, reason };
  };

  return {
    verify: (input) => {
      const context = input.channel.accountGrantContext;
      if (context === undefined) return reject("grant_binding");
      const material = options.state.accountGrantMaterial(
        options.connectorGeneration(),
        context.nodeCapabilityStatementDigest,
      );
      if (material === undefined) return reject("grant_binding");

      const policy = options.policy();
      if (
        !policy.accountGrantsAllowed ||
        !policy.suiteRegistry.includes(E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256)
      ) {
        return reject("grant_policy");
      }

      const role = relayRole(input.intendedRole);
      const capability = relayCapability(input.intendedCapability);
      if (role === undefined || capability === undefined) return reject("grant_policy");

      const claims = input.grant.claims;
      const enrollmentCurrent = options.state.enrollmentGrantIsCurrent({
        enrollmentId: claims.enrollmentId,
        enrollmentRevision: claims.enrollmentRevision,
        accountAuthEpoch: claims.accountAuthEpoch,
        deviceAuthEpoch: claims.deviceAuthEpoch,
      });

      const key = {
        hubOrigin: material.hubOrigin,
        accountId: claims.accountId,
        clientIdentityFingerprint: claims.deviceIdentityFingerprint,
      };
      let local: ReturnType<typeof options.authorization.lookupClientAuthorization>;
      try {
        local = options.authorization.lookupClientAuthorization(key);
      } catch {
        return reject("grant_policy");
      }
      // §18.7 lets only a local restriction or denial outrank the grant. A
      // pending §13.2 request is neither: it is an unanswered ceremony that
      // grants nothing, so the device is admitted exactly as one with no
      // record. Otherwise one abandoned verification would lock an enrolled
      // device out of this node until an owner approved it here.
      if (local?.status === "pending") local = undefined;
      if (
        local !== undefined &&
        (local.status !== "approved" || !local.capabilitySet.includes(capability))
      ) {
        return reject("grant_policy");
      }
      try {
        if (local !== undefined && !e2eeRoleWithinCeiling(role, local.maxRole)) {
          return reject("grant_policy");
        }
      } catch {
        return reject("grant_policy");
      }

      const advertisement = material.advertisement;
      if (
        advertisement.hubOrigin !== input.channel.hubOrigin ||
        !e2eeBytesEqual(advertisement.statementDigest, context.nodeCapabilityStatementDigest) ||
        !e2eeBytesEqual(input.grant.grantDigest, context.deviceGrantDigest)
      ) {
        return reject("grant_binding");
      }

      const verified = verifyHubDeviceGrant({
        envelope: input.grant.envelope,
        verificationKeys: material.verifierKeys,
        bindings: {
          issuerHubOrigin: material.hubOrigin,
          accountId: claims.accountId,
          accountAuthEpoch: claims.accountAuthEpoch,
          enrollmentId: claims.enrollmentId,
          enrollmentRevision: claims.enrollmentRevision,
          deviceAuthEpoch: claims.deviceAuthEpoch,
          enrollmentStatus: enrollmentCurrent ? "active" : "revoked",
          deviceIdentityPublicKey: input.certificate.identityPublicKey,
          deviceAgreementPublicKey: input.certificate.agreementPublicKey,
          clientPrekeyCertificateDigest: input.certificateDigest,
          clientPrekeyCertificateExpiresAt: input.certificate.expiresAt,
          nodeId: advertisement.material.nodeId,
          nodeIdentityPublicKey: advertisement.nodeIdentityPublicKey,
          nodeAgreementPublicKey: advertisement.material.agreementPublicKey,
          nodeAgreementPrekeyExpiresAt: advertisement.nodeAgreementPrekeyExpiresAt,
          nodeContinuityId: advertisement.material.continuityId,
          nodePolicyGeneration: advertisement.material.policyGeneration ?? -1,
          nodeCapabilityStatementDigest: advertisement.statementDigest,
          nodeCapabilityStatementExpiresAt: advertisement.expiresAt,
          relayTicketId: context.relayTicketId,
          // Minor 3 exposes only the public ticket id to the node. The signed
          // grant is already bounded by that ticket and is never extended here.
          relayTicketExpiresAt: claims.expiresAt,
          effectiveRole: role,
          effectiveCapabilities: [capability],
          accountGrantAllowed: true,
          now: input.now,
        },
      });
      if (verified.kind === "error") return reject(verified.reason);

      let intersectedLocalAuthority: E2eeAdmittedAuthoritySnapshot | undefined;
      if (local !== undefined) {
        const maxRole = e2eeRoleWithinCeiling(local.maxRole, claims.maximumRole)
          ? local.maxRole
          : claims.maximumRole;
        const capabilities = new Set<string>(claims.capabilities);
        intersectedLocalAuthority = {
          ...key,
          status: local.status,
          maxRole,
          capabilitySet: local.capabilitySet.filter((entry) => capabilities.has(entry)),
        };
      }

      return {
        accepted: true,
        localAuthority: intersectedLocalAuthority,
      };
    },
  };
}
