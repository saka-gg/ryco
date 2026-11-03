import type {
  AuthSessionRole,
  DesktopWorkspaceMachineProjection,
  EnvironmentConnectionState,
  EnvironmentId,
  EnvironmentMachineKind,
  ExecutionEnvironmentPlatformOs,
} from "@ryco/contracts";
import { inferEnvironmentMachineKind } from "@ryco/shared/environmentIcon";

import type {
  NodeCatalogEntry,
  NodePresence,
  NodeProjectCopySupport,
  NodeTransport,
} from "../nodes/types.js";
import { nodeProjectCopySupport, reconcileWorkspaceMachine } from "./machineCatalog.js";
import type { WorkspaceMachineAccessReason, WorkspaceMachineCatalogEntry } from "./types.js";

/**
 * The node catalog: one list across the primary environment, saved
 * environments, Desktop Hub machines and hosted nodes. Hosted nodes and
 * Desktop Hub machines arrive already reconciled by the machine catalog
 * (`reconcileWorkspaceMachine`); the primary and saved environments are
 * reconciled here through the same policy, so `canMutate` has one owner.
 * The only logic of this module is the merge: which source describes a node
 * that several of them list, and the folding of the Desktop's local Hub alias
 * into the primary it already is.
 */

/** The environment this client was opened for: the local backend on Desktop, the serving node in a browser. */
export interface NodeCatalogPrimarySource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: EnvironmentConnectionState;
  /**
   * The direct session's role, null while unknown. An unknown role does not
   * block mutation, as everywhere the primary is written to (the node still
   * checks every call), but only a known owner role is owner-held.
   */
  readonly role: AuthSessionRole | null;
}

/** A saved (directly paired) environment with its runtime state. */
export interface NodeCatalogSavedSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: EnvironmentConnectionState;
  readonly role: AuthSessionRole | null;
  /**
   * Added through Desktop SSH. Such a node is re-paired as owner on connect,
   * so a `client` role there means its Ryco is too old to issue an owner link.
   */
  readonly viaSsh: boolean;
  /** Epoch milliseconds of its last connect or disconnect; null when never connected. */
  readonly lastSeenAt: number | null;
}

/** What a node itself said in its descriptor, once this client heard from it. */
export interface NodeCatalogLiveFacts {
  readonly platformOs: ExecutionEnvironmentPlatformOs;
  readonly iconKind: EnvironmentMachineKind | null;
  /** A descriptor without the flag comes from a node that predates project copy. */
  readonly projectCopy: boolean;
}

export interface NodeCatalogInput {
  /** Hosted mode: the Hub directory's machines are every node there is. */
  readonly hosted: ReadonlyArray<WorkspaceMachineCatalogEntry> | null;
  readonly primary: NodeCatalogPrimarySource | null;
  readonly saved: ReadonlyArray<NodeCatalogSavedSource>;
  /** Desktop only: its Hub machines, as Desktop main reconciled them. */
  readonly desktop: {
    readonly localEnvironmentId: EnvironmentId | null;
    readonly machines: ReadonlyArray<DesktopWorkspaceMachineProjection>;
  } | null;
  /** The local Desktop backend's environment, when this client is the Desktop app. */
  readonly thisDeviceEnvironmentId: EnvironmentId | null;
  readonly liveFacts: (environmentId: EnvironmentId) => NodeCatalogLiveFacts | null;
  readonly observedAt: number;
}

export interface NodeCatalogSnapshot {
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  /**
   * Nodes this client is known to hold the owner role on: a hosted or Desktop
   * Hub grant, or a direct session whose role is `owner`. Only these are
   * published to Agent Control's node directory.
   */
  readonly ownerEnvironmentIds: ReadonlySet<EnvironmentId>;
}

/** A node as the sources describe it, before presentation. */
interface NodeFacts {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platformOs: string | null;
  readonly connectionState: EnvironmentConnectionState;
  readonly online: boolean;
  readonly canMutate: boolean;
  readonly accessReasons: ReadonlyArray<WorkspaceMachineAccessReason>;
  /** The node's `client` session was added through Desktop SSH (see `viaSsh`). */
  readonly sshClientSession: boolean;
  readonly projectCopySupport: NodeProjectCopySupport;
  readonly transport: NodeTransport | null;
  readonly lastSeenAt: number | null;
  readonly ownerHeld: boolean;
}

const ACCESS_REASONS: ReadonlySet<string> = new Set<WorkspaceMachineAccessReason>([
  "revoked",
  "removed",
  "native-client-required",
  "trust-unknown",
  "not-verified",
  "identity-conflict",
  "offline",
  "role-unknown",
  "viewer",
  "client-session",
]);

function isAccessReason(reason: string): reason is WorkspaceMachineAccessReason {
  return ACCESS_REASONS.has(reason);
}

/** Reasons that take a node out of the catalog altogether. */
const GONE_REASONS: ReadonlySet<WorkspaceMachineAccessReason> = new Set(["revoked", "removed"]);

/**
 * Why a node cannot be mutated, in the words a picker shows. The first reason
 * that applies wins, most fundamental first: a revoked or untrusted node is
 * that before it is offline, and an offline one before its role matters.
 */
export function nodeMutateBlockedReason(input: {
  readonly label: string;
  readonly accessReasons: ReadonlyArray<WorkspaceMachineAccessReason>;
  /** A `client` session that came from Desktop SSH pairing (see `NodeCatalogSavedSource.viaSsh`). */
  readonly sshClientSession?: boolean;
}): string {
  const { label } = input;
  const has = (reason: WorkspaceMachineAccessReason) => input.accessReasons.includes(reason);
  if (has("revoked")) return `Access to ${label} was revoked`;
  if (has("removed")) return `${label} was removed from your account`;
  if (has("identity-conflict")) return `${label} changed its identity; check it in Settings`;
  if (has("native-client-required")) return `${label} can only be used from the Ryco app`;
  if (has("not-verified")) return `Verify ${label} on this device first`;
  if (has("trust-unknown")) return `Checking ${label}…`;
  if (has("offline")) return `${label} is offline`;
  if (has("viewer")) return `You can only view ${label}`;
  if (has("client-session")) {
    return input.sshClientSession === true
      ? `Update Ryco on ${label} to copy projects here`
      : `${label} was paired with limited access; pair it again as its owner to add projects`;
  }
  if (has("role-unknown")) return `Checking your access to ${label}…`;
  return `${label} is not available right now`;
}

function presenceFor(facts: NodeFacts): NodePresence {
  if (facts.connectionState === "connected") return "online";
  if (facts.connectionState === "connecting") return "connecting";
  return facts.online ? "online" : "offline";
}

function knownOs(os: string | null | undefined): string | null {
  return os && os !== "unknown" ? os : null;
}

/**
 * A catalog entry's `platformOs` as the contracts name it (`win32` is `windows`); null when the
 * node reported none, `unknown` for an OS outside the list.
 */
export function catalogPlatformOs(os: string | null): ExecutionEnvironmentPlatformOs | null {
  switch (os?.trim().toLowerCase()) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "windows":
    case "win32":
      return "windows";
    case undefined:
    case "":
      return null;
    default:
      return "unknown";
  }
}

function toEntry(
  facts: NodeFacts,
  input: NodeCatalogInput,
  primaryEnvironmentId: EnvironmentId | null,
): NodeCatalogEntry {
  const live = input.liveFacts(facts.environmentId);
  const platformOs = knownOs(live?.platformOs) ?? knownOs(facts.platformOs);
  return {
    environmentId: facts.environmentId,
    label: facts.label,
    isPrimary: facts.environmentId === primaryEnvironmentId,
    isThisDevice: facts.environmentId === input.thisDeviceEnvironmentId,
    presence: presenceFor(facts),
    platformOs,
    iconKind: live?.iconKind ?? inferEnvironmentMachineKind(platformOs ?? undefined, facts.label),
    canMutate: facts.canMutate,
    mutateBlockedReason: facts.canMutate
      ? null
      : nodeMutateBlockedReason({
          label: facts.label,
          accessReasons: facts.accessReasons,
          sshClientSession: facts.sshClientSession,
        }),
    // The node's own answer outranks what a directory says for it.
    projectCopySupport: live ? nodeProjectCopySupport(live.projectCopy) : facts.projectCopySupport,
    transport: facts.transport,
    lastSeenAt: facts.lastSeenAt,
  };
}

function machineFacts(machine: WorkspaceMachineCatalogEntry): NodeFacts {
  return {
    environmentId: machine.environmentId,
    label: machine.label,
    platformOs: machine.platform.os,
    connectionState: machine.connectionState,
    online: machine.presence.online,
    canMutate: machine.canMutate,
    accessReasons: machine.accessReasons,
    sshClientSession: false,
    projectCopySupport: machine.projectCopySupport,
    transport: machine.transport,
    lastSeenAt: machine.presence.lastSeenAt,
    // The role is the grant's, whether or not the node is reachable now.
    ownerHeld: machine.canReadMetadata && machine.effectiveRole === "owner",
  };
}

function desktopMachineFacts(machine: DesktopWorkspaceMachineProjection): NodeFacts {
  return {
    environmentId: machine.environmentId,
    label: machine.label,
    platformOs: machine.platformOs ?? null,
    connectionState: machine.connectionState,
    online: machine.online,
    canMutate: machine.canMutate,
    accessReasons: machine.accessReasons.filter(isAccessReason),
    sshClientSession: false,
    projectCopySupport: "unknown",
    // Desktop main reaches its Hub machines through its own relay transport.
    transport: machine.connectionState === "connected" ? "relay" : null,
    lastSeenAt: null,
    // Desktop main states the role only while the machine is connectable.
    ownerHeld: machine.effectiveRole === "owner",
  };
}

/** A direct session as the machine catalog sees it: always trusted, never relayed. */
function directFacts(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: EnvironmentConnectionState;
  readonly online: boolean;
  readonly role: AuthSessionRole | null;
  readonly viaSsh: boolean;
  readonly lastSeenAt: number | null;
  readonly observedAt: number;
}): NodeFacts {
  const client = input.role === "client";
  const machine = reconcileWorkspaceMachine({
    environmentId: input.environmentId,
    label: input.label,
    clientTier: "native",
    nativeTrust: "not-required",
    requiresNativeVerification: false,
    effectiveRole: client ? null : "owner",
    directSessionRole: input.role,
    transport: "direct",
    online: input.online,
    lastSeenAt: input.lastSeenAt,
    observedAt: input.observedAt,
    connectionState: input.connectionState,
  });
  return {
    ...machineFacts(machine),
    sshClientSession: client && input.viaSsh,
    // Pairing defaults to the client role, so only a known owner session counts.
    ownerHeld: input.role === "owner",
  };
}

function compareNodes(left: NodeCatalogEntry, right: NodeCatalogEntry): number {
  return (
    Number(right.isPrimary) - Number(left.isPrimary) ||
    Number(right.isThisDevice) - Number(left.isThisDevice) ||
    left.label.localeCompare(right.label) ||
    String(left.environmentId).localeCompare(String(right.environmentId))
  );
}

/**
 * Merges every source into one entry per node, the primary first, then this
 * device, then by label. A node several sources list is described by the one
 * that owns its connection: the Hub directory in hosted mode, else the primary
 * or saved (direct) session before a Desktop Hub machine, whose label (the
 * one the Hub renames) it still shows. Revoked and removed machines are left
 * out. The Desktop's local Hub alias is the primary itself.
 */
export function buildNodeCatalog(input: NodeCatalogInput): NodeCatalogSnapshot {
  const primaryEnvironmentId = input.primary?.environmentId ?? null;
  const byEnvironment = new Map<EnvironmentId, NodeFacts>();
  const add = (facts: NodeFacts) => {
    if (byEnvironment.has(facts.environmentId)) return;
    if (facts.accessReasons.some((reason) => GONE_REASONS.has(reason))) return;
    byEnvironment.set(facts.environmentId, facts);
  };

  if (input.hosted !== null) {
    for (const machine of input.hosted) add(machineFacts(machine));
  } else {
    const desktopMachines = input.desktop?.machines ?? [];
    const localEnvironmentId = input.desktop?.localEnvironmentId ?? null;
    const localAlias =
      primaryEnvironmentId !== null &&
      localEnvironmentId !== null &&
      localEnvironmentId !== primaryEnvironmentId
        ? localEnvironmentId
        : null;
    const hubLabel = (environmentId: EnvironmentId | null) =>
      environmentId === null
        ? undefined
        : desktopMachines
            .find((machine) => machine.environmentId === environmentId)
            ?.label.trim() || undefined;

    if (input.primary) {
      add(
        directFacts({
          environmentId: input.primary.environmentId,
          // The Hub knows this device by its alias, under the name it renames.
          label:
            hubLabel(localAlias) ?? hubLabel(input.primary.environmentId) ?? input.primary.label,
          connectionState: input.primary.connectionState,
          online:
            input.primary.connectionState !== "disconnected" &&
            input.primary.connectionState !== "error",
          role: input.primary.role,
          viaSsh: false,
          lastSeenAt: null,
          observedAt: input.observedAt,
        }),
      );
    }
    for (const saved of input.saved) {
      if (saved.environmentId === localAlias) continue;
      add(
        directFacts({
          environmentId: saved.environmentId,
          label: hubLabel(saved.environmentId) ?? saved.label,
          connectionState: saved.connectionState,
          // A saved environment is known reachable only through its own socket.
          online: saved.connectionState === "connected" || saved.connectionState === "connecting",
          role: saved.role,
          viaSsh: saved.viaSsh,
          lastSeenAt: saved.lastSeenAt,
          observedAt: input.observedAt,
        }),
      );
    }
    for (const machine of desktopMachines) {
      if (machine.environmentId === localAlias) continue;
      add(desktopMachineFacts(machine));
    }
  }

  const nodes: NodeCatalogEntry[] = [];
  const ownerEnvironmentIds = new Set<EnvironmentId>();
  for (const facts of byEnvironment.values()) {
    nodes.push(toEntry(facts, input, primaryEnvironmentId));
    if (facts.ownerHeld) ownerEnvironmentIds.add(facts.environmentId);
  }
  return { nodes: nodes.toSorted(compareNodes), ownerEnvironmentIds };
}

/** Whether two catalogs show the same nodes, so a caller can keep the one it holds. */
export function sameNodeCatalog(
  left: ReadonlyArray<NodeCatalogEntry>,
  right: ReadonlyArray<NodeCatalogEntry>,
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index]!;
    return (Object.keys(entry) as Array<keyof NodeCatalogEntry>).every(
      (key) => entry[key] === other[key],
    );
  });
}
