import {
  buildNodeCatalog,
  sameNodeCatalog,
  type NodeCatalogLiveFacts,
  type NodeCatalogSavedSource,
  type NodeCatalogSnapshot,
} from "@ryco/client-runtime/state/nodes";
import type { WorkspaceMachineCatalogEntry } from "@ryco/client-runtime/state/workspace";
import type {
  AuthSessionRole,
  EnvironmentConnectionState,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ServerConfig,
} from "@ryco/contracts";
import { resolveEnvironmentMachineKind } from "@ryco/shared/environmentIcon";

/**
 * The phone's node catalog: every machine a copy, a link or an Agent Control
 * copy may name, merged by the shared catalog policy (`buildNodeCatalog`) from
 * the directly paired machines and the Hub's. The phone has no primary
 * environment and is never a node itself.
 */

/** One directly paired machine as the catalog reads it. */
export interface MobileSavedNodeSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Switched off by the user: left out, it never connects. */
  readonly switchedOff: boolean;
  readonly connectionState: EnvironmentConnectionState;
  readonly role: AuthSessionRole | null;
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly serverConfig: ServerConfig | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
}

export interface MobileNodeCatalogInput {
  readonly saved: ReadonlyArray<MobileSavedNodeSource>;
  /** The Hub machines as the native workspace catalog reconciled them; null when signed out. */
  readonly hosted: ReadonlyArray<WorkspaceMachineCatalogEntry> | null;
  /** What each connected node last reported. */
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly observedAt: number;
}

function epochOrNull(value: string | null): number | null {
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

export const EMPTY_MOBILE_NODE_CATALOG: NodeCatalogSnapshot = {
  nodes: [],
  ownerEnvironmentIds: new Set(),
};

export function buildMobileNodeCatalog(input: MobileNodeCatalogInput): NodeCatalogSnapshot {
  const savedById = new Map(input.saved.map((source) => [source.environmentId, source] as const));
  const saved: NodeCatalogSavedSource[] = input.saved
    .filter((source) => !source.switchedOff)
    .map((source) => ({
      environmentId: source.environmentId,
      label: source.descriptor?.label ?? source.label,
      connectionState: source.connectionState,
      role: source.role,
      viaSsh: false,
      lastSeenAt: epochOrNull(source.disconnectedAt) ?? epochOrNull(source.connectedAt),
    }));
  return buildNodeCatalog({
    hosted: input.hosted,
    primary: null,
    saved,
    desktop: null,
    thisDeviceEnvironmentId: null,
    liveFacts: (environmentId) => {
      const source = savedById.get(environmentId);
      const config = input.configs.get(environmentId) ?? source?.serverConfig ?? null;
      const descriptor = config?.environment ?? source?.descriptor ?? null;
      return descriptor ? liveFactsFrom(descriptor, config) : null;
    },
    observedAt: input.observedAt,
  });
}

/** The previous snapshot when nothing a picker shows changed, so subscribers re-render less. */
export function stableMobileNodeCatalog(
  previous: NodeCatalogSnapshot,
  next: NodeCatalogSnapshot,
): NodeCatalogSnapshot {
  const sameOwners =
    previous.ownerEnvironmentIds.size === next.ownerEnvironmentIds.size &&
    Array.from(next.ownerEnvironmentIds).every((id) => previous.ownerEnvironmentIds.has(id));
  return sameOwners && sameNodeCatalog(previous.nodes, next.nodes) ? previous : next;
}
