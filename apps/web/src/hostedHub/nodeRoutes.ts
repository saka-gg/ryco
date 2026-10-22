import {
  createBrowserHistory,
  type HistoryLocation,
  type RouterHistory,
} from "@tanstack/react-router";
import type { EnvironmentId } from "@ryco/contracts";

/**
 * Stable hosted node routes.
 *
 * In hosted-hub mode the pages a node owns carry that node as a stable URL
 * segment (`/node/<directory node id>`) wrapping the existing logical route
 * tree: a thread (`/$environmentId/$threadId`) names its own environment's
 * node, and a draft (`/draft/$draftId`) the node it targets. Every other page
 * — home, settings, projects, tasks, statistics, pull requests, diagnostics —
 * belongs to no node and keeps its plain logical address. The mapping lives
 * entirely in the history layer: the router keeps matching the unchanged
 * logical routes while the browser URL, rendered link hrefs, and history
 * entries carry the node scope. Non-hosted builds never install this history,
 * so their routing is untouched.
 *
 * The segment value is the bounded node identifier the authorized directory
 * already renders to signed-in users — directory metadata only. Possession of
 * a node URL grants nothing: every restore runs the full fail-closed pipeline
 * (session → directory → validation → fresh ticket → relay → sync).
 * No session, ticket, credential, challenge, or signature material is ever
 * written to the URL, history state, or browser storage by this module.
 */

const HOSTED_NODE_ROUTE_PREFIX = "/node";

/**
 * Bounded, URL-safe charset for the routed node segment. Directory node ids
 * use this alphabet; anything else fails closed as a malformed route. Dots
 * are intentionally excluded so `.`/`..` path segments can never validate.
 */
const NODE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface RoutedHostedNodeSegment {
  readonly nodeId: string | null;
  readonly malformed: boolean;
}

/**
 * The published route snapshot pairs the segment with the logical pathname
 * parsed from the same browser URL. Consumers (the route orchestrator) must
 * use this pathname — never `history.location`, which is not yet updated when
 * this value is published from inside the popstate handler.
 */
export interface RoutedHostedNode extends RoutedHostedNodeSegment {
  readonly logicalPathname: string;
}

const NO_ROUTED_NODE: RoutedHostedNode = { nodeId: null, malformed: false, logicalPathname: "/" };
const MALFORMED_ROUTED_NODE_SEGMENT: RoutedHostedNodeSegment = { nodeId: null, malformed: true };
const NO_ROUTED_NODE_SEGMENT: RoutedHostedNodeSegment = { nodeId: null, malformed: false };

export function isValidHostedNodeRouteSegment(segment: string): boolean {
  return NODE_SEGMENT_PATTERN.test(segment);
}

function splitHref(href: string): { readonly pathname: string; readonly suffix: string } {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const searchIndex = beforeHash.indexOf("?");
  const pathname = searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex);
  return { pathname, suffix: href.slice(pathname.length) };
}

export interface ParsedHostedNodeHref {
  readonly routed: RoutedHostedNodeSegment;
  readonly logicalHref: string;
}

/**
 * Split a browser href into the routed node segment and the logical href the
 * router should match. A malformed segment yields a fail-closed logical `/`.
 */
export function parseHostedNodeHref(browserHref: string): ParsedHostedNodeHref {
  const { pathname, suffix } = splitHref(browserHref);
  if (
    pathname !== HOSTED_NODE_ROUTE_PREFIX &&
    !pathname.startsWith(`${HOSTED_NODE_ROUTE_PREFIX}/`)
  ) {
    return { routed: NO_ROUTED_NODE_SEGMENT, logicalHref: browserHref };
  }
  const remainder = pathname.slice(HOSTED_NODE_ROUTE_PREFIX.length + 1);
  const slashIndex = remainder.indexOf("/");
  const segment = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
  if (!isValidHostedNodeRouteSegment(segment)) {
    return { routed: MALFORMED_ROUTED_NODE_SEGMENT, logicalHref: "/" };
  }
  const logicalPathname = slashIndex === -1 ? "/" : remainder.slice(slashIndex) || "/";
  return {
    routed: { nodeId: segment, malformed: false },
    logicalHref: `${logicalPathname}${suffix}`,
  };
}

/**
 * First path segments owned by the Hub website rather than by a node's logical
 * route tree.
 *
 * Declared here rather than imported from `hubRoutes.ts` to keep this module
 * free of a cycle — `hubRoutes` reads this module's published route. The two
 * are kept in agreement by a test asserting this set equals
 * `HUB_ROUTE_TOP_SEGMENTS`.
 */
const HUB_ROUTE_TOP_SEGMENT_SET: ReadonlySet<string> = new Set([
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

let nodeIdForEnvironment: (environmentId: EnvironmentId) => string | null = () => null;
let environmentForDraft: (draftId: string) => EnvironmentId | null = () => null;

/** Install the authorized-directory resolver used by logical cross-node links. */
export function setHostedNodeRouteEnvironmentResolver(
  resolver: (environmentId: EnvironmentId) => string | null,
): () => void {
  nodeIdForEnvironment = resolver;
  return () => {
    if (nodeIdForEnvironment === resolver) nodeIdForEnvironment = () => null;
  };
}

/**
 * Install the resolver that names the environment a draft belongs to, so a
 * link to a draft carries its own node even from a page that names none.
 */
export function setHostedNodeRouteDraftResolver(
  resolver: (draftId: string) => EnvironmentId | null,
): () => void {
  environmentForDraft = resolver;
  return () => {
    if (environmentForDraft === resolver) environmentForDraft = () => null;
  };
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function logicalEnvironmentId(pathname: string): EnvironmentId | null {
  const match = /^\/([^/]+)\/[^/]+\/?$/u.exec(pathname);
  const raw = match?.[1];
  if (!raw || HUB_ROUTE_TOP_SEGMENT_SET.has(raw) || raw === "draft" || raw === "node") return null;
  return decodeSegment(raw) as EnvironmentId;
}

function logicalDraftId(pathname: string): string | null {
  const raw = /^\/draft\/([^/]+)\/?$/u.exec(pathname)?.[1];
  return raw ? decodeSegment(raw) : null;
}

/**
 * Whether a logical pathname names a node: a thread or a draft. No other page
 * belongs to one, so no other page carries a node segment.
 */
export function isHostedNodeScopedPathname(pathname: string): boolean {
  return logicalEnvironmentId(pathname) !== null || logicalDraftId(pathname) !== null;
}

/**
 * The node a logical pathname is routed under, or null for a page no node owns.
 * `routedNodeId` is the node the current entry is routed to: the fallback for a
 * thread or draft no resolver can place, and the node of the open draft itself,
 * whose view keeps it on the draft's target — a device the draft may be moving
 * to, which is not yet the draft's own environment.
 */
function nodeIdForLogicalPathname(pathname: string, routedNodeId: string | null): string | null {
  const environmentId = logicalEnvironmentId(pathname);
  if (environmentId !== null) return nodeIdForEnvironment(environmentId) ?? routedNodeId;
  const draftId = logicalDraftId(pathname);
  if (draftId === null) return null;
  if (routedNodeId !== null && pathname === routedHostedNode.logicalPathname) return routedNodeId;
  const draftEnvironmentId = environmentForDraft(draftId);
  const draftNodeId = draftEnvironmentId === null ? null : nodeIdForEnvironment(draftEnvironmentId);
  return draftNodeId ?? routedNodeId;
}

/**
 * Prefix a logical href with the node it is routed under: a thread's own node,
 * a draft's target node. Every other href, Hub pathnames included, is returned
 * unchanged.
 *
 * This function is the history's `createHref`, so it rewrites **every** href
 * the app renders. Leaving the pages no node owns unprefixed keeps them from
 * inheriting the last opened thread's node: home and settings stay the same
 * address whichever node a thread was last opened on, and a link to `/account`
 * still reaches the Hub page instead of parsing back out as a node's logical
 * `/account` (a two-segment Hub address is never read as a thread).
 */
export function buildHostedNodeHref(logicalHref: string, nodeId: string | null): string {
  const { pathname, suffix } = splitHref(logicalHref);
  const resolvedNodeId = nodeIdForLogicalPathname(pathname, nodeId);
  if (resolvedNodeId === null || !isValidHostedNodeRouteSegment(resolvedNodeId)) return logicalHref;
  return `${HOSTED_NODE_ROUTE_PREFIX}/${resolvedNodeId}${pathname}${suffix}`;
}

let routedHostedNode: RoutedHostedNode = NO_ROUTED_NODE;
const routedSubscribers = new Set<() => void>();
let installedHistory: RouterHistory | null = null;

function publishRoutedHostedNode(next: RoutedHostedNode): void {
  if (
    next.nodeId === routedHostedNode.nodeId &&
    next.malformed === routedHostedNode.malformed &&
    next.logicalPathname === routedHostedNode.logicalPathname
  ) {
    return;
  }
  routedHostedNode = next;
  // Snapshot so notification survives subscribe/unsubscribe during dispatch.
  for (const subscriber of Array.from(routedSubscribers)) subscriber();
}

function logicalPathnameOf(logicalHref: string): string {
  const { pathname } = splitHref(logicalHref);
  return pathname === "" ? "/" : pathname;
}

export function getRoutedHostedNode(): RoutedHostedNode {
  return routedHostedNode;
}

export function subscribeRoutedHostedNode(subscriber: () => void): () => void {
  routedSubscribers.add(subscriber);
  return () => {
    routedSubscribers.delete(subscriber);
  };
}

function parseLogicalHref(href: string, state: unknown): HistoryLocation {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const searchIndex = beforeHash.indexOf("?");
  return {
    href,
    pathname: searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex),
    search: searchIndex === -1 ? "" : beforeHash.slice(searchIndex),
    hash: hashIndex === -1 ? "" : href.slice(hashIndex),
    state: (state ?? { __TSR_index: 0 }) as HistoryLocation["state"],
  };
}

/**
 * Create and install the hosted-hub browser history. The returned history is
 * a standard TanStack `RouterHistory`; it differs from the default browser
 * history only in that browser URLs (and rendered link hrefs) carry the
 * routed node segment while the router sees the logical href.
 */
export function installHostedNodeHistory(win: Window & typeof globalThis = window): RouterHistory {
  const history = createBrowserHistory({
    window: win,
    parseLocation: () => {
      const browserHref = `${win.location.pathname}${win.location.search}${win.location.hash}`;
      const parsed = parseHostedNodeHref(browserHref);
      publishRoutedHostedNode({
        ...parsed.routed,
        logicalPathname: logicalPathnameOf(parsed.logicalHref),
      });
      return parseLogicalHref(parsed.logicalHref, win.history.state);
    },
    createHref: (href) => buildHostedNodeHref(href, routedHostedNode.nodeId),
  });
  // `createBrowserHistory` intentionally keeps PUSH/REPLACE locations logical
  // in memory and only calls `parseLocation` for native history events. A
  // normal router navigation can therefore write a correctly node-prefixed
  // browser URL without publishing that node to the route orchestrator. The
  // URL looks right, but no thread scope is retained and no relay connection
  // starts until a reload reparses the physical URL.
  //
  // Publish accepted logical navigations from the history notification. This
  // runs after blockers have allowed the transition, while the authorized
  // environment resolver still produces the exact physical href queued by
  // `createBrowserHistory`. POP navigation continues to publish through
  // `parseLocation` above.
  const unsubscribeLogicalNavigation = history.subscribe(({ location, action }) => {
    if (action.type !== "PUSH" && action.type !== "REPLACE") return;
    const browserHref = buildHostedNodeHref(location.href, routedHostedNode.nodeId);
    const parsed = parseHostedNodeHref(browserHref);
    publishRoutedHostedNode({
      ...parsed.routed,
      logicalPathname: logicalPathnameOf(parsed.logicalHref),
    });
  });
  const destroyHistory = history.destroy.bind(history);
  history.destroy = () => {
    unsubscribeLogicalNavigation();
    destroyHistory();
  };
  installedHistory = history;
  return history;
}

export function getInstalledHostedNodeHistory(): RouterHistory | null {
  return installedHistory;
}

/**
 * Open the workspace home with a new history entry, unless the current entry
 * is home already. Home names no node, so the entry carries no segment. Back
 * returns to the previous surface.
 */
export function enterHostedHomeRoute(): boolean {
  const history = installedHistory;
  if (!history) return false;
  if (routedHostedNode.nodeId === null && routedHostedNode.logicalPathname === "/") return true;
  publishRoutedHostedNode(NO_ROUTED_NODE);
  history.push("/");
  return true;
}

/**
 * Route the current entry to `nodeId` in place, preserving the logical href
 * (thread, draft and panel state). No new entry. Only an entry that can name
 * that node takes it: a legacy thread address of that node's environment, or
 * the open draft, which follows the device it targets. Anywhere else — a page
 * no node owns, or a thread of another node — the entry is left alone and the
 * call answers false.
 */
export function adoptRoutedHostedNode(nodeId: string): boolean {
  const history = installedHistory;
  if (!history || !isValidHostedNodeRouteSegment(nodeId)) return false;
  const { pathname } = splitHref(history.location.href);
  if (nodeIdForLogicalPathname(pathname, nodeId) !== nodeId) return false;
  publishRoutedHostedNode({
    nodeId,
    malformed: false,
    logicalPathname: logicalPathnameOf(history.location.href),
  });
  history.replace(history.location.href);
  return true;
}

/**
 * Drop the node segment from an entry whose page no node owns, in place: an
 * address from before only threads and drafts named a node (a bookmarked node
 * home or settings page). The logical href is kept. No new entry.
 */
export function dropHostedNodeRouteSegment(): void {
  const history = installedHistory;
  if (!history) return;
  publishRoutedHostedNode({
    nodeId: null,
    malformed: false,
    logicalPathname: logicalPathnameOf(history.location.href),
  });
  history.replace(history.location.href);
}

/** User-facing node catalog navigation; unlike route demand release, this chooses the Hub page. */
export function leaveHostedNodeRouteToHubDirectory(): boolean {
  const history = installedHistory;
  if (!history) return false;
  publishRoutedHostedNode({ nodeId: null, malformed: false, logicalPathname: "/nodes" });
  history.push("/nodes");
  return true;
}

/** Fail closed: replace the current entry with the plain node directory. */
export function clearHostedNodeRoute(): void {
  const history = installedHistory;
  if (!history) return;
  publishRoutedHostedNode(NO_ROUTED_NODE);
  history.replace("/");
}

export function resetHostedNodeRoutesForTests(): void {
  installedHistory?.destroy();
  installedHistory = null;
  // Subscribers are intentionally retained: mounted hooks re-read the reset
  // value instead of being silently detached.
  publishRoutedHostedNode(NO_ROUTED_NODE);
  nodeIdForEnvironment = () => null;
  environmentForDraft = () => null;
}
