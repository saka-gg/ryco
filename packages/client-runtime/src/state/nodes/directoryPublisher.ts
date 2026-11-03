import {
  AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES,
  AGENT_CONTROL_NODE_DIRECTORY_MAX_PROJECTS,
  AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHED_PROJECTS,
} from "@ryco/contracts/agent-control";
import type {
  AgentControlNodeDirectoryEntry,
  AgentControlNodeDirectoryProject,
  AgentControlPublishNodeDirectoryInput,
  EnvironmentId,
} from "@ryco/contracts";

import { catalogPlatformOs, type NodeCatalogSnapshot } from "../workspace/nodeCatalog.js";

/**
 * Agent Control's node directory, fed by owner clients: every node that
 * supports project copy learns which other nodes this client holds owner on,
 * so an agent there can name a copy target. Entries are non-secret (id,
 * label, OS, presence, copy support, how this client reaches the node, its
 * code directory and where its repository projects are, so an agent can
 * tell the project is already there). The publisher sends them on every
 * connect and whenever they change, coalesced, and backs off from a node that
 * refuses them.
 */

/** Changes arriving within this window are published together. */
export const NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS = 2_000;
const NODE_DIRECTORY_RETRY_BASE_MS = 30_000;
const NODE_DIRECTORY_RETRY_MAX_MS = 15 * 60_000;
const NODE_DIRECTORY_ENVIRONMENT_ID_MAX_CHARS = 128;
const NODE_DIRECTORY_LABEL_MAX_CHARS = 120;
const NODE_DIRECTORY_PATH_MAX_CHARS = 1_024;
const NODE_DIRECTORY_REPOSITORY_KEY_MAX_CHARS = 512;

/** What this client knows of a node beyond the catalog, when it has read it. */
export interface NodeDirectoryNodeFacts {
  /** The node's normal code directory (its path hints); null when not read. */
  readonly defaultProjectDirectory: string | null;
  /** The node's projects with a repository identity; null when this client does not know them. */
  readonly projects: ReadonlyArray<{
    readonly repositoryCanonicalKey: string;
    readonly path: string;
  }> | null;
}

const boundedText = (value: string, max: number): string | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? null : trimmed;
};

/**
 * A node's projects as published: valid and distinct. Null (not known) when they do not all fit
 * the node's bound or what is left of the publication's: a partial list would say a project is
 * missing when it is there.
 */
function publishedProjects(
  projects: NonNullable<NodeDirectoryNodeFacts["projects"]>,
  budget: number,
): Array<AgentControlNodeDirectoryProject> | null {
  const published: Array<AgentControlNodeDirectoryProject> = [];
  const limit = Math.min(budget, AGENT_CONTROL_NODE_DIRECTORY_MAX_PROJECTS);
  for (const project of projects) {
    const key = boundedText(
      project.repositoryCanonicalKey,
      NODE_DIRECTORY_REPOSITORY_KEY_MAX_CHARS,
    );
    const path = boundedText(project.path, NODE_DIRECTORY_PATH_MAX_CHARS);
    if (key === null || path === null) continue;
    if (published.some((entry) => entry.repositoryCanonicalKey === key && entry.path === path))
      continue;
    if (published.length >= limit) return null;
    published.push({ repositoryCanonicalKey: key, path });
  }
  return published;
}

/**
 * The entries this client publishes: the catalog's owner-held nodes, in the
 * catalog's order (primary first), bounded to the directory's limits. `facts`
 * adds what this client read of a node (its code directory, its projects);
 * projects stay within one publication's total bound, first nodes first.
 */
export function nodeDirectoryEntries(
  snapshot: NodeCatalogSnapshot,
  facts?: (environmentId: EnvironmentId) => NodeDirectoryNodeFacts | null,
): ReadonlyArray<AgentControlNodeDirectoryEntry> {
  const entries: AgentControlNodeDirectoryEntry[] = [];
  let projectBudget = AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHED_PROJECTS;
  for (const node of snapshot.nodes) {
    if (entries.length === AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES) break;
    if (!snapshot.ownerEnvironmentIds.has(node.environmentId)) continue;
    if (String(node.environmentId).length > NODE_DIRECTORY_ENVIRONMENT_ID_MAX_CHARS) continue;
    const label = node.label.trim().slice(0, NODE_DIRECTORY_LABEL_MAX_CHARS).trim();
    if (label.length === 0) continue;
    const known = facts?.(node.environmentId) ?? null;
    const directory =
      known?.defaultProjectDirectory == null
        ? null
        : boundedText(known.defaultProjectDirectory, NODE_DIRECTORY_PATH_MAX_CHARS);
    const projects =
      known?.projects == null ? null : publishedProjects(known.projects, projectBudget);
    if (projects !== null) projectBudget -= projects.length;
    entries.push({
      environmentId: node.environmentId,
      label,
      platformOs: catalogPlatformOs(node.platformOs) ?? "unknown",
      online: node.presence === "online",
      projectCopySupport: node.projectCopySupport,
      ...(node.transport === null ? {} : { transport: node.transport }),
      ...(directory === null ? {} : { defaultProjectDirectory: directory }),
      // A node whose projects do not fit is published without them: not known, never empty.
      ...(projects === null ? {} : { projects }),
    });
  }
  return entries;
}

/** A node the directory may be published to right now. */
export interface NodeDirectoryTarget {
  readonly environmentId: EnvironmentId;
  /** Changes whenever the node's connection is replaced, so every connect publishes again. */
  readonly connection: unknown;
  readonly publish: (input: AgentControlPublishNodeDirectoryInput) => Promise<unknown>;
}

/**
 * The nodes the directory may be published to now: connected, owner-held,
 * implementing project copy, admitting the call (a hosted session that is not
 * ready, or blocked after uncertain delivery, does not) and with a connection
 * that has the publish method. Nothing else is ever called.
 */
export function selectNodeDirectoryTargets(
  snapshot: NodeCatalogSnapshot,
  ports: {
    /** Whether the node's session admits `agentControl.publishNodeDirectory` now. */
    readonly admits: (environmentId: EnvironmentId) => boolean;
    /** The node's registered connection and its publish method, when it has both. */
    readonly connectionFor: (
      environmentId: EnvironmentId,
    ) => Pick<NodeDirectoryTarget, "connection" | "publish"> | null;
  },
): ReadonlyArray<NodeDirectoryTarget> {
  const targets: NodeDirectoryTarget[] = [];
  for (const node of snapshot.nodes) {
    const { environmentId } = node;
    if (node.transport === null || node.projectCopySupport !== "yes") continue;
    if (!snapshot.ownerEnvironmentIds.has(environmentId) || !ports.admits(environmentId)) continue;
    const connection = ports.connectionFor(environmentId);
    if (connection) targets.push({ environmentId, ...connection });
  }
  return targets;
}

export interface NodeDirectoryPublisherPorts {
  readonly readEntries: () => ReadonlyArray<AgentControlNodeDirectoryEntry>;
  /**
   * Connected nodes that implement project copy and admit the call now (owner
   * role, a hosted session that is not blocked). Nothing else is ever called.
   */
  readonly readTargets: () => ReadonlyArray<NodeDirectoryTarget>;
  /** Fires when the entries or the targets may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly debounceMs?: number;
  readonly onPublishFailed?: (environmentId: EnvironmentId, error: unknown) => void;
}

interface Delivery {
  readonly connection: unknown;
  readonly digest: string;
}

interface Failure extends Delivery {
  readonly count: number;
  readonly retryAt: number;
}

function retryDelayMs(failures: number): number {
  return Math.min(
    NODE_DIRECTORY_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
    NODE_DIRECTORY_RETRY_MAX_MS,
  );
}

/**
 * Starts publishing; returns the stop. A target is sent the entries when it
 * has not received them over its current connection, at most one call per
 * target at a time. A refused publish is retried with backoff while the
 * entries and the connection stay the same, and at once when either changes.
 */
export function startNodeDirectoryPublisher(ports: NodeDirectoryPublisherPorts): () => void {
  const debounceMs = ports.debounceMs ?? NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS;
  const delivered = new Map<EnvironmentId, Delivery>();
  const failed = new Map<EnvironmentId, Failure>();
  const inFlight = new Set<EnvironmentId>();
  let timer: unknown = null;
  let dueAt = Number.POSITIVE_INFINITY;
  let stopped = false;

  /** Flushes at `now + delayMs`, unless a flush is already due sooner. */
  const schedule = (delayMs: number) => {
    if (stopped) return;
    const at = ports.now() + Math.max(0, delayMs);
    if (timer !== null && dueAt <= at) return;
    if (timer !== null) ports.clearTimeout(timer);
    dueAt = at;
    timer = ports.setTimeout(flush, Math.max(0, delayMs));
  };

  const sameDelivery = (left: Delivery | undefined, right: Delivery) =>
    left !== undefined && left.connection === right.connection && left.digest === right.digest;

  function flush(): void {
    timer = null;
    dueAt = Number.POSITIVE_INFINITY;
    if (stopped) return;
    const entries = ports.readEntries();
    const digest = JSON.stringify(entries);
    const targets = ports.readTargets();
    const present = new Set(targets.map((target) => target.environmentId));
    for (const environmentId of Array.from(delivered.keys())) {
      if (!present.has(environmentId)) delivered.delete(environmentId);
    }
    for (const environmentId of Array.from(failed.keys())) {
      if (!present.has(environmentId)) failed.delete(environmentId);
    }
    const now = ports.now();
    let nextRetryAt = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      const { environmentId } = target;
      const delivery: Delivery = { connection: target.connection, digest };
      // A call in flight re-checks once it settles.
      if (sameDelivery(delivered.get(environmentId), delivery) || inFlight.has(environmentId)) {
        continue;
      }
      const failure = failed.get(environmentId);
      const repeat = failure !== undefined && sameDelivery(failure, delivery);
      if (repeat && failure.retryAt > now) {
        nextRetryAt = Math.min(nextRetryAt, failure.retryAt);
        continue;
      }
      inFlight.add(environmentId);
      void Promise.resolve()
        .then(() => target.publish({ nodes: entries }))
        .then(
          () => {
            delivered.set(environmentId, delivery);
            failed.delete(environmentId);
          },
          (error: unknown) => {
            const count = (repeat ? failure.count : 0) + 1;
            failed.set(environmentId, {
              ...delivery,
              count,
              retryAt: ports.now() + retryDelayMs(count),
            });
            if (!stopped) ports.onPublishFailed?.(environmentId, error);
          },
        )
        .finally(() => {
          inFlight.delete(environmentId);
          schedule(debounceMs);
        });
    }
    if (nextRetryAt !== Number.POSITIVE_INFINITY) schedule(nextRetryAt - now);
  }

  const unsubscribe = ports.subscribe(() => schedule(debounceMs));
  schedule(debounceMs);
  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (timer !== null) ports.clearTimeout(timer);
    timer = null;
  };
}
