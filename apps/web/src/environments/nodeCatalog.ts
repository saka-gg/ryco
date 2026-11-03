import {
  appAtomRegistry,
  getEnvironmentServerConfigsSnapshot,
  getWsConnectionStatusForEnvironment,
  subscribeEnvironmentServerConfigs,
  wsConnectionStatusForEnvironmentAtom,
  type WsConnectionStatus,
} from "@ryco/client-runtime/rpc";
import { isSavedEnvironmentSwitchedOff } from "@ryco/client-runtime/connection";
import {
  buildNodeCatalog,
  sameNodeCatalog,
  type NodeCatalogEntry,
  type NodeCatalogLiveFacts,
  type NodeCatalogSavedSource,
  type NodeCatalogSnapshot,
} from "@ryco/client-runtime/state/nodes";
import type {
  AuthSessionRole,
  EnvironmentConnectionState,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ServerConfig,
} from "@ryco/contracts";
import { resolveEnvironmentMachineKind } from "@ryco/shared/environmentIcon";
import { useSyncExternalStore } from "react";

import { isElectron, isHostedHubMode } from "../env";
import {
  readHostedWorkspaceState,
  subscribeHostedWorkspaceState,
} from "../hostedHub/hostedConnectionCoordinator";
import {
  readDesktopWorkspaceState,
  subscribeDesktopWorkspaceState,
} from "../platform/desktopWorkspace";
import { readPrimaryEnvironmentDescriptor, subscribePrimaryEnvironmentDescriptor } from "./primary";
import {
  peekPrimarySessionRole,
  requestPrimarySessionRole,
  subscribePrimarySessionRole,
} from "./nodeRole";
import { useSavedEnvironmentRegistryStore, useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * The node catalog of this client (`buildNodeCatalog`) as an external store:
 * every node picker, the add-project and copy dialogs, the Projects page and
 * the Agent Control node directory read the same list. It follows the stores
 * it is built from and keeps its identity while it reads the same, so a
 * config push or a socket retry that changes nothing a picker shows
 * re-renders nothing. Reading never connects or wakes a node.
 */

function primaryConnectionState(status: WsConnectionStatus): EnvironmentConnectionState {
  switch (status.phase) {
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    // Not started yet is on its way: the primary always connects.
    case "idle":
    case "connecting":
      return "connecting";
  }
}

function epochOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function liveFactsFrom(
  descriptor: ExecutionEnvironmentDescriptor,
  config: ServerConfig | null,
): NodeCatalogLiveFacts {
  return {
    platformOs: descriptor.platform.os,
    iconKind: config
      ? resolveEnvironmentMachineKind(config)
      : (descriptor.platform.machine ?? null),
    projectCopy: descriptor.capabilities.projectCopy === true,
  };
}

/** The inputs a catalog was built from, compared by identity before rebuilding. */
interface CatalogSources {
  readonly primaryDescriptor: ExecutionEnvironmentDescriptor | null;
  readonly primaryStatus: WsConnectionStatus | null;
  /** This page's own session role on the primary; undefined until it is known. */
  readonly primaryRole: AuthSessionRole | null | undefined;
  readonly registry: ReturnType<typeof useSavedEnvironmentRegistryStore.getState>["byId"];
  readonly runtime: ReturnType<typeof useSavedEnvironmentRuntimeStore.getState>["byId"];
  readonly desktop: ReturnType<typeof readDesktopWorkspaceState> | null;
  readonly hosted: ReturnType<typeof readHostedWorkspaceState>["machines"] | null;
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
}

function readSources(): CatalogSources {
  const hosted = isHostedHubMode();
  const primaryDescriptor = readPrimaryEnvironmentDescriptor();
  return {
    primaryDescriptor,
    primaryStatus:
      hosted || !primaryDescriptor
        ? null
        : getWsConnectionStatusForEnvironment(primaryDescriptor.environmentId),
    primaryRole:
      hosted || !primaryDescriptor ? null : peekPrimarySessionRole(primaryDescriptor.environmentId),
    registry: useSavedEnvironmentRegistryStore.getState().byId,
    runtime: useSavedEnvironmentRuntimeStore.getState().byId,
    desktop: isElectron && !hosted ? readDesktopWorkspaceState() : null,
    hosted: hosted ? readHostedWorkspaceState().machines : null,
    configs: getEnvironmentServerConfigsSnapshot(),
  };
}

function sameSources(left: CatalogSources, right: CatalogSources): boolean {
  return (Object.keys(left) as Array<keyof CatalogSources>).every(
    (key) => left[key] === right[key],
  );
}

function buildFrom(sources: CatalogSources): NodeCatalogSnapshot {
  const { primaryDescriptor, runtime, configs } = sources;
  const liveFacts = (environmentId: EnvironmentId): NodeCatalogLiveFacts | null => {
    const config = configs.get(environmentId) ?? runtime[environmentId]?.serverConfig ?? null;
    const descriptor =
      config?.environment ??
      runtime[environmentId]?.descriptor ??
      (primaryDescriptor?.environmentId === environmentId && sources.hosted === null
        ? primaryDescriptor
        : null);
    return descriptor ? liveFactsFrom(descriptor, config) : null;
  };
  // A switched-off machine is left out, as in the sidebar: it never connects,
  // so no picker, dialog or Agent Control directory may offer it.
  const saved: NodeCatalogSavedSource[] = Object.values(sources.registry).flatMap((record) => {
    if (isSavedEnvironmentSwitchedOff(record)) return [];
    const state = runtime[record.environmentId];
    return {
      environmentId: record.environmentId,
      label: state?.descriptor?.label ?? record.label,
      connectionState: state?.connectionState ?? "disconnected",
      role: state?.role ?? null,
      viaSsh: record.desktopSsh !== undefined,
      lastSeenAt: epochOrNull(state?.disconnectedAt) ?? epochOrNull(state?.connectedAt),
    };
  });
  return buildNodeCatalog({
    hosted: sources.hosted,
    primary: primaryDescriptor
      ? {
          environmentId: primaryDescriptor.environmentId,
          label: primaryDescriptor.label,
          connectionState: sources.primaryStatus
            ? primaryConnectionState(sources.primaryStatus)
            : "connecting",
          // Owner-held, and so published to Agent Control's node directory, only
          // once the page knows its own session there is the owner's.
          role: sources.primaryRole ?? null,
        }
      : null,
    saved,
    desktop: sources.desktop
      ? {
          localEnvironmentId: sources.desktop.localEnvironmentId,
          machines: sources.desktop.status === "ready" ? sources.desktop.machines : [],
        }
      : null,
    thisDeviceEnvironmentId:
      isElectron && sources.hosted === null ? (primaryDescriptor?.environmentId ?? null) : null,
    liveFacts,
    observedAt: Date.now(),
  });
}

const EMPTY_SNAPSHOT: NodeCatalogSnapshot = { nodes: [], ownerEnvironmentIds: new Set() };
let built: { readonly sources: CatalogSources; readonly snapshot: NodeCatalogSnapshot } | null =
  null;

/** The catalog now; the same object while what it shows is the same. */
export function readNodeCatalogSnapshot(): NodeCatalogSnapshot {
  const sources = readSources();
  if (built !== null && sameSources(built.sources, sources)) return built.snapshot;
  const next = buildFrom(sources);
  const previous = built?.snapshot ?? EMPTY_SNAPSHOT;
  const snapshot =
    sameNodeCatalog(previous.nodes, next.nodes) &&
    previous.ownerEnvironmentIds.size === next.ownerEnvironmentIds.size &&
    Array.from(next.ownerEnvironmentIds).every((id) => previous.ownerEnvironmentIds.has(id))
      ? previous
      : next;
  built = { sources, snapshot };
  return snapshot;
}

export function readNodeCatalog(): ReadonlyArray<NodeCatalogEntry> {
  return readNodeCatalogSnapshot().nodes;
}

/**
 * Notifies when the catalog may have changed. The primary's socket status is
 * followed for whichever environment is the primary now, and this page's role
 * there is asked for while it is unknown: when the catalog is first followed,
 * and again whenever that socket changes (it connects only once signed in).
 */
export function subscribeNodeCatalog(listener: () => void): () => void {
  let primaryEnvironmentId: EnvironmentId | null = null;
  let unsubscribePrimaryStatus: (() => void) | null = null;
  const followPrimaryStatus = () => {
    const next = isHostedHubMode()
      ? null
      : (readPrimaryEnvironmentDescriptor()?.environmentId ?? null);
    if (next === primaryEnvironmentId) return;
    unsubscribePrimaryStatus?.();
    primaryEnvironmentId = next;
    if (next === null) {
      unsubscribePrimaryStatus = null;
      return;
    }
    requestPrimarySessionRole(next);
    unsubscribePrimaryStatus = appAtomRegistry.subscribe(
      wsConnectionStatusForEnvironmentAtom(next),
      () => {
        requestPrimarySessionRole(next);
        listener();
      },
    );
  };
  followPrimaryStatus();
  const unsubscribes = [
    subscribePrimarySessionRole(listener),
    subscribePrimaryEnvironmentDescriptor(() => {
      followPrimaryStatus();
      listener();
    }),
    useSavedEnvironmentRegistryStore.subscribe(listener),
    useSavedEnvironmentRuntimeStore.subscribe(listener),
    subscribeDesktopWorkspaceState(listener),
    subscribeHostedWorkspaceState(listener),
    subscribeEnvironmentServerConfigs(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribePrimaryStatus?.();
  };
}

/**
 * Every node this client knows, the primary first: presence, platform, whether
 * projects can be added there (and why not) and project copy support.
 */
export function useNodeCatalog(): ReadonlyArray<NodeCatalogEntry> {
  return useSyncExternalStore(subscribeNodeCatalog, readNodeCatalog, readNodeCatalog);
}

/** One node of the catalog, or null when this client does not know it. */
export function useNodeCatalogEntry(environmentId: EnvironmentId | null): NodeCatalogEntry | null {
  const nodes = useNodeCatalog();
  return environmentId === null
    ? null
    : (nodes.find((node) => node.environmentId === environmentId) ?? null);
}
