import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@ryco/contracts";
import { useEffect, useSyncExternalStore } from "react";

import {
  adoptRoutedHostedNode,
  clearHostedNodeRoute,
  enterHostedNodeRoute,
  getInstalledHostedNodeHistory,
  getRoutedHostedNode,
  leaveHostedNodeRouteToHubDirectory,
  subscribeRoutedHostedNode,
  type RoutedHostedNode,
} from "./nodeRoutes";
import { HUB_ROUTE_TOP_SEGMENTS } from "./hubRoutes";
import {
  HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
  hostedHubController,
  useHostedHubStore,
} from "./state";
import { hasActiveHostedWorkspaceCoordinator } from "./hostedConnectionCoordinator";
import { retainHostedWorkspaceThreadScope } from "./hostedConnectionScopes";
import { selectThreadExistsByRef, useStore } from "../store";
import { canShowHostedReadPreview, readHostedReadCache } from "./readCache";

/**
 * Orchestrates the routed node segment against the hosted lifecycle owner.
 *
 * This module adds no second activation or readiness path: it only decides
 * *when* to invoke the existing controller primitives. A routed node is
 * restored strictly through the ordered fail-closed pipeline — restore Hub
 * session and refresh the authorized directory (existing bootstrap), validate
 * the routed id against the directory, then `selectNode`, which runs the
 * existing activation path (fresh one-use ticket → relay channel → canonical
 * state sync → mutation readiness gates). Routes that cannot be validated
 * fail closed to the node directory with a bounded notice.
 */

export type HostedNodeRouteNoticeKind = "unavailable" | "revoked" | "offline" | "invalid-link";

const HOSTED_NODE_ROUTE_NOTICE_COPY: Record<HostedNodeRouteNoticeKind, string> = {
  unavailable:
    "The node from this link is not in your authorized node directory. Choose a node to continue.",
  revoked: "Access to the node from this link was revoked. Choose a node to continue.",
  offline: "The node from this link is offline. Choose a node to continue.",
  "invalid-link": "This node link is not valid. Choose a node to continue.",
};

let notice: HostedNodeRouteNoticeKind | null = null;
const noticeSubscribers = new Set<() => void>();

function setNotice(next: HostedNodeRouteNoticeKind | null): void {
  if (notice === next) return;
  notice = next;
  // Snapshot so notification survives subscribe/unsubscribe during dispatch.
  for (const subscriber of Array.from(noticeSubscribers)) subscriber();
}

function subscribeNotice(subscriber: () => void): () => void {
  noticeSubscribers.add(subscriber);
  return () => {
    noticeSubscribers.delete(subscriber);
  };
}

export function getHostedNodeRouteNotice(): string | null {
  return notice === null ? null : HOSTED_NODE_ROUTE_NOTICE_COPY[notice];
}

export function useHostedNodeRouteNotice(): string | null {
  return useSyncExternalStore(subscribeNotice, getHostedNodeRouteNotice);
}

export function useRoutedHostedNode(): RoutedHostedNode {
  return useSyncExternalStore(subscribeRoutedHostedNode, getRoutedHostedNode);
}

/**
 * Route segments that can never be a legacy `/$environmentId/$threadId` pair.
 *
 * Includes every segment the Hub website owns. Without them a two-segment Hub
 * address is silently reinterpreted as a thread: `/account/security` matches
 * the legacy pattern exactly and would be adopted as environment `account`,
 * thread `security`. `hubRoutes.test.ts` asserts this set stays a superset of
 * `HUB_ROUTE_TOP_SEGMENTS`, so a Hub route added later cannot reintroduce that
 * hole by omission.
 */
export const RESERVED_TOP_SEGMENTS = new Set([
  "node",
  "draft",
  "pair",
  "diagnostics",
  ...HUB_ROUTE_TOP_SEGMENTS,
]);

function readLegacyThreadEnvironmentId(pathname: string): string | null {
  const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  const raw = match[1] ?? "";
  if (RESERVED_TOP_SEGMENTS.has(raw)) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseHostedScopedThreadPath(pathname: string): ScopedThreadRef | null {
  const match = /^\/([^/]+)\/([^/]+)\/?$/u.exec(pathname);
  if (!match || RESERVED_TOP_SEGMENTS.has(match[1] ?? "")) return null;
  try {
    return {
      environmentId: EnvironmentId.make(decodeURIComponent(match[1] ?? "")),
      threadId: ThreadId.make(decodeURIComponent(match[2] ?? "")),
    };
  } catch {
    return null;
  }
}

function isLegacyDraftPathname(pathname: string): boolean {
  return pathname.startsWith("/draft/");
}

/** Node id whose `selectNode` dispatch is currently in flight. */
let restoreRequestedNodeId: string | null = null;
/** Node id whose current selection was initiated by URL restore (not a click). */
let restoreOriginNodeId: string | null = null;
/** Node id the user just picked interactively (distinguishes failure ownership). */
let interactiveNodeId: string | null = null;
/** Guards compound transitions so reconcile observes only their final state. */
let reconcileSuspended = false;
/** Last observed account status, for clearing stale notices on sign-out. */
let lastAccountStatus: string | null = null;
/** Active orchestrator subscriptions; scheduled runs no-op at zero. */
let activeOrchestratorCount = 0;
let reconcilePending = false;
let routeScopeKey: string | null = null;
let releaseRouteScope: (() => void) | null = null;

function replaceRouteScope(scopedThread: ReturnType<typeof parseHostedScopedThreadPath>): void {
  const nextKey = scopedThread
    ? JSON.stringify([scopedThread.environmentId, scopedThread.threadId])
    : null;
  if (nextKey === routeScopeKey) return;
  releaseRouteScope?.();
  releaseRouteScope = null;
  routeScopeKey = nextKey;
  if (scopedThread) {
    releaseRouteScope = retainHostedWorkspaceThreadScope(
      scopedThread.environmentId,
      scopedThread.threadId,
    );
  }
}

function routeScopeKeyFor(
  scopedThread: ReturnType<typeof parseHostedScopedThreadPath>,
): string | null {
  return scopedThread ? JSON.stringify([scopedThread.environmentId, scopedThread.threadId]) : null;
}

/**
 * Reconcile runs deferred on a microtask. Route publications fire as a side
 * effect of `parseLocation` inside the history's popstate handler, before the
 * history updates its own location closure and notifies subscribers; deferring
 * guarantees every reconcile observes post-notify history state and post-patch
 * store state, and coalesces the bursts a single navigation produces.
 */
function scheduleReconcile(): void {
  if (reconcilePending) return;
  reconcilePending = true;
  queueMicrotask(() => {
    reconcilePending = false;
    if (activeOrchestratorCount === 0) return;
    reconcile();
  });
}

function runExclusive(transition: () => void): void {
  reconcileSuspended = true;
  try {
    transition();
  } finally {
    reconcileSuspended = false;
  }
  scheduleReconcile();
}

function failClosed(
  selectionStatus: ReturnType<typeof useHostedHubStore.getState>["selectionStatus"],
  kind: HostedNodeRouteNoticeKind,
): void {
  restoreRequestedNodeId = null;
  restoreOriginNodeId = null;
  interactiveNodeId = null;
  // When the store already reports a terminal selection state the directory
  // renders its own bounded alert; avoid duplicate messaging.
  if (selectionStatus === "none" || selectionStatus === "online" || selectionStatus === "offline") {
    setNotice(kind);
  }
  clearHostedNodeRoute();
}

function reconcile(): void {
  if (reconcileSuspended) return;
  const history = getInstalledHostedNodeHistory();
  if (!history) return;
  const routed = getRoutedHostedNode();
  const state = useHostedHubStore.getState();

  if (routed.malformed) {
    // A malformed segment can never validate; normalize the URL immediately
    // and explain on the directory once it renders.
    setNotice("invalid-link");
    replaceRouteScope(null);
    clearHostedNodeRoute();
    return;
  }

  if (state.accountStatus !== "authenticated") {
    replaceRouteScope(null);
    // Authentication surfaces own the screen. The routed segment stays in the
    // URL so a re-authenticated session resumes it through this same
    // validation pipeline. A notice from the previous authenticated session
    // is stale once the account leaves it; keep only notices produced while
    // signed out (for example a normalized malformed link).
    if (lastAccountStatus === "authenticated") setNotice(null);
    lastAccountStatus = state.accountStatus;
    return;
  }
  lastAccountStatus = state.accountStatus;

  const nodeId = routed.nodeId;

  if (nodeId === null) {
    interactiveNodeId = null;
    replaceRouteScope(null);
    restoreRequestedNodeId = null;
    restoreOriginNodeId = null;
    if (state.selectedNode && !hasActiveHostedWorkspaceCoordinator()) {
      const terminalSelection =
        state.selectionStatus === "revoked" ||
        state.selectionStatus === "authorization-removed" ||
        state.selectionStatus === "incompatible";
      void hostedHubController.returnToDirectory(
        terminalSelection ? { preserveTerminalSelection: true } : undefined,
      );
      return;
    }
    // Use the logical pathname published together with the segment. Never
    // read history.location here: reconcile can run between a popstate parse
    // and the history's own location update, and a stale thread pathname
    // would be mapped straight back to the node that was just left.
    maybeRedirectLegacyLocation(routed.logicalPathname, state);
    return;
  }

  const scopedThread = parseHostedScopedThreadPath(routed.logicalPathname);
  if (routeScopeKeyFor(scopedThread) !== routeScopeKey) replaceRouteScope(null);
  const directoryNode = state.nodes.find((candidate) => candidate.id === nodeId) ?? null;
  const hasCachedView =
    scopedThread !== null &&
    selectThreadExistsByRef(useStore.getState(), scopedThread) &&
    ((directoryNode?.environmentId === scopedThread.environmentId &&
      directoryNode.revokedAt === null &&
      !directoryNode.capabilities?.nativeClientRequired) ||
      (state.directoryStatus !== "ready" &&
        canShowHostedReadPreview() &&
        readHostedReadCache().nodes.some(
          (node) => node.nodeId === nodeId && node.environmentId === scopedThread.environmentId,
        )));
  if (
    directoryNode &&
    (directoryNode.capabilities?.nativeClientRequired === true ||
      (scopedThread && directoryNode.environmentId !== scopedThread.environmentId))
  ) {
    replaceRouteScope(null);
    failClosed(state.selectionStatus, "unavailable");
    return;
  }
  if (state.selectedNode?.id === nodeId) {
    replaceRouteScope(scopedThread);
    restoreRequestedNodeId = null;
    interactiveNodeId = null;
    if (state.sessionEstablished) {
      restoreOriginNodeId = null;
      setNotice(null);
      return;
    }
    if (
      restoreOriginNodeId === nodeId &&
      state.transportStatus === "terminal-failure" &&
      (state.selectionStatus === "revoked" ||
        state.selectionStatus === "authorization-removed" ||
        state.selectionStatus === "incompatible")
    ) {
      // A URL-initiated restore ended in a terminal authorization or
      // compatibility failure before the session was established: fail closed
      // to the directory, keeping the existing bounded selection alert.
      restoreOriginNodeId = null;
      runExclusive(() => {
        clearHostedNodeRoute();
        void hostedHubController.returnToDirectory({ preserveTerminalSelection: true });
      });
      return;
    }
    if (
      restoreOriginNodeId === nodeId &&
      state.transportStatus === "terminal-failure" &&
      state.selectionStatus === "offline" &&
      state.errorMessage === HOSTED_SESSION_SYNC_FAILURE_MESSAGE
    ) {
      if (hasCachedView) return;
      // An authorized node can be transiently reported offline while a cold
      // route is restoring. Let the singular hosted lifecycle own its bounded
      // reconnect window; only after that lifecycle terminates do we return
      // the URL-originated attempt to the directory with an offline notice.
      runExclusive(() => {
        failClosed(state.selectionStatus, "offline");
        void hostedHubController.returnToDirectory();
      });
    }
    return;
  }

  if (state.directoryStatus === "stale") {
    if (hasCachedView) {
      replaceRouteScope(null);
      return;
    }
    failClosed(state.selectionStatus, "unavailable");
    return;
  }
  if (state.directoryStatus !== "ready") return;
  // Access checks must finish before choosing a node. Once they have reached
  // shell synchronization, navigation may replace that pending node through
  // the same lifecycle owner without waiting for its snapshot or deadline.
  if (state.browserStatus !== "current" && state.browserStatus !== "synchronizing") return;

  const node = state.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    failClosed(state.selectionStatus, "unavailable");
    return;
  }
  if (node.revokedAt !== null) {
    failClosed(state.selectionStatus, "revoked");
    return;
  }
  const interactive = interactiveNodeId === nodeId;
  replaceRouteScope(scopedThread);
  // Scoped thread demand is acquired above. The environment-keyed
  // coordinator owns normal activation and eviction. Its catalog eligibility
  // intentionally excludes offline nodes, so a URL-originated offline restore
  // enters the same singular controller lifecycle here instead of being
  // stranded on the pre-selection surface.
  const urlOfflineRestore = scopedThread !== null && !node.presence.online && !interactive;
  if (scopedThread && hasActiveHostedWorkspaceCoordinator() && !urlOfflineRestore) return;
  if (restoreRequestedNodeId === nodeId) return;
  restoreRequestedNodeId = nodeId;
  restoreOriginNodeId = interactive ? null : nodeId;
  interactiveNodeId = null;
  setNotice(null);
  void hostedHubController.selectNode(node.id).finally(() => {
    if (restoreRequestedNodeId === nodeId) restoreRequestedNodeId = null;
  });
}

function maybeRedirectLegacyLocation(
  pathname: string,
  state: ReturnType<typeof useHostedHubStore.getState>,
): void {
  if (isLegacyDraftPathname(pathname)) {
    // Hosted drafts are memory-only and identify no node; the directory is
    // the only restorable surface for this legacy shape.
    clearHostedNodeRoute();
    return;
  }
  const environmentId = readLegacyThreadEnvironmentId(pathname);
  if (environmentId === null) return;
  if (state.directoryStatus === "stale") {
    setNotice("unavailable");
    clearHostedNodeRoute();
    return;
  }
  if (state.directoryStatus !== "ready") return;
  const node = state.nodes.find(
    (candidate) => candidate.environmentId === environmentId && candidate.revokedAt === null,
  );
  if (!node) {
    setNotice("unavailable");
    clearHostedNodeRoute();
    return;
  }
  // Upgrade the legacy URL in place; the next reconcile runs the restore
  // pipeline for the adopted segment.
  adoptRoutedHostedNode(node.id);
}

/**
 * Select a node from the directory or node menu by navigating into its
 * node-scoped route. Returns false when no hosted history is installed.
 */
export function selectHostedNodeRoute(nodeId: string): boolean {
  if (!getInstalledHostedNodeHistory()) return false;
  interactiveNodeId = nodeId;
  setNotice(null);
  return enterHostedNodeRoute(nodeId);
}

/**
 * User-facing "All nodes": leave the scoped route for the Hub catalog. This
 * releases only the route's lease; retained work and the bounded LRU transport
 * remain owned by the hosted workspace coordinator.
 */
export function leaveHostedNodeRouteToDirectory(): boolean {
  if (!getInstalledHostedNodeHistory()) return false;
  interactiveNodeId = null;
  setNotice(null);
  // Already on the directory route (for example a second tap while the
  // teardown is in flight): the leave is handled without pushing a duplicate
  // "/" history entry.
  const routed = getRoutedHostedNode();
  if (routed.nodeId === null && routed.logicalPathname === "/nodes") return true;
  return leaveHostedNodeRouteToHubDirectory();
}

export function startHostedNodeRouteOrchestrator(): () => void {
  activeOrchestratorCount += 1;
  const unsubscribeRouted = subscribeRoutedHostedNode(scheduleReconcile);
  const unsubscribeStore = useHostedHubStore.subscribe(scheduleReconcile);
  const history = getInstalledHostedNodeHistory();
  const unsubscribeHistory = history?.subscribe(() => scheduleReconcile());
  scheduleReconcile();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    activeOrchestratorCount -= 1;
    unsubscribeRouted();
    unsubscribeStore();
    unsubscribeHistory?.();
  };
}

export function useHostedNodeRouteOrchestrator(): void {
  useEffect(() => startHostedNodeRouteOrchestrator(), []);
}

export function resetHostedNodeRouteOrchestratorForTests(): void {
  restoreRequestedNodeId = null;
  restoreOriginNodeId = null;
  interactiveNodeId = null;
  reconcileSuspended = false;
  lastAccountStatus = null;
  replaceRouteScope(null);
  setNotice(null);
}
