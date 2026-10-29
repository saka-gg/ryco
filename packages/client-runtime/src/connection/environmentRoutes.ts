/**
 * environmentRoutes - One machine over several routes: the route model and the
 * policy that picks and upgrades a route (`docs/environment-routes.md`).
 *
 * A Hub machine keeps its one environment id (the Hub's) whichever way it is
 * reached. Its routes are the Hub relay and the direct addresses a linked
 * direct grant proved belong to it, each checked to answer with the machine's
 * own direct id before any credential is sent. This module is pure: the
 * connection layer owns sockets, attempts and readiness; it asks here which
 * route to try, and when a better one is worth trying again.
 *
 * Credentials never cross route kinds: direct routes use the linked bearer,
 * the relay its own E2EE session. Only native clients (Desktop, mobile) use
 * routes; the hosted browser keeps its single relay lifecycle owner.
 *
 * @module connection/environmentRoutes
 */
import type { AdvertisedEndpoint, EnvironmentId } from "@ryco/contracts";

export type EnvironmentRouteReach = "tailnet-https" | "tailnet" | "lan" | "public";

/** Where a direct route came from; only learned routes are replaced automatically. */
export type EnvironmentRouteSource = "linked" | "learned" | "user";

export type EnvironmentRoute =
  | { readonly kind: "relay" }
  | {
      readonly kind: "direct";
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly reach: EnvironmentRouteReach;
      /** The machine's direct environment id; a route answering with another id is refused. */
      readonly expectedDescriptorId: EnvironmentId;
      readonly source: EnvironmentRouteSource;
    };

export const RELAY_ROUTE: EnvironmentRoute = Object.freeze({ kind: "relay" });

/** How long a route's public descriptor may take to answer before the next is tried. */
export const ROUTE_CHECK_TIMEOUT_MS = 2_500;
/** While on a worse route, a better one is checked again this often. */
export const BETTER_ROUTE_CHECK_INTERVAL_MS = 60_000;
/** A route an upgrade could not land on is not tried again for this long. */
export const BETTER_ROUTE_HOLDBACK_MS = 300_000;

const REACH_RANK: Readonly<Record<EnvironmentRouteReach, number>> = {
  "tailnet-https": 0,
  tailnet: 1,
  lan: 2,
  public: 3,
};

export function environmentRouteKey(route: EnvironmentRoute): string {
  return route.kind === "relay" ? "relay" : route.httpBaseUrl;
}

function routeRank(route: EnvironmentRoute): number {
  return route.kind === "relay" ? Number.POSITIVE_INFINITY : REACH_RANK[route.reach];
}

/** Best first: tailnet HTTPS, tailnet, LAN, public, then the relay. Stable within a reach. */
export function orderEnvironmentRoutes(
  routes: ReadonlyArray<EnvironmentRoute>,
): ReadonlyArray<EnvironmentRoute> {
  return routes.toSorted((left, right) => routeRank(left) - routeRank(right));
}

/** The reach of an advertised endpoint, or null for one another device can't use. */
export function endpointRouteReach(endpoint: AdvertisedEndpoint): EnvironmentRouteReach | null {
  if (endpoint.status === "unavailable") return null;
  switch (endpoint.reachability) {
    case "loopback":
      return null;
    case "private-network":
      return endpoint.httpBaseUrl.startsWith("https:") ? "tailnet-https" : "tailnet";
    case "lan":
      return "lan";
    case "public":
      return "public";
  }
}

/** Direct routes for a machine's advertised endpoints; loopback and unavailable ones never. */
export function directRoutesFromEndpoints(input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly expectedDescriptorId: EnvironmentId;
  readonly source: EnvironmentRouteSource;
}): ReadonlyArray<EnvironmentRoute> {
  const routes: EnvironmentRoute[] = [];
  for (const endpoint of input.endpoints) {
    const reach = endpointRouteReach(endpoint);
    if (reach === null) continue;
    routes.push({
      kind: "direct",
      httpBaseUrl: endpoint.httpBaseUrl,
      wsBaseUrl: endpoint.wsBaseUrl,
      reach,
      expectedDescriptorId: input.expectedDescriptorId,
      source: input.source,
    });
  }
  return orderEnvironmentRoutes(routes);
}

/**
 * The routes after the machine reported `learned` again: learned routes it no
 * longer reports are dropped, linked and user routes are never touched, and
 * the relay stays last.
 */
export function mergeLearnedRoutes(
  current: ReadonlyArray<EnvironmentRoute>,
  learned: ReadonlyArray<EnvironmentRoute>,
): ReadonlyArray<EnvironmentRoute> {
  const kept = current.filter((route) => route.kind === "relay" || route.source !== "learned");
  const keys = new Set(kept.map(environmentRouteKey));
  const added = learned.filter((route) => {
    const key = environmentRouteKey(route);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return orderEnvironmentRoutes([...kept, ...added]);
}

/** A route check's answer: the descriptor id it reported, or why it gave none. */
export type RouteCheckResult =
  | { readonly kind: "answered"; readonly descriptorId: EnvironmentId }
  | { readonly kind: "unreachable" }
  | { readonly kind: "timeout" };

/** Whether a direct route answered as the expected machine. The relay needs no check. */
export function routeCheckAccepted(route: EnvironmentRoute, result: RouteCheckResult): boolean {
  return (
    route.kind === "relay" ||
    (result.kind === "answered" && result.descriptorId === route.expectedDescriptorId)
  );
}

/**
 * The route to connect over: the best direct route that answered as the
 * machine, else the relay when the machine has one, else null. Checks run in
 * parallel; this only reads their results.
 */
export function selectEnvironmentRoute(
  routes: ReadonlyArray<EnvironmentRoute>,
  results: ReadonlyMap<string, RouteCheckResult>,
): EnvironmentRoute | null {
  for (const route of orderEnvironmentRoutes(routes)) {
    if (route.kind === "relay") return route;
    const result = results.get(environmentRouteKey(route));
    if (result !== undefined && routeCheckAccepted(route, result)) return route;
  }
  return null;
}

export type BetterRouteTrigger = "interval" | "network-changed" | "resume";

/** What the supervisor remembers per machine between upgrade checks. */
export interface BetterRouteState {
  readonly lastCheckAt: number | null;
  readonly checking: boolean;
  /** Route key → when it may be tried again. */
  readonly heldBackUntil: ReadonlyMap<string, number>;
}

export const INITIAL_BETTER_ROUTE_STATE: BetterRouteState = Object.freeze({
  lastCheckAt: null,
  checking: false,
  heldBackUntil: new Map<string, number>(),
});

/**
 * The routes better than `active` worth checking now, best first; empty when
 * none is due. One check at a time; the interval only paces the timer, while a
 * network change or a resume checks at once. Held-back routes wait out their
 * holdback.
 */
export function planBetterRouteCheck(input: {
  readonly routes: ReadonlyArray<EnvironmentRoute>;
  readonly active: EnvironmentRoute;
  readonly state: BetterRouteState;
  readonly trigger: BetterRouteTrigger;
  readonly nowMs: number;
}): ReadonlyArray<EnvironmentRoute> {
  const { state, nowMs } = input;
  if (state.checking) return [];
  if (
    input.trigger === "interval" &&
    state.lastCheckAt !== null &&
    nowMs - state.lastCheckAt < BETTER_ROUTE_CHECK_INTERVAL_MS
  ) {
    return [];
  }
  const activeRank = routeRank(input.active);
  return orderEnvironmentRoutes(input.routes).filter(
    (route) =>
      route.kind === "direct" &&
      routeRank(route) < activeRank &&
      (state.heldBackUntil.get(environmentRouteKey(route)) ?? 0) <= nowMs,
  );
}

/**
 * After an upgrade attempt aimed at `target`: landing elsewhere holds the
 * target back, landing on it clears its holdback.
 */
export function recordUpgradeOutcome(input: {
  readonly state: BetterRouteState;
  readonly target: EnvironmentRoute;
  readonly landedOn: EnvironmentRoute | null;
  readonly nowMs: number;
}): BetterRouteState {
  const key = environmentRouteKey(input.target);
  const heldBackUntil = new Map(input.state.heldBackUntil);
  for (const [routeKey, until] of heldBackUntil) {
    if (until <= input.nowMs) heldBackUntil.delete(routeKey);
  }
  if (input.landedOn !== null && environmentRouteKey(input.landedOn) === key) {
    heldBackUntil.delete(key);
  } else {
    heldBackUntil.set(key, input.nowMs + BETTER_ROUTE_HOLDBACK_MS);
  }
  return { lastCheckAt: input.nowMs, checking: false, heldBackUntil };
}

/** A check found nothing better answering: try again after the interval. */
export function recordCheckWithoutUpgrade(
  state: BetterRouteState,
  nowMs: number,
): BetterRouteState {
  return { ...state, lastCheckAt: nowMs, checking: false };
}
