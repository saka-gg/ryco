import type {
  EnvironmentConnectionState,
  EnvironmentId,
  ExecutionEnvironmentPlatform,
  RelayEffectiveRole,
} from "@ryco/contracts";

import type {
  WorkspaceClientTier,
  WorkspaceMachineAccessReason,
  WorkspaceMachineCatalogEntry,
  WorkspaceNativeTrustState,
} from "./types.js";

export interface WorkspaceMachineCatalogInput {
  readonly environmentId: EnvironmentId;
  readonly nodeId?: string | null;
  readonly label: string;
  readonly platform?: ExecutionEnvironmentPlatform;
  readonly serverVersion?: string | null;
  readonly capabilities?: {
    readonly repositoryIdentity?: boolean;
    readonly nativeClientRequired?: boolean;
    readonly threadSettlement?: boolean;
    readonly threadSnooze?: boolean;
  };
  readonly clientTier: WorkspaceClientTier;
  readonly nativeTrust: WorkspaceNativeTrustState;
  readonly requiresNativeVerification: boolean;
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly online: boolean;
  readonly lastSeenAt: number | null;
  readonly observedAt: number;
  readonly connectionState?: EnvironmentConnectionState;
  readonly deliveryUnknown?: boolean;
  readonly revokedAt?: number | null;
  readonly removed?: boolean;
}

const UNKNOWN_PLATFORM: ExecutionEnvironmentPlatform = { os: "unknown", arch: "other" };

function uniqueReasons(
  reasons: ReadonlyArray<WorkspaceMachineAccessReason | null>,
): ReadonlyArray<WorkspaceMachineAccessReason> {
  return Array.from(new Set(reasons.filter((reason) => reason !== null)));
}

export function reconcileWorkspaceMachine(
  input: WorkspaceMachineCatalogInput,
): WorkspaceMachineCatalogEntry {
  const revoked = input.revokedAt != null;
  const removed = input.removed === true;
  const nativePolicyLocked =
    input.clientTier === "hosted-web" && input.capabilities?.nativeClientRequired === true;
  const trustUnknown =
    input.clientTier === "native" &&
    input.requiresNativeVerification &&
    input.nativeTrust === "unknown";
  const unverified =
    input.clientTier === "native" &&
    input.requiresNativeVerification &&
    input.nativeTrust === "unverified";
  const identityConflict = input.nativeTrust === "identity-conflict";
  const trustedForTier =
    input.clientTier === "hosted-web"
      ? !nativePolicyLocked
      : !input.requiresNativeVerification ||
        input.nativeTrust === "verified" ||
        input.nativeTrust === "account-trusted";
  const canReadMetadata = !revoked && !removed && trustedForTier && !identityConflict;
  const canConnect = canReadMetadata && input.online;
  const canMutate = canConnect && input.effectiveRole !== null && input.effectiveRole !== "viewer";

  const accessReasons = uniqueReasons([
    revoked ? "revoked" : null,
    removed ? "removed" : null,
    nativePolicyLocked ? "native-client-required" : null,
    trustUnknown ? "trust-unknown" : null,
    unverified ? "not-verified" : null,
    identityConflict ? "identity-conflict" : null,
    !input.online ? "offline" : null,
    input.effectiveRole === null ? "role-unknown" : null,
    input.effectiveRole === "viewer" ? "viewer" : null,
  ]);

  return {
    environmentId: input.environmentId,
    nodeId: input.nodeId ?? null,
    label: input.label,
    platform: input.platform ?? UNKNOWN_PLATFORM,
    serverVersion: input.serverVersion ?? null,
    capabilities: {
      repositoryIdentity: input.capabilities?.repositoryIdentity ?? false,
      nativeClientRequired: input.capabilities?.nativeClientRequired ?? false,
      ...(input.capabilities?.threadSettlement !== undefined
        ? { threadSettlement: input.capabilities.threadSettlement }
        : {}),
      ...(input.capabilities?.threadSnooze !== undefined
        ? { threadSnooze: input.capabilities.threadSnooze }
        : {}),
    },
    clientTier: input.clientTier,
    nativeTrust: input.nativeTrust,
    effectiveRole: input.effectiveRole,
    presence: {
      online: input.online,
      lastSeenAt: input.lastSeenAt,
      observedAt: input.observedAt,
    },
    connectionState: input.connectionState ?? "disconnected",
    deliveryUnknown: input.deliveryUnknown ?? false,
    revokedAt: input.revokedAt ?? null,
    removed,
    canReadMetadata,
    canConnect,
    canMutate,
    cacheDisposition:
      revoked || removed || nativePolicyLocked || trustUnknown || unverified
        ? "purge"
        : identityConflict
          ? "locked-stale"
          : "available",
    accessReasons,
  };
}

export function reconcileWorkspaceMachineCatalog(
  inputs: ReadonlyArray<WorkspaceMachineCatalogInput>,
): ReadonlyArray<WorkspaceMachineCatalogEntry> {
  const byEnvironment = new Map<EnvironmentId, WorkspaceMachineCatalogEntry>();
  for (const input of inputs) {
    byEnvironment.set(input.environmentId, reconcileWorkspaceMachine(input));
  }
  return Array.from(byEnvironment.values()).toSorted(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      String(left.environmentId).localeCompare(String(right.environmentId)),
  );
}
