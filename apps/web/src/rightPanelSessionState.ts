import type { RightPanelRouteSearch } from "./rightPanelRouteSearch";

export type RightPanelSessionSearch = Omit<RightPanelRouteSearch, "messageId">;

const rightPanelSearchByThreadKey = new Map<string, RightPanelSessionSearch>();

export function readRightPanelSessionSearch(
  threadKey: string,
): RightPanelSessionSearch | undefined {
  const remembered = rightPanelSearchByThreadKey.get(threadKey);
  return remembered ? { ...remembered } : undefined;
}

export function rememberRightPanelSessionSearch(
  threadKey: string,
  search: RightPanelRouteSearch,
): void {
  rightPanelSearchByThreadKey.set(threadKey, pickRightPanelSessionSearch(search));
}

export function applyRightPanelSessionSearch(
  search: RightPanelRouteSearch,
  remembered: RightPanelSessionSearch,
): RightPanelRouteSearch {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    preview: _preview,
    workspaceOpen: _workspaceOpen,
    workspaceTab: _workspaceTab,
    workspaceAgentKey: _workspaceAgentKey,
    workspacePr: _workspacePr,
    ...rest
  } = search;
  return {
    ...rest,
    ...remembered,
  };
}

export function pickRightPanelSessionSearch(
  search: RightPanelRouteSearch,
): RightPanelSessionSearch {
  return definedEntries({
    diff: search.diff,
    diffTurnId: search.diffTurnId,
    diffFilePath: search.diffFilePath,
    preview: search.preview,
    workspaceOpen: search.workspaceOpen,
    workspaceTab: search.workspaceTab,
    workspaceAgentKey: search.workspaceAgentKey,
    workspacePr: search.workspacePr,
  });
}

export function clearRightPanelSessionSearch(): void {
  rightPanelSearchByThreadKey.clear();
}

export function copyRightPanelSessionSearch(fromThreadKey: string, toThreadKey: string): void {
  const remembered = rightPanelSearchByThreadKey.get(fromThreadKey);
  if (remembered) {
    rightPanelSearchByThreadKey.set(toThreadKey, { ...remembered });
  }
}

function definedEntries<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
