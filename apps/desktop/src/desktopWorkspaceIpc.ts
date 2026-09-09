import type {
  DesktopWorkspaceMetadataProjection,
  DesktopWorkspaceScopeProjection,
  DesktopWorkspaceStateProjection,
} from "@ryco/contracts";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  isWorkspaceMetadataSnapshot,
  type WorkspaceConnectionScope,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";

import type {
  DesktopWorkspaceClient,
  DesktopWorkspaceClientSnapshot,
} from "./desktopWorkspaceClient.ts";
export { DESKTOP_WORKSPACE_IPC } from "./desktopWorkspaceChannels.ts";

const BOUNDED_TEXT = 2_048;

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= BOUNDED_TEXT;
}

function environmentId(value: unknown): EnvironmentId {
  if (!boundedText(value)) throw new Error("Desktop workspace environment is invalid.");
  return EnvironmentId.make(value);
}

function leaseId(value: unknown): string {
  if (!boundedText(value) || !/^desktop-workspace-[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Desktop workspace lease is invalid.");
  }
  return value;
}

function opaqueHandle(value: unknown): string {
  if (!boundedText(value) || !/^[A-Za-z0-9_-]{16,128}$/u.test(value)) {
    throw new Error("Desktop workspace operation handle is invalid.");
  }
  return value;
}

function parseScope(value: unknown): WorkspaceConnectionScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop workspace scope is invalid.");
  }
  const scope = value as Partial<DesktopWorkspaceScopeProjection>;
  switch (scope.type) {
    case "interactive":
      return { type: scope.type };
    case "thread-detail":
      if (!boundedText(scope.threadId)) throw new Error("Desktop workspace scope is invalid.");
      return { type: scope.type, threadId: ThreadId.make(scope.threadId) };
    case "vcs-status":
      if (!boundedText(scope.cwd)) throw new Error("Desktop workspace scope is invalid.");
      return { type: scope.type, cwd: scope.cwd };
    case "provider-status":
      if (scope.instanceId !== undefined && !boundedText(scope.instanceId)) {
        throw new Error("Desktop workspace scope is invalid.");
      }
      return scope.instanceId === undefined
        ? { type: scope.type }
        : { type: scope.type, instanceId: scope.instanceId };
    default:
      throw new Error("Desktop workspace scope is invalid.");
  }
}

export function projectDesktopWorkspaceState(
  state: DesktopWorkspaceClientSnapshot,
): DesktopWorkspaceStateProjection {
  return {
    status: state.status,
    accountId: state.accountId,
    localEnvironmentId: state.localEnvironmentId,
    machines: state.catalog.map((machine) => ({
      environmentId: machine.environmentId,
      nodeId: machine.nodeId,
      label: machine.label,
      online: machine.presence.online,
      nativeTrust: machine.nativeTrust,
      connectionState: machine.connectionState,
      canReadMetadata: machine.canReadMetadata,
      canConnect: machine.canConnect,
      canMutate: machine.canMutate,
      effectiveRole: machine.canConnect ? machine.effectiveRole : null,
      threadSettlementSupported: machine.capabilities.threadSettlement,
      accessReasons: machine.accessReasons,
    })),
    snapshots: state.workspace.snapshots.flatMap((entry) =>
      entry.status === "available" ? [entry.snapshot] : [],
    ),
    queuedEnvironmentIds: state.queuedEnvironmentIds,
    activeConnectionCount: state.demand.connections.filter((entry) => entry.connected).length,
  };
}

export function createDesktopWorkspaceIpcHandlers(client: DesktopWorkspaceClient) {
  return {
    getState: async () => projectDesktopWorkspaceState(client.snapshot()),
    refreshCatalog: async () => projectDesktopWorkspaceState(await client.refreshCatalog()),
    publishSnapshot: async (raw: unknown) => {
      if (!isWorkspaceMetadataSnapshot(raw)) {
        throw new Error("Desktop workspace metadata snapshot is invalid.");
      }
      return projectDesktopWorkspaceState(
        await client.acceptWorkspaceSnapshot(raw as WorkspaceMetadataSnapshot),
      );
    },
    retainScope: async (raw: unknown) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("Desktop workspace demand is invalid.");
      }
      const input = raw as { readonly environmentId?: unknown; readonly scope?: unknown };
      const retained = await client.retainScope({
        environmentId: environmentId(input.environmentId),
        scope: parseScope(input.scope),
      });
      return { leaseId: retained.leaseId, state: projectDesktopWorkspaceState(retained.snapshot) };
    },
    renewScope: async (raw: unknown) =>
      projectDesktopWorkspaceState(await client.renewScope(leaseId(raw))),
    releaseScope: async (raw: unknown) =>
      projectDesktopWorkspaceState(await client.releaseScope(leaseId(raw))),
    setBackgrounded: async (raw: unknown) => {
      if (typeof raw !== "boolean") throw new Error("Desktop workspace lifecycle is invalid.");
      return projectDesktopWorkspaceState(await client.setBackgrounded(raw));
    },
    purgeCache: async (raw?: unknown) =>
      projectDesktopWorkspaceState(
        await client.purgeCache(raw === undefined ? undefined : environmentId(raw)),
      ),
    beginVerification: async (raw: unknown) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("Desktop workspace verification is invalid.");
      }
      const input = raw as { readonly nodeId?: unknown; readonly environmentId?: unknown };
      if (!boundedText(input.nodeId)) {
        throw new Error("Desktop workspace verification is invalid.");
      }
      return client.beginVerification({
        nodeId: input.nodeId,
        environmentId: environmentId(input.environmentId),
      });
    },
    cancelVerification: async (raw: unknown) => client.cancelVerification(opaqueHandle(raw)),
    verifyApproval: async (raw: unknown) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("Desktop workspace approval is invalid.");
      }
      const input = raw as {
        readonly nodeId?: unknown;
        readonly environmentId?: unknown;
        readonly payload?: unknown;
      };
      if (
        !boundedText(input.nodeId) ||
        typeof input.payload !== "string" ||
        input.payload.length === 0 ||
        input.payload.length > 4_096
      ) {
        throw new Error("Desktop workspace approval is invalid.");
      }
      return projectDesktopWorkspaceState(
        await client.verifyApproval({
          nodeId: input.nodeId,
          environmentId: environmentId(input.environmentId),
          payload: input.payload,
        }),
      );
    },
  };
}

export function asDesktopWorkspaceMetadataProjection(
  snapshot: WorkspaceMetadataSnapshot,
): DesktopWorkspaceMetadataProjection {
  return snapshot;
}
