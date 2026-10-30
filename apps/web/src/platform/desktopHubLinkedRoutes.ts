import type { EnvironmentId } from "@ryco/contracts";
import {
  BETTER_ROUTE_CHECK_INTERVAL_MS,
  RELAY_ROUTE,
  createEnvironmentRouteUpgrader,
  environmentRouteKey,
} from "@ryco/client-runtime/connection";
import { createHubLinkedRoutes } from "@ryco/client-runtime/connection/hubLinkedRoutes";

import {
  fetchRemoteEnvironmentDescriptor,
  isRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl,
} from "../environments/remote/api";
import { requestWebDirectRouteIdentityProof } from "./directRouteIdentityRequest";
import {
  listLinkedDirectRecords,
  readSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken,
  useSavedEnvironmentRegistryStore,
  waitForSavedEnvironmentRegistryHydration,
  type SavedEnvironmentRecord,
} from "../environments/runtime/catalog";
import { haltDesktopLinking } from "./desktopHubLinkedDirectAccess";
import type { DesktopWorkspaceDirectRoutes } from "./desktopWorkspaceSocket";

/**
 * Desktop's routes to a Hub machine (`docs/environment-routes.md`, phase 2).
 *
 * The machine stays one environment under its Hub id. Its linked direct access
 * (a saved record carrying `hubLink`) is a route of that environment, never an
 * environment of its own: each connection attempt to the machine walks those
 * addresses first (`@ryco/client-runtime/connection/hubLinkedRoutes`, shared
 * with the phone) and takes the best one that answers as the machine and
 * proves its identity key, with the linked bearer. Otherwise the relay, which
 * the Electron workspace transport owns as before. Addresses that refused the
 * bearer or the proof stay out until their link changes
 * (`requestDesktopHubRouteCheck`), never on a timer: trying one again would
 * only drop a healthy relay connection for the same refusal.
 */
const linkedRoutes = createHubLinkedRoutes({
  listLinkedRecords: listLinkedDirectRecords,
  readBearerToken: readSavedEnvironmentBearerToken,
  fetchDescriptorId: async (httpBaseUrl, signal) =>
    (await fetchRemoteEnvironmentDescriptor({ httpBaseUrl, signal })).environmentId,
  requestProof: requestWebDirectRouteIdentityProof,
  socketUrl: ({ route, bearerToken, signal }) =>
    resolveRemoteWebSocketConnectionUrl({
      wsBaseUrl: route.wsBaseUrl,
      httpBaseUrl: route.httpBaseUrl,
      bearerToken,
      signal,
    }),
  isBearerRefused: isRemoteEnvironmentAuthHttpError,
});

/** The route walk each attempt to `hubEnvironmentId` makes before falling back to the relay. */
export function createDesktopHubLinkedRoutes(
  hubEnvironmentId: EnvironmentId,
  options?: {
    /** The node refused the linked bearer or the identity proof: link again over the relay. */
    readonly onRefused?: () => void;
  },
): DesktopWorkspaceDirectRoutes {
  return {
    resolve: async (signal) => {
      const attempt = await linkedRoutes.resolve(hubEnvironmentId, signal, options?.onRefused);
      return attempt === null ? null : { routeKey: attempt.routeKey, url: attempt.url };
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
  /** False once the relay refused the machine: no route may go around that. */
  readonly mayUpgrade: () => boolean;
  readonly reconnect: () => void;
  /** Each check while on the relay: the link's renewal (if due) rides on it. */
  readonly onRelay?: () => void;
}): () => void {
  const upgrader = createEnvironmentRouteUpgrader({
    readRoutes: () => [...linkedRoutes.routesFor(input.hubEnvironmentId), RELAY_ROUTE],
    readActiveRouteKey: input.readActiveRouteKey,
    checkRoutes: linkedRoutes.checkRoutes,
    reconnect: () => {
      if (input.mayUpgrade()) input.reconnect();
    },
    nowMs: () => Date.now(),
  });
  const trigger = (reason: "interval" | "network-changed" | "resume") => {
    if (input.readActiveRouteKey() === environmentRouteKey(RELAY_ROUTE)) input.onRelay?.();
    if (input.mayUpgrade()) upgrader.trigger(reason);
  };
  const interval = globalThis.setInterval(
    () => trigger("interval"),
    BETTER_ROUTE_CHECK_INTERVAL_MS,
  );
  const onOnline = () => trigger("network-changed");
  const onVisible = () => {
    if (globalThis.document?.visibilityState === "visible") trigger("resume");
  };
  globalThis.addEventListener?.("online", onOnline);
  globalThis.document?.addEventListener("visibilitychange", onVisible);
  const check = () => trigger("resume");
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

/** A machine's routes changed (linked, renewed, removed): check them now. */
export function requestDesktopHubRouteCheck(hubEnvironmentId: string): void {
  linkedRoutes.clearRefusals(hubEnvironmentId);
  upgradeChecksByHubId.get(hubEnvironmentId)?.();
}

/**
 * Forget Hub-linked direct access: one Hub machine's (Remove direct access),
 * or every machine's (Hub sign-out or account change). Records and their
 * bearers go; the machines' connections leave any direct route they were on.
 */
export async function forgetDesktopHubLinkedDirectAccess(hubEnvironmentId?: string): Promise<void> {
  const linkingHalted = await haltDesktopLinking();
  const hubs = new Set<string>();
  for (const record of listLinkedDirectRecords()) {
    const hub = record.hubLink?.hubEnvironmentId;
    if (hub === undefined || (hubEnvironmentId !== undefined && hub !== hubEnvironmentId)) continue;
    hubs.add(hub);
    useSavedEnvironmentRegistryStore.getState().remove(record.environmentId);
    linkedRoutes.forgetRefusal(record.httpBaseUrl);
    await removeSavedEnvironmentBearerToken(record.environmentId).catch(() => undefined);
  }
  linkingHalted();
  for (const hub of hubs) upgradeChecksByHubId.get(hub)?.();
}

type ForgetFoldedEnvironment = (environmentId: EnvironmentId) => Promise<void>;

/**
 * A link was made or renewed: it replaces an older link of the same Hub
 * machine under another direct id (the node was reinstalled), drops what this
 * client held under the direct id, and the machine's connection checks its
 * routes now.
 */
export async function adoptHubLinkedDirectAccess(
  record: SavedEnvironmentRecord,
  forgetFolded: ForgetFoldedEnvironment,
): Promise<void> {
  const hubEnvironmentId = record.hubLink?.hubEnvironmentId;
  if (hubEnvironmentId === undefined) return;
  for (const stale of listLinkedDirectRecords()) {
    if (
      stale.environmentId === record.environmentId ||
      stale.hubLink?.hubEnvironmentId !== hubEnvironmentId
    ) {
      continue;
    }
    useSavedEnvironmentRegistryStore.getState().remove(stale.environmentId);
    await removeSavedEnvironmentBearerToken(stale.environmentId).catch(() => undefined);
  }
  await forgetFolded(record.environmentId);
  requestDesktopHubRouteCheck(hubEnvironmentId);
}

let folded: Promise<void> | null = null;

/**
 * Once per run, after the saved registry loaded: a Desktop that linked a
 * machine before routes existed kept it as a second environment. Its data
 * under the direct id goes, and only the newest link per Hub machine stays.
 */
export function foldHubLinkedDirectAccessOnce(
  forgetFolded: ForgetFoldedEnvironment,
): Promise<void> {
  folded ??= (async () => {
    await waitForSavedEnvironmentRegistryHydration();
    const newestByHub = new Map<string, SavedEnvironmentRecord>();
    for (const record of listLinkedDirectRecords()) {
      const hub = record.hubLink?.hubEnvironmentId;
      if (hub === undefined) continue;
      const kept = newestByHub.get(hub);
      if (kept === undefined || (record.hubLink?.linkedAt ?? "") > (kept.hubLink?.linkedAt ?? "")) {
        newestByHub.set(hub, record);
      }
    }
    for (const record of listLinkedDirectRecords()) {
      await forgetFolded(record.environmentId);
      const hub = record.hubLink?.hubEnvironmentId;
      if (hub !== undefined && newestByHub.get(hub) !== record) {
        useSavedEnvironmentRegistryStore.getState().remove(record.environmentId);
        await removeSavedEnvironmentBearerToken(record.environmentId).catch(() => undefined);
      }
    }
  })();
  return folded;
}
