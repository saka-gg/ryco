import type {
  EnvironmentConnectionState,
  EnvironmentId,
  RelayEffectiveRole,
} from "@ryco/contracts";

import type {
  HostedHubNode,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
} from "../../authorization/types.js";
import type { WorkspaceMachineCatalogInput } from "./machineCatalog.js";
import type { WorkspaceClientTier, WorkspaceNativeTrustState } from "./types.js";

export interface HostedSessionConnectionStatus {
  readonly transportStatus: HostedRelayTransportStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
}

const ESTABLISHING_TRANSPORT_STATUSES: ReadonlySet<HostedRelayTransportStatus> = new Set([
  "requesting-ticket",
  "connecting",
  "authenticating",
  "opening-channel",
  "reconnecting",
]);

/**
 * The one rule that turns a hosted session into a machine's connection state:
 * connected once its relay is online and its session is ready, connecting
 * while the relay is being established or the session synchronizes or
 * replays, and disconnected otherwise (including without a session).
 */
export function hostedSessionConnectionState(
  session?: HostedSessionConnectionStatus | null,
): EnvironmentConnectionState {
  if (!session) return "disconnected";
  if (session.transportStatus === "online" && session.sessionStatus === "ready") {
    return "connected";
  }
  if (
    ESTABLISHING_TRANSPORT_STATUSES.has(session.transportStatus) ||
    session.sessionStatus === "synchronizing" ||
    session.sessionStatus === "replaying"
  ) {
    return "connecting";
  }
  return "disconnected";
}

export interface HostedNodeCatalogContext {
  readonly clientTier: WorkspaceClientTier;
  readonly nativeTrust: WorkspaceNativeTrustState;
  readonly requiresNativeVerification: boolean;
  /** The node's hosted session on this client, if one exists. */
  readonly session?:
    | (HostedSessionConnectionStatus & { readonly effectiveRole: RelayEffectiveRole | null })
    | null;
  readonly deliveryUnknown: boolean;
  readonly observedAt: number;
}

/**
 * Maps a Hub directory node into the shared machine-catalog policy. Absent
 * directory capabilities keep current eligibility: repository identity is
 * assumed and the native-client requirement is not. Thread settlement is
 * carried only when the directory states it, so a directory without the flag
 * leaves it unknown rather than unsupported. The session's role wins over the
 * directory's, which may lag a grant change.
 */
export function hostedNodeCatalogInput(
  node: HostedHubNode,
  input: HostedNodeCatalogContext,
): WorkspaceMachineCatalogInput {
  const capabilities = node.capabilities;
  return {
    environmentId: node.environmentId,
    nodeId: node.id,
    label: node.label,
    platform: { os: node.platformOs, arch: node.platformArch },
    serverVersion: node.clientVersion,
    capabilities: {
      repositoryIdentity: capabilities?.repositoryIdentity ?? true,
      ...(capabilities?.threadSettlement !== undefined
        ? { threadSettlement: capabilities.threadSettlement }
        : {}),
      nativeClientRequired: capabilities?.nativeClientRequired ?? false,
    },
    clientTier: input.clientTier,
    nativeTrust: input.nativeTrust,
    requiresNativeVerification: input.requiresNativeVerification,
    effectiveRole: input.session?.effectiveRole ?? node.effectiveRole,
    // Directory presence is independent of the relay connection state.
    online: node.presence.online,
    lastSeenAt: node.presence.lastHeartbeatAt ?? node.lastAuthenticatedAt,
    observedAt: input.observedAt,
    connectionState: hostedSessionConnectionState(input.session),
    deliveryUnknown: input.deliveryUnknown,
    revokedAt: node.revokedAt,
  };
}

/**
 * The client a read-cache preview is shown on. A native client passes its
 * trust state, so a cached machine stays gated (and purged) like a live one.
 */
export type CachedHubNodeClient =
  | { readonly clientTier: "hosted-web" }
  | {
      readonly clientTier: "native";
      readonly nativeTrust: WorkspaceNativeTrustState;
      readonly requiresNativeVerification: boolean;
    };

/**
 * A machine known only from a read-cache preview: offline, viewer, no
 * capabilities, so it can show cached metadata but never connects or mutates.
 */
export function cachedHubNodeCatalogInput(
  input: {
    readonly environmentId: EnvironmentId;
    readonly nodeId: string;
    readonly label: string;
    readonly observedAt: number;
  } & CachedHubNodeClient,
): WorkspaceMachineCatalogInput {
  return {
    environmentId: input.environmentId,
    nodeId: input.nodeId,
    label: input.label,
    clientTier: input.clientTier,
    nativeTrust: input.clientTier === "native" ? input.nativeTrust : "not-required",
    requiresNativeVerification:
      input.clientTier === "native" ? input.requiresNativeVerification : false,
    effectiveRole: "viewer",
    online: false,
    lastSeenAt: null,
    observedAt: input.observedAt,
    connectionState: "disconnected",
    deliveryUnknown: false,
    revokedAt: null,
  };
}
