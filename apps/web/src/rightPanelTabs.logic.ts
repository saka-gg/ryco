import type { RightPanelMode } from "./rightPanelRouteSearch";
import {
  buildOpenAgentSearch,
  buildOpenAgentsSearch,
  buildOpenBrowserSearch,
  buildOpenFilesSearch,
  buildOpenPullRequestSearch,
  buildOpenReviewSearch,
  buildOpenSimulatorSearch,
  buildOpenTerminalSearch,
  buildOpenWorkspaceSearch,
} from "./workspaceRouteSearch";

/**
 * Which workspace tabs a thread has opened. The URL only names the active
 * tab; this remembers the rest so their content stays mounted, the panel
 * reopens where the user left it, and closing the active tab falls back to a
 * sibling instead of the launcher. One module for every route that hosts the
 * panel, so a new tab kind is one entry in the fallback order.
 */

/** Panel modes that own exactly one tab (agent transcripts are keyed separately). */
export type RightPanelTabMode = Exclude<RightPanelMode, "agent">;

/** Fallback order when the active tab closes or the panel reopens without a remembered tab. */
export const RIGHT_PANEL_TAB_FALLBACK_ORDER: ReadonlyArray<RightPanelTabMode> = [
  "files",
  "review",
  "terminal",
  "simulator",
  "browser",
  "pullRequest",
  "agents",
];

/** The frozen web phone tier only ever mounts these (AGENTS.md). */
const PHONE_RIGHT_PANEL_TAB_MODES: ReadonlySet<RightPanelMode> = new Set<RightPanelMode>([
  "files",
  "review",
  "terminal",
]);

export interface RightPanelOpenedTabs {
  /** Thread (or draft) these tabs belong to; another scope starts over from its URL. */
  readonly scopeKey: string | null;
  readonly modes: ReadonlyArray<RightPanelTabMode>;
  readonly agentKeys: ReadonlyArray<string>;
}

/** What the route currently shows, for the scope it belongs to. */
export interface RightPanelRouteTabs {
  readonly scopeKey: string | null;
  readonly mode: RightPanelMode | null;
  readonly activeAgentKey: string | null;
}

/** Where opening or falling back lands: a tab, an agent transcript, or the launcher. */
export type RightPanelTarget =
  | { readonly kind: "tab"; readonly mode: RightPanelTabMode }
  | { readonly kind: "agent"; readonly agentKey: string }
  | { readonly kind: "launcher" };

export function isRightPanelTabMode(mode: RightPanelMode | null): mode is RightPanelTabMode {
  return mode !== null && mode !== "agent";
}

function orderTabModes(modes: Iterable<RightPanelTabMode>): RightPanelTabMode[] {
  const set = new Set(modes);
  return RIGHT_PANEL_TAB_FALLBACK_ORDER.filter((mode) => set.has(mode));
}

function sameOpenedTabs(left: RightPanelOpenedTabs, right: RightPanelOpenedTabs): boolean {
  return (
    left.scopeKey === right.scopeKey &&
    left.modes.length === right.modes.length &&
    left.modes.every((mode, index) => mode === right.modes[index]) &&
    left.agentKeys === right.agentKeys
  );
}

/** Tabs implied by the URL alone: whatever it currently shows. */
export function openedTabsFromRoute(route: RightPanelRouteTabs): RightPanelOpenedTabs {
  return {
    scopeKey: route.scopeKey,
    modes: isRightPanelTabMode(route.mode) ? [route.mode] : [],
    agentKeys: route.activeAgentKey ? [route.activeAgentKey] : [],
  };
}

/** The remembered tabs for this scope, or the route's own when the scope changed. */
export function resolveOpenedTabs(
  state: RightPanelOpenedTabs,
  route: RightPanelRouteTabs,
): RightPanelOpenedTabs {
  return state.scopeKey === route.scopeKey ? state : openedTabsFromRoute(route);
}

/** The tab strip: remembered tabs plus whatever the route shows right now. */
export function visibleRightPanelTabs(
  opened: RightPanelOpenedTabs,
  route: RightPanelRouteTabs,
): { readonly modes: RightPanelTabMode[]; readonly agentKeys: ReadonlyArray<string> } {
  const modes = orderTabModes([
    ...opened.modes,
    ...(isRightPanelTabMode(route.mode) ? [route.mode] : []),
  ]);
  const agentKeys =
    route.activeAgentKey && !opened.agentKeys.includes(route.activeAgentKey)
      ? [...opened.agentKeys, route.activeAgentKey]
      : opened.agentKeys;
  return { modes, agentKeys };
}

/** Remember a tab once it has been shown (the route made it active). */
export function markRightPanelTabOpened(
  state: RightPanelOpenedTabs,
  route: RightPanelRouteTabs,
  mode: RightPanelMode,
): RightPanelOpenedTabs {
  const base = resolveOpenedTabs(state, route);
  const next: RightPanelOpenedTabs = {
    scopeKey: route.scopeKey,
    modes: isRightPanelTabMode(mode) ? orderTabModes([...base.modes, mode]) : base.modes,
    agentKeys: base.agentKeys,
  };
  return sameOpenedTabs(state, next) ? state : next;
}

/** Remember the agent transcript the route points at. */
export function rememberActiveAgentTab(
  state: RightPanelOpenedTabs,
  route: RightPanelRouteTabs,
): RightPanelOpenedTabs {
  if (!route.scopeKey || !route.activeAgentKey) return state;
  const base = resolveOpenedTabs(state, route);
  if (base.agentKeys.includes(route.activeAgentKey)) return base;
  return { ...base, agentKeys: [...base.agentKeys, route.activeAgentKey] };
}

function firstOpenedTab(modes: ReadonlyArray<RightPanelTabMode>): RightPanelTarget | null {
  const mode = RIGHT_PANEL_TAB_FALLBACK_ORDER.find((candidate) => modes.includes(candidate));
  return mode ? { kind: "tab", mode } : null;
}

/** Closing a tab: the tabs that remain, and where the route goes if it showed that tab. */
export function closeRightPanelTab(
  state: RightPanelOpenedTabs,
  route: RightPanelRouteTabs,
  input: { readonly mode: RightPanelMode; readonly agentKey?: string | undefined },
): { readonly next: RightPanelOpenedTabs; readonly target: RightPanelTarget | null } {
  const base = resolveOpenedTabs(state, route);
  const visible = visibleRightPanelTabs(base, route);

  if (input.mode === "agent") {
    const agentKeys = visible.agentKeys.filter((key) => key !== input.agentKey);
    const next = { scopeKey: route.scopeKey, modes: base.modes, agentKeys };
    if (route.mode !== "agent" || route.activeAgentKey !== input.agentKey) {
      return { next, target: null };
    }
    const nextAgentKey = agentKeys.at(-1);
    return {
      next,
      target: nextAgentKey
        ? { kind: "agent", agentKey: nextAgentKey }
        : (firstOpenedTab(base.modes) ?? { kind: "launcher" }),
    };
  }

  const modes = visible.modes.filter((mode) => mode !== input.mode);
  const next = { scopeKey: route.scopeKey, modes, agentKeys: base.agentKeys };
  return {
    next: sameOpenedTabs(state, next) ? state : next,
    target: route.mode === input.mode ? (firstOpenedTab(modes) ?? { kind: "launcher" }) : null,
  };
}

/** Reopening the panel: the last tab if it is still open, else the first open tab. */
export function resolveRightPanelReopenTarget(
  state: RightPanelOpenedTabs,
  route: RightPanelRouteTabs,
  lastOpenedMode: RightPanelMode,
): RightPanelTarget {
  const base = resolveOpenedTabs(state, route);
  const lastAgentKey = visibleRightPanelTabs(base, route).agentKeys.at(-1);
  if (lastOpenedMode === "agent" && lastAgentKey) {
    return { kind: "agent", agentKey: lastAgentKey };
  }
  if (isRightPanelTabMode(lastOpenedMode) && base.modes.includes(lastOpenedMode)) {
    return { kind: "tab", mode: lastOpenedMode };
  }
  return (
    firstOpenedTab(base.modes) ??
    (lastAgentKey ? { kind: "agent", agentKey: lastAgentKey } : { kind: "launcher" })
  );
}

/** Whether panel content should stay mounted (open, or holding opened tabs while closed). */
export function shouldMountRightPanelContent(input: {
  readonly open: boolean;
  readonly route: RightPanelRouteTabs;
  readonly opened: RightPanelOpenedTabs;
  readonly agentKeys: ReadonlyArray<string>;
  readonly phone: boolean;
}): boolean {
  if (input.open || input.agentKeys.length > 0) return true;
  if (!input.phone) return input.route.mode !== null || input.opened.modes.length > 0;
  return (
    (input.route.mode !== null && PHONE_RIGHT_PANEL_TAB_MODES.has(input.route.mode)) ||
    input.route.mode === "agent" ||
    input.opened.modes.some((mode) => PHONE_RIGHT_PANEL_TAB_MODES.has(mode))
  );
}

export function buildOpenRightPanelTabSearch<T extends Record<string, unknown>>(
  previous: T,
  mode: RightPanelTabMode,
) {
  switch (mode) {
    case "files":
      return buildOpenFilesSearch(previous);
    case "review":
      return buildOpenReviewSearch(previous);
    case "terminal":
      return buildOpenTerminalSearch(previous);
    case "simulator":
      return buildOpenSimulatorSearch(previous);
    case "browser":
      return buildOpenBrowserSearch(previous);
    case "pullRequest":
      return buildOpenPullRequestSearch(previous);
    case "agents":
      return buildOpenAgentsSearch(previous);
  }
}

export function buildRightPanelTargetSearch<T extends Record<string, unknown>>(
  previous: T,
  target: RightPanelTarget,
) {
  switch (target.kind) {
    case "tab":
      return buildOpenRightPanelTabSearch(previous, target.mode);
    case "agent":
      return buildOpenAgentSearch(previous, target.agentKey);
    case "launcher":
      return buildOpenWorkspaceSearch(previous);
  }
}
