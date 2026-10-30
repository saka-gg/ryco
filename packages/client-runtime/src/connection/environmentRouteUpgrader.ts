/**
 * environmentRouteUpgrader - Moves a connection back to a better route
 * (`docs/environment-routes.md`, "Choosing and upgrading").
 *
 * While a machine is reached over a worse route than it has, its better
 * direct routes are checked every `BETTER_ROUTE_CHECK_INTERVAL_MS`, and at
 * once on a network change or a resume; one check runs at a time. When one
 * answers as the machine, the connection makes a new attempt, which walks the
 * routes itself. This module never opens a socket and never picks the route an
 * attempt takes: it only decides when an attempt is worth making. Readiness
 * and mutation authority stay with the attempt, which waits for a fresh shell
 * snapshot like any reconnect.
 *
 * @module connection/environmentRouteUpgrader
 */
import {
  INITIAL_BETTER_ROUTE_STATE,
  RELAY_ROUTE,
  environmentRouteKey,
  planBetterRouteCheck,
  recordCheckWithoutUpgrade,
  recordUpgradeOutcome,
  selectEnvironmentRoute,
  type BetterRouteState,
  type BetterRouteTrigger,
  type EnvironmentRoute,
  type RouteCheckResult,
} from "./environmentRoutes.ts";

export interface EnvironmentRouteUpgrader {
  readonly trigger: (trigger: BetterRouteTrigger) => void;
  readonly dispose: () => void;
}

export function createEnvironmentRouteUpgrader(input: {
  /** The machine's routes now: its direct routes and, when it has one, the relay. */
  readonly readRoutes: () => ReadonlyArray<EnvironmentRoute>;
  /** The route the current attempt took (`environmentRouteKey`), or null before one. */
  readonly readActiveRouteKey: () => string | null;
  readonly checkRoutes: (
    routes: ReadonlyArray<EnvironmentRoute>,
    signal: AbortSignal,
  ) => Promise<ReadonlyMap<string, RouteCheckResult>>;
  /** Start a new attempt; it walks the routes and lands where it can. */
  readonly reconnect: () => void;
  readonly nowMs: () => number;
}): EnvironmentRouteUpgrader {
  let state: BetterRouteState = INITIAL_BETTER_ROUTE_STATE;
  let disposed = false;
  let checking: AbortController | null = null;
  /** The route the last upgrade aimed at, until the next trigger sees where it landed. */
  let pendingTarget: EnvironmentRoute | null = null;

  const routeByKey = (key: string | null): EnvironmentRoute | null => {
    if (key === null) return null;
    if (key === environmentRouteKey(RELAY_ROUTE)) return RELAY_ROUTE;
    return input.readRoutes().find((route) => environmentRouteKey(route) === key) ?? null;
  };

  const settlePendingUpgrade = () => {
    if (pendingTarget === null) return;
    state = recordUpgradeOutcome({
      state,
      target: pendingTarget,
      landedOn: routeByKey(input.readActiveRouteKey()),
      nowMs: input.nowMs(),
    });
    pendingTarget = null;
  };

  const trigger = (trigger: BetterRouteTrigger) => {
    if (disposed || checking !== null) return;
    settlePendingUpgrade();
    const routes = input.readRoutes();
    const active = routeByKey(input.readActiveRouteKey());
    // A route that is gone (unlinked, or its link aged out) is not kept: the
    // next attempt walks the routes there are.
    if (active === null) {
      if (input.readActiveRouteKey() !== null) input.reconnect();
      return;
    }
    const candidates = planBetterRouteCheck({
      routes,
      active,
      state,
      trigger,
      nowMs: input.nowMs(),
    });
    if (candidates.length === 0) return;
    const controller = new AbortController();
    checking = controller;
    state = { ...state, checking: true };
    void input
      .checkRoutes(candidates, controller.signal)
      .catch(() => new Map<string, RouteCheckResult>())
      .then((results) => {
        if (checking !== controller) return;
        checking = null;
        if (disposed) return;
        const better = selectEnvironmentRoute(candidates, results);
        if (better === null) {
          state = recordCheckWithoutUpgrade(state, input.nowMs());
          return;
        }
        state = { ...state, checking: false };
        pendingTarget = better;
        input.reconnect();
      });
  };

  return {
    trigger,
    dispose: () => {
      disposed = true;
      checking?.abort();
      checking = null;
    },
  };
}
