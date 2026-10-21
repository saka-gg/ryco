import { useSyncExternalStore } from "react";

import {
  getInstalledHostedNodeHistory,
  getRoutedHostedNode,
  subscribeRoutedHostedNode,
} from "./nodeRoutes";

/**
 * The Hub website's own routes.
 *
 * Every Hub screen used to be a `useState` discriminator inside one component:
 * sign-in, the four signup stages, password login, the reset ceremony,
 * invitation redemption, first-owner setup and the node directory all lived at
 * `/` with no address. That cost the three things a website is expected to do —
 * a refresh restored nothing, Back left the Hub entirely instead of stepping
 * back through a flow, and no page could be linked or bookmarked.
 *
 * ## Why this is not a TanStack route tree
 *
 * The hosted build already replaces the router's history with
 * {@link installHostedNodeHistory}, which maps `/node/<id>/<logical>` onto the
 * unchanged logical route tree, and `routes/__root.tsx` short-circuits the
 * router in hosted mode — `HostedHubRoot` is what renders for every pathname
 * that is not `/pair` or `/native/authorize/*`. Adding file routes for the Hub
 * would mean regenerating the shared route tree, re-pathing surfaces the node
 * app also matches, and giving ten hosted browser suites a real `RouterProvider`
 * they currently mock. It would buy nothing a visitor could perceive: this
 * module reads and writes the same history, so the URLs, the history entries
 * and the Back behaviour are identical either way.
 *
 * ## Reserved pathnames
 *
 * `/email-verification`, `/password-reset` and `/public-signup/verify` are a
 * Hub **server** contract: the Hub builds them from its configured public origin
 * in mail bodies. They are used verbatim as this module's route paths rather
 * than redirected, so a mailed link and the page it lands on are the same
 * address, and a reload of one lands on a page that says what to do instead of
 * "this link is incomplete or expired".
 *
 * No route carries authorization material. Link tokens arrive in the URL
 * *fragment* and are consumed and scrubbed by `hostedIdentityLinks.ts` before
 * anything else reads the location; nothing here writes a secret to a pathname,
 * a search parameter or a history entry.
 */

export type HubAccountSection = "overview" | "security" | "appearance";

export type HubRoute =
  | { readonly kind: "sign-in" }
  | { readonly kind: "sign-in-password" }
  | { readonly kind: "sign-in-recovery-code" }
  | { readonly kind: "sign-up" }
  | { readonly kind: "sign-up-verify" }
  | { readonly kind: "reset-password" }
  | { readonly kind: "invitation" }
  | { readonly kind: "setup" }
  | { readonly kind: "email-verification" }
  | { readonly kind: "nodes" }
  | { readonly kind: "nodes-enroll" }
  | { readonly kind: "account"; readonly section: HubAccountSection };

/** The Hub home. Resolves to the unified workspace when signed in, sign-in when not. */
export const HUB_ROOT_PATHNAME = "/";

const ACCOUNT_SECTION_BY_SUFFIX: Readonly<Record<string, HubAccountSection>> = Object.freeze({
  "": "overview",
  security: "security",
  appearance: "appearance",
});

const PATHNAME_BY_KIND = Object.freeze({
  "sign-in": "/sign-in",
  "sign-in-password": "/sign-in/password",
  "sign-in-recovery-code": "/sign-in/recovery-code",
  "sign-up": "/sign-up",
  // The Hub server's mail contract, used verbatim.
  "sign-up-verify": "/public-signup/verify",
  "reset-password": "/password-reset",
  invitation: "/invitation",
  setup: "/setup",
  "email-verification": "/email-verification",
  nodes: "/nodes",
  "nodes-enroll": "/nodes/enroll",
} as const);

/**
 * Every first path segment the Hub owns.
 *
 * Two other modules must agree with this set or a Hub address is silently
 * reinterpreted: `buildHostedNodeHref` would otherwise read `/account/security`
 * as a thread and render it as `/node/<id>/account/security`, and the route
 * orchestrator's legacy-thread matcher would read it as an
 * `$environmentId/$threadId` pair. Both consume this constant, and
 * `nodeRouteOrchestrator` asserts its reserved set is a superset of it.
 */
export const HUB_ROUTE_TOP_SEGMENTS: readonly string[] = Object.freeze([
  "sign-in",
  "sign-up",
  "public-signup",
  "password-reset",
  "invitation",
  "setup",
  "email-verification",
  "nodes",
  "account",
]);

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname === "" ? "/" : pathname;
}

/**
 * The Hub route a pathname names, or `null` when the pathname belongs to the
 * node workspace's logical tree (`/`, `/$environmentId/$threadId`, `/draft/…`).
 *
 * `/` is deliberately not a Hub route: it is the shared home whose meaning
 * depends on account state, and resolving it here would need state this module
 * does not have.
 */
export function parseHubRoute(pathname: string): HubRoute | null {
  const path = normalize(pathname);
  if (path.startsWith("/account")) {
    const suffix = path.slice("/account".length).replace(/^\//, "");
    const section = ACCOUNT_SECTION_BY_SUFFIX[suffix];
    // An unknown account subpath resolves to the overview rather than falling
    // through to the node tree, where it would be read as a thread pair.
    return { kind: "account", section: section ?? "overview" };
  }
  for (const [kind, candidate] of Object.entries(PATHNAME_BY_KIND)) {
    if (path === candidate) return { kind } as HubRoute;
  }
  return null;
}

export function hubRoutePathname(route: HubRoute): string {
  if (route.kind === "account") {
    return route.section === "overview" ? "/account" : `/account/${route.section}`;
  }
  return PATHNAME_BY_KIND[route.kind];
}

/** The document title for a Hub route, used by `hubPageTitle`. */
export function hubRouteTitle(route: HubRoute): string {
  switch (route.kind) {
    case "sign-in":
      return "Sign in";
    case "sign-in-password":
      return "Sign in with a password";
    case "sign-in-recovery-code":
      return "Use a recovery code";
    case "sign-up":
      return "Create your account";
    case "sign-up-verify":
      return "Verify your email";
    case "reset-password":
      return "Reset your password";
    case "invitation":
      return "Redeem your invitation";
    case "setup":
      return "Claim this Hub";
    case "email-verification":
      return "Email verification";
    case "nodes":
      return "Your nodes";
    case "nodes-enroll":
      return "Enroll a node";
    case "account":
      return route.section === "overview"
        ? "Account"
        : route.section === "security"
          ? "Security"
          : "Appearance";
  }
}

/**
 * The current Hub pathname.
 *
 * Held here rather than read from `window.location` on every render because the
 * installed history publishes its logical pathname through
 * `subscribeRoutedHostedNode`, and a surface must see the same value the
 * history layer just published — `window.location` is not yet updated inside a
 * popstate handler.
 *
 * Without an installed history — component tests, which never boot `main.tsx` —
 * this is simply module state, so navigation still works and the surfaces under
 * test behave exactly as they do in production.
 */
let currentPathname: string =
  typeof window === "undefined" ? HUB_ROOT_PATHNAME : normalize(window.location.pathname);

const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of Array.from(subscribers)) subscriber();
}

function publish(pathname: string): void {
  const next = normalize(pathname);
  if (next === currentPathname) return;
  currentPathname = next;
  notify();
}

let historySubscribed = false;

function ensureHistorySubscription(): void {
  if (historySubscribed) return;
  historySubscribed = true;
  subscribeRoutedHostedNode(() => {
    publish(getRoutedHostedNode().logicalPathname);
  });
}

/**
 * The current Hub pathname.
 *
 * With the router history installed — the production hosted build — the value
 * published by its `parseLocation` is authoritative, because a surface must see
 * what the history layer just published rather than `window.location`, which is
 * not yet updated inside a popstate handler.
 *
 * Without one, the browser location is the only source of truth. That is not a
 * test affordance: it keeps this module honest about the URL in any host that
 * renders a Hub surface without booting `main.tsx`, and it means a Hub page
 * reached by a real navigation resolves the same way in both.
 */
export function getHubPathname(): string {
  if (getInstalledHostedNodeHistory() !== null) return currentPathname;
  return typeof window === "undefined" ? currentPathname : normalize(window.location.pathname);
}

let popstateBound = false;

function ensurePopstateSubscription(): void {
  if (popstateBound || typeof window === "undefined") return;
  popstateBound = true;
  // Back and Forward without a router history — the router installs its own
  // popstate listener and republishes through `parseLocation` instead.
  window.addEventListener("popstate", () => {
    if (getInstalledHostedNodeHistory() !== null) return;
    notify();
  });
}

export function subscribeHubPathname(subscriber: () => void): () => void {
  ensureHistorySubscription();
  ensurePopstateSubscription();
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/**
 * Navigate to a Hub page.
 *
 * `replace` is for steps that must not become a Back target — consuming a
 * mailed link, or failing closed out of a route the account may not reach.
 */
export function navigateHub(route: HubRoute, options?: { readonly replace?: boolean }): void {
  navigateHubPathname(hubRoutePathname(route), options);
}

export function navigateHubPathname(
  pathname: string,
  options?: { readonly replace?: boolean },
): void {
  const next = normalize(pathname);
  const history = getInstalledHostedNodeHistory();
  if (history) {
    if (options?.replace === true) history.replace(next);
    else history.push(next);
    publish(next);
    return;
  }
  // No router history: write the browser location directly, so the address bar,
  // the history stack and `getHubPathname` stay in agreement.
  if (typeof window !== "undefined") {
    if (options?.replace === true) window.history.replaceState(window.history.state, "", next);
    else window.history.pushState(window.history.state, "", next);
  }
  currentPathname = next;
  notify();
}

/** The current Hub pathname, or `null` when it belongs to the node workspace. */
export function useHubRoute(): HubRoute | null {
  return parseHubRoute(useSyncExternalStore(subscribeHubPathname, getHubPathname));
}

/**
 * Return the Hub to its root between test cases.
 *
 * The pathname outlives a render — it is module state backed by the browser
 * location — so without this the page one case navigated to is the page the
 * next case starts on.
 */
export function resetHubRoutesForTests(): void {
  currentPathname = HUB_ROOT_PATHNAME;
  if (typeof window !== "undefined" && window.location.pathname !== HUB_ROOT_PATHNAME) {
    window.history.replaceState(window.history.state, "", HUB_ROOT_PATHNAME);
  }
  notify();
}
