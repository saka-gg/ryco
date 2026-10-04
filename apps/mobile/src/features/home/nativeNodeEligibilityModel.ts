import type { WorkspaceNativeTrustState } from "@ryco/client-runtime/state/workspace";

import type { E2eeTrustClassification } from "../../platform/e2eeTrustModel";

export interface NativeNodeTrustTarget {
  readonly environmentId: string;
  readonly nodeId: string;
}

export interface NativeNodeTrustScope {
  readonly hubOrigin: string;
  readonly accountId: string;
}

export interface NativeNodeTrustSelection {
  readonly kind: "node-id-hint";
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly nodeId: string;
}

export type NativeNodeTrustClassifier = (
  input: NativeNodeTrustSelection,
) => Promise<E2eeTrustClassification>;

/**
 * Whether the selection resolves to a §13.2 pairing record, read after the
 * classifier's load completed. Only ever narrows eligibility.
 */
export type NativeNodePairingProbe = (input: NativeNodeTrustSelection) => boolean;

/**
 * Resolve native trust through the durable async classifier. This is the
 * authorization input used by Mobile workspace projection; synchronous display
 * readers are deliberately not accepted by this seam.
 */
export async function resolveAuthoritativeNativeNodeTrust(input: {
  readonly scope: NativeNodeTrustScope | null;
  readonly targets: ReadonlyArray<NativeNodeTrustTarget>;
  readonly classify: NativeNodeTrustClassifier;
  readonly pairing: NativeNodePairingProbe;
  readonly accountEnrollmentReady?: boolean;
  readonly identityConflictEnvironmentIds?: ReadonlySet<string>;
}): Promise<ReadonlyMap<string, WorkspaceNativeTrustState>> {
  const conflicts = input.identityConflictEnvironmentIds ?? new Set<string>();
  const entries = await Promise.all(
    input.targets.map(async (target) => {
      if (conflicts.has(target.environmentId)) {
        return [target.environmentId, "identity-conflict"] as const;
      }
      if (input.scope === null) return [target.environmentId, "unknown"] as const;
      try {
        const selection = {
          kind: "node-id-hint",
          hubOrigin: input.scope.hubOrigin,
          accountId: input.scope.accountId,
          nodeId: target.nodeId,
        } as const;
        const classification = await input.classify(selection);
        // A pending approval request routes every channel to this node
        // pairing-only, which no account grant or legacy consent changes, so
        // the node cannot carry a workspace. `unverified` keeps it out of the
        // eligible set and lists it under Needs verification, the way back to
        // the request, its safety number and the scanner.
        if (input.pairing(selection)) return [target.environmentId, "unverified"] as const;
        return [
          target.environmentId,
          classification.class === "latched"
            ? "verified"
            : input.accountEnrollmentReady
              ? "account-trusted"
              : "unverified",
        ] as const;
      } catch {
        return [target.environmentId, "unknown"] as const;
      }
    }),
  );
  return new Map(entries);
}

export function workspaceEligibleEnvironmentIds(
  trustByEnvironmentId: ReadonlyMap<string, WorkspaceNativeTrustState>,
): ReadonlySet<string> {
  return new Set(
    Array.from(trustByEnvironmentId, ([environmentId, trust]) =>
      trust === "verified" || trust === "account-trusted" ? environmentId : null,
    ).filter((environmentId): environmentId is string => environmentId !== null),
  );
}

export function needsVerificationEnvironmentIds(
  trustByEnvironmentId: ReadonlyMap<string, WorkspaceNativeTrustState>,
): ReadonlySet<string> {
  return new Set(
    Array.from(trustByEnvironmentId, ([environmentId, trust]) =>
      trust === "unverified" ||
      trust === "account-trusted" ||
      trust === "unknown" ||
      trust === "identity-conflict"
        ? environmentId
        : null,
    ).filter((environmentId): environmentId is string => environmentId !== null),
  );
}
