import type { ThreadId } from "@ryco/contracts";
import type {
  ThreadReadCacheShellResponse,
  ThreadReadCacheThreadResponse,
} from "@ryco/contracts/thread-read-cache";
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
  readonly readShell: (
    nodeId: string,
    signal: AbortSignal,
  ) => Promise<ThreadReadCacheShellResponse>;
  readonly readThread: (
    nodeId: string,
    threadId: string,
    signal: AbortSignal,
  ) => Promise<ThreadReadCacheThreadResponse>;
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
    ports.applySnapshot(node, response, contents);
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
        .readShell(node.id, controller.signal)
        .then((response) => {
          const previous = shells.get(node.id);
          if (
            !current(node, epoch, controller.signal) ||
            !newerOrEqual(response, previous) ||
            (previous?.generation === response.generation &&
              previous.revision === response.revision)
          )
            return;
          shells.set(node.id, response);
          apply(node);
        })
        // Missing caches and older Hubs fall back to the existing node path.
        .catch(() => undefined)
        .finally(() => {
          if (requests.get(key) === controller) requests.delete(key);
          if (epoch === requestEpoch) activeShellRequests--;
          if (
            version !== invalidationVersion &&
            current(node, epoch, controller.signal) &&
            !queue.some((entry) => entry.id === node.id)
          )
            queue.push(node);
          pump();
        });
    }
  };
  const refreshShells = () => {
    nextShellRefresh = ports.now() + SHELL_REFRESH_MS;
    const routedNodeId = ports.readRoute().nodeId;
    const nodes = eligibleNodes().toSorted(
      (left, right) => Number(right.id === routedNodeId) - Number(left.id === routedNodeId),
    );
    for (const node of nodes) {
      if (!queue.some((queued) => queued.id === node.id) && !requests.has(`shell:${node.id}`))
        queue.push(node);
    }
    pump();
  };
  const refreshThread = () => {
    if (disposed) return;
    const route = ports.readRoute();
    const node = eligibleNodes().find((entry) => entry.id === route.nodeId);
    const threadId = route.threadId;
    if (!node || route.environmentId !== node.environmentId || threadId === null) return;
    const key = `thread:${node.id}:${threadId}`;
    if (requests.has(key)) return;
    threadInvalidated = false;
    const controller = new AbortController();
    const epoch = requestEpoch;
    const version = invalidationVersion;
    requests.set(key, controller);
    void ports
      .readThread(node.id, threadId, controller.signal)
      .then((response) => {
        if (!current(node, epoch, controller.signal) || response.threadId !== threadId) return;
        const previous = details.get(node.id)?.get(response.threadId);
        if (
          !newerOrEqual(response, previous) ||
          (previous?.generation === response.generation && previous.revision === response.revision)
        )
          return;
        const content = details.get(node.id) ?? new Map<ThreadId, ThreadReadCacheThreadResponse>();
        content.delete(response.threadId);
        content.set(response.threadId, response);
        while (content.size > 32) content.delete(content.keys().next().value!);
        details.set(node.id, content);
        apply(node);
        if ((shells.get(node.id)?.generation ?? -1) < response.generation) refreshShells();
      })
      .catch(() => undefined)
      .finally(() => {
        if (requests.get(key) === controller) requests.delete(key);
        if (version !== invalidationVersion && current(node, epoch, controller.signal))
          refreshThread();
      });
  };
  const abort = () => {
    requestEpoch++;
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    queue.length = 0;
    activeShellRequests = 0;
  };
  const reconcile = () => {
    if (disposed) return;
    const state = ports.readState();
    const nextAccountKey =
      state.accountStatus === "authenticated" && state.account
        ? JSON.stringify([state.account.id, state.session?.id, state.session?.activeSpaceId])
        : null;
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
      for (const [key, controller] of requests) {
        if (!key.startsWith("thread:")) continue;
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
    abort();
    unsubscribeState();
    unsubscribeRoute();
    unsubscribeInvalidation?.();
    unsubscribeVisibility?.();
    unsubscribeProjection?.();
    ports.clearInterval(timer);
  };
}
