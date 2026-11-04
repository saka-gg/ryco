import type { EnvironmentId, EnvironmentMachineKind } from "@ryco/contracts";

/** Whether a node can be reached right now. */
export type NodePresence = "online" | "connecting" | "offline";

/**
 * Whether a node implements the cross-node project copy RPCs (`capabilities.projectCopy`).
 * `unknown` means the client has not connected to it yet: it stays selectable, and selecting it
 * connects and then checks.
 */
export type NodeProjectCopySupport = "yes" | "no" | "unknown";

/** How the client reaches a node: directly, or through the Hub relay (which caps transfers). */
export type NodeTransport = "direct" | "relay";

/**
 * One node as every node picker sees it, merged from the primary environment, saved
 * environments, Desktop Hub machines and hosted nodes, with local Hub aliases folded into the
 * machine they belong to.
 */
export interface NodeCatalogEntry {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The environment this client treats as primary (the routed node in hosted mode). */
  readonly isPrimary: boolean;
  /** The machine this client runs on (the local Desktop backend). */
  readonly isThisDevice: boolean;
  readonly presence: NodePresence;
  /** `platform.os` (`darwin`, `linux`, `windows`, …) when known. */
  readonly platformOs: string | null;
  readonly iconKind: EnvironmentMachineKind | null;
  /** The client may create projects, clone, browse folders and start imports there. */
  readonly canMutate: boolean;
  /** Why `canMutate` is false, in words a picker can show; null when it can mutate. */
  readonly mutateBlockedReason: string | null;
  readonly projectCopySupport: NodeProjectCopySupport;
  /** Null while the node is not connected. */
  readonly transport: NodeTransport | null;
  /** Epoch milliseconds the node was last seen online; null when unknown. */
  readonly lastSeenAt: number | null;
}
