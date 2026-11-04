import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";

import {
  UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS,
  type WorkspaceConnectionScope,
} from "../workspace/connectionDemand.js";
import type { NodeCatalogEntry, NodeTransport } from "./types.js";

/**
 * Acquiring a node for a cross-node project copy: hold it with a scope no
 * other demand may displace, wait for its connection (and, through the Hub,
 * its mutation lease), and hand out calls only while that connection and
 * lease are still the ones acquired. Platforms supply the ports; the policy
 * (budget, renewal, cleanup, generation checks) lives here once.
 */

/** How long an acquisition may take before it gives up. */
export const NODE_ACQUIRE_TIMEOUT_MS = 30_000;
/** The held scope is renewed at half its lease, so one missed renewal never lets it lapse. */
export const NODE_SCOPE_RENEW_INTERVAL_MS = UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS / 2;
/** A timed-out acquisition's message when the platform has no better one. */
export const NODE_ACQUIRE_TIMEOUT_MESSAGE =
  "All connections are in use; close a view on another device";
/** What a `project-copy` scope's `copyId` may be (a UUID, for one). */
export const PROJECT_COPY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
/** Pause between attempts when a connection was replaced while it was being awaited. */
const NODE_ACQUIRE_RETRY_DELAY_MS = 250;

export type ProjectCopyConnectionScope = Extract<
  WorkspaceConnectionScope,
  { readonly type: "project-copy" }
>;

export type NodeAcquireFailure = "timeout" | "cancelled";

/** The acquisition ran out of time or was cancelled; its scope is already released. */
export class NodeAcquireError extends Error {
  readonly environmentId: EnvironmentId;
  readonly failure: NodeAcquireFailure;

  constructor(
    environmentId: EnvironmentId,
    failure: NodeAcquireFailure,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "NodeAcquireError";
    this.environmentId = environmentId;
    this.failure = failure;
  }
}

/**
 * The node's connection or mutation lease is no longer the one acquired (a
 * reconnect, a relay renewal) or the hold was released. Nothing was sent: the
 * caller pauses, acquires the node again and resumes with the same ids.
 */
export class NodeLeaseLostError extends Error {
  readonly environmentId: EnvironmentId;

  constructor(environmentId: EnvironmentId, label: string) {
    super(`Reconnecting to ${label}`);
    this.name = "NodeLeaseLostError";
    this.environmentId = environmentId;
  }
}

export function isNodeLeaseLostError(error: unknown): error is NodeLeaseLostError {
  return error instanceof NodeLeaseLostError;
}

/**
 * Why this client can't hold `node` to write a copy there, or null when it can
 * try. A reachable node that refuses changes stays refused once connected; an
 * offline or connecting one is worth connecting to find out. Through the Hub,
 * writes need the node's mutation lease, which only an owner gets. Acquiring a
 * node for a copy and offering to run an Agent Control copy apply this one rule.
 */
export function projectCopyNodeRefusal(
  node: Pick<NodeCatalogEntry, "label" | "canMutate" | "presence" | "mutateBlockedReason">,
  access: { readonly hosted: boolean; readonly owner: boolean },
): string | null {
  if (!node.canMutate && node.presence === "online") {
    return node.mutateBlockedReason ?? `${node.label} is not available right now`;
  }
  if (access.hosted && !access.owner) {
    return `Copying projects with ${node.label} needs owner access to it`;
  }
  return null;
}

/** A retained connection scope. `renew`, when present, is called every {@link NODE_SCOPE_RENEW_INTERVAL_MS}. */
export interface NodeScopeHold {
  readonly release: () => void;
  readonly renew?: () => void;
}

export interface NodeAcquireConnection {
  readonly api: EnvironmentApi;
  /** Whether this is still the node's connection; a replaced one is never called through. */
  readonly isCurrent: () => boolean;
}

export interface NodeAcquirePorts {
  readonly transport: NodeTransport;
  /** Retains the non-preemptible scope that keeps the node connected while the copy needs it. */
  readonly retain: (scope: ProjectCopyConnectionScope) => NodeScopeHold;
  /**
   * Resolves with the node's connection once it is bootstrapped, waking it when
   * nothing else does. Rejects on a failure no wait can fix (a refused
   * credential); otherwise waits, and stops when `signal` aborts.
   */
  readonly connect: (signal: AbortSignal) => Promise<NodeAcquireConnection>;
  /**
   * Hub connections only: resolves once the node grants a mutation lease, with
   * a check of whether that lease is still current. Direct connections have
   * no lease; their connection's identity is the whole check.
   */
  readonly awaitMutationLease?: (signal: AbortSignal) => Promise<() => boolean>;
  /** The message a timed-out acquisition fails with; {@link NODE_ACQUIRE_TIMEOUT_MESSAGE} by default. */
  readonly timeoutMessage?: () => string;
}

export interface NodeAcquireTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

const GLOBAL_TIMERS: NodeAcquireTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** A node held for a copy. Release it once the copy no longer needs it there. */
export interface AcquiredNode {
  readonly environmentId: EnvironmentId;
  /** For reads. Calls that change the node go through {@link AcquiredNode.withLease}. */
  readonly api: EnvironmentApi;
  readonly transport: NodeTransport;
  /** Whether the acquired connection and lease are still current and the hold is not released. */
  readonly isCurrent: () => boolean;
  /**
   * Whether the acquired connection is still current and the hold is not
   * released, whatever its lease: reads and subscriptions need no lease.
   */
  readonly isConnected: () => boolean;
  /**
   * Runs `call` only while the acquired connection and lease are current;
   * otherwise fails with {@link NodeLeaseLostError} without calling.
   */
  readonly withLease: <A>(call: (api: EnvironmentApi) => Promise<A>) => Promise<A>;
  /** Releases the held scope. Idempotent. */
  readonly release: () => void;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function untilAborted<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function delay(ms: number, signal: AbortSignal, timers: NodeAcquireTimers): Promise<void> {
  return untilAborted(
    new Promise<void>((resolve) => {
      timers.setTimeout(resolve, ms);
    }),
    signal,
  );
}

/**
 * Holds the node for one copy and resolves once it can be written to. The
 * scope is `{ type: "project-copy", copyId }`, so acquiring the same node for
 * the same copy again joins the hold. Fails after `timeoutMs` (the platform's
 * timeout message) or when `signal` aborts; either way the scope is released.
 */
export async function acquireNodeConnection(input: {
  readonly environmentId: EnvironmentId;
  readonly copyId: string;
  /** Names the node in the lease-lost message. */
  readonly label: string;
  readonly ports: NodeAcquirePorts;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly timers?: NodeAcquireTimers;
}): Promise<AcquiredNode> {
  const { environmentId, ports } = input;
  // It travels in scope keys and through Desktop's preload, which accept only this shape.
  if (!PROJECT_COPY_ID_PATTERN.test(input.copyId)) {
    throw new TypeError("A copy id is 1-128 letters, digits, '_' or '-'.");
  }
  const timers = input.timers ?? GLOBAL_TIMERS;
  const hold = ports.retain({ type: "project-copy", copyId: input.copyId });
  let released = false;
  let renewal: unknown = null;
  const scheduleRenewal = () => {
    if (released || !hold.renew) return;
    renewal = timers.setTimeout(() => {
      renewal = null;
      if (released) return;
      hold.renew?.();
      scheduleRenewal();
    }, NODE_SCOPE_RENEW_INTERVAL_MS);
  };
  scheduleRenewal();
  const release = () => {
    if (released) return;
    released = true;
    if (renewal !== null) timers.clearTimeout(renewal);
    renewal = null;
    hold.release();
  };

  const attempt = new AbortController();
  let timedOut = false;
  const deadline = timers.setTimeout(() => {
    timedOut = true;
    attempt.abort();
  }, input.timeoutMs ?? NODE_ACQUIRE_TIMEOUT_MS);
  const cancel = () => attempt.abort();
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) attempt.abort();

  try {
    for (;;) {
      const connection = await untilAborted(ports.connect(attempt.signal), attempt.signal);
      const leaseIsCurrent = ports.awaitMutationLease
        ? await untilAborted(ports.awaitMutationLease(attempt.signal), attempt.signal)
        : () => true;
      // The connection may have been replaced while the lease was awaited.
      if (connection.isCurrent() && leaseIsCurrent()) {
        const isConnected = () => !released && connection.isCurrent();
        const isCurrent = () => isConnected() && leaseIsCurrent();
        return {
          environmentId,
          api: connection.api,
          transport: ports.transport,
          isCurrent,
          isConnected,
          withLease: (call) =>
            isCurrent()
              ? call(connection.api)
              : Promise.reject(new NodeLeaseLostError(environmentId, input.label)),
          release,
        };
      }
      await delay(NODE_ACQUIRE_RETRY_DELAY_MS, attempt.signal, timers);
    }
  } catch (error) {
    release();
    if (timedOut) {
      throw new NodeAcquireError(
        environmentId,
        "timeout",
        ports.timeoutMessage?.() ?? NODE_ACQUIRE_TIMEOUT_MESSAGE,
        { cause: error },
      );
    }
    if (attempt.signal.aborted) {
      throw new NodeAcquireError(environmentId, "cancelled", "Cancelled", { cause: error });
    }
    throw error;
  } finally {
    timers.clearTimeout(deadline);
    input.signal?.removeEventListener("abort", cancel);
  }
}
