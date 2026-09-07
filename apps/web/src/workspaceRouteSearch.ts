import { type TurnId } from "@ryco/contracts";

import { stripDiffSearchParams } from "./diffRouteSearch";
import { stripPreviewSearchParams } from "./previewRouteSearch";

export type WorkspacePanelTab =
  | "review"
  | "files"
  | "terminal"
  | "simulator"
  | "browser"
  | "agent"
  | "agents";

export interface WorkspaceRouteSearch {
  workspaceOpen?: "1" | undefined;
  workspaceTab?: WorkspacePanelTab | undefined;
  workspaceAgentKey?: string | undefined;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkspaceTab(value: unknown): WorkspacePanelTab | undefined {
  if (
    value === "review" ||
    value === "files" ||
    value === "terminal" ||
    value === "simulator" ||
    value === "browser" ||
    value === "agent" ||
    value === "agents"
  ) {
    return value;
  }
  return undefined;
}

export function stripWorkspaceSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "workspaceOpen" | "workspaceTab" | "workspaceAgentKey"> {
  const {
    workspaceOpen: _workspaceOpen,
    workspaceTab: _workspaceTab,
    workspaceAgentKey: _workspaceAgentKey,
    ...rest
  } = params;
  return rest as Omit<T, "workspaceOpen" | "workspaceTab" | "workspaceAgentKey">;
}

export function stripWorkspacePanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> {
  return stripWorkspaceSearchParams(
    stripPreviewSearchParams(stripDiffSearchParams(params)),
  ) as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  >;
}

export function buildOpenWorkspaceSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> &
  WorkspaceRouteSearch & {
    diff?: undefined;
    preview?: undefined;
  } {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: "1",
    workspaceTab: undefined,
    workspaceAgentKey: undefined,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
  } as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  > &
    WorkspaceRouteSearch & {
      diff?: undefined;
      preview?: undefined;
    };
}

export function buildOpenReviewSearch<T extends Record<string, unknown>>(
  params: T,
  input?: {
    diffTurnId?: TurnId | undefined;
    diffFilePath?: string | undefined;
  },
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> &
  WorkspaceRouteSearch & {
    diff: "1";
    preview?: undefined;
  } {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: "1",
    workspaceTab: "review",
    workspaceAgentKey: undefined,
    diff: "1",
    diffTurnId: input?.diffTurnId,
    diffFilePath: input?.diffTurnId ? input.diffFilePath : undefined,
    preview: undefined,
  } as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  > &
    WorkspaceRouteSearch & {
      diff: "1";
      preview?: undefined;
    };
}

export function buildOpenFilesSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> &
  WorkspaceRouteSearch & {
    diff?: undefined;
    preview: "1";
  } {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: "1",
    workspaceTab: "files",
    workspaceAgentKey: undefined,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: "1",
  } as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  > &
    WorkspaceRouteSearch & {
      diff?: undefined;
      preview: "1";
    };
}

export function buildOpenTerminalSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> &
  WorkspaceRouteSearch & {
    diff?: undefined;
    preview?: undefined;
  } {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: "1",
    workspaceTab: "terminal",
    workspaceAgentKey: undefined,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
  } as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  > &
    WorkspaceRouteSearch & {
      diff?: undefined;
      preview?: undefined;
    };
}

export function buildOpenSimulatorSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> &
  WorkspaceRouteSearch & {
    diff?: undefined;
    preview?: undefined;
  } {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: "1",
    workspaceTab: "simulator",
    workspaceAgentKey: undefined,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
  } as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  > &
    WorkspaceRouteSearch & {
      diff?: undefined;
      preview?: undefined;
    };
}

export function buildOpenAgentsSearch<T extends Record<string, unknown>>(
  params: T,
  agentKey?: string,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> &
  WorkspaceRouteSearch & {
    diff?: undefined;
    preview?: undefined;
  } {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: "1",
    workspaceTab: "agents",
    workspaceAgentKey: agentKey,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
  } as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  > &
    WorkspaceRouteSearch & {
      diff?: undefined;
      preview?: undefined;
    };
}

export function buildOpenAgentSearch<T extends Record<string, unknown>>(
  params: T,
  agentKey: string,
): Omit<
  T,
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
> &
  WorkspaceRouteSearch & {
    diff?: undefined;
    preview?: undefined;
  } {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: "1",
    workspaceTab: "agent",
    workspaceAgentKey: agentKey,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
  } as Omit<
    T,
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "preview"
    | "workspaceOpen"
    | "workspaceTab"
    | "workspaceAgentKey"
  > &
    WorkspaceRouteSearch & {
      diff?: undefined;
      preview?: undefined;
    };
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

  return {
    workspaceOpen: "1",
    workspaceTab,
    ...(workspaceAgentKey ? { workspaceAgentKey } : {}),
  };
}

export function buildOpenBrowserSearch<T extends Record<string, unknown>>(params: T) {
  return { ...buildOpenWorkspaceSearch(params), workspaceTab: "browser" as const };
}
