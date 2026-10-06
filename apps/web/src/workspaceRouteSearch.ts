import { type TurnId } from "@ryco/contracts";

import { stripDiffSearchParams } from "./diffRouteSearch";
import { stripPreviewSearchParams } from "./previewRouteSearch";

export type WorkspacePanelTab =
  | "review"
  | "files"
  | "terminal"
  | "simulator"
  | "browser"
  | "pullRequest"
  | "agent"
  | "agents";

const WORKSPACE_PANEL_TABS: ReadonlySet<string> = new Set<WorkspacePanelTab>([
  "review",
  "files",
  "terminal",
  "simulator",
  "browser",
  "pullRequest",
  "agent",
  "agents",
]);

// A type alias, not an interface: the builders' results feed back into
// builders that take `Record<string, unknown>`, which interfaces never satisfy.
export type WorkspaceRouteSearch = {
  workspaceOpen?: "1" | undefined;
  workspaceTab?: WorkspacePanelTab | undefined;
  workspaceAgentKey?: string | undefined;
  /** Pull request tab: a specific change request; absent = the thread's own. */
  workspacePr?: number | undefined;
};

/** Every search key the workspace panel owns, legacy diff/preview included. */
export type WorkspacePanelSearchKey =
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
  | "workspacePr";

type WorkspaceSearchKey = "workspaceOpen" | "workspaceTab" | "workspaceAgentKey" | "workspacePr";

/**
 * A route search with the workspace panel's keys replaced. Every key the panel
 * owns is written explicitly (undefined clears it), so a builder's result
 * never inherits a stale tab parameter from the previous search.
 */
export type WorkspacePanelSearch<T, Legacy> = Omit<T, WorkspacePanelSearchKey> &
  WorkspaceRouteSearch &
  Legacy;

type ClosedLegacySearch = { diff?: undefined; preview?: undefined };

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkspaceTab(value: unknown): WorkspacePanelTab | undefined {
  return typeof value === "string" && WORKSPACE_PANEL_TABS.has(value)
    ? (value as WorkspacePanelTab)
    : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

export function stripWorkspaceSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, WorkspaceSearchKey> {
  const {
    workspaceOpen: _workspaceOpen,
    workspaceTab: _workspaceTab,
    workspaceAgentKey: _workspaceAgentKey,
    workspacePr: _workspacePr,
    ...rest
  } = params;
  return rest as Omit<T, WorkspaceSearchKey>;
}

export function stripWorkspacePanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, WorkspacePanelSearchKey> {
  return stripWorkspaceSearchParams(
    stripPreviewSearchParams(stripDiffSearchParams(params)),
  ) as Omit<T, WorkspacePanelSearchKey>;
}

/**
 * A pinned change request (`workspacePr`) names a change request in the thread
 * that pinned it. Navigation that carries the panel's search over to another
 * thread drops the pin, so that thread's tab shows its own change request.
 */
export function stripWorkspacePullRequestPin<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "workspacePr"> {
  const { workspacePr: _workspacePr, ...rest } = params;
  return rest;
}

/** One builder for every tab: clears all panel keys, then applies `fields`. */
function withWorkspacePanelSearch<T extends Record<string, unknown>, Legacy>(
  params: T,
  fields: WorkspaceRouteSearch & {
    diff?: "1" | undefined;
    diffTurnId?: TurnId | undefined;
    diffFilePath?: string | undefined;
    preview?: "1" | undefined;
  },
): WorkspacePanelSearch<T, Legacy> {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: undefined,
    workspaceTab: undefined,
    workspaceAgentKey: undefined,
    workspacePr: undefined,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
    ...fields,
    // Each exported builder states the legacy diff/preview shape it writes.
  } as unknown as WorkspacePanelSearch<T, Legacy>;
}

/** Closes the workspace panel: every key it owns is cleared. */
export function buildCloseWorkspacePanelSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {});
}

export function buildOpenWorkspaceSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1" });
}

export function buildOpenReviewSearch<T extends Record<string, unknown>>(
  params: T,
  input?: {
    diffTurnId?: TurnId | undefined;
    diffFilePath?: string | undefined;
  },
): WorkspacePanelSearch<T, { diff: "1"; preview?: undefined }> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "review",
    diff: "1",
    diffTurnId: input?.diffTurnId,
    diffFilePath: input?.diffTurnId ? input.diffFilePath : undefined,
  });
}

export function buildOpenFilesSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, { diff?: undefined; preview: "1" }> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "files",
    preview: "1",
  });
}

export function buildOpenTerminalSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1", workspaceTab: "terminal" });
}

export function buildOpenSimulatorSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1", workspaceTab: "simulator" });
}

export function buildOpenBrowserSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1", workspaceTab: "browser" });
}

/**
 * Pull request tab. Without a number the tab follows the thread's own change
 * request; a number pins another one (a stack layer, a linked PR).
 */
export function buildOpenPullRequestSearch<T extends Record<string, unknown>>(
  params: T,
  pullRequestNumber?: number,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "pullRequest",
    workspacePr: normalizePositiveInt(pullRequestNumber),
  });
}

export function buildOpenAgentsSearch<T extends Record<string, unknown>>(
  params: T,
  agentKey?: string,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "agents",
    workspaceAgentKey: agentKey,
  });
}

export function buildOpenAgentSearch<T extends Record<string, unknown>>(
  params: T,
  agentKey: string,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "agent",
    workspaceAgentKey: agentKey,
  });
}

export function parseWorkspaceRouteSearch(search: Record<string, unknown>): WorkspaceRouteSearch {
  const workspaceOpen = search.workspaceOpen === "1" ? "1" : undefined;
  const workspaceTab = normalizeWorkspaceTab(search.workspaceTab);
  if (!workspaceTab) {
    return workspaceOpen ? { workspaceOpen } : {};
  }

  const workspaceAgentKey =
    workspaceTab === "agent" || workspaceTab === "agents"
      ? normalizeSearchString(search.workspaceAgentKey)
      : undefined;
  if (workspaceTab === "agent" && !workspaceAgentKey) {
    return {};
  }
  const workspacePr =
    workspaceTab === "pullRequest" ? normalizePositiveInt(search.workspacePr) : undefined;

  return {
    workspaceOpen: "1",
    workspaceTab,
    ...(workspaceAgentKey ? { workspaceAgentKey } : {}),
    ...(workspacePr !== undefined ? { workspacePr } : {}),
  };
}
