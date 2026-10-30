import type { EnvironmentId } from "@ryco/contracts";
import {
  BETTER_ROUTE_CHECK_INTERVAL_MS,
  BETTER_ROUTE_HOLDBACK_MS,
  RELAY_ROUTE,
  checkEnvironmentRoutes,
  createEnvironmentRouteUpgrader,
  environmentRouteKey,
  linkedDirectRoutes,
  routeCheckAccepted,
  type EnvironmentRoute,
} from "@ryco/client-runtime/connection";

import {
  fetchRemoteEnvironmentDescriptor,
  isRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl,
} from "../environments/remote/api";
import {
  listLinkedDirectRecords,
  readSavedEnvironmentBearerToken,
} from "../environments/runtime/catalog";
import type { DesktopWorkspaceDirectRoutes } from "./desktopWorkspaceSocket";

/**
 * Desktop's routes to a Hub machine (`docs/environment-routes.md`, phase 2).
 *
 * The machine stays one environment under its Hub id. Its linked direct access
 * (a saved record carrying `hubLink`) is a route of that environment, never an
 * environment of its own: each connection attempt to the machine checks those
 * addresses first and takes the best one that answers as the machine's own
 * direct id, with the linked bearer; otherwise the relay, which the Electron
 * workspace transport owns as before. The relay's credentials never reach a
 * direct address and the linked bearer never reaches the relay.
 */

/** A direct route whose bearer the node refused waits this long before the next try. */
const REFUSED_ROUTE_HOLDBACK_MS = BETTER_ROUTE_HOLDBACK_MS;

const refusedUntilByRoute = new Map<string, number>();

function readLinkedRoutes(hubEnvironmentId: EnvironmentId, nowMs: number) {
  return linkedDirectRoutes({ records: listLinkedDirectRecords(), hubEnvironmentId, nowMs });
}

const fetchDescriptorId = async (httpBaseUrl: string) =>
  (await fetchRemoteEnvironmentDescriptor({ httpBaseUrl })).environmentId;

/** The socket URL of a direct route, with a one-time token from the linked bearer. */
async function directSocketUrl(
  route: Extract<EnvironmentRoute, { kind: "direct" }>,
  signal: AbortSignal,
): Promise<string | null> {
  const bearerToken = await readSavedEnvironmentBearerToken(route.expectedDescriptorId);
  if (!bearerToken) return null;
  const raw = await resolveRemoteWebSocketConnectionUrl({
    wsBaseUrl: route.wsBaseUrl,
    httpBaseUrl: route.httpBaseUrl,
    bearerToken,
    signal,
  });
  const url = new URL(raw, globalThis.location?.origin);
  url.pathname = "/ws";
  return url.toString();
}

/** The route walk each attempt to `hubEnvironmentId` makes before falling back to the relay. */
export function createDesktopHubLinkedRoutes(
  hubEnvironmentId: EnvironmentId,
): DesktopWorkspaceDirectRoutes {
  return {
    resolve: async (signal) => {
      const nowMs = Date.now();
      const routes = readLinkedRoutes(hubEnvironmentId, nowMs).filter(
        (route) => (refusedUntilByRoute.get(environmentRouteKey(route)) ?? 0) <= nowMs,
      );
      if (routes.length === 0) return null;
      const results = await checkEnvironmentRoutes({ routes, fetchDescriptorId, signal });
      for (const route of routes) {
        if (route.kind !== "direct" || signal.aborted) continue;
        const result = results.get(environmentRouteKey(route));
        if (result === undefined || !routeCheckAccepted(route, result)) continue;
        try {
          const url = await directSocketUrl(route, signal);
          if (url !== null) return { routeKey: environmentRouteKey(route), url };
        } catch (error) {
          // A refused bearer waits for the next renewal over the relay; an
          // unreachable address is simply skipped this time.
          if (isRemoteEnvironmentAuthHttpError(error)) {
            refusedUntilByRoute.set(environmentRouteKey(route), nowMs + REFUSED_ROUTE_HOLDBACK_MS);
          }
        }
      }
      return null;
    },
  };
}

const upgradeChecksByHubId = new Map<string, () => void>();

/**
 * Keep a Hub machine's connection on its best route: check better routes
 * every minute, when the network comes back and when the window is shown
 * again, and start a new attempt when one answers. Returns the stop.
 */
export function keepDesktopHubRouteUpgraded(input: {
  readonly hubEnvironmentId: EnvironmentId;
  readonly readActiveRouteKey: () => string | null;
  readonly reconnect: () => void;
}): () => void {
  const upgrader = createEnvironmentRouteUpgrader({
    readRoutes: () => [...readLinkedRoutes(input.hubEnvironmentId, Date.now()), RELAY_ROUTE],
    readActiveRouteKey: input.readActiveRouteKey,
    checkRoutes: (routes, signal) => checkEnvironmentRoutes({ routes, fetchDescriptorId, signal }),
    reconnect: input.reconnect,
    nowMs: () => Date.now(),
  });
  const interval = globalThis.setInterval(
    () => upgrader.trigger("interval"),
    BETTER_ROUTE_CHECK_INTERVAL_MS,
  );
  const onOnline = () => upgrader.trigger("network-changed");
  const onVisible = () => {
    if (globalThis.document?.visibilityState === "visible") upgrader.trigger("resume");
  };
  globalThis.addEventListener?.("online", onOnline);
  globalThis.document?.addEventListener("visibilitychange", onVisible);
  const check = () => upgrader.trigger("resume");
  upgradeChecksByHubId.set(input.hubEnvironmentId, check);
  return () => {
    globalThis.clearInterval(interval);
    globalThis.removeEventListener?.("online", onOnline);
    globalThis.document?.removeEventListener("visibilitychange", onVisible);
    if (upgradeChecksByHubId.get(input.hubEnvironmentId) === check) {
      upgradeChecksByHubId.delete(input.hubEnvironmentId);
    }
    upgrader.dispose();
  };
}

/** A machine's routes changed (linked, renewed): check them now. */
export function requestDesktopHubRouteCheck(hubEnvironmentId: string): void {
  for (const route of readLinkedRoutes(hubEnvironmentId as EnvironmentId, Date.now())) {
    refusedUntilByRoute.delete(environmentRouteKey(route));
  }
  upgradeChecksByHubId.get(hubEnvironmentId)?.();
}
