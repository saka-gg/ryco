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

import type { SavedEnvironmentRecord } from "./catalog.ts";

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

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A linked route is used for this long after it was linked, then the relay
 * carries the connection so the link can be renewed there, well within the
 * node's seven days (`HUB_LINKED_DIRECT_ACCESS_RENEW_AFTER_MS`).
 */
export const LINKED_ROUTE_USABLE_FOR_MS = 3 * DAY_MS;

function isPrivateIpv4(host: string): "tailnet" | "lan" | null {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  if (a === 169 && b === 254) return "lan";
  return null;
}

/**
 * The reach of a saved direct address, read from its URL: a MagicDNS name over
 * HTTPS, a tailnet address, a private or `.local` address, else public. Null
 * for loopback, which no other device can use. Only orders routes; whether a
 * route is the machine is the descriptor check's job.
 */
export function routeReachForBaseUrl(httpBaseUrl: string): EnvironmentRouteReach | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return null;
  if (host.endsWith(".ts.net")) return url.protocol === "https:" ? "tailnet-https" : "tailnet";
  const ipv4 = isPrivateIpv4(host);
  if (ipv4 !== null) return ipv4;
  if (host.startsWith("fd") && host.includes(":")) return "tailnet";
  if (host.endsWith(".local") || host.startsWith("fe80:")) return "lan";
  return "public";
}

/**
 * The direct routes a Hub machine's linked direct access gives it: one per
 * linked record that names this Hub environment and is still within its
 * usable age (an older one waits for its renewal over the relay).
 */
export function linkedDirectRoutes(input: {
  readonly records: ReadonlyArray<SavedEnvironmentRecord>;
  readonly hubEnvironmentId: EnvironmentId;
  readonly nowMs: number;
}): ReadonlyArray<EnvironmentRoute> {
  const routes: EnvironmentRoute[] = [];
  for (const record of input.records) {
    if (record.hubLink?.hubEnvironmentId !== input.hubEnvironmentId) continue;
    const linkedAtMs = Date.parse(record.hubLink.linkedAt);
    if (!Number.isFinite(linkedAtMs) || input.nowMs - linkedAtMs >= LINKED_ROUTE_USABLE_FOR_MS) {
      continue;
    }
    const reach = routeReachForBaseUrl(record.httpBaseUrl);
    if (reach === null) continue;
    routes.push({
      kind: "direct",
      httpBaseUrl: record.httpBaseUrl,
      wsBaseUrl: record.wsBaseUrl,
      reach,
      expectedDescriptorId: record.environmentId,
      source: "linked",
    });
  }
  return orderEnvironmentRoutes(routes);
}

/**
 * Check every direct route at once: each answers with its public descriptor's
 * id within the timeout or counts as unreachable. No credential is sent; the
 * relay is not checked.
 */
export async function checkEnvironmentRoutes(input: {
  readonly routes: ReadonlyArray<EnvironmentRoute>;
  readonly fetchDescriptorId: (httpBaseUrl: string, signal: AbortSignal) => Promise<EnvironmentId>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, RouteCheckResult>> {
  const timeoutMs = input.timeoutMs ?? ROUTE_CHECK_TIMEOUT_MS;
  const direct = input.routes.filter(
    (route): route is Extract<EnvironmentRoute, { kind: "direct" }> => route.kind === "direct",
  );
  const entries = await Promise.all(
    direct.map(async (route): Promise<readonly [string, RouteCheckResult]> => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<RouteCheckResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "timeout" });
        }, timeoutMs);
      });
      try {
        const answered = input.fetchDescriptorId(route.httpBaseUrl, controller.signal).then(
          (descriptorId): RouteCheckResult => ({ kind: "answered", descriptorId }),
          (): RouteCheckResult => ({ kind: "unreachable" }),
        );
        return [environmentRouteKey(route), await Promise.race([answered, timedOut])] as const;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }
    }),
  );
  return new Map(entries);
}
