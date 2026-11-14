import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import type { EnvironmentId, SpaceRole } from "@ryco/contracts";
import { isObjectLike } from "@ryco/shared/unknownValue";

/**
 * The locally persisted Hub node roster (wave 2 amendment A). The directory
 * lives only in memory in the hosted runtime, so before this a cold start had
 * snapshots keyed by environmentId and nothing to render them against — no
 * label, no role, no presence. Each record is the last directory observation
 * of one node, stamped with when it was observed (the directory itself never
 * records that).
 *
 * Version history:
 * v1 — initial: node identity, label, effective role, revocation, presence
 *      plus observation timestamp.
 */
export const HUB_NODE_ROSTER_SCHEMA_VERSION = 1;

export interface CachedHubNodeRecord {
  readonly nodeId: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly effectiveRole: SpaceRole;
  readonly revokedAt: number | null;
  readonly presenceOnline: boolean;
  readonly lastHeartbeatAt: number | null;
  readonly lastAuthenticatedAt: number | null;
  readonly observedAt: number;
}

export interface StoredHubNodeRoster {
  readonly schemaVersion: typeof HUB_NODE_ROSTER_SCHEMA_VERSION;
  readonly nodes: ReadonlyArray<CachedHubNodeRecord>;
}

const ROLES = new Set(["viewer", "operator", "owner"]);

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isValidRosterRecord(value: unknown): value is CachedHubNodeRecord {
  return (
    isObjectLike(value) &&
    typeof value.nodeId === "string" &&
    value.nodeId.length > 0 &&
    typeof value.environmentId === "string" &&
    value.environmentId.length > 0 &&
    typeof value.label === "string" &&
    ROLES.has(value.effectiveRole as string) &&
    isNullableNumber(value.revokedAt) &&
    typeof value.presenceOnline === "boolean" &&
    isNullableNumber(value.lastHeartbeatAt) &&
    isNullableNumber(value.lastAuthenticatedAt) &&
    typeof value.observedAt === "number" &&
    Number.isFinite(value.observedAt)
  );
}

export function encodeStoredHubNodeRoster(nodes: ReadonlyArray<CachedHubNodeRecord>): string {
  const roster: StoredHubNodeRoster = { schemaVersion: HUB_NODE_ROSTER_SCHEMA_VERSION, nodes };
  return JSON.stringify(roster);
}

/** Version-literal or shape mismatch → null; the caller treats it as absent. */
export function decodeStoredHubNodeRoster(raw: string): ReadonlyArray<CachedHubNodeRecord> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObjectLike(value)) return null;
  if (value.schemaVersion !== HUB_NODE_ROSTER_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.nodes)) return null;
  if (!value.nodes.every(isValidRosterRecord)) return null;
  return value.nodes;
}

export interface HubNodeRosterReconciliation {
  readonly roster: ReadonlyArray<CachedHubNodeRecord>;
  /**
   * Environments whose cached content must be purged: nodes that vanished
   * from the directory (authorization removed) and nodes newly reported
   * revoked. Revoked-but-listed nodes stay in the roster with `revokedAt` set
   * so a later hydration can also discard any snapshot that slipped through.
   */
  readonly purgeEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly changed: boolean;
}

function toRosterRecord(node: HostedHubNode, observedAt: number): CachedHubNodeRecord {
  return {
    nodeId: node.id,
    environmentId: node.environmentId,
    label: node.label,
    effectiveRole: node.effectiveRole,
    revokedAt: node.revokedAt,
    presenceOnline: node.presence.online,
    lastHeartbeatAt: node.presence.lastHeartbeatAt,
    lastAuthenticatedAt: node.lastAuthenticatedAt,
    observedAt,
  };
}

function rosterRecordsEqual(left: CachedHubNodeRecord, right: CachedHubNodeRecord): boolean {
  // observedAt deliberately excluded: a poll that changes nothing else should
  // not count as a roster change (it would rewrite the persisted roster every
  // 20 seconds).
  return (
    left.nodeId === right.nodeId &&
    left.environmentId === right.environmentId &&
    left.label === right.label &&
    left.effectiveRole === right.effectiveRole &&
    left.revokedAt === right.revokedAt &&
    left.presenceOnline === right.presenceOnline &&
    left.lastHeartbeatAt === right.lastHeartbeatAt &&
    left.lastAuthenticatedAt === right.lastAuthenticatedAt
  );
}

/**
 * Fold a fresh directory listing over the cached roster. Only call with a
 * ready directory — reconciling against a transient empty list (bootstrap,
 * sign-out teardown) would read as every node being removed.
 */
export function reconcileHubNodeRoster(
  current: ReadonlyArray<CachedHubNodeRecord>,
  liveNodes: ReadonlyArray<HostedHubNode>,
  observedAt: number,
): HubNodeRosterReconciliation {
  const next = liveNodes.map((node) => toRosterRecord(node, observedAt));
  const nextByNodeId = new Map(next.map((record) => [record.nodeId, record] as const));

  const purgeEnvironmentIds: EnvironmentId[] = [];
  for (const record of current) {
    const live = nextByNodeId.get(record.nodeId);
    if (!live) {
      purgeEnvironmentIds.push(record.environmentId);
      continue;
    }
    if (live.revokedAt !== null && record.revokedAt === null) {
      purgeEnvironmentIds.push(record.environmentId);
    }
  }
  // A node that arrives already revoked (first observation) has no cached
  // content yet, but purge defensively in case a snapshot exists for it.
  const knownNodeIds = new Set(current.map((record) => record.nodeId));
  for (const record of next) {
    if (record.revokedAt !== null && !knownNodeIds.has(record.nodeId)) {
      purgeEnvironmentIds.push(record.environmentId);
    }
  }

  const changed =
    current.length !== next.length ||
    next.some((record, index) => {
      const previous = current[index];
      return !previous || !rosterRecordsEqual(previous, record);
    });
  return { roster: next, purgeEnvironmentIds, changed };
}

// ---------------------------------------------------------------------------
// Module store — the render-side mirror of the persisted roster. Hydrated at
// cold start from the snapshot database, replaced by directory reconciliation
// while the hosted session is live.
// ---------------------------------------------------------------------------

let rosterNodes: ReadonlyArray<CachedHubNodeRecord> = [];
const listeners = new Set<() => void>();

export function getCachedHubNodeRoster(): ReadonlyArray<CachedHubNodeRecord> {
  return rosterNodes;
}

export function subscribeCachedHubNodeRoster(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCachedHubNodeRoster(nodes: ReadonlyArray<CachedHubNodeRecord>): void {
  rosterNodes = nodes;
  listeners.forEach((listener) => listener());
}

export function resetCachedHubNodeRosterForTests(): void {
  rosterNodes = [];
  listeners.clear();
}
