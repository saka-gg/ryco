import { EnvironmentId } from "@ryco/contracts";
import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import {
  buildUnifiedWorkspaceIndex,
  createWorkspaceConnectionDemandState,
  planWorkspaceConnectionDemand,
  reconcileWorkspaceMachineCatalog,
  releaseWorkspaceConnectionScope,
  renewWorkspaceConnectionScope,
  retainWorkspaceConnectionScope,
  setWorkspaceConnectionBackgrounded,
  setWorkspaceEnvironmentConnected,
  UNIFIED_WORKSPACE_MAX_CONNECTIONS,
  workspaceMetadataPayloadBytes,
  type UnifiedWorkspaceIndex,
  type WorkspaceConnectionDemandPlan,
  type WorkspaceConnectionDemandState,
  type WorkspaceConnectionScope,
  type WorkspaceMachineCatalogEntry,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataSnapshot,
  type WorkspaceNativeTrustState,
} from "@ryco/client-runtime/state/workspace";

export type DesktopWorkspaceIdentityStatus =
  | { readonly status: "signed-out" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly accountId: string;
      readonly nodeId: string | null;
      readonly localNodeHandle: string | null;
      readonly accountE2eeReady?: true;
    };

export interface DesktopWorkspaceIdentityPort {
  readonly resume: () => Promise<DesktopWorkspaceIdentityStatus>;
  readonly connect: () => Promise<DesktopWorkspaceIdentityStatus>;
  readonly disconnect: () => Promise<void>;
  readonly listNodes: () => Promise<ReadonlyArray<HostedHubNode>>;
  readonly renameNode?: (nodeId: string, label: string) => Promise<void>;
}

export interface DesktopWorkspaceTrustPort {
  readonly read: (
    hubOrigin: string,
    accountId: string,
    nodeId: string,
  ) => Promise<{ readonly environmentId: string } | null>;
}

export interface DesktopWorkspaceConnectionDriver {
  readonly connect: (input: {
    readonly environmentId: EnvironmentId;
    readonly delayMs: number;
  }) => Promise<void>;
  readonly release: (environmentId: EnvironmentId) => Promise<void>;
}

export interface DesktopWorkspaceVerificationPort {
  readonly begin: (input: {
    readonly accountId: string;
    readonly nodeId: string;
    readonly environmentId: EnvironmentId;
  }) => Promise<{ readonly handle: string }>;
  readonly cancel: (handle: string) => Promise<void>;
  readonly verifyApproval: (input: {
    readonly accountId: string;
    readonly nodeId: string;
    readonly environmentId: EnvironmentId;
    readonly payload: string;
  }) => Promise<void>;
}

export type DesktopWorkspaceClientStatus = "signed-out" | "ready" | "unavailable";

export interface DesktopWorkspaceClientSnapshot {
  readonly status: DesktopWorkspaceClientStatus;
  readonly accountId: string | null;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly catalog: ReadonlyArray<WorkspaceMachineCatalogEntry>;
  readonly workspace: UnifiedWorkspaceIndex;
  readonly demand: WorkspaceConnectionDemandState;
  readonly queuedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

const EMPTY_WORKSPACE: UnifiedWorkspaceIndex = {
  machines: [],
  snapshots: [],
  projects: [],
  worktrees: [],
  threads: [],
  logicalProjects: [],
};

function nativeTrustForPin(
  pin: { readonly environmentId: string } | null,
  node: HostedHubNode,
  accountE2eeReady: boolean,
): WorkspaceNativeTrustState {
  if (pin === null) return accountE2eeReady ? "account-trusted" : "unverified";
  return pin.environmentId === node.environmentId ? "verified" : "identity-conflict";
}

export class DesktopWorkspaceClient {
  readonly #hubOrigin: string;
  readonly #identity: DesktopWorkspaceIdentityPort;
  readonly #trust: DesktopWorkspaceTrustPort;
  readonly #cache: WorkspaceMetadataCache;
  readonly #connection: DesktopWorkspaceConnectionDriver;
  readonly #verification: DesktopWorkspaceVerificationPort | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<(snapshot: DesktopWorkspaceClientSnapshot) => void>();
  readonly #snapshots = new Map<EnvironmentId, WorkspaceMetadataSnapshot>();
  #identityStatus: DesktopWorkspaceIdentityStatus = { status: "signed-out" };
  #catalog: ReadonlyArray<WorkspaceMachineCatalogEntry> = [];
  #demand = createWorkspaceConnectionDemandState(UNIFIED_WORKSPACE_MAX_CONNECTIONS);
  #queued: ReadonlyArray<EnvironmentId> = [];
  #leaseSequence = 0;

  constructor(input: {
    readonly hubOrigin: string;
    readonly identity: DesktopWorkspaceIdentityPort;
    readonly trust: DesktopWorkspaceTrustPort;
    readonly cache: WorkspaceMetadataCache;
    readonly connection: DesktopWorkspaceConnectionDriver;
    readonly verification?: DesktopWorkspaceVerificationPort;
    readonly now?: () => number;
  }) {
    this.#hubOrigin = input.hubOrigin;
    this.#identity = input.identity;
    this.#trust = input.trust;
    this.#cache = input.cache;
    this.#connection = input.connection;
    this.#verification = input.verification;
    this.#now = input.now ?? Date.now;
  }

  snapshot(): DesktopWorkspaceClientSnapshot {
    const ready = this.#identityStatus.status === "ready" ? this.#identityStatus : null;
    return {
      status: this.#identityStatus.status,
      accountId: ready?.accountId ?? null,
      localEnvironmentId:
        this.#catalog.find((entry) => entry.nodeId === ready?.nodeId)?.environmentId ?? null,
      catalog: this.#catalog,
      workspace: buildUnifiedWorkspaceIndex({
        machines: this.#catalog,
        snapshots: Array.from(this.#snapshots.values()),
        localDesktopEnvironmentId:
          this.#catalog.find((entry) => entry.nodeId === ready?.nodeId)?.environmentId ?? null,
      }),
      demand: this.#demand,
      queuedEnvironmentIds: this.#queued,
    };
  }

  subscribe(listener: (snapshot: DesktopWorkspaceClientSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async resume(): Promise<DesktopWorkspaceClientSnapshot> {
    return this.#adoptIdentity(await this.#identity.resume());
  }

  async connectIdentity(): Promise<DesktopWorkspaceClientSnapshot> {
    return this.#adoptIdentity(await this.#identity.connect());
  }

  async signOut(): Promise<DesktopWorkspaceClientSnapshot> {
    const ready = this.#identityStatus.status === "ready" ? this.#identityStatus : null;
    for (const connection of this.#demand.connections.filter((entry) => entry.connected)) {
      await this.#connection.release(connection.environmentId).catch(() => undefined);
    }
    await this.#identity.disconnect();
    if (ready) {
      await this.#cache
        .purgeAccount({
          hubOrigin: this.#hubOrigin,
          accountId: ready.accountId,
        })
        .catch(() => undefined);
    }
    this.#identityStatus = { status: "signed-out" };
    this.#catalog = [];
    this.#snapshots.clear();
    this.#demand = createWorkspaceConnectionDemandState(UNIFIED_WORKSPACE_MAX_CONNECTIONS);
    this.#queued = [];
    return this.#publish();
  }

  /**
   * Remove every live capability immediately when native account authorization
   * is revoked. Transport release continues asynchronously, but callers and the
   * renderer observe the unavailable state before another mutation can start.
   */
  invalidateAccess(): DesktopWorkspaceClientSnapshot {
    const connected = this.#demand.connections
      .filter((entry) => entry.connected)
      .map((entry) => entry.environmentId);
    this.#identityStatus = { status: "unavailable" };
    this.#catalog = [];
    this.#snapshots.clear();
    this.#demand = createWorkspaceConnectionDemandState(UNIFIED_WORKSPACE_MAX_CONNECTIONS);
    this.#queued = [];
    const snapshot = this.#publish();
    for (const environmentId of connected) {
      void this.#connection.release(environmentId).catch(() => undefined);
    }
    return snapshot;
  }

  async refreshCatalog(): Promise<DesktopWorkspaceClientSnapshot> {
    if (this.#identityStatus.status !== "ready") return this.snapshot();
    const identity = this.#identityStatus;
    let nodes: ReadonlyArray<HostedHubNode>;
    try {
      nodes = await this.#identity.listNodes();
    } catch {
      // A directory failure is scoped to workspace refresh. It must not turn a
      // valid account session into a sign-out or affect the colocated node.
      return this.#publish();
    }
    const inputs = await Promise.all(
      nodes.map(async (node) => {
        let nativeTrust: WorkspaceNativeTrustState = "unknown";
        try {
          nativeTrust = nativeTrustForPin(
            await this.#trust.read(this.#hubOrigin, identity.accountId, node.id),
            node,
            identity.accountE2eeReady === true,
          );
        } catch {
          nativeTrust = "unknown";
        }
        const connected = this.#demand.connections.find(
          (entry) => entry.environmentId === node.environmentId,
        )?.connected;
        return {
          environmentId: node.environmentId,
          nodeId: node.id,
          label: node.label,
          platform: { os: node.platformOs, arch: node.platformArch },
          serverVersion: node.clientVersion,
          capabilities: {
            repositoryIdentity: true,
            nativeClientRequired: true,
          },
          clientTier: "native" as const,
          nativeTrust,
          requiresNativeVerification: true,
          effectiveRole: node.effectiveRole,
          online: node.presence.online,
          lastSeenAt: node.presence.lastHeartbeatAt,
          observedAt: this.#now(),
          connectionState: connected ? ("connected" as const) : ("disconnected" as const),
          revokedAt: node.revokedAt,
        };
      }),
    );
    if (this.#identityStatus !== identity) return this.snapshot();
    this.#catalog = reconcileWorkspaceMachineCatalog(inputs);
    await this.#releaseIneligibleConnections();
    await this.#reconcileCacheDisposition();
    return this.#publish();
  }

  async renameDevice(
    environmentId: EnvironmentId,
    label: string,
  ): Promise<DesktopWorkspaceClientSnapshot> {
    const normalized = label.trim();
    if (!normalized || normalized.length > 100)
      throw new Error("Use a device name of 1–100 characters.");
    if (this.#identityStatus.status !== "ready" || !this.#identity.renameNode)
      throw new Error("Sign in to rename a device.");
    const identity = this.#identityStatus;
    const machine = this.#catalog.find((entry) => entry.environmentId === environmentId);
    if (!machine?.nodeId || machine.effectiveRole !== "owner" || !machine.canReadMetadata)
      throw new Error("Only the device owner can rename it.");
    await this.#identity.renameNode(machine.nodeId, normalized);
    // An account switch must not publish the previous account's device labels.
    if (this.#identityStatus !== identity) return this.snapshot();
    return this.refreshCatalog();
  }

  async acceptWorkspaceSnapshot(
    snapshot: WorkspaceMetadataSnapshot,
  ): Promise<DesktopWorkspaceClientSnapshot> {
    if (this.#identityStatus.status !== "ready")
      throw new Error("Desktop workspace client is signed out.");
    const machine = this.#catalog.find((entry) => entry.environmentId === snapshot.environmentId);
    if (!machine?.canReadMetadata) throw new Error("Desktop workspace snapshot is not eligible.");
    this.#snapshots.set(snapshot.environmentId, snapshot);
    await this.#cache.replace({
      namespace: {
        hubOrigin: this.#hubOrigin,
        accountId: this.#identityStatus.accountId,
        environmentId: snapshot.environmentId,
      },
      snapshot,
      payloadBytes: workspaceMetadataPayloadBytes(snapshot),
      updatedAt: this.#now(),
    });
    return this.#publish();
  }

  async retainScope(input: {
    readonly environmentId: EnvironmentId;
    readonly scope: WorkspaceConnectionScope;
    readonly leaseId?: string;
  }): Promise<{
    readonly leaseId: string;
    readonly snapshot: DesktopWorkspaceClientSnapshot;
  }> {
    const machine = this.#catalog.find((entry) => entry.environmentId === input.environmentId);
    if (!machine?.canConnect) throw new Error("Desktop workspace machine is not connectable.");
    const leaseId = input.leaseId ?? `desktop-workspace-${++this.#leaseSequence}`;
    this.#demand = retainWorkspaceConnectionScope(this.#demand, {
      leaseId,
      environmentId: input.environmentId,
      scope: input.scope,
      now: this.#now(),
    });
    await this.#applyDemand();
    return { leaseId, snapshot: this.snapshot() };
  }

  async renewScope(leaseId: string): Promise<DesktopWorkspaceClientSnapshot> {
    this.#demand = renewWorkspaceConnectionScope(this.#demand, leaseId, this.#now());
    await this.#applyDemand();
    return this.snapshot();
  }

  async releaseScope(leaseId: string): Promise<DesktopWorkspaceClientSnapshot> {
    this.#demand = releaseWorkspaceConnectionScope(this.#demand, leaseId);
    await this.#applyDemand();
    return this.snapshot();
  }

  async setBackgrounded(backgrounded: boolean): Promise<DesktopWorkspaceClientSnapshot> {
    this.#demand = setWorkspaceConnectionBackgrounded(this.#demand, backgrounded);
    await this.#applyDemand(backgrounded ? 0 : 250);
    return this.snapshot();
  }

  reportConnection(
    environmentId: EnvironmentId,
    connected: boolean,
  ): DesktopWorkspaceClientSnapshot {
    if (!this.#catalog.some((machine) => machine.environmentId === environmentId)) {
      throw new Error("Desktop workspace machine does not match.");
    }
    this.#demand = setWorkspaceEnvironmentConnected(
      this.#demand,
      environmentId,
      connected,
      this.#now(),
    );
    this.#syncCatalogConnectionStates();
    return this.#publish();
  }

  async beginVerification(input: {
    readonly nodeId: string;
    readonly environmentId: EnvironmentId;
  }): Promise<{ readonly handle: string }> {
    if (this.#identityStatus.status !== "ready" || !this.#verification) {
      throw new Error("Desktop workspace verification is unavailable.");
    }
    const exact = this.#catalog.find(
      (machine) => machine.nodeId === input.nodeId && machine.environmentId === input.environmentId,
    );
    if (!exact) throw new Error("Desktop workspace machine does not match.");
    if (
      !exact.presence.online ||
      (exact.nativeTrust !== "unverified" &&
        exact.nativeTrust !== "unknown" &&
        exact.nativeTrust !== "account-trusted")
    ) {
      throw new Error("Desktop workspace machine is not eligible for verification.");
    }
    return this.#verification.begin({
      accountId: this.#identityStatus.accountId,
      nodeId: input.nodeId,
      environmentId: input.environmentId,
    });
  }

  async cancelVerification(handle: string): Promise<void> {
    if (!this.#verification) return;
    await this.#verification.cancel(handle);
  }

  async verifyApproval(input: {
    readonly nodeId: string;
    readonly environmentId: EnvironmentId;
    readonly payload: string;
  }): Promise<DesktopWorkspaceClientSnapshot> {
    if (this.#identityStatus.status !== "ready" || !this.#verification) {
      throw new Error("Desktop workspace verification is unavailable.");
    }
    const exact = this.#catalog.find(
      (machine) => machine.nodeId === input.nodeId && machine.environmentId === input.environmentId,
    );
    if (!exact) throw new Error("Desktop workspace machine does not match.");
    await this.#verification.verifyApproval({
      accountId: this.#identityStatus.accountId,
      nodeId: input.nodeId,
      environmentId: input.environmentId,
      payload: input.payload,
    });
    return this.refreshCatalog();
  }

  async purgeCache(environmentId?: EnvironmentId): Promise<DesktopWorkspaceClientSnapshot> {
    if (this.#identityStatus.status !== "ready") return this.snapshot();
    if (environmentId) {
      await this.#cache.purgeEnvironment({
        hubOrigin: this.#hubOrigin,
        accountId: this.#identityStatus.accountId,
        environmentId,
      });
      this.#snapshots.delete(environmentId);
    } else {
      await this.#cache.purgeAccount({
        hubOrigin: this.#hubOrigin,
        accountId: this.#identityStatus.accountId,
      });
      this.#snapshots.clear();
    }
    return this.#publish();
  }

  async #adoptIdentity(
    status: DesktopWorkspaceIdentityStatus,
  ): Promise<DesktopWorkspaceClientSnapshot> {
    this.#identityStatus = status;
    if (status.status !== "ready") {
      this.#catalog = [];
      this.#snapshots.clear();
      return this.#publish();
    }
    for (const record of await this.#cache.list({
      hubOrigin: this.#hubOrigin,
      accountId: status.accountId,
    })) {
      this.#snapshots.set(record.namespace.environmentId, record.snapshot);
    }
    return this.refreshCatalog();
  }

  async #reconcileCacheDisposition(): Promise<void> {
    if (this.#identityStatus.status !== "ready") return;
    for (const machine of this.#catalog) {
      if (machine.cacheDisposition !== "purge") continue;
      this.#snapshots.delete(machine.environmentId);
      await this.#cache
        .purgeEnvironment({
          hubOrigin: this.#hubOrigin,
          accountId: this.#identityStatus.accountId,
          environmentId: machine.environmentId,
        })
        .catch(() => undefined);
    }
  }

  async #applyDemand(wakeStaggerMs = 0): Promise<WorkspaceConnectionDemandPlan> {
    const plan = planWorkspaceConnectionDemand(this.#demand, {
      now: this.#now(),
      wakeStaggerMs,
    });
    this.#demand = plan.state;
    for (const environmentId of plan.release) {
      await this.#connection.release(environmentId).catch(() => undefined);
      this.#demand = setWorkspaceEnvironmentConnected(
        this.#demand,
        environmentId,
        false,
        this.#now(),
      );
    }
    for (const request of plan.connect) {
      try {
        await this.#connection.connect(request);
        this.#demand = setWorkspaceEnvironmentConnected(
          this.#demand,
          request.environmentId,
          true,
          this.#now(),
        );
      } catch {
        this.#demand = setWorkspaceEnvironmentConnected(
          this.#demand,
          request.environmentId,
          false,
          this.#now(),
        );
      }
    }
    this.#queued = plan.queued;
    this.#syncCatalogConnectionStates();
    this.#publish();
    return plan;
  }

  async #releaseIneligibleConnections(): Promise<void> {
    const eligible = new Set(
      this.#catalog.filter((machine) => machine.canConnect).map((machine) => machine.environmentId),
    );
    const rejected = new Set(
      this.#demand.connections
        .filter((connection) => !eligible.has(connection.environmentId))
        .map((connection) => connection.environmentId),
    );
    for (const environmentId of rejected) {
      const connected = this.#demand.connections.find(
        (connection) => connection.environmentId === environmentId,
      )?.connected;
      if (connected) await this.#connection.release(environmentId).catch(() => undefined);
    }
    if (rejected.size === 0) return;
    this.#demand = {
      ...this.#demand,
      leases: this.#demand.leases.filter((lease) => !rejected.has(lease.environmentId)),
      connections: this.#demand.connections.filter(
        (connection) => !rejected.has(connection.environmentId),
      ),
    };
  }

  #syncCatalogConnectionStates(): void {
    this.#catalog = this.#catalog.map((machine) => ({
      ...machine,
      connectionState:
        this.#demand.connections.find(
          (connection) => connection.environmentId === machine.environmentId,
        )?.connected === true
          ? "connected"
          : "disconnected",
    }));
  }

  #publish(): DesktopWorkspaceClientSnapshot {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }
}

export { EMPTY_WORKSPACE as EMPTY_DESKTOP_WORKSPACE };
