import type { AuthLinkedDirectAccess, EnvironmentId, RelayEffectiveRole } from "@ryco/contracts";
import {
  BETTER_ROUTE_CHECK_INTERVAL_MS,
  RELAY_ROUTE,
  createEnvironmentRouteUpgrader,
  environmentRouteKey,
  hubLinkedDirectAccessDue,
  resolveHubLinkedDirectTarget,
  type BetterRouteTrigger,
  type SavedEnvironmentRecord,
} from "@ryco/client-runtime/connection";
import {
  proveDirectRouteIdentity,
  type DirectRouteIdentityProofAnswer,
} from "@ryco/client-runtime/connection/directRouteIdentity";
import { createHubLinkedRoutes } from "@ryco/client-runtime/connection/hubLinkedRoutes";
import type { createSavedEnvironmentCatalog } from "@ryco/client-runtime/connection";
import type { HostedDirectRoute } from "@ryco/client-runtime/relay";

import type { MobileRemoteEnvironmentApi } from "../connection/remoteApi";

/**
 * Hub-linked direct access on the phone (`docs/environment-routes.md`, phase 3).
 *
 * The owner adds direct access to a Hub machine from its row: the machine
 * issues a one-time code over the E2EE relay channel the phone already holds,
 * names its identity key, and the phone redeems the code at the first HTTPS or
 * Tailscale address that answers as the machine and proves that key. The link
 * is a route of the Hub machine, never an environment: the catalog keeps it
 * apart (`linkedById`), so nothing lists or connects it.
 *
 * Each attempt of the machine's hosted connection asks {@link resolveRoute}
 * first. The hosted attempt factory stays the lifecycle owner: it fences the
 * attempt by generation, resets readiness and role, waits for a fresh shell
 * snapshot, and takes no route while a relay refusal holds. While on the relay,
 * better routes are checked every minute, on a network change and on resume,
 * and the link is renewed there once it has aged.
 *
 * React-free and adapter-injected; `linkedDirectAccessRuntime.ts` binds the app's.
 */

type Catalog = Pick<
  ReturnType<typeof createSavedEnvironmentCatalog>,
  | "get"
  | "getLinked"
  | "listLinked"
  | "persistRecord"
  | "readBearerToken"
  | "writeBearerToken"
  | "removeBearerToken"
  | "registryStore"
>;

export type MobileHubLinkOutcome =
  | "linked"
  /** The owner paired this machine by hand; that pairing is left alone. */
  | "already-paired"
  /** The machine listens on loopback only. */
  | "no-direct-endpoint"
  /** The machine is older than the direct identity proof. */
  | "node-update-required"
  /** None of its HTTPS or Tailscale addresses answered as the machine from this network. */
  | "unreachable";

export interface MobileLinkedDirectAccessDeps {
  readonly catalog: Catalog;
  readonly remoteApi: Pick<
    MobileRemoteEnvironmentApi,
    | "fetchRemoteEnvironmentDescriptor"
    | "bootstrapRemoteBearerSession"
    | "resolveRemoteWebSocketConnectionUrl"
    | "fetchRemoteSessionState"
  >;
  readonly requestProof: (request: {
    readonly httpBaseUrl: string;
    readonly challenge: string;
    readonly signal?: AbortSignal;
  }) => Promise<DirectRouteIdentityProofAnswer>;
  readonly isBearerRefused: (error: unknown) => boolean;
  /** `auth.issueLinkedDirectAccess` over the machine's relay connection. */
  readonly issueLinkedDirectAccess: (
    hubEnvironmentId: EnvironmentId,
  ) => Promise<AuthLinkedDirectAccess>;
  /** The route a machine's latest attempt took: a direct route's address, or `null` for the relay. */
  readonly onRoute?: (hubEnvironmentId: EnvironmentId, routeKey: string | null) => void;
  readonly nowMs?: () => number;
}

const ROLE_RANK: Readonly<Record<RelayEffectiveRole, number>> = {
  viewer: 0,
  operator: 1,
  owner: 2,
};

/**
 * The role a direct attempt publishes: the linked session's, never above the
 * machine's current role in the Hub directory. A link keeps the role it was
 * made with until it is renewed (up to three days); a demotion in the Hub
 * meanwhile must not leave the phone offering what the relay would refuse.
 * `null` (the relay) when the directory no longer lists the machine.
 */
export function capLinkedRole(
  linkedRole: RelayEffectiveRole,
  directoryRole: RelayEffectiveRole | null,
): RelayEffectiveRole | null {
  if (directoryRole === null) return null;
  return ROLE_RANK[directoryRole] < ROLE_RANK[linkedRole] ? directoryRole : linkedRole;
}

/** After a failed automatic renewal, the next attempt waits at least this long. */
const AUTOMATIC_RENEWAL_RETRY_MS = 15 * 60 * 1000;

class LinkedBearerRefused extends Error {}

export function createMobileLinkedDirectAccess(deps: MobileLinkedDirectAccessDeps) {
  const nowMs = deps.nowMs ?? Date.now;
  const routes = createHubLinkedRoutes({
    listLinkedRecords: () => deps.catalog.listLinked(),
    readBearerToken: (environmentId) => deps.catalog.readBearerToken(environmentId),
    fetchDescriptorId: async (httpBaseUrl, signal) =>
      (await deps.remoteApi.fetchRemoteEnvironmentDescriptor({ httpBaseUrl, signal }))
        .environmentId,
    requestProof: deps.requestProof,
    socketUrl: ({ route, bearerToken, signal }) =>
      deps.remoteApi.resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: route.wsBaseUrl,
        httpBaseUrl: route.httpBaseUrl,
        bearerToken,
        signal,
      }),
    // No relay reports a role on a direct socket: the node says which one the
    // link carries, and the attempt publishes it as a relay channel would.
    readRole: async ({ route, bearerToken, signal }): Promise<RelayEffectiveRole | null> => {
      const session = await deps.remoteApi.fetchRemoteSessionState({
        httpBaseUrl: route.httpBaseUrl,
        bearerToken,
        signal,
      });
      if (!session.authenticated) throw new LinkedBearerRefused();
      return session.linkedRole ?? null;
    },
    isBearerRefused: (error) => error instanceof LinkedBearerRefused || deps.isBearerRefused(error),
    nowMs,
  });
  const inFlight = new Map<EnvironmentId, Promise<MobileHubLinkOutcome>>();
  const lastAutomaticAttemptAt = new Map<EnvironmentId, number>();
  const upgradeChecks = new Map<EnvironmentId, () => void>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const linkFor = (hubEnvironmentId: EnvironmentId): SavedEnvironmentRecord | null =>
    deps.catalog
      .listLinked()
      .find((record) => record.hubLink?.hubEnvironmentId === hubEnvironmentId) ?? null;

  /** Drop a link and its bearer; the machine's connection leaves the route. */
  async function dropLink(record: SavedEnvironmentRecord): Promise<void> {
    deps.catalog.registryStore.getState().remove(record.environmentId);
    routes.forgetRefusal(record.httpBaseUrl);
    await deps.catalog.removeBearerToken(record.environmentId).catch(() => undefined);
  }

  async function link(machine: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }): Promise<MobileHubLinkOutcome> {
    const access = await deps.issueLinkedDirectAccess(machine.environmentId);
    if (access.kind === "unavailable") return "no-direct-endpoint";
    // A machine paired by hand stays an environment of its own.
    if (deps.catalog.get(access.environmentId) !== null) return "already-paired";
    if (access.nodeIdentityPublicKey === undefined) return "node-update-required";
    const target = await resolveHubLinkedDirectTarget({
      access,
      fetchDescriptor: (httpBaseUrl) =>
        deps.remoteApi.fetchRemoteEnvironmentDescriptor({ httpBaseUrl }),
      proveIdentity: (input) =>
        proveDirectRouteIdentity({ ...input, requestProof: deps.requestProof }),
    });
    if (target === null) return "unreachable";
    const bearer = await deps.remoteApi.bootstrapRemoteBearerSession({
      httpBaseUrl: target.httpBaseUrl,
      credential: target.credential,
    });
    const prior = deps.catalog.getLinked(target.environmentId);
    const now = new Date(nowMs()).toISOString();
    const record: SavedEnvironmentRecord = {
      environmentId: target.environmentId,
      label: machine.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      createdAt: prior?.createdAt ?? now,
      lastConnectedAt: now,
      hubLink: {
        hubEnvironmentId: machine.environmentId,
        linkedAt: now,
        nodeIdentityPublicKey: target.nodeIdentityPublicKey,
      },
    };
    await deps.catalog.persistRecord(record);
    if (!(await deps.catalog.writeBearerToken(record.environmentId, bearer.sessionToken))) {
      if (prior !== null) await deps.catalog.persistRecord(prior);
      throw new Error("Unable to persist the direct access credential.");
    }
    deps.catalog.registryStore.getState().upsert(record);
    // A reinstalled node answers under another direct id: its older link goes.
    for (const stale of deps.catalog.listLinked()) {
      if (
        stale.environmentId !== record.environmentId &&
        stale.hubLink?.hubEnvironmentId === machine.environmentId
      ) {
        await dropLink(stale);
      }
    }
    routes.clearRefusals(machine.environmentId);
    upgradeChecks.get(machine.environmentId)?.();
    return "linked";
  }

  function linkOnce(machine: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }): Promise<MobileHubLinkOutcome> {
    const running = inFlight.get(machine.environmentId);
    if (running) return running;
    const attempt = link(machine).finally(() => {
      if (inFlight.get(machine.environmentId) === attempt) inFlight.delete(machine.environmentId);
      notify();
    });
    inFlight.set(machine.environmentId, attempt);
    notify();
    return attempt;
  }

  /** Renew a link the owner made once it has aged, or now when it was refused. */
  function renew(
    machine: { readonly environmentId: EnvironmentId; readonly label: string },
    options?: { readonly force?: boolean },
  ): void {
    if (linkFor(machine.environmentId) === null) return;
    const now = nowMs();
    if (
      options?.force !== true &&
      !hubLinkedDirectAccessDue({
        hubEnvironmentId: machine.environmentId,
        records: deps.catalog.listLinked(),
        nowMs: now,
      })
    ) {
      return;
    }
    const lastAttemptAt = lastAutomaticAttemptAt.get(machine.environmentId);
    if (lastAttemptAt !== undefined && now - lastAttemptAt < AUTOMATIC_RENEWAL_RETRY_MS) return;
    lastAutomaticAttemptAt.set(machine.environmentId, now);
    void linkOnce(machine).catch(() => undefined);
  }

  return {
    /** The owner's "Add direct access". Rejects when the machine refuses outright. */
    link: linkOnce,
    renew,
    linkFor,
    isLinking: (hubEnvironmentId: EnvironmentId) => inFlight.has(hubEnvironmentId),
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * The attempt's direct route, for the hosted attempt factory's
     * `resolveDirectRoute` port; `null` for the relay. A refused bearer or
     * identity holds the address and renews the link over the relay.
     */
    async resolveRoute(
      machine: { readonly environmentId: EnvironmentId; readonly label: string },
      signal: AbortSignal,
    ): Promise<HostedDirectRoute | null> {
      const attempt = await routes.resolve(machine.environmentId, signal, () =>
        renew(machine, { force: true }),
      );
      const route =
        attempt === null || attempt.role === undefined
          ? null
          : { routeKey: attempt.routeKey, url: attempt.url, role: attempt.role };
      if (!signal.aborted) deps.onRoute?.(machine.environmentId, route?.routeKey ?? null);
      return route;
    },

    /**
     * Keep the machine's connection on its best route. `trigger` is called on
     * every interval, network change and resume; it stops once `isCurrent`
     * says the connection's generation was replaced or released.
     */
    keepUpgraded(input: {
      readonly machine: { readonly environmentId: EnvironmentId; readonly label: string };
      readonly readActiveRouteKey: () => string | null;
      /** False while a relay refusal holds, or before the session is ready. */
      readonly mayUpgrade: () => boolean;
      /** The relay channel is ready for a renewal request. */
      readonly relayReady: () => boolean;
      readonly isCurrent: () => boolean;
      readonly reconnect: () => void;
      readonly subscribeTriggers: (trigger: (reason: BetterRouteTrigger) => void) => () => void;
    }): () => void {
      const hubEnvironmentId = input.machine.environmentId;
      const upgrader = createEnvironmentRouteUpgrader({
        readRoutes: () => [...routes.routesFor(hubEnvironmentId), RELAY_ROUTE],
        readActiveRouteKey: input.readActiveRouteKey,
        checkRoutes: routes.checkRoutes,
        reconnect: () => {
          if (input.mayUpgrade()) input.reconnect();
        },
        nowMs,
      });
      let stopped = false;
      let unsubscribe: (() => void) | null = null;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe?.();
        upgrader.dispose();
        deps.onRoute?.(hubEnvironmentId, null);
        if (upgradeChecks.get(hubEnvironmentId) === check) upgradeChecks.delete(hubEnvironmentId);
      };
      const trigger = (reason: BetterRouteTrigger) => {
        if (stopped) return;
        if (!input.isCurrent()) return stop();
        const onRelay = input.readActiveRouteKey() === environmentRouteKey(RELAY_ROUTE);
        if (onRelay && input.relayReady()) renew(input.machine);
        if (input.mayUpgrade()) upgrader.trigger(reason);
      };
      // The machine's routes changed: a connection on a route that is gone (removed,
      // replaced, refused) leaves it now; otherwise better routes are checked at once.
      const check = () => {
        if (stopped) return;
        const active = input.readActiveRouteKey();
        const stillThere =
          active === null ||
          active === environmentRouteKey(RELAY_ROUTE) ||
          routes.routesFor(hubEnvironmentId).some((route) => environmentRouteKey(route) === active);
        if (stillThere) trigger("resume");
        else if (input.isCurrent()) input.reconnect();
      };
      upgradeChecks.set(hubEnvironmentId, check);
      unsubscribe = input.subscribeTriggers(trigger);
      return stop;
    },

    /**
     * Forget direct access: one machine's (Remove direct access), or every
     * machine's (Hub sign-out or another account). Links and bearers go, and a
     * machine's connection on one of them reconnects over the relay.
     */
    async forget(hubEnvironmentId?: EnvironmentId): Promise<void> {
      const hubs = new Set<EnvironmentId>();
      for (const record of deps.catalog.listLinked()) {
        const hub = record.hubLink?.hubEnvironmentId as EnvironmentId | undefined;
        if (hub === undefined || (hubEnvironmentId !== undefined && hub !== hubEnvironmentId)) {
          continue;
        }
        hubs.add(hub);
        await dropLink(record);
      }
      for (const hub of hubs) upgradeChecks.get(hub)?.();
      notify();
    },
  };
}

export type MobileLinkedDirectAccess = ReturnType<typeof createMobileLinkedDirectAccess>;

/** The upgrade checks' pace while the app is in front: the route model's interval. */
export const MOBILE_ROUTE_CHECK_INTERVAL_MS = BETTER_ROUTE_CHECK_INTERVAL_MS;
