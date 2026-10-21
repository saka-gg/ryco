import type { ThreadId } from "@ryco/contracts";
import type {
  ThreadReadCacheShellResponse,
  ThreadReadCacheThreadResponse,
} from "@ryco/contracts/thread-read-cache";
import { recordEnvironmentShellSettlementPolicy } from "../rpc/environmentServerConfigs.ts";
import type { HostedThreadCacheVersion } from "./api.ts";
import type { HostedHubState } from "./state.ts";
import type { HostedHubNode } from "./types.ts";

/** A platform's current read target; route decoding belongs to its adapter. */
export interface HostedThreadReadCacheRoute {
  readonly nodeId: string | null;
  readonly environmentId: string | null;
  readonly threadId: string | null;
}

const SHELL_REFRESH_MS = 30_000;
const THREAD_REFRESH_MS = 15_000;
const MAX_SHELL_REQUESTS = 3;

export interface HostedThreadReadCachePorts {
  readonly readState: () => HostedHubState;
  readonly subscribeState: (listener: () => void) => () => void;
  readonly readRoute: () => HostedThreadReadCacheRoute;
  readonly subscribeRoute: (listener: () => void) => () => void;
  /** Account-scoped Hub subscription. Notifications contain no thread content. */
  readonly subscribeInvalidation?: (listener: () => void) => () => void;
  readonly isSubscriptionOnline?: () => boolean;
  /** A retained live projection became eligible for display-only cache fill. */
  readonly subscribeProjection?: (listener: () => void) => () => void;
  readonly subscribeVisibility?: (listener: () => void) => () => void;
  /**
   * With `held`, a conditional read: `null` means the Hub still stores that
   * version. A Hub without conditional reads answers with the body.
   */
  readonly readShell: (
    nodeId: string,
    signal: AbortSignal,
    held?: HostedThreadCacheVersion,
  ) => Promise<ThreadReadCacheShellResponse | null>;
  readonly readThread: (
    nodeId: string,
    threadId: string,
    signal: AbortSignal,
    held?: HostedThreadCacheVersion,
  ) => Promise<ThreadReadCacheThreadResponse | null>;
  /**
   * The owner's access check is in flight and has not answered yet. While it
   * is, the routed thread's cached shell and thread are read beside it and held
   * unapplied; see {@link RoutedPrefetch}.
   */
  readonly isAccessPending?: () => boolean;
  /**
   * The nodes whose cached shell read is in flight changed. A node's shell
   * that is about to land makes waking it over the relay unnecessary.
   */
  readonly onShellReadsChanged?: (nodeIds: ReadonlySet<string>) => void;
  readonly isVisible: () => boolean;
  readonly now: () => number;
  readonly setInterval: (callback: () => void, delay: number) => unknown;
  readonly clearInterval: (timer: unknown) => void;
  readonly applySnapshot: (
    node: HostedHubNode,
    shell: ThreadReadCacheShellResponse,
    details: ReadonlyMap<ThreadId, ThreadReadCacheThreadResponse>,
  ) => void;
}

function newerOrEqual(
  next: { generation: number; revision: number },
  previous: { generation: number; revision: number } | undefined,
): boolean {
  return (
    !previous ||
    next.generation > previous.generation ||
    (next.generation === previous.generation && next.revision >= previous.revision)
  );
}

function sameVersion(
  next: { generation: number; revision: number },
  previous: { generation: number; revision: number } | undefined,
): boolean {
  return previous?.generation === next.generation && previous.revision === next.revision;
}

interface PrefetchPart<T> {
  readonly controller: AbortController;
  /** `undefined` while pending, `null` when the read failed or was refused. */
  result: T | null | undefined;
}

/**
 * The routed node's cached shell and thread, read beside the access check and
 * the directory instead of after them.
 *
 * A thread only paints together with its node's shell, so both are read. The
 * bodies are held, never applied by themselves: they are adopted only once the
 * session has validated (bound to the first authenticated account they meet,
 * dropped if that account changes or the check ends without one) and the
 * directory lists the node, eligible, with the same environment. Anything else
 * aborts them. The Hub authorizes each read on its own, and the cache stays
 * display-only either way.
 */
interface RoutedPrefetch {
  readonly nodeId: string;
  readonly environmentId: string;
  readonly threadId: ThreadId;
  accountKey: string | null;
  readonly shell: PrefetchPart<ThreadReadCacheShellResponse>;
  readonly thread: PrefetchPart<ThreadReadCacheThreadResponse>;
  /** Set once adopted: completions then commit like any other read. */
  adopted: {
    readonly node: HostedHubNode;
    readonly epoch: number;
    readonly version: number;
  } | null;
}

/** Hub display snapshots never establish relay readiness or a replay cursor. */
export function startHostedThreadReadCache(ports: HostedThreadReadCachePorts): () => void {
  let disposed = false;
  let accountKey: string | null = null;
  let admissionKey = "";
  let requestEpoch = 0;
  let nextShellRefresh = 0;
  let routeKey = "";
  let activeShellRequests = 0;
  let invalidationVersion = 0;
  let threadInvalidated = false;
  let projectionInvalidated = false;
  const shells = new Map<string, ThreadReadCacheShellResponse>();
  const details = new Map<string, Map<ThreadId, ThreadReadCacheThreadResponse>>();
  const requests = new Map<string, AbortController>();
  const queue: HostedHubNode[] = [];
  let prefetch: RoutedPrefetch | null = null;
  /** A read an adopted prefetch already answered; the next refresh skips it once. */
  let adoptedShellNodeId: string | null = null;
  let adoptedThreadKey: string | null = null;
  let shellReadsKey = "";

  const eligibleNodes = () => {
    const state = ports.readState();
    return state.accountStatus === "authenticated" &&
      state.directoryStatus === "ready" &&
      (state.browserStatus === "current" || state.browserStatus === "synchronizing")
      ? state.nodes.filter(
          (node) =>
            !node.revokedAt &&
            !node.capabilities?.nativeClientRequired &&
            !(
              node.id === state.selectedNode?.id &&
              (state.selectionStatus === "revoked" ||
                state.selectionStatus === "authorization-removed")
            ),
        )
      : [];
  };
  const current = (node: HostedHubNode, epoch: number, signal: AbortSignal) =>
    !disposed &&
    !signal.aborted &&
    epoch === requestEpoch &&
    eligibleNodes().some(
      (candidate) => candidate.id === node.id && candidate.environmentId === node.environmentId,
    );
  const apply = (node: HostedHubNode) => {
    const response = shells.get(node.id);
    if (!response) return;
    const contents = new Map<ThreadId, ThreadReadCacheThreadResponse>();
    for (const [threadId, detail] of details.get(node.id) ?? []) {
      if (detail.generation === response.generation) contents.set(threadId, detail);
    }
    // A cold node's rows are listed by its own settlement rule (display only).
    recordEnvironmentShellSettlementPolicy(node.environmentId, response.snapshot.settlementPolicy);
    ports.applySnapshot(node, response, contents);
  };
  /** Nodes with a cached shell read in flight, for discovery to wait on. */
  const notifyShellReads = () => {
    if (!ports.onShellReadsChanged) return;
    const nodeIds = new Set<string>();
    for (const key of requests.keys()) {
      if (key.startsWith("shell:")) nodeIds.add(key.slice("shell:".length));
    }
    for (const node of queue) nodeIds.add(node.id);
    const next = [...nodeIds].toSorted().join(",");
    if (next === shellReadsKey) return;
    shellReadsKey = next;
    ports.onShellReadsChanged(nodeIds);
  };
  const commitShell = (
    node: HostedHubNode,
    epoch: number,
    signal: AbortSignal,
    response: ThreadReadCacheShellResponse | null,
  ) => {
    // `null`: the Hub still stores the version this read presented.
    if (response === null || !current(node, epoch, signal)) return;
    const previous = shells.get(node.id);
    if (!newerOrEqual(response, previous) || sameVersion(response, previous)) return;
    shells.set(node.id, response);
    apply(node);
  };
  const commitThread = (
    node: HostedHubNode,
    threadId: ThreadId,
    epoch: number,
    signal: AbortSignal,
    response: ThreadReadCacheThreadResponse | null,
  ) => {
    if (response === null || !current(node, epoch, signal) || response.threadId !== threadId)
      return;
    const previous = details.get(node.id)?.get(response.threadId);
    if (!newerOrEqual(response, previous) || sameVersion(response, previous)) return;
    const content = details.get(node.id) ?? new Map<ThreadId, ThreadReadCacheThreadResponse>();
    content.delete(response.threadId);
    content.set(response.threadId, response);
    while (content.size > 32) content.delete(content.keys().next().value!);
    details.set(node.id, content);
    apply(node);
    if ((shells.get(node.id)?.generation ?? -1) < response.generation) refreshShells();
  };
  /** An invalidation crossed this read: it is read again once it finishes. */
  const followUpShell = (
    node: HostedHubNode,
    epoch: number,
    version: number,
    signal: AbortSignal,
  ) => {
    if (
      version !== invalidationVersion &&
      current(node, epoch, signal) &&
      !queue.some((entry) => entry.id === node.id)
    )
      queue.push(node);
  };
  const pump = () => {
    while (activeShellRequests < MAX_SHELL_REQUESTS && queue.length > 0) {
      if (disposed) return;
      const node = queue.shift()!;
      const key = `shell:${node.id}`;
      if (requests.has(key)) continue;
      const controller = new AbortController();
      const epoch = requestEpoch;
      const version = invalidationVersion;
      requests.set(key, controller);
      activeShellRequests++;
      void ports
        .readShell(node.id, controller.signal, shells.get(node.id))
        .then((response) => commitShell(node, epoch, controller.signal, response))
        // Missing caches and older Hubs fall back to the existing node path.
        .catch(() => undefined)
        .finally(() => {
          if (requests.get(key) === controller) requests.delete(key);
          if (epoch === requestEpoch) activeShellRequests--;
          followUpShell(node, epoch, version, controller.signal);
          pump();
          notifyShellReads();
        });
    }
    notifyShellReads();
  };
  const refreshShells = () => {
    nextShellRefresh = ports.now() + SHELL_REFRESH_MS;
    const routedNodeId = ports.readRoute().nodeId;
    const nodes = eligibleNodes().toSorted(
      (left, right) => Number(right.id === routedNodeId) - Number(left.id === routedNodeId),
    );
    const adopted = adoptedShellNodeId;
    adoptedShellNodeId = null;
    for (const node of nodes) {
      if (node.id === adopted) continue;
      if (!queue.some((queued) => queued.id === node.id) && !requests.has(`shell:${node.id}`))
        queue.push(node);
    }
    pump();
  };
  const refreshThread = () => {
    if (disposed) return;
    const route = ports.readRoute();
    const node = eligibleNodes().find((entry) => entry.id === route.nodeId);
    const threadId = route.threadId as ThreadId | null;
    if (!node || route.environmentId !== node.environmentId || threadId === null) return;
    const key = `thread:${node.id}:${threadId}`;
    if (adoptedThreadKey === key && !threadInvalidated) {
      adoptedThreadKey = null;
      return;
    }
    adoptedThreadKey = null;
    if (requests.has(key)) return;
    threadInvalidated = false;
    const controller = new AbortController();
    const epoch = requestEpoch;
    const version = invalidationVersion;
    requests.set(key, controller);
    void ports
      .readThread(node.id, threadId, controller.signal, details.get(node.id)?.get(threadId))
      .then((response) => commitThread(node, threadId, epoch, controller.signal, response))
      .catch(() => undefined)
      .finally(() => {
        if (requests.get(key) === controller) requests.delete(key);
        if (version !== invalidationVersion && current(node, epoch, controller.signal))
          refreshThread();
      });
  };
  const discardPrefetch = () => {
    const held = prefetch;
    prefetch = null;
    if (!held) return;
    held.shell.controller.abort();
    held.thread.controller.abort();
  };
  /** The prefetch's account binding, the route and the access check still hold. */
  const reconcilePrefetch = (state: HostedHubState, nextAccountKey: string | null) => {
    const held = prefetch;
    if (!held || held.adopted) return;
    const route = ports.readRoute();
    if (
      route.nodeId !== held.nodeId ||
      route.environmentId !== held.environmentId ||
      route.threadId !== held.threadId
    ) {
      discardPrefetch();
      return;
    }
    if (state.accountStatus === "authenticated") {
      if (held.accountKey === null) held.accountKey = nextAccountKey;
      else if (held.accountKey !== nextAccountKey) discardPrefetch();
      return;
    }
    // The check answered without a session, or another account operation
    // replaced it: what the reads were sent with is no longer this browser's.
    if (held.accountKey !== null || ports.isAccessPending?.() !== true) discardPrefetch();
  };
  const startPrefetch = (state: HostedHubState) => {
    if (prefetch || disposed || !ports.isVisible()) return;
    const route = ports.readRoute();
    if (route.nodeId === null || route.environmentId === null || route.threadId === null) return;
    // Only before the routed node can be read the ordinary way.
    const awaitingAccess =
      state.accountStatus !== "authenticated" && ports.isAccessPending?.() === true;
    const awaitingDirectory =
      state.accountStatus === "authenticated" &&
      state.account !== null &&
      state.directoryStatus !== "ready" &&
      state.directoryStatus !== "stale";
    if (!awaitingAccess && !awaitingDirectory) return;
    const nodeId = route.nodeId;
    const threadId = route.threadId as ThreadId;
    const held: RoutedPrefetch = {
      nodeId,
      environmentId: route.environmentId,
      threadId,
      accountKey: awaitingDirectory ? accountKey : null,
      shell: { controller: new AbortController(), result: undefined },
      thread: { controller: new AbortController(), result: undefined },
      adopted: null,
    };
    prefetch = held;
    /** A held read that finished after its check answered without a session is dropped. */
    const orphaned = () =>
      prefetch === held &&
      ports.readState().accountStatus !== "authenticated" &&
      ports.isAccessPending?.() !== true;
    const settleShell = (result: ThreadReadCacheShellResponse | null) => {
      held.shell.result = result;
      const adopted = held.adopted;
      if (!adopted) {
        if (orphaned()) discardPrefetch();
        return;
      }
      const key = `shell:${nodeId}`;
      if (requests.get(key) === held.shell.controller) requests.delete(key);
      commitShell(adopted.node, adopted.epoch, held.shell.controller.signal, result);
      followUpShell(adopted.node, adopted.epoch, adopted.version, held.shell.controller.signal);
      pump();
    };
    const settleThread = (result: ThreadReadCacheThreadResponse | null) => {
      held.thread.result = result;
      const adopted = held.adopted;
      if (!adopted) {
        if (orphaned()) discardPrefetch();
        return;
      }
      const key = `thread:${nodeId}:${threadId}`;
      if (requests.get(key) === held.thread.controller) requests.delete(key);
      commitThread(adopted.node, threadId, adopted.epoch, held.thread.controller.signal, result);
      if (
        adopted.version !== invalidationVersion &&
        current(adopted.node, adopted.epoch, held.thread.controller.signal)
      )
        refreshThread();
    };
    void ports
      .readShell(nodeId, held.shell.controller.signal)
      .then(settleShell, () => settleShell(null));
    void ports
      .readThread(nodeId, threadId, held.thread.controller.signal)
      .then(settleThread, () => settleThread(null));
  };
  /**
   * Hand a validated prefetch to the ordinary reads: a finished part commits
   * now, a pending one is registered as that read in flight, so neither is
   * sent a second time.
   */
  const adoptPrefetch = (eligible: ReadonlyArray<HostedHubNode>) => {
    const held = prefetch;
    if (!held || held.adopted) return;
    const node = eligible.find((candidate) => candidate.id === held.nodeId);
    if (!node || node.environmentId !== held.environmentId || held.accountKey !== accountKey) {
      discardPrefetch();
      return;
    }
    prefetch = null;
    held.adopted = { node, epoch: requestEpoch, version: invalidationVersion };
    const shellKey = `shell:${node.id}`;
    const threadKey = `thread:${node.id}:${held.threadId}`;
    // A pending part is registered as that read in flight; a finished one
    // commits now and is not read again by the refresh that follows. A failed
    // part is read again the ordinary way.
    if (held.shell.result === undefined) requests.set(shellKey, held.shell.controller);
    else if (held.shell.result !== null) {
      commitShell(node, requestEpoch, held.shell.controller.signal, held.shell.result);
      adoptedShellNodeId = node.id;
    }
    if (held.thread.result === undefined) requests.set(threadKey, held.thread.controller);
    else if (held.thread.result !== null) {
      commitThread(
        node,
        held.threadId,
        requestEpoch,
        held.thread.controller.signal,
        held.thread.result,
      );
      adoptedThreadKey = threadKey;
    }
    notifyShellReads();
  };
  const abort = () => {
    requestEpoch++;
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    queue.length = 0;
    activeShellRequests = 0;
    adoptedShellNodeId = null;
    adoptedThreadKey = null;
    notifyShellReads();
  };
  const reconcile = () => {
    if (disposed) return;
    const state = ports.readState();
    const nextAccountKey =
      state.accountStatus === "authenticated" && state.account
        ? JSON.stringify([state.account.id, state.session?.id, state.session?.activeSpaceId])
        : null;
    reconcilePrefetch(state, nextAccountKey);
    if (nextAccountKey !== accountKey) {
      abort();
      shells.clear();
      details.clear();
      accountKey = nextAccountKey;
    }
    const eligible = eligibleNodes();
    const nextAdmissionKey = JSON.stringify([
      accountKey,
      eligible.map((node) => [node.id, node.environmentId, node.effectiveRole]),
    ]);
    if (admissionKey !== nextAdmissionKey) {
      admissionKey = nextAdmissionKey;
      abort();
      for (const nodeId of new Set([...shells.keys(), ...details.keys()])) {
        if (eligible.some((node) => node.id === nodeId)) continue;
        shells.delete(nodeId);
        details.delete(nodeId);
      }
      nextShellRefresh = 0;
      routeKey = "";
    }
    if (eligible.length > 0) adoptPrefetch(eligible);
    else startPrefetch(state);
    if (!ports.isVisible()) return;
    if (projectionInvalidated) {
      projectionInvalidated = false;
      const node = eligible.find((candidate) => candidate.id === ports.readRoute().nodeId);
      if (node) apply(node);
    }
    if (
      nextShellRefresh === 0 ||
      (!ports.isSubscriptionOnline?.() && nextShellRefresh <= ports.now())
    )
      refreshShells();
    const nextRouteKey = JSON.stringify(ports.readRoute());
    if (routeKey !== nextRouteKey) {
      routeKey = nextRouteKey;
      const route = ports.readRoute();
      const routedKey = `thread:${route.nodeId}:${route.threadId}`;
      for (const [key, controller] of requests) {
        // A read already in flight for the routed thread answers for it.
        if (!key.startsWith("thread:") || key === routedKey) continue;
        controller.abort();
        requests.delete(key);
      }
      const routed = eligible.find((node) => node.id === ports.readRoute().nodeId);
      if (routed) apply(routed);
      refreshThread();
    } else if (threadInvalidated) {
      refreshThread();
    }
  };
  const unsubscribeProjection = ports.subscribeProjection?.(() => {
    projectionInvalidated = true;
    reconcile();
  });
  const unsubscribeState = ports.subscribeState(reconcile);
  const unsubscribeRoute = ports.subscribeRoute(reconcile);
  const unsubscribeVisibility = ports.subscribeVisibility?.(reconcile);
  const unsubscribeInvalidation = ports.subscribeInvalidation?.(() => {
    invalidationVersion++;
    adoptedShellNodeId = null;
    nextShellRefresh = 0;
    threadInvalidated = true;
    reconcile();
  });
  const timer = ports.setInterval(() => {
    reconcile();
    if (ports.isVisible() && !ports.isSubscriptionOnline?.()) refreshThread();
  }, THREAD_REFRESH_MS);
  reconcile();
  return () => {
    if (disposed) return;
    disposed = true;
    discardPrefetch();
    abort();
    unsubscribeState();
    unsubscribeRoute();
    unsubscribeInvalidation?.();
    unsubscribeVisibility?.();
    unsubscribeProjection?.();
    ports.clearInterval(timer);
  };
}
