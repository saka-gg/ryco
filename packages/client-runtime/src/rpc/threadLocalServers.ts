import type { EnvironmentApi, ThreadId, ThreadLocalServerList } from "@ryco/contracts";

/**
 * One connection's `threads.subscribeLocalServers` (`EnvironmentApi.threads`).
 * Clients call it only on nodes that advertise `threadLocalServers`.
 */
export type ThreadLocalServersSubscribe = NonNullable<
  NonNullable<EnvironmentApi["threads"]>["subscribeLocalServers"]
>;

type Listener = (list: ThreadLocalServerList) => void;

interface SharedThreadServers {
  readonly listeners: Set<Listener>;
  /** The latest list, for a listener that joins later. */
  latest: ThreadLocalServerList | null;
  stop: () => void;
}

/** One map per connection, so a key is (environment, thread). */
const watchesByConnection = new WeakMap<
  ThreadLocalServersSubscribe,
  Map<ThreadId, SharedThreadServers>
>();

/**
 * The servers one thread started, on one connection. Every view of the same
 * thread shares one subscription (a node caps them per connection, and every
 * subscription keeps the node scanning): it closes with its last listener, and
 * a listener that joins later gets the latest list at once. The transport
 * subscribes again after a reconnect, and the node then sends the current list.
 */
export function watchThreadLocalServers(
  subscribe: ThreadLocalServersSubscribe,
  threadId: ThreadId,
  listener: Listener,
): () => void {
  let watches = watchesByConnection.get(subscribe);
  if (watches === undefined) {
    watches = new Map();
    watchesByConnection.set(subscribe, watches);
  }
  const connectionWatches = watches;
  const release = (watch: SharedThreadServers) => {
    if (!watch.listeners.delete(listener) || watch.listeners.size > 0) return;
    if (connectionWatches.get(threadId) === watch) connectionWatches.delete(threadId);
    watch.stop();
  };
  const existing = watches.get(threadId);
  if (existing !== undefined) {
    existing.listeners.add(listener);
    const latest = existing.latest;
    if (latest !== null) {
      // Not synchronously: the caller is still subscribing.
      void Promise.resolve().then(() => {
        if (existing.listeners.has(listener)) listener(latest);
      });
    }
    return () => release(existing);
  }

  const shared: SharedThreadServers = {
    listeners: new Set([listener]),
    latest: null,
    stop: () => undefined,
  };
  watches.set(threadId, shared);
  shared.stop = subscribe({ threadId }, (list) => {
    shared.latest = list;
    for (const each of Array.from(shared.listeners)) each(list);
  });
  return () => release(shared);
}

/** What to tell the user when `threads.stopLocalServer` failed. */
export function describeThreadLocalServerStopFailure(cause: unknown): string {
  const failure = cause as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  } | null;
  if (failure?._tag !== "ThreadStopLocalServerError") return "The node did not answer. Try again.";
  switch (failure.reason) {
    case "not-found":
      return "It is no longer running.";
    case "identity-changed":
      return "Its process changed since the list was read.";
    case "not-attributed":
      return "It does not belong to this thread.";
    case "shared-group":
      return "It shares its process group with the agent, a terminal or Ryco itself, so stop it where it runs.";
    case "unsupported":
      return "This node cannot stop servers.";
    default:
      return "The node could not stop it.";
  }
}
