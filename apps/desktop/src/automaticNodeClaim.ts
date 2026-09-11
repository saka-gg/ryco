import * as Crypto from "node:crypto";

import type { HostedHubApi } from "@ryco/client-runtime/authorization";
import type {
  NativeNodeClaimFinishResponse,
  NativeNodeClaimStartResponse,
} from "@ryco/contracts/hosted-identity";

import type { DesktopHubControlClient } from "./desktopHubControl.ts";

export type DesktopAutomaticNodeClaimErrorCode =
  | "authentication_required"
  | "claim_unavailable"
  | "claim_conflict";

export class DesktopAutomaticNodeClaimError extends Error {
  readonly code: DesktopAutomaticNodeClaimErrorCode;

  constructor(code: DesktopAutomaticNodeClaimErrorCode) {
    super("Automatic Desktop node claim failed.");
    this.name = "DesktopAutomaticNodeClaimError";
    this.code = code;
  }
}

function fail(code: DesktopAutomaticNodeClaimErrorCode): never {
  throw new DesktopAutomaticNodeClaimError(code);
}

export interface DesktopAutomaticNodeClaimResult {
  readonly claim: NativeNodeClaimStartResponse;
  readonly result: NativeNodeClaimFinishResponse;
}

/** Claim the exact backend child through the authenticated Hub-native session. */
export async function runDesktopAutomaticNodeClaim(input: {
  readonly api: HostedHubApi;
  readonly control: DesktopHubControlClient;
  readonly installationId: string;
  readonly expectedHubOrigin: string;
  readonly expectedAccountId: string;
  readonly randomIdempotencyKey?: () => string;
  readonly signal?: AbortSignal;
}): Promise<DesktopAutomaticNodeClaimResult> {
  if (!input.api.hasSessionMaterial) return fail("authentication_required");
  const descriptor = await input.control
    .nodeClaimDescriptor()
    .catch(() => fail("claim_unavailable"));
  if (descriptor.hubOrigin !== input.expectedHubOrigin) return fail("claim_conflict");

  let claim: NativeNodeClaimStartResponse;
  try {
    claim = await input.api.startNativeNodeClaim(
      {
        installationId: input.installationId as never,
        node: {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          platformOs: descriptor.platformOs,
          platformArch: descriptor.platformArch,
          clientVersion: descriptor.clientVersion,
          algorithm: descriptor.algorithm,
          publicKey: descriptor.publicKey,
          fingerprint: descriptor.fingerprint,
        },
      },
      input.signal,
    );
  } catch {
    return fail("claim_unavailable");
  }
  if (
    claim.installationId !== input.installationId ||
    claim.accountId !== input.expectedAccountId ||
    claim.environmentId !== descriptor.environmentId ||
    claim.nodeFingerprint !== descriptor.fingerprint
  ) {
    return fail("claim_conflict");
  }

  const signed = await input.control
    .signNodeClaim({ claim })
    .catch(() => fail("claim_unavailable"));
  let result: NativeNodeClaimFinishResponse;
  try {
    result = await input.api.finishNativeNodeClaim(
      {
        claimId: claim.claimId,
        challenge: claim.challenge,
        signature: signed.signature,
        idempotencyKey: (
          input.randomIdempotencyKey ?? (() => Crypto.randomBytes(32).toString("base64url"))
        )() as never,
      },
      input.signal,
    );
  } catch {
    return fail("claim_unavailable");
  }
  if (
    result.node.environmentId !== descriptor.environmentId ||
    (result.node.label !== descriptor.label &&
      !(descriptor.state === "active" && result.disposition === "reconnected")) ||
    result.node.fingerprint !== descriptor.fingerprint ||
    result.node.effectiveRole !== "owner"
  ) {
    return fail("claim_conflict");
  }
  const committed = await input.control
    .commitNodeClaim({ claim, result })
    .catch(() => fail("claim_unavailable"));
  if (committed.status !== "active" || committed.result !== result) {
    // The strict child response contains the same JSON value, not object identity.
    if (JSON.stringify(committed.result) !== JSON.stringify(result)) return fail("claim_conflict");
  }
  return { claim, result };
}
