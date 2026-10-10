import type {
  EnvironmentConnectionState,
  EnvironmentId,
  ExecutionEnvironmentPlatform,
  ModelSelection,
  ProjectId,
  ProjectKind,
  ProviderDriverKind,
  RelayEffectiveRole,
  RepositoryIdentity,
  ThreadId,
  ThreadLineage,
  ThreadSettlementOverride,
  WorktreeId,
} from "@ryco/contracts";

export type WorkspaceClientTier = "native" | "hosted-web";

/** Native trust is authoritative input, never a synchronous UI classification. */
export type WorkspaceNativeTrustState =
  | "not-required"
  | "unknown"
  | "unverified"
  | "account-trusted"
  | "verified"
  | "identity-conflict";

export type WorkspaceMachineAccessReason =
  | "revoked"
  | "removed"
  | "native-client-required"
  | "trust-unknown"
  | "not-verified"
  | "identity-conflict"
  | "offline"
  | "role-unknown"
  | "viewer";

export type WorkspaceCacheDisposition = "available" | "locked-stale" | "purge";

export interface WorkspaceMachineCatalogEntry {
  readonly environmentId: EnvironmentId;
  readonly nodeId: string | null;
  readonly label: string;
  readonly platform: ExecutionEnvironmentPlatform;
  readonly serverVersion: string | null;
  readonly capabilities: {
    readonly repositoryIdentity: boolean;
    readonly nativeClientRequired: boolean;
    readonly threadSettlement: boolean;
    readonly threadSnooze?: boolean;
  };
  readonly clientTier: WorkspaceClientTier;
  readonly nativeTrust: WorkspaceNativeTrustState;
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly presence: {
    readonly online: boolean;
    readonly lastSeenAt: number | null;
    readonly observedAt: number;
  };
  readonly connectionState: EnvironmentConnectionState;
  readonly deliveryUnknown: boolean;
  readonly revokedAt: number | null;
  readonly removed: boolean;
  readonly canReadMetadata: boolean;
  readonly canConnect: boolean;
  readonly canMutate: boolean;
  readonly cacheDisposition: WorkspaceCacheDisposition;
  readonly accessReasons: ReadonlyArray<WorkspaceMachineAccessReason>;
}

export interface WorkspaceProjectMetadata {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  /** Absent in caches written before chats existed, which only held regular projects. */
  readonly kind?: ProjectKind | undefined;
  readonly name: string;
  readonly cwd: string;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface WorkspaceWorktreeMetadata {
  readonly environmentId: EnvironmentId;
  readonly id: WorktreeId;
  readonly projectId: ProjectId;
  readonly title: string | null;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly workItemLabel: string | null;
  readonly pullRequestNumber: number | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

export interface WorkspaceThreadMetadata {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId | null;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly archivedAt: string | null;
  /** Optional for backward compatibility with schema-v1 metadata caches. */
  readonly settledOverride?: ThreadSettlementOverride | null;
  /** Optional for backward compatibility with schema-v1 metadata caches. */
  readonly settledAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly modelSelection: ModelSelection | null;
  readonly providerDriver: ProviderDriverKind | null;
  readonly branch: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly deliveryUnknown: boolean;
  /** Server-owned provenance. Optional: older caches omit it; validate before reuse. */
  readonly lineage?: ThreadLineage | null;
}

export const WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface WorkspaceMetadataSnapshot {
  readonly schemaVersion: typeof WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION;
  readonly environmentId: EnvironmentId;
  readonly capturedAt: number;
  readonly projects: ReadonlyArray<WorkspaceProjectMetadata>;
  readonly worktrees: ReadonlyArray<WorkspaceWorktreeMetadata>;
  readonly threads: ReadonlyArray<WorkspaceThreadMetadata>;
}

export interface WorkspaceMetadataCacheNamespace {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly environmentId: EnvironmentId;
}

export interface WorkspaceMetadataCacheRecord {
  readonly namespace: WorkspaceMetadataCacheNamespace;
  readonly snapshot: WorkspaceMetadataSnapshot;
  readonly payloadBytes: number;
  readonly updatedAt: number;
}

/** Platform storage port. Implementations must not route through a service worker. */
export interface WorkspaceMetadataCache {
  readonly load: (
    namespace: WorkspaceMetadataCacheNamespace,
  ) => Promise<WorkspaceMetadataCacheRecord | null>;
  readonly list: (input: {
    readonly hubOrigin: string;
    readonly accountId: string;
  }) => Promise<ReadonlyArray<WorkspaceMetadataCacheRecord>>;
  readonly replace: (record: WorkspaceMetadataCacheRecord) => Promise<void>;
  readonly purgeEnvironment: (namespace: WorkspaceMetadataCacheNamespace) => Promise<void>;
  readonly purgeAccount: (input: {
    readonly hubOrigin: string;
    readonly accountId: string;
  }) => Promise<void>;
}

export interface WorkspacePhysicalProjectVariant {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly physicalKey: string;
  readonly name: string;
  readonly cwd: string;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly machineLabel: string;
  readonly online: boolean;
  readonly canMutate: boolean;
  readonly nativeTrust: WorkspaceNativeTrustState;
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly lastUsedAt: number | null;
  readonly lastLiveAt: number | null;
  readonly localDesktop: boolean;
}

export interface WorkspaceLogicalProject {
  readonly key: string;
  readonly label: string;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly variants: ReadonlyArray<WorkspacePhysicalProjectVariant>;
  readonly ambiguous: boolean;
}

export type WorkspaceSnapshotVisibility =
  | { readonly status: "available"; readonly snapshot: WorkspaceMetadataSnapshot }
  | {
      readonly status: "locked-stale";
      readonly environmentId: EnvironmentId;
      readonly capturedAt: number;
    };

export interface UnifiedWorkspaceIndex {
  readonly machines: ReadonlyArray<WorkspaceMachineCatalogEntry>;
  readonly snapshots: ReadonlyArray<WorkspaceSnapshotVisibility>;
  readonly projects: ReadonlyArray<WorkspaceProjectMetadata>;
  readonly worktrees: ReadonlyArray<WorkspaceWorktreeMetadata>;
  readonly threads: ReadonlyArray<WorkspaceThreadMetadata>;
  readonly logicalProjects: ReadonlyArray<WorkspaceLogicalProject>;
}
