import type { ThreadId } from "@ryco/contracts";
import {
  startHostedThreadReadCache as startSharedHostedThreadReadCache,
  type HostedThreadReadCachePorts as SharedHostedThreadReadCachePorts,
  type HostedThreadReadCacheRoute,
} from "@ryco/client-runtime/authorization";
import {
  decodeThreadReadContent,
  projectThreadReadCacheShell,
  syncServerShellSnapshot,
  type CachedThreadContent,
} from "@ryco/client-runtime/state/threads";
import type { WorkspaceMetadataSnapshot } from "@ryco/client-runtime/state/workspace";

import { useStore } from "../store";
import { readWorkspaceMetadataSnapshot } from "../workspaceMetadataProjection";
import { hostedHubApi } from "./api";
import { hostedHubStore } from "./state";
import { isWebHubSessionOnline, subscribeWebHubInvalidation } from "./hubSession";
import {
  getRoutedHostedNode,
  subscribeRoutedHostedNode,
  type RoutedHostedNode,
} from "./nodeRoutes";

export interface HostedThreadReadCachePorts extends Omit<
  SharedHostedThreadReadCachePorts,
  "readRoute" | "applySnapshot"
> {
  readonly readRoute: () => RoutedHostedNode;
  readonly onSnapshot: (snapshot: WorkspaceMetadataSnapshot) => void;
}

function readTarget(route: RoutedHostedNode): HostedThreadReadCacheRoute {
  const empty = { nodeId: route.nodeId, environmentId: null, threadId: null };
  if (route.malformed) return empty;
  const match = /^\/([^/]+)\/([^/]+)\/?$/u.exec(route.logicalPathname);
  if (!match) return empty;
  try {
    return {
      nodeId: route.nodeId,
      environmentId: decodeURIComponent(match[1]!),
      threadId: decodeURIComponent(match[2]!),
    };
  } catch {
    return empty;
  }
}

/** Browser routing and display projection adapt the shared cache controller. */
export function startHostedThreadReadCache(ports: HostedThreadReadCachePorts): () => void {
  const demoteUnavailableProjection = () => {
    const state = ports.readState();
    const node = state.selectedNode;
    // Canonical connection loss removes display readiness. Directory presence
    // alone cannot demote a current channel, whose accepted live data wins.
    if (
      !node ||
      state.accountStatus !== "authenticated" ||
      !(
        state.sessionStatus === "stale" ||
        state.sessionStatus === "closed" ||
        (state.sessionStatus === "delivery-unknown" && !state.sessionRecoveredAfterUnknown)
      ) ||
      !(
        state.transportStatus === "idle" ||
        state.transportStatus === "reconnecting" ||
        state.transportStatus === "terminal-failure"
      )
    )
      return;
    if (useStore.getState().environmentStateById[node.environmentId]?.bootstrapComplete) {
      useStore.getState().demoteEnvironmentStateToCachedSnapshot(node.environmentId, ports.now());
    }
  };
  demoteUnavailableProjection();
  return startSharedHostedThreadReadCache({
    ...ports,
    readRoute: () => readTarget(ports.readRoute()),
    subscribeState: (listener) =>
      ports.subscribeState(() => {
        demoteUnavailableProjection();
        listener();
      }),
    subscribeProjection:
      ports.subscribeProjection ??
      ((listener) =>
        useStore.subscribe((state, previous) => {
          const nodeId = ports.readRoute().nodeId;
          const node = ports.readState().nodes.find((candidate) => candidate.id === nodeId);
          if (!node) return;
          const before = previous.environmentStateById[node.environmentId];
          const after = state.environmentStateById[node.environmentId];
          if (
            before?.bootstrapComplete &&
            after &&
            !after.bootstrapComplete &&
            after.retainedLiveSnapshot
          )
            listener();
        })),
    applySnapshot: (node, response, details) => {
      const isLive = () =>
        useStore.getState().environmentStateById[node.environmentId]?.bootstrapComplete === true;
      // Hub storedAt measures upload time, not the shell's causal freshness.
      // A delayed upload must not replace metadata from an already-live node.
      if (isLive()) return;
      const contents = new Map<ThreadId, CachedThreadContent>();
      for (const [threadId, detail] of details) {
        const content = decodeThreadReadContent(detail.snapshot);
        if (content) contents.set(threadId, content);
      }
      useStore
        .getState()
        .hydrateEnvironmentStateFromCache(
          projectThreadReadCacheShell(
            response.snapshot,
            node.environmentId,
            response.storedAt,
            contents,
          ),
          node.environmentId,
          { replaceCached: true },
        );
      // Hydration flushes queued shell events before applying its cache. That
      // flush can establish live state, which must also win this projection.
      if (
        isLive() ||
        useStore.getState().environmentStateById[node.environmentId]?.retainedLiveSnapshot
      )
        return;
      // The isolated projection supplies metadata only; it never publishes
      // live readiness or a replay cursor into the application store.
      const metadata = readWorkspaceMetadataSnapshot(
        node.environmentId,
        response.storedAt,
        false,
        syncServerShellSnapshot(
          { activeEnvironmentId: null, environmentStateById: {} },
          response.snapshot,
          node.environmentId,
        ),
      );
      if (metadata) ports.onSnapshot(metadata);
    },
  });
}

export function startBrowserHostedThreadReadCache(
  onSnapshot: (snapshot: WorkspaceMetadataSnapshot) => void,
): () => void {
  return startHostedThreadReadCache({
    readState: hostedHubStore.getState,
    subscribeState: hostedHubStore.subscribe,
    readRoute: getRoutedHostedNode,
    subscribeRoute: subscribeRoutedHostedNode,
    subscribeInvalidation: (listener) =>
      subscribeWebHubInvalidation((event) => {
        if (event.threadCache) listener();
      }),
    isSubscriptionOnline: isWebHubSessionOnline,
    subscribeVisibility: (listener) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    readShell: (nodeId, signal) => hostedHubApi.readThreadCacheShell(nodeId, signal),
    readThread: (nodeId, threadId, signal) =>
      hostedHubApi.readThreadCacheThread(nodeId, threadId, signal),
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
    now: Date.now,
    setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
    clearInterval: (timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
    onSnapshot,
  });
}
