import type { EnvironmentId, NodeUpdateInput, NodeUpdateState } from "@ryco/contracts";

import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";
import { isUnsupportedRpcError } from "../../rpc/wsTransport.ts";

/** How long `waitForOutcome` follows a node by default before it reports `unknown`. */
export const NODE_UPDATE_OUTCOME_TIMEOUT_MS = 10 * 60_000;
/** First delay before following a node again after its update stream failed for good. */
export const NODE_UPDATE_RESUBSCRIBE_DELAY_MS = 5_000;
/** Ceiling for that delay as failures repeat. */
export const NODE_UPDATE_RESUBSCRIBE_MAX_DELAY_MS = 5 * 60_000;

export type NodeUpdateOutcome = "succeeded" | "failed" | "postponed" | "unknown";

export interface NodeUpdateOutcomeResult {
  readonly outcome: NodeUpdateOutcome;
  readonly message: string | null;
}

export interface WaitForNodeUpdateOutcomeInput {
  readonly requestId: string;
  readonly targetVersion: string;
  /** Defaults to `NODE_UPDATE_OUTCOME_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type NodeUpdateClient = Pick<WsRpcClient, "server">;

export interface NodeUpdateStore {
  /** Latest state per environment; null when unknown/unsupported/detached. */
  read(environmentId: EnvironmentId): NodeUpdateState | null;
  /** Stable snapshot object that changes identity only when some state changed (for useSyncExternalStore). */
  snapshot(): ReadonlyMap<EnvironmentId, NodeUpdateState>;
  subscribe(listener: () => void): () => void;
  /** Start following one connected environment; returns detach. Re-attaching with a new client replaces the old subscription. */
  attach(environmentId: EnvironmentId, client: NodeUpdateClient): () => void;
  check(environmentId: EnvironmentId): Promise<NodeUpdateState>;
  update(environmentId: EnvironmentId, input: NodeUpdateInput): Promise<NodeUpdateState>;
  /**
   * Resolves with the node's outcome for `requestId`: "succeeded" when the (restarted) node reports
   * run.requestId === requestId with status succeeded, or reports currentVersion === targetVersion;
   * "failed"/"postponed" from the matching run; "unknown" on timeout (default 10 min) or abort.
   */
  waitForOutcome(
    environmentId: EnvironmentId,
    input: WaitForNodeUpdateOutcomeInput,
  ): Promise<NodeUpdateOutcomeResult>;
}

export interface NodeUpdateStoreOptions {
  /** Defaults to `NODE_UPDATE_RESUBSCRIBE_DELAY_MS`. */
  readonly resubscribeDelayMs?: number;
}

/** `check` / `update` on an environment nothing attached. */
export class NodeUpdateNotAttachedError extends Error {
  readonly _tag = "NodeUpdateNotAttachedError";
  readonly environmentId: EnvironmentId;

  constructor(environmentId: EnvironmentId) {
    super("This node isn't connected.");
    this.environmentId = environmentId;
  }
}

/**
 * What `state` says about the update `input` started, or null while it says
 * nothing yet. A run carrying the request's id decides; otherwise a node that
 * came back on the target release succeeded (an older restarted process may
 * not carry the id across).
 */
export function readNodeUpdateOutcome(
  state: NodeUpdateState,
  input: Pick<WaitForNodeUpdateOutcomeInput, "requestId" | "targetVersion">,
): NodeUpdateOutcomeResult | null {
  const run = state.run;
  if (run.requestId === input.requestId) {
    if (run.status === "succeeded") return { outcome: "succeeded", message: run.message };
    if (run.status === "failed") {
      return { outcome: "failed", message: run.message ?? "The update failed." };
    }
    if (run.status === "postponed") {
      return {
        outcome: "postponed",
        message: run.message ?? "Someone at that machine postponed the restart.",
      };
    }
  }
  if (state.currentVersion === input.targetVersion) {
    return { outcome: "succeeded", message: null };
  }
  return null;
}

/** States are small, plain decoded values: their JSON tells whether anything changed. */
function sameState(left: NodeUpdateState, right: NodeUpdateState): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function isAuthRpcError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown })._tag === "AuthRpcError"
  );
}

interface Attachment {
  client: NodeUpdateClient;
  /** Attaches not yet detached, across clients. */
  count: number;
  teardownScheduled: boolean;
  /** Stops the current client's subscription and any pending resubscribe. */
  stopFollowing: () => void;
  /** Bumped by every streamed state, so an RPC answer can tell whether the stream spoke since. */
  streamRevision: number;
}

type Waiter = (state: NodeUpdateState) => void;

/**
 * Follows `server.subscribeNodeUpdate` per attached environment. The transport
 * resubscribes by itself across a dropped socket (a node restarting during its
 * update) and the node sends its current state on every subscription, so the
 * last state stays readable through the gap and the restarted node's report
 * replaces it. A stream that fails for good is followed again after a backoff,
 * unless the node lacks the method or refuses this session; those clear the
 * state. The stream is the authority: an RPC answer is published only when no
 * streamed state arrived while it was out.
 */
export function createNodeUpdateStore(options: NodeUpdateStoreOptions = {}): NodeUpdateStore {
  const baseResubscribeDelayMs = options.resubscribeDelayMs ?? NODE_UPDATE_RESUBSCRIBE_DELAY_MS;
  const states = new Map<EnvironmentId, NodeUpdateState>();
  let snapshot: ReadonlyMap<EnvironmentId, NodeUpdateState> = new Map();
  const listeners = new Set<() => void>();
  const attachments = new Map<EnvironmentId, Attachment>();
  const waiters = new Map<EnvironmentId, Set<Waiter>>();

  const changed = () => {
    snapshot = new Map(states);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One failing listener must not stop the others or the stream.
      }
    }
  };

  const publish = (environmentId: EnvironmentId, state: NodeUpdateState) => {
    const previous = states.get(environmentId);
    if (previous !== undefined && sameState(previous, state)) return;
    states.set(environmentId, state);
    changed();
    const pending = waiters.get(environmentId);
    // A waiter that settles removes itself; a Set iterates safely past that.
    if (pending) for (const waiter of pending) waiter(state);
  };

  const clear = (environmentId: EnvironmentId) => {
    if (states.delete(environmentId)) changed();
  };

  const isCurrent = (environmentId: EnvironmentId, entry: Attachment, client: NodeUpdateClient) =>
    attachments.get(environmentId) === entry && entry.client === client;

  const follow = (environmentId: EnvironmentId, entry: Attachment): (() => void) => {
    const client = entry.client;
    let stopped = false;
    let unsubscribe: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const start = () => {
      retryTimer = null;
      if (stopped) return;
      let failure: "unsupported" | "forbidden" | "failed" = "failed";
      unsubscribe = client.server.subscribeNodeUpdate(
        (state) => {
          if (stopped || !isCurrent(environmentId, entry, client)) return;
          consecutiveFailures = 0;
          entry.streamRevision += 1;
          publish(environmentId, state);
        },
        {
          classifyFailure: (error) => {
            failure = isUnsupportedRpcError(error)
              ? "unsupported"
              : isAuthRpcError(error)
                ? "forbidden"
                : "failed";
            return failure === "unsupported" ? "unsupported" : "failed";
          },
          onError: () => {
            unsubscribe = null;
            if (stopped || !isCurrent(environmentId, entry, client)) return;
            if (failure !== "failed") {
              // An older node or a session it refuses: nothing to follow on this client.
              clear(environmentId);
              return;
            }
            const delay = Math.min(
              Math.max(baseResubscribeDelayMs, 1) * 2 ** Math.min(consecutiveFailures, 16),
              NODE_UPDATE_RESUBSCRIBE_MAX_DELAY_MS,
            );
            consecutiveFailures += 1;
            retryTimer = setTimeout(start, delay);
          },
        },
      );
    };

    start();
    return () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      unsubscribe?.();
      unsubscribe = null;
    };
  };

  const attach = (environmentId: EnvironmentId, client: NodeUpdateClient): (() => void) => {
    let entry = attachments.get(environmentId);
    if (!entry) {
      const created: Attachment = {
        client,
        count: 0,
        teardownScheduled: false,
        stopFollowing: () => undefined,
        streamRevision: 0,
      };
      attachments.set(environmentId, created);
      created.stopFollowing = follow(environmentId, created);
      entry = created;
    } else if (entry.client !== client) {
      // A new connection: follow it instead, keeping the last state until it reports.
      entry.stopFollowing();
      entry.client = client;
      entry.stopFollowing = follow(environmentId, entry);
    }
    entry.count += 1;
    const held = entry;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.count -= 1;
      if (held.count > 0 || held.teardownScheduled) return;
      held.teardownScheduled = true;
      // Deferred, so an effect re-running (detach, then attach) hands the stream over.
      void Promise.resolve().then(() => {
        held.teardownScheduled = false;
        if (held.count > 0 || attachments.get(environmentId) !== held) return;
        attachments.delete(environmentId);
        held.stopFollowing();
        clear(environmentId);
      });
    };
  };

  const call = async (
    environmentId: EnvironmentId,
    run: (client: NodeUpdateClient) => Promise<NodeUpdateState>,
  ): Promise<NodeUpdateState> => {
    const entry = attachments.get(environmentId);
    if (!entry) throw new NodeUpdateNotAttachedError(environmentId);
    const client = entry.client;
    const revision = entry.streamRevision;
    const state = await run(client);
    if (isCurrent(environmentId, entry, client) && entry.streamRevision === revision) {
      publish(environmentId, state);
    }
    return state;
  };

  const waitForOutcome = (
    environmentId: EnvironmentId,
    input: WaitForNodeUpdateOutcomeInput,
  ): Promise<NodeUpdateOutcomeResult> =>
    new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: NodeUpdateOutcomeResult) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        const pending = waiters.get(environmentId);
        pending?.delete(waiter);
        if (pending?.size === 0) waiters.delete(environmentId);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const waiter: Waiter = (state) => {
        const result = readNodeUpdateOutcome(state, input);
        if (result !== null) finish(result);
      };
      const onAbort = () =>
        finish({ outcome: "unknown", message: "Stopped waiting; the node may still finish." });
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      let pending = waiters.get(environmentId);
      if (!pending) {
        pending = new Set();
        waiters.set(environmentId, pending);
      }
      pending.add(waiter);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => finish({ outcome: "unknown", message: "The node did not report back in time." }),
        input.timeoutMs ?? NODE_UPDATE_OUTCOME_TIMEOUT_MS,
      );
      const current = states.get(environmentId);
      if (current !== undefined) waiter(current);
    });

  return {
    read: (environmentId) => states.get(environmentId) ?? null,
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach,
    check: (environmentId) => call(environmentId, (client) => client.server.checkNodeUpdate()),
    update: (environmentId, input) =>
      call(environmentId, (client) => client.server.updateNode(input)),
    waitForOutcome,
  };
}
