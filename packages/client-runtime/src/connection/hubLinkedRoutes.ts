/**
 * hubLinkedRoutes - A Hub machine's linked direct routes as a native client
 * walks them on each connection attempt (`docs/environment-routes.md`,
 * phases 2 and 3). Desktop and the phone share it; each supplies only its
 * storage and HTTP adapters.
 *
 * Each attempt checks the machine's linked addresses in parallel (public
 * descriptor only, no credential), then, best first, makes the first one that
 * answered as the machine prove its node identity key, and only then spends
 * the linked bearer on a one-time socket token. An address that refuses the
 * bearer or fails the proof is held until its link changes; one that does not
 * answer is skipped this time. The relay's credentials never reach a direct
 * address, and the linked bearer never reaches the relay.
 *
 * An attempt must not wait long for an address that is not there: away from
 * the tailnet a linked address answers nothing at all, and the machine's relay
 * connection would start only after the whole check timeout, on every launch
 * and every return to the app. An attempt therefore gives each address a short
 * time to answer, and leaves out one that recently did not. Nothing is lost by
 * that: the route upgrader keeps checking the machine's addresses with the
 * full timeout (on an interval, a network change and a resume) and moves the
 * connection onto a direct route as soon as one answers.
 *
 * Its own subpath: the route code loads with a Hub machine's first connection,
 * never with the app's first paint.
 *
 * @module connection/hubLinkedRoutes
 */
import type { EnvironmentId, RelayEffectiveRole } from "@ryco/contracts";

import type { SavedEnvironmentRecord } from "./catalog.ts";
import {
  proveDirectRouteIdentity,
  type DirectRouteIdentityProofAnswer,
} from "./directRouteIdentity.ts";
import {
  ROUTE_CHECK_TIMEOUT_MS,
  checkEnvironmentRoutes,
  environmentRouteKey,
  linkedDirectRoutes,
  routeCheckAccepted,
  type EnvironmentRoute,
  type RouteCheckResult,
} from "./environmentRoutes.ts";

export type LinkedDirectRoute = Extract<EnvironmentRoute, { kind: "direct" }>;

export interface HubLinkedRoutesPorts {
  readonly listLinkedRecords: () => ReadonlyArray<SavedEnvironmentRecord>;
  readonly readBearerToken: (environmentId: EnvironmentId) => Promise<string | null>;
  readonly fetchDescriptorId: (httpBaseUrl: string, signal: AbortSignal) => Promise<EnvironmentId>;
  readonly requestProof: (request: {
    readonly httpBaseUrl: string;
    readonly challenge: string;
    readonly origin: string;
    readonly signal?: AbortSignal;
  }) => Promise<DirectRouteIdentityProofAnswer>;
  /**
   * The route's socket URL with a one-time token bought with the bearer
   * (`resolveRemoteWebSocketConnectionUrl`). Its path is set to the node's
   * `/ws` here, since the connection uses the URL as given.
   */
  readonly socketUrl: (input: {
    readonly route: LinkedDirectRoute;
    readonly bearerToken: string;
    readonly signal: AbortSignal;
  }) => Promise<string>;
  /**
   * The linked session's role, read with the bearer; for a client whose
   * lifecycle owner publishes a role per attempt (the phone). `null` when the
   * node does not say, and the route is then not taken.
   */
  readonly readRole?: (input: {
    readonly route: LinkedDirectRoute;
    readonly bearerToken: string;
    readonly signal: AbortSignal;
  }) => Promise<RelayEffectiveRole | null>;
  /** Whether an error from `socketUrl` or `readRole` is the node refusing the bearer. */
  readonly isBearerRefused: (error: unknown) => boolean;
  readonly nowMs?: () => number;
  /** Test seam: {@link LINKED_ROUTE_ATTEMPT_DEADLINE_MS}. */
  readonly attemptDeadlineMs?: number;
  /** Test seam: {@link LINKED_ROUTE_ATTEMPT_CHECK_TIMEOUT_MS}. */
  readonly attemptCheckTimeoutMs?: number;
}

export interface HubLinkedRouteAttempt {
  readonly routeKey: string;
  readonly url: string;
  /** Present when the ports read one. */
  readonly role?: RelayEffectiveRole;
}

class LinkedRouteRefused extends Error {}

/**
 * How long one route's proof, socket token and role may take together before
 * the attempt moves on (to the next route or the relay): an address that
 * answers its descriptor and then stalls must not hold the machine up.
 */
export const LINKED_ROUTE_ATTEMPT_DEADLINE_MS = 5_000;

/**
 * How long a connection attempt waits for a linked address to answer with its
 * descriptor before it takes the next route or the relay. A reachable address
 * (LAN, an established tailnet) answers well within it; a slower one is found
 * by the upgrader's check, which allows {@link ROUTE_CHECK_TIMEOUT_MS}.
 */
export const LINKED_ROUTE_ATTEMPT_CHECK_TIMEOUT_MS = 800;

/**
 * How long connection attempts leave out an address that did not answer. The
 * upgrader's check, which is what brings a connection back onto the address,
 * ends the wait early when the address answers and proves the machine's key.
 */
export const LINKED_ROUTE_UNANSWERED_SKIP_MS = 10 * 60_000;

/** How long after the upgrader's check proved an address an attempt allows it the full check time. */
export const LINKED_ROUTE_PROVEN_ALLOWANCE_MS = 30_000;

/** Run `work` with a signal that aborts with `signal` or after `ms`; `null` once it did. */
async function withDeadline<A>(
  signal: AbortSignal,
  ms: number,
  work: (signal: AbortSignal) => Promise<A | null>,
): Promise<A | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function createHubLinkedRoutes(ports: HubLinkedRoutesPorts) {
  const nowMs = ports.nowMs ?? Date.now;
  /** Addresses that refused the bearer or the proof; each waits for its link to change. */
  const refused = new Set<string>();
  /** Addresses that did not answer, and when; attempts leave them out for a while. */
  const unanswered = new Map<string, number>();
  /**
   * Addresses the upgrader's check just saw answer and prove the key. The
   * attempt that check asks for allows them the same time the check did, so an
   * address that answers slower than an attempt's short check is not found by
   * the upgrader only to be given up by the attempt.
   */
  const provenAt = new Map<string, number>();
  const noteAnswer = (key: string, result: RouteCheckResult | undefined) => {
    if (result?.kind === "timeout" || result?.kind === "unreachable") unanswered.set(key, nowMs());
  };

  const routesFor = (hubEnvironmentId: EnvironmentId): ReadonlyArray<EnvironmentRoute> =>
    linkedDirectRoutes({
      records: ports.listLinkedRecords(),
      hubEnvironmentId,
      nowMs: nowMs(),
    }).filter((route) => !refused.has(environmentRouteKey(route)));

  const checkDescriptors = (routes: ReadonlyArray<EnvironmentRoute>, signal: AbortSignal) =>
    checkEnvironmentRoutes({ routes, fetchDescriptorId: ports.fetchDescriptorId, signal });

  const prove = (route: LinkedDirectRoute, signal: AbortSignal) =>
    route.nodeIdentityPublicKey === undefined
      ? Promise.resolve("refused" as const)
      : proveDirectRouteIdentity({
          httpBaseUrl: route.httpBaseUrl,
          environmentId: route.expectedDescriptorId,
          nodeIdentityPublicKey: route.nodeIdentityPublicKey,
          requestProof: ports.requestProof,
          signal,
        });

  /**
   * The upgrader's check: a route counts as answering only when its descriptor
   * names the machine and it proves the machine's key, both without any
   * credential, so a route that would fail its attempt never drops the working
   * connection to try it. A refused proof holds the address like an attempt's.
   */
  const checkRoutes = async (
    routes: ReadonlyArray<EnvironmentRoute>,
    signal: AbortSignal,
    onRefused?: () => void,
  ): Promise<ReadonlyMap<string, RouteCheckResult>> => {
    const results = new Map(await checkDescriptors(routes, signal));
    await Promise.all(
      routes.map(async (route) => {
        const key = environmentRouteKey(route);
        const result = results.get(key);
        if (route.kind !== "direct" || result === undefined || !routeCheckAccepted(route, result)) {
          return;
        }
        const proof = await withDeadline(signal, ROUTE_CHECK_TIMEOUT_MS, (deadline) =>
          prove(route, deadline),
        );
        if (proof === "proven") {
          unanswered.delete(key);
          provenAt.set(key, nowMs());
          return;
        }
        provenAt.delete(key);
        if (proof === "refused") {
          refused.add(key);
          onRefused?.();
        }
        results.set(key, proof === null ? { kind: "timeout" } : { kind: "unreachable" });
      }),
    );
    // A check that was called off says nothing about its addresses.
    if (!signal.aborted) {
      for (const route of routes) {
        if (route.kind !== "direct") continue;
        const key = environmentRouteKey(route);
        noteAnswer(key, results.get(key));
      }
    }
    return results;
  };

  /** The route's attempt once it proved the machine's key; `null` to try the next one. */
  async function attemptOver(
    route: LinkedDirectRoute,
    signal: AbortSignal,
  ): Promise<HubLinkedRouteAttempt | null> {
    if (route.nodeIdentityPublicKey === undefined) return null;
    const proof = await prove(route, signal);
    if (proof === "refused") throw new LinkedRouteRefused();
    if (proof !== "proven" || signal.aborted) return null;
    const bearerToken = await ports.readBearerToken(route.expectedDescriptorId);
    if (!bearerToken || signal.aborted) return null;
    const socketUrl = new URL(await ports.socketUrl({ route, bearerToken, signal }));
    socketUrl.pathname = "/ws";
    const url = socketUrl.toString();
    if (ports.readRole === undefined) return { routeKey: environmentRouteKey(route), url };
    const role = await ports.readRole({ route, bearerToken, signal });
    if (role === null || signal.aborted) return null;
    return { routeKey: environmentRouteKey(route), url, role };
  }

  return {
    routesFor,
    checkRoutes,
    /**
     * The best linked route of `hubEnvironmentId` for this attempt, or `null`
     * for the relay. `onRefused` hears an address that refused the bearer or
     * the proof: the link should be renewed over the relay.
     */
    async resolve(
      hubEnvironmentId: EnvironmentId,
      signal: AbortSignal,
      onRefused?: () => void,
    ): Promise<HubLinkedRouteAttempt | null> {
      const startedAt = nowMs();
      const routes = routesFor(hubEnvironmentId).filter((route) => {
        const unansweredAt = unanswered.get(environmentRouteKey(route));
        return (
          unansweredAt === undefined || startedAt - unansweredAt >= LINKED_ROUTE_UNANSWERED_SKIP_MS
        );
      });
      if (routes.length === 0) return null;
      const justProven = routes.some((route) => {
        const at = provenAt.get(environmentRouteKey(route));
        return at !== undefined && startedAt - at < LINKED_ROUTE_PROVEN_ALLOWANCE_MS;
      });
      const results = await checkEnvironmentRoutes({
        routes,
        fetchDescriptorId: ports.fetchDescriptorId,
        signal,
        timeoutMs: justProven
          ? ROUTE_CHECK_TIMEOUT_MS
          : (ports.attemptCheckTimeoutMs ?? LINKED_ROUTE_ATTEMPT_CHECK_TIMEOUT_MS),
      });
      for (const route of routes) {
        if (route.kind !== "direct" || signal.aborted) continue;
        const key = environmentRouteKey(route);
        const result = results.get(key);
        noteAnswer(key, result);
        if (result === undefined || !routeCheckAccepted(route, result)) continue;
        try {
          const attempt = await withDeadline(
            signal,
            ports.attemptDeadlineMs ?? LINKED_ROUTE_ATTEMPT_DEADLINE_MS,
            (deadline) => attemptOver(route, deadline),
          );
          if (attempt !== null) {
            unanswered.delete(key);
            return attempt;
          }
        } catch (error) {
          // A refused bearer or identity waits for the link to change; an
          // unreachable address is simply skipped this time.
          if (error instanceof LinkedRouteRefused || ports.isBearerRefused(error)) {
            refused.add(environmentRouteKey(route));
            onRefused?.();
          }
        }
      }
      return null;
    },
    /** The machine's link changed (renewed, removed): its addresses may be tried again. */
    clearRefusals(hubEnvironmentId: string): void {
      for (const record of ports.listLinkedRecords()) {
        if (record.hubLink?.hubEnvironmentId === hubEnvironmentId) {
          refused.delete(record.httpBaseUrl);
          unanswered.delete(record.httpBaseUrl);
          provenAt.delete(record.httpBaseUrl);
        }
      }
    },
    /** Forget a removed address's hold, whichever machine it belonged to. */
    forgetRefusal(httpBaseUrl: string): void {
      refused.delete(httpBaseUrl);
      unanswered.delete(httpBaseUrl);
      provenAt.delete(httpBaseUrl);
    },
  };
}

export type HubLinkedRoutes = ReturnType<typeof createHubLinkedRoutes>;
