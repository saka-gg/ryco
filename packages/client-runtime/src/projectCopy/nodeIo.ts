// FILE: nodeIo.ts
// Purpose: A client's `ProjectCopyIo` for the copy coordinator: nodes are held
//          through the app's `acquire`, every write goes through the held
//          node's lease check, and a node's config is read from what its
//          connection already reports. Plus one-off reads and writes against a
//          node outside a copy's own holds (Agent Control reports).
// Layer: Client runtime. Each app supplies how it acquires a node and watches
//        its connections; the copy manager creates one IO per copy.

import type { EnvironmentApi, EnvironmentId, ServerConfig } from "@ryco/contracts";

import { isNodeLeaseLostError, type AcquiredNode } from "../state/nodes/acquire.ts";
import {
  ProjectCopyLeaseLostError,
  ProjectCopyNodeUnavailableError,
  type ProjectCopyAcquireRequest,
  type ProjectCopyIo,
  type ProjectCopyNodeApi,
  type ProjectCopyNodeHandle,
  type ProjectCopyNodePurpose,
} from "./io.ts";

/** How a copy's IO holds a node: the app's `acquireNode`, a fake in tests. */
export type ProjectCopyNodeAcquire = (
  environmentId: EnvironmentId,
  options: {
    readonly copyId: string;
    readonly signal: AbortSignal;
    readonly purpose: ProjectCopyNodePurpose;
  },
) => Promise<AcquiredNode>;

export interface ProjectCopyNodeIoDeps {
  readonly acquire: ProjectCopyNodeAcquire;
  /** The node's API outside a held copy (config reads); none by default. */
  readonly readApi?: (environmentId: EnvironmentId) => EnvironmentApi | undefined;
  /** What the node's connection last reported; nothing by default. */
  readonly readCachedConfig?: (environmentId: EnvironmentId) => ServerConfig | null;
  /**
   * Calls `listener` whenever a node's connection is registered, replaced or removed;
   * `subscribeEnvironmentConnections` in the app.
   */
  readonly subscribeConnections: (listener: () => void) => () => void;
  readonly now?: () => number;
  /** A lowercase random (version 4) UUID; `crypto.randomUUID` by default. */
  readonly uuid?: () => string;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** The IO of one copy, plus what the dialogs and the executor read through it. */
export interface ProjectCopyNodeIo extends ProjectCopyIo {
  /**
   * The node's server config: what its connection already reports, else read
   * from the node (held by this copy, or reachable now). Null when neither
   * answers; the follow-up thread then uses the node's own defaults (A19).
   */
  readonly readServerConfig: (environmentId: EnvironmentId) => Promise<ServerConfig | null>;
  /** Releases every node this IO still holds. The coordinator releases its own; this is the backstop. */
  readonly dispose: () => void;
}

const BASE_DEPS = {
  readApi: () => undefined,
  readCachedConfig: () => null,
  now: () => Date.now(),
  uuid: () =>
    (globalThis as unknown as { readonly crypto: { randomUUID(): string } }).crypto.randomUUID(),
  setTimeout: (callback: () => void, ms: number): unknown => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
} satisfies Omit<Required<ProjectCopyNodeIoDeps>, "acquire" | "subscribeConnections">;

interface HeldNode {
  readonly node: AcquiredNode;
  /** Aborts once the acquired connection is no longer the node's, or the hold is released. */
  readonly connectionLost: AbortSignal;
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;

/**
 * One copy's IO. The latest acquisition of a node is the one calls go through;
 * releasing an earlier handle (the copy scope after the target was downgraded
 * to following) leaves the newer one in place. A call never runs through a
 * connection or lease other than the one acquired: a stale lease fails
 * `withLease` with `ProjectCopyLeaseLostError` before anything is sent, and a
 * replaced connection fails `withNode` with `ProjectCopyNodeUnavailableError`;
 * the coordinator then pauses, acquires again and resumes with the same ids.
 * A subscription opened through `withNode` dies silently with its connection
 * (the replaced transport is disposed), so each hold watches its connection
 * and aborts the `connectionLost` signal `withNode` hands out once it goes.
 */
export function createProjectCopyNodeIo(input: ProjectCopyNodeIoDeps): ProjectCopyNodeIo {
  const deps: Required<ProjectCopyNodeIoDeps> = { ...BASE_DEPS, ...input };
  const held = new Map<EnvironmentId, HeldNode>();
  /** Releases every hold still out; `dispose` runs them. */
  const releases = new Set<() => void>();

  const acquireNodeHandle = async (
    request: ProjectCopyAcquireRequest,
  ): Promise<ProjectCopyNodeHandle> => {
    const node = await deps.acquire(request.environmentId, {
      copyId: request.copyId,
      signal: request.signal,
      purpose: request.purpose,
    });
    const lost = new AbortController();
    let stopWatching: () => void = () => undefined;
    const loseConnection = () => {
      if (lost.signal.aborted) return;
      stopWatching();
      lost.abort();
    };
    stopWatching = deps.subscribeConnections(() => {
      if (!node.isConnected()) loseConnection();
    });
    if (!node.isConnected()) loseConnection();
    const entry: HeldNode = { node, connectionLost: lost.signal };
    held.set(request.environmentId, entry);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releases.delete(release);
      node.release();
      loseConnection();
      if (held.get(request.environmentId) === entry) held.delete(request.environmentId);
    };
    releases.add(release);
    return { environmentId: request.environmentId, transport: node.transport, release };
  };

  const withLease = <T>(
    environmentId: EnvironmentId,
    call: (api: ProjectCopyNodeApi) => Promise<T>,
  ): Promise<T> => {
    const entry = held.get(environmentId);
    if (!entry) {
      return Promise.reject(
        new ProjectCopyLeaseLostError(environmentId, "The copy no longer holds this device."),
      );
    }
    return entry.node
      .withLease((api) => call(api))
      .catch((error: unknown) => {
        // The lease check failed before the call went out.
        if (isNodeLeaseLostError(error)) {
          throw new ProjectCopyLeaseLostError(environmentId, error.message);
        }
        throw error;
      });
  };

  const withNode = <T>(
    environmentId: EnvironmentId,
    call: (api: ProjectCopyNodeApi, connectionLost: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const entry = held.get(environmentId);
    if (!entry || !entry.node.isConnected()) {
      return Promise.reject(
        new ProjectCopyNodeUnavailableError(environmentId, "Reconnecting to the device."),
      );
    }
    return call(entry.node.api, entry.connectionLost);
  };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        deps.clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = deps.setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done, { once: true });
    });

  const readServerConfig = async (environmentId: EnvironmentId): Promise<ServerConfig | null> => {
    const cached = deps.readCachedConfig(environmentId);
    if (cached) return cached;
    const entry = held.get(environmentId);
    const api = entry && entry.node.isConnected() ? entry.node.api : deps.readApi(environmentId);
    const getConfig = api?.server?.getConfig;
    if (!getConfig) return null;
    try {
      return await getConfig();
    } catch (error) {
      console.warn(errorMessage(error, "Reading the device's settings failed."));
      return null;
    }
  };

  return {
    acquireNode: acquireNodeHandle,
    withLease,
    withNode,
    now: deps.now,
    uuid: deps.uuid,
    sleep,
    readServerConfig,
    dispose: () => {
      for (const release of Array.from(releases)) release();
      held.clear();
    },
  };
}

/**
 * Runs one read against a node outside a copy's own holds (a resumed Agent
 * Control report reading how the copy's import ended): holds the node only to
 * follow it, with no mutation lease, runs `call` and releases it.
 */
export async function callNodeToRead<T>(
  environmentId: EnvironmentId,
  call: (api: EnvironmentApi) => Promise<T>,
  options: {
    readonly copyId: string;
    readonly signal?: AbortSignal;
    readonly acquire: ProjectCopyNodeAcquire;
  },
): Promise<T> {
  const node = await options.acquire(environmentId, {
    copyId: options.copyId,
    signal: options.signal ?? new AbortController().signal,
    purpose: "follow",
  });
  try {
    return await call(node.api);
  } finally {
    node.release();
  }
}

/**
 * Runs one write against a node outside a copy's own holds (an Agent Control
 * report to the agent's node): acquires it for `copyId`, runs `call` under the
 * lease and releases it. A lease lost before the call went out acquires again,
 * up to `attempts` times.
 */
export async function callNodeWithLease<T>(
  environmentId: EnvironmentId,
  call: (api: EnvironmentApi) => Promise<T>,
  options: {
    readonly copyId: string;
    readonly signal?: AbortSignal;
    readonly attempts?: number;
    readonly acquire: ProjectCopyNodeAcquire;
  },
): Promise<T> {
  const acquire = options.acquire;
  const attempts = Math.max(1, options.attempts ?? 3);
  const signal = options.signal ?? new AbortController().signal;
  for (let attempt = 1; ; attempt += 1) {
    const node = await acquire(environmentId, {
      copyId: options.copyId,
      signal,
      purpose: "copy",
    });
    try {
      return await node.withLease(call);
    } catch (error) {
      if (!isNodeLeaseLostError(error) || attempt >= attempts) throw error;
    } finally {
      node.release();
    }
  }
}
