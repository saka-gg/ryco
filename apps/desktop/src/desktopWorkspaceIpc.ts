import type {
  DesktopThreadContentProjectionMap,
  DesktopWorkspaceMetadataProjection,
  DesktopWorkspaceScopeProjection,
  DesktopWorkspaceStateProjection,
  DesktopWorkspaceStatePush,
  DesktopWorkspaceStateSummary,
} from "@ryco/contracts";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { decodeCachedEnvironmentContent } from "@ryco/client-runtime/state/threads/threadContentCachePolicy";
import {
  isWorkspaceMetadataSnapshot,
  type WorkspaceConnectionScope,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";

import type { DesktopThreadContentCache } from "./desktopThreadContentCache.ts";
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

export function projectDesktopWorkspaceSummary(
  state: DesktopWorkspaceClientSnapshot,
): DesktopWorkspaceStateSummary {
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
      canRename: machine.effectiveRole === "owner" && machine.canReadMetadata,
      canConnect: machine.canConnect,
      canMutate: machine.canMutate,
      effectiveRole: machine.canConnect ? machine.effectiveRole : null,
      threadSettlementSupported: machine.capabilities.threadSettlement,
      accessReasons: machine.accessReasons,
    })),
    queuedEnvironmentIds: state.queuedEnvironmentIds,
    activeConnectionCount: state.demand.connections.filter((entry) => entry.connected).length,
    ...(state.accountE2ee === null ? {} : { accountE2ee: state.accountE2ee }),
  };
}

/** The complete state, for a renderer that holds none (first load or reload). */
export function projectDesktopWorkspaceFullState(
  state: DesktopWorkspaceClientSnapshot,
): DesktopWorkspaceStateProjection {
  return { ...projectDesktopWorkspaceSummary(state), snapshots: state.snapshots };
}

/**
 * The state as pushed to the renderer: its snapshots only when they changed
 * since the previous publication.
 */
export function projectDesktopWorkspaceState(
  state: DesktopWorkspaceClientSnapshot,
): DesktopWorkspaceStatePush {
  return state.snapshotsUnchanged === true
    ? projectDesktopWorkspaceSummary(state)
    : projectDesktopWorkspaceFullState(state);
}

/** What the handlers need of the Desktop thread content cache. */
export type DesktopWorkspaceThreadContent = Pick<
  DesktopThreadContentCache,
  "isEnabled" | "setEnabled" | "load" | "publish"
>;

/** For a workspace client without a content cache: nothing is kept, and the setting reads off. */
const NO_THREAD_CONTENT: DesktopWorkspaceThreadContent = {
  isEnabled: async () => false,
  setEnabled: async () => undefined,
  load: async () => ({}),
  publish: async () => undefined,
};

/**
 * Thread content is kept and served only for the signed-in account's machines
 * whose metadata may be shown, the same eligibility as their snapshots.
 */
function threadContentScope(state: DesktopWorkspaceClientSnapshot, environment: EnvironmentId) {
  if (state.status !== "ready" || state.accountId === null) return null;
  const eligible = state.catalog.some(
    (machine) =>
      machine.environmentId === environment &&
      machine.canReadMetadata &&
      machine.cacheDisposition === "available",
  );
  return eligible ? { accountId: state.accountId, environmentId: environment } : null;
}

/**
 * Replies to invoked commands carry no snapshot bodies: the renderer learns of
 * changed snapshots from the pushed state and reads the full state with `getState`.
 */
export function createDesktopWorkspaceIpcHandlers(
  client: DesktopWorkspaceClient,
  threadContent: DesktopWorkspaceThreadContent = NO_THREAD_CONTENT,
) {
  return {
    getState: async () => projectDesktopWorkspaceFullState(client.snapshot()),
    refreshCatalog: async () => projectDesktopWorkspaceSummary(await client.refreshCatalog()),
    renameDevice: async (raw: unknown) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new Error("Device name request is invalid.");
      const input = raw as { readonly environmentId?: unknown; readonly label?: unknown };
      if (typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 100)
        throw new Error("Use a device name of 1–100 characters.");
      return projectDesktopWorkspaceSummary(
        await client.renameDevice(environmentId(input.environmentId), input.label.trim()),
      );
    },
    publishSnapshot: async (raw: unknown) => {
      if (!isWorkspaceMetadataSnapshot(raw)) {
        throw new Error("Desktop workspace metadata snapshot is invalid.");
      }
      return projectDesktopWorkspaceSummary(
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
      return {
        leaseId: retained.leaseId,
        state: projectDesktopWorkspaceSummary(retained.snapshot),
      };
    },
    renewScope: async (raw: unknown) =>
      projectDesktopWorkspaceSummary(await client.renewScope(leaseId(raw))),
    releaseScope: async (raw: unknown) =>
      projectDesktopWorkspaceSummary(await client.releaseScope(leaseId(raw))),
    setBackgrounded: async (raw: unknown) => {
      if (typeof raw !== "boolean") throw new Error("Desktop workspace lifecycle is invalid.");
      return projectDesktopWorkspaceSummary(await client.setBackgrounded(raw));
    },
    purgeCache: async (raw?: unknown) =>
      projectDesktopWorkspaceSummary(
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
    publishThreadContent: async (rawEnvironmentId: unknown, raw: unknown) => {
      const environment = environmentId(rawEnvironmentId);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("Desktop thread content is invalid.");
      }
      const scope = threadContentScope(client.snapshot(), environment);
      // The cache bounds what it is handed to the shared policy: thread count and record size.
      if (scope !== null) await threadContent.publish(scope, raw);
    },
    getThreadContent: async (
      rawEnvironmentId: unknown,
    ): Promise<DesktopThreadContentProjectionMap> => {
      const environment = environmentId(rawEnvironmentId);
      const state = client.snapshot();
      const scope = threadContentScope(state, environment);
      const snapshot = state.snapshots.find((entry) => entry.environmentId === environment);
      if (scope === null || snapshot === undefined) return {};
      // Only threads the environment's own metadata lists, each decoded within the shared limits.
      return decodeCachedEnvironmentContent(
        { content: await threadContent.load(scope) },
        new Set(snapshot.threads.map((thread) => String(thread.id))),
      );
    },
    getThreadContentCacheEnabled: async () => threadContent.isEnabled(),
    setThreadContentCacheEnabled: async (raw: unknown) => {
      if (typeof raw !== "boolean") throw new Error("Desktop thread content setting is invalid.");
      await threadContent.setEnabled(raw);
      return threadContent.isEnabled();
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
      return projectDesktopWorkspaceSummary(
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
