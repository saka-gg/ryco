import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";

import { isHostedHubMode } from "./env";

export const PERSISTED_STATE_KEY = "ryco:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "ryco:renderer-state:v8",
  "ryco:renderer-state:v7",
  "ryco:renderer-state:v6",
  "ryco:renderer-state:v5",
  "ryco:renderer-state:v4",
  "ryco:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const DEFAULT_WIDE_COMPOSER_CONTROLS_AUTO_COLLAPSE = true;
const DEFAULT_ALWAYS_USE_BUILD_MODE = true;

export type SidebarMode = "inbox" | "projects";

export function resolveSidebarModeForDocument(input: {
  documentFound: boolean;
  persistedMode: unknown;
}): SidebarMode {
  if (input.persistedMode === "inbox" || input.persistedMode === "projects") {
    return input.persistedMode;
  }
  return input.documentFound ? "projects" : "inbox";
}

function sanitizeWideComposerControlsAutoCollapse(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_WIDE_COMPOSER_CONTROLS_AUTO_COLLAPSE;
}

function sanitizeAlwaysUseBuildMode(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_ALWAYS_USE_BUILD_MODE;
}

export interface PersistedUiState {
  sidebarMode?: SidebarMode;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  projectFolders?: PersistedUiProjectFolder[];
  projectFolderOrder?: string[];
  projectTreeOrder?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  pinnedThreadKeys?: string[];
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  wideComposerControlsAutoCollapse?: boolean;
  alwaysUseBuildMode?: boolean;
}

export type UiProjectFolderId = string;
export type UiProjectTreeItemId = `folder:${UiProjectFolderId}` | `project:${string}`;

export interface PersistedUiProjectFolder {
  id?: string;
  name?: string;
  projectKeys?: string[];
  expanded?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface UiProjectFolder {
  id: UiProjectFolderId;
  name: string;
  projectKeys: string[];
  expanded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
  projectFoldersById: Record<string, UiProjectFolder>;
  projectFolderOrder: string[];
  projectTreeOrder: UiProjectTreeItemId[];
}

export interface UiThreadState {
  pinnedThreadKeys: Record<string, boolean>;
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
  /** Session-only expansion overrides for running and settled turn folds. */
  threadTurnFoldExpandedById: Record<string, Record<string, boolean>>;
  /** Session-only expansion overrides for compact work-log groups. */
  threadWorkGroupExpandedById: Record<string, Record<string, boolean>>;
  /**
   * Per-thread expand state for individual work-log entries (tool calls,
   * terminal commands). Session-only — not persisted.
   *
   * `state[threadKey][entryId]` is `undefined` when the row uses its
   * default state (all entries default closed).
   */
  threadWorkEntryExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiState extends UiProjectState, UiThreadState, UiEndpointState {
  sidebarMode: SidebarMode;
  wideComposerControlsAutoCollapse: boolean;
  alwaysUseBuildMode: boolean;
}

export interface SyncProjectInput {
  /** Physical project key (env + cwd). Used for manual sort order. */
  key: string;
  /** Logical group key. Used for expand/collapse state. */
  logicalKey: string;
  cwd: string;
}

export interface UiSyncScope {
  /** Only a current live catalog can establish that a saved item was deleted. */
  readonly authoritativeEnvironmentIds: ReadonlySet<string>;
}

function retainMissingScopedKey(key: string, scope: UiSyncScope | undefined): boolean {
  if (!scope) return false;
  const separator = key.indexOf(":");
  return separator <= 0 || !scope.authoritativeEnvironmentIds.has(key.slice(0, separator));
}

export interface SyncThreadInput {
  key: string;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  sidebarMode: "inbox",
  projectExpandedById: {},
  projectOrder: [],
  projectFoldersById: {},
  projectFolderOrder: [],
  projectTreeOrder: [],
  pinnedThreadKeys: {},
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  threadTurnFoldExpandedById: {},
  threadWorkGroupExpandedById: {},
  threadWorkEntryExpandedById: {},
  defaultAdvertisedEndpointKey: null,
  wideComposerControlsAutoCollapse: DEFAULT_WIDE_COMPOSER_CONTROLS_AUTO_COLLAPSE,
  alwaysUseBuildMode: DEFAULT_ALWAYS_USE_BUILD_MODE,
};

const persistedCollapsedProjectCwds = new Set<string>();
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
// Pre-fix persisted shape only listed expanded cwds, so anything not listed
// was treated as collapsed. Track whether the loaded blob carried the new
// `collapsedProjectCwds` field so we can preserve that legacy semantic for
// one session after upgrade, until persistState rewrites in the new shape.
let persistedProjectStateUsesLegacyShape = false;
const currentProjectCwdById = new Map<string, string>();
const currentProjectCwdsByLogicalKey = new Map<string, string[]>();
const currentLogicalKeyByPhysicalKey = new Map<string, string>();
let legacyKeysCleanedUp = false;

function nowIso(): string {
  return new Date().toISOString();
}

function makeProjectFolderId(): UiProjectFolderId {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `folder-${globalThis.crypto.randomUUID()}`;
  }
  return `folder-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function projectFolderTreeItemId(folderId: UiProjectFolderId): UiProjectTreeItemId {
  return `folder:${folderId}`;
}

export function projectTreeItemId(projectKey: string): UiProjectTreeItemId {
  return `project:${projectKey}`;
}

export function parseProjectTreeItemId(
  itemId: string,
): { kind: "folder"; folderId: string } | { kind: "project"; projectKey: string } | null {
  if (itemId.startsWith("folder:")) {
    const folderId = itemId.slice("folder:".length);
    return folderId.length > 0 ? { kind: "folder", folderId } : null;
  }
  if (itemId.startsWith("project:")) {
    const projectKey = itemId.slice("project:".length);
    return projectKey.length > 0 ? { kind: "project", projectKey } : null;
  }
  return null;
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sanitizeIsoDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) {
    return fallback;
  }
  return value;
}

function sanitizeProjectFolders(
  folders: PersistedUiState["projectFolders"],
): Record<string, UiProjectFolder> {
  if (!Array.isArray(folders)) {
    return {};
  }
  const sanitized: Record<string, UiProjectFolder> = {};
  const fallbackTimestamp = nowIso();
  for (const folder of folders) {
    if (!folder || typeof folder !== "object") {
      continue;
    }
    const id = typeof folder.id === "string" ? folder.id.trim() : "";
    const name = typeof folder.name === "string" ? folder.name.trim() : "";
    if (!id || !name || sanitized[id] !== undefined) {
      continue;
    }
    const createdAt = sanitizeIsoDate(folder.createdAt, fallbackTimestamp);
    sanitized[id] = {
      id,
      name,
      projectKeys: uniqueNonEmptyStrings(folder.projectKeys ?? []),
      expanded: folder.expanded !== false,
      createdAt,
      updatedAt: sanitizeIsoDate(folder.updatedAt, createdAt),
    };
  }
  return sanitized;
}

function sanitizeProjectFolderOrder(
  order: PersistedUiState["projectFolderOrder"],
  foldersById: Record<string, UiProjectFolder>,
): string[] {
  const knownFolderIds = new Set(Object.keys(foldersById));
  const result: string[] = [];
  for (const folderId of uniqueNonEmptyStrings(order ?? [])) {
    if (knownFolderIds.has(folderId)) {
      result.push(folderId);
    }
  }
  for (const folderId of Object.keys(foldersById)) {
    if (!result.includes(folderId)) {
      result.push(folderId);
    }
  }
  return result;
}

function sanitizeProjectTreeOrder(
  order: PersistedUiState["projectTreeOrder"],
  foldersById: Record<string, UiProjectFolder>,
): UiProjectTreeItemId[] {
  if (!Array.isArray(order)) {
    return [];
  }
  const seen = new Set<string>();
  const result: UiProjectTreeItemId[] = [];
  for (const itemId of order) {
    if (typeof itemId !== "string" || seen.has(itemId)) {
      continue;
    }
    const parsed = parseProjectTreeItemId(itemId);
    if (!parsed) {
      continue;
    }
    if (parsed.kind === "folder" && foldersById[parsed.folderId] === undefined) {
      continue;
    }
    seen.add(itemId);
    result.push(itemId as UiProjectTreeItemId);
  }
  return result;
}

function rootProjectKeyForPhysicalProjectKey(projectKey: string): string {
  return currentLogicalKeyByPhysicalKey.get(projectKey) ?? projectKey;
}

function rootProjectKeysForProjectKeys(projectKeys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const projectKey of projectKeys) {
    const rootProjectKey = rootProjectKeyForPhysicalProjectKey(projectKey);
    if (!seen.has(rootProjectKey)) {
      seen.add(rootProjectKey);
      result.push(rootProjectKey);
    }
  }
  return result;
}

function rootProjectKeysInFolders(foldersById: Record<string, UiProjectFolder>): Set<string> {
  const keys = new Set<string>();
  for (const folder of Object.values(foldersById)) {
    for (const projectKey of folder.projectKeys) {
      keys.add(rootProjectKeyForPhysicalProjectKey(projectKey));
    }
  }
  return keys;
}

function removeProjectTreeItemsForProjectKeys(
  treeOrder: readonly UiProjectTreeItemId[],
  projectKeys: readonly string[],
): UiProjectTreeItemId[] {
  const physicalProjectKeys = new Set(projectKeys);
  const rootProjectKeys = new Set(rootProjectKeysForProjectKeys(projectKeys));
  return treeOrder.filter((itemId) => {
    const parsed = parseProjectTreeItemId(itemId);
    return (
      parsed?.kind !== "project" ||
      (!physicalProjectKeys.has(parsed.projectKey) && !rootProjectKeys.has(parsed.projectKey))
    );
  });
}

function normalizeProjectTreeOrder(input: {
  projectKeys: readonly string[];
  rootProjectKeys?: readonly string[];
  foldersById: Record<string, UiProjectFolder>;
  folderOrder: readonly string[];
  treeOrder: readonly UiProjectTreeItemId[];
}): UiProjectTreeItemId[] {
  const rootProjectKeys = input.rootProjectKeys ?? rootProjectKeysForProjectKeys(input.projectKeys);
  const currentRootProjectKeys = new Set(rootProjectKeys);
  const folderedRootProjectKeys = rootProjectKeysInFolders(input.foldersById);
  const seen = new Set<string>();
  const result: UiProjectTreeItemId[] = [];

  for (const itemId of input.treeOrder) {
    if (seen.has(itemId)) {
      continue;
    }
    const parsed = parseProjectTreeItemId(itemId);
    if (!parsed) {
      continue;
    }
    if (parsed.kind === "folder") {
      if (input.foldersById[parsed.folderId] === undefined) {
        continue;
      }
    } else if (
      !currentRootProjectKeys.has(parsed.projectKey) ||
      folderedRootProjectKeys.has(parsed.projectKey)
    ) {
      continue;
    }
    seen.add(itemId);
    result.push(itemId);
  }

  for (const folderId of input.folderOrder) {
    const itemId = projectFolderTreeItemId(folderId);
    if (input.foldersById[folderId] !== undefined && !seen.has(itemId)) {
      seen.add(itemId);
      result.push(itemId);
    }
  }

  for (const projectKey of rootProjectKeys) {
    const itemId = projectTreeItemId(projectKey);
    if (!folderedRootProjectKeys.has(projectKey) && !seen.has(itemId)) {
      seen.add(itemId);
      result.push(itemId);
    }
  }

  return result;
}

function insertAt<T>(values: readonly T[], inserted: readonly T[], index?: number): T[] {
  const boundedIndex =
    typeof index === "number" && Number.isFinite(index)
      ? Math.max(0, Math.min(values.length, Math.trunc(index)))
      : values.length;
  return [...values.slice(0, boundedIndex), ...inserted, ...values.slice(boundedIndex)];
}

function removeProjectKeysFromAllFolders(
  foldersById: Record<string, UiProjectFolder>,
  projectKeys: ReadonlySet<string>,
  updatedAt: string,
): Record<string, UiProjectFolder> {
  let changed = false;
  const nextEntries = Object.entries(foldersById).map(([folderId, folder]) => {
    const projectKeysForFolder = folder.projectKeys.filter((key) => !projectKeys.has(key));
    if (projectKeysForFolder.length === folder.projectKeys.length) {
      return [folderId, folder] as const;
    }
    changed = true;
    return [
      folderId,
      {
        ...folder,
        projectKeys: projectKeysForFolder,
        updatedAt,
      },
    ] as const;
  });
  return changed ? Object.fromEntries(nextEntries) : foldersById;
}

export function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        const parsed = JSON.parse(legacyRaw) as PersistedUiState;
        if (!isHostedHubMode()) {
          hydratePersistedProjectState(parsed);
        }
        return { ...initialState, sidebarMode: "projects" };
      }
      return initialState;
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    const sidebarMode = resolveSidebarModeForDocument({
      documentFound: true,
      persistedMode: parsed.sidebarMode,
    });
    if (isHostedHubMode()) {
      return { ...initialState, sidebarMode };
    }
    hydratePersistedProjectState(parsed);
    const projectFoldersById = sanitizeProjectFolders(parsed.projectFolders);
    const projectFolderOrder = sanitizeProjectFolderOrder(
      parsed.projectFolderOrder,
      projectFoldersById,
    );
    return {
      ...initialState,
      sidebarMode,
      projectFoldersById,
      projectFolderOrder,
      projectTreeOrder: sanitizeProjectTreeOrder(parsed.projectTreeOrder, projectFoldersById),
      defaultAdvertisedEndpointKey:
        typeof parsed.defaultAdvertisedEndpointKey === "string" &&
        parsed.defaultAdvertisedEndpointKey.length > 0
          ? parsed.defaultAdvertisedEndpointKey
          : null,
      pinnedThreadKeys: sanitizePersistedPinnedThreadKeys(parsed.pinnedThreadKeys),
      threadChangedFilesExpandedById: sanitizePersistedThreadChangedFilesExpanded(
        parsed.threadChangedFilesExpandedById,
      ),
      wideComposerControlsAutoCollapse: sanitizeWideComposerControlsAutoCollapse(
        parsed.wideComposerControlsAutoCollapse,
      ),
      alwaysUseBuildMode: sanitizeAlwaysUseBuildMode(parsed.alwaysUseBuildMode),
    };
  } catch {
    return initialState;
  }
}

function sanitizePersistedPinnedThreadKeys(
  value: PersistedUiState["pinnedThreadKeys"],
): Record<string, boolean> {
  return Object.fromEntries(
    uniqueNonEmptyStrings(value ?? []).map((threadKey) => [threadKey, true]),
  );
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean" && expanded === false) {
        nextTurns[turnId] = false;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

export function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedCollapsedProjectCwds.clear();
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  persistedProjectStateUsesLegacyShape = !Array.isArray(parsed.collapsedProjectCwds);
  for (const cwd of parsed.collapsedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedCollapsedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (isHostedHubMode()) {
      window.localStorage.setItem(
        PERSISTED_STATE_KEY,
        JSON.stringify({ sidebarMode: state.sidebarMode } satisfies PersistedUiState),
      );
      return;
    }
    // Persist collapsed cwds explicitly so an empty/missing field unambiguously
    // means "first install" rather than "user collapsed everything"; without
    // this, the syncProjects fallback would re-expand all rows on next launch.
    const collapsedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => !expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    const projectFolders = state.projectFolderOrder.flatMap((folderId) => {
      const folder = state.projectFoldersById[folderId];
      return folder
        ? [
            {
              id: folder.id,
              name: folder.name,
              projectKeys: folder.projectKeys,
              expanded: folder.expanded,
              createdAt: folder.createdAt,
              updatedAt: folder.updatedAt,
            } satisfies PersistedUiProjectFolder,
          ]
        : [];
    });
    const pinnedThreadKeys = Object.entries(state.pinnedThreadKeys).flatMap(
      ([threadKey, pinned]) => (pinned ? [threadKey] : []),
    );
    const threadChangedFilesExpandedById = Object.fromEntries(
      Object.entries(state.threadChangedFilesExpandedById).flatMap(([threadId, turns]) => {
        const nextTurns = Object.fromEntries(
          Object.entries(turns).filter(([, expanded]) => expanded === false),
        );
        return Object.keys(nextTurns).length > 0 ? [[threadId, nextTurns]] : [];
      }),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        sidebarMode: state.sidebarMode,
        collapsedProjectCwds,
        expandedProjectCwds,
        projectOrderCwds,
        projectFolders,
        projectFolderOrder: state.projectFolderOrder,
        projectTreeOrder: state.projectTreeOrder,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        pinnedThreadKeys,
        threadChangedFilesExpandedById,
        wideComposerControlsAutoCollapse: state.wideComposerControlsAutoCollapse,
        alwaysUseBuildMode: state.alwaysUseBuildMode,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function projectOrdersEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

function projectFoldersEqual(
  left: Record<string, UiProjectFolder>,
  right: Record<string, UiProjectFolder>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [folderId, leftFolder] of leftEntries) {
    const rightFolder = right[folderId];
    if (!rightFolder) {
      return false;
    }
    if (
      leftFolder.id !== rightFolder.id ||
      leftFolder.name !== rightFolder.name ||
      leftFolder.expanded !== rightFolder.expanded ||
      leftFolder.createdAt !== rightFolder.createdAt ||
      leftFolder.updatedAt !== rightFolder.updatedAt ||
      !projectOrdersEqual(leftFolder.projectKeys, rightFolder.projectKeys)
    ) {
      return false;
    }
  }
  return true;
}

function nestedBooleanRecordsEqual(
  left: Record<string, Record<string, boolean>>,
  right: Record<string, Record<string, boolean>>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (!(key in right) || !recordsEqual(value, right[key]!)) {
      return false;
    }
  }
  return true;
}

export function syncProjects(
  state: UiState,
  projects: readonly SyncProjectInput[],
  scope?: UiSyncScope,
): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousLogicalKeyByPhysicalKey = new Map(currentLogicalKeyByPhysicalKey);
  for (const key of currentProjectCwdById.keys()) {
    if (retainMissingScopedKey(key, scope)) continue;
    currentProjectCwdById.delete(key);
    currentLogicalKeyByPhysicalKey.delete(key);
  }
  for (const project of projects) {
    currentProjectCwdById.set(project.key, project.cwd);
    currentLogicalKeyByPhysicalKey.set(project.key, project.logicalKey);
  }
  currentProjectCwdsByLogicalKey.clear();
  for (const [key, cwd] of currentProjectCwdById) {
    const logicalKey = currentLogicalKeyByPhysicalKey.get(key)!;
    const cwds = currentProjectCwdsByLogicalKey.get(logicalKey);
    if (cwds) {
      if (!cwds.includes(cwd)) {
        cwds.push(cwd);
      }
    } else {
      currentProjectCwdsByLogicalKey.set(logicalKey, [cwd]);
    }
  }
  // Build reverse map: for each new logical key, which previous logical keys
  // did its member projects live under? Lets us preserve expand state when a
  // project's logical key changes (e.g. late-arriving repo metadata flips the
  // group identity).
  const previousLogicalKeysByNewLogicalKey = new Map<string, Set<string>>();
  for (const project of projects) {
    const previousLogicalKey = previousLogicalKeyByPhysicalKey.get(project.key);
    if (!previousLogicalKey || previousLogicalKey === project.logicalKey) {
      continue;
    }
    const set = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
    if (set) {
      set.add(previousLogicalKey);
    } else {
      previousLogicalKeysByNewLogicalKey.set(project.logicalKey, new Set([previousLogicalKey]));
    }
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.key) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = Object.fromEntries(
    [...previousLogicalKeyByPhysicalKey].flatMap(([key, logicalKey]) =>
      retainMissingScopedKey(key, scope) && logicalKey in state.projectExpandedById
        ? [[logicalKey, state.projectExpandedById[logicalKey]!]]
        : [],
    ),
  );
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    if (!(project.logicalKey in nextExpandedById)) {
      const groupCwds = currentProjectCwdsByLogicalKey.get(project.logicalKey) ?? [project.cwd];
      const fallbackFromPreviousLogicalKey = (() => {
        const previousKeys = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
        if (!previousKeys) {
          return undefined;
        }
        for (const previousKey of previousKeys) {
          if (previousKey in previousExpandedById) {
            return previousExpandedById[previousKey];
          }
        }
        return undefined;
      })();
      const fallbackFromPersistedShape = (() => {
        if (groupCwds.some((cwd) => persistedExpandedProjectCwds.has(cwd))) {
          return true;
        }
        if (groupCwds.some((cwd) => persistedCollapsedProjectCwds.has(cwd))) {
          return false;
        }
        if (persistedProjectStateUsesLegacyShape && persistedExpandedProjectCwds.size > 0) {
          return false;
        }
        return true;
      })();
      const expanded =
        previousExpandedById[project.logicalKey] ??
        fallbackFromPreviousLogicalKey ??
        fallbackFromPersistedShape;
      nextExpandedById[project.logicalKey] = expanded;
    }
    return {
      id: project.key,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const currentProjectIds = new Set(mappedProjects.map((project) => project.id));
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<string>();
          const orderedProjectIds: string[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (currentProjectIds.has(projectId) ? projectId : undefined) ??
              (retainMissingScopedKey(projectId, scope) ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  const currentProjectKeySet = new Set(mappedProjects.map((project) => project.id));
  let projectFoldersById = state.projectFoldersById;
  const nextFolderEntries = Object.entries(state.projectFoldersById).map(
    ([folderId, folder]) =>
      [
        folderId,
        {
          ...folder,
          projectKeys: folder.projectKeys.filter(
            (projectKey) =>
              currentProjectKeySet.has(projectKey) || retainMissingScopedKey(projectKey, scope),
          ),
        },
      ] as const,
  );
  const nextProjectFoldersById = Object.fromEntries(nextFolderEntries);
  if (!projectFoldersEqual(state.projectFoldersById, nextProjectFoldersById)) {
    projectFoldersById = nextProjectFoldersById;
  }
  const projectFolderOrder = state.projectFolderOrder.filter(
    (folderId) => projectFoldersById[folderId] !== undefined,
  );
  for (const folderId of Object.keys(projectFoldersById)) {
    if (!projectFolderOrder.includes(folderId)) {
      projectFolderOrder.push(folderId);
    }
  }
  const projectTreeOrder = normalizeProjectTreeOrder({
    projectKeys: nextProjectOrder,
    rootProjectKeys: rootProjectKeysForProjectKeys(nextProjectOrder),
    foldersById: projectFoldersById,
    folderOrder: projectFolderOrder,
    treeOrder: state.projectTreeOrder,
  });

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    projectFoldersEqual(state.projectFoldersById, projectFoldersById) &&
    projectOrdersEqual(state.projectFolderOrder, projectFolderOrder) &&
    projectOrdersEqual(state.projectTreeOrder, projectTreeOrder) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
    projectFoldersById,
    projectFolderOrder,
    projectTreeOrder,
  };
}

export function syncThreads(
  state: UiState,
  threads: readonly SyncThreadInput[],
  scope?: UiSyncScope,
): UiState {
  const retainedThreadIds = new Set(threads.map((thread) => thread.key));
  const retainThread = (key: string) =>
    retainedThreadIds.has(key) || retainMissingScopedKey(key, scope);
  const nextPinnedThreadKeys = Object.fromEntries(
    Object.entries(state.pinnedThreadKeys).filter(([threadId]) => retainThread(threadId)),
  );
  const nextThreadLastVisitedAtById = Object.fromEntries(
    Object.entries(state.threadLastVisitedAtById).filter(([threadId]) => retainThread(threadId)),
  );
  for (const thread of threads) {
    if (
      nextThreadLastVisitedAtById[thread.key] === undefined &&
      thread.seedVisitedAt !== undefined &&
      thread.seedVisitedAt.length > 0
    ) {
      nextThreadLastVisitedAtById[thread.key] = thread.seedVisitedAt;
    }
  }
  const nextThreadChangedFilesExpandedById = Object.fromEntries(
    Object.entries(state.threadChangedFilesExpandedById).filter(([threadId]) =>
      retainThread(threadId),
    ),
  );
  const nextThreadWorkEntryExpandedById = Object.fromEntries(
    Object.entries(state.threadWorkEntryExpandedById).filter(([threadId]) =>
      retainThread(threadId),
    ),
  );
  const nextThreadTurnFoldExpandedById = Object.fromEntries(
    Object.entries(state.threadTurnFoldExpandedById).filter(([threadId]) => retainThread(threadId)),
  );
  const nextThreadWorkGroupExpandedById = Object.fromEntries(
    Object.entries(state.threadWorkGroupExpandedById).filter(([threadId]) =>
      retainThread(threadId),
    ),
  );
  if (
    recordsEqual(state.pinnedThreadKeys, nextPinnedThreadKeys) &&
    recordsEqual(state.threadLastVisitedAtById, nextThreadLastVisitedAtById) &&
    nestedBooleanRecordsEqual(
      state.threadChangedFilesExpandedById,
      nextThreadChangedFilesExpandedById,
    ) &&
    nestedBooleanRecordsEqual(state.threadTurnFoldExpandedById, nextThreadTurnFoldExpandedById) &&
    nestedBooleanRecordsEqual(state.threadWorkGroupExpandedById, nextThreadWorkGroupExpandedById) &&
    nestedBooleanRecordsEqual(state.threadWorkEntryExpandedById, nextThreadWorkEntryExpandedById)
  ) {
    return state;
  }
  return {
    ...state,
    pinnedThreadKeys: nextPinnedThreadKeys,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
    threadTurnFoldExpandedById: nextThreadTurnFoldExpandedById,
    threadWorkGroupExpandedById: nextThreadWorkGroupExpandedById,
    threadWorkEntryExpandedById: nextThreadWorkEntryExpandedById,
  };
}

export function markThreadVisited(state: UiState, threadId: string, visitedAt?: string): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: at,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function setThreadPinned(state: UiState, threadId: string, pinned: boolean): UiState {
  if ((state.pinnedThreadKeys[threadId] === true) === pinned) {
    return state;
  }

  if (!pinned) {
    const nextPinnedThreadKeys = { ...state.pinnedThreadKeys };
    delete nextPinnedThreadKeys[threadId];
    return {
      ...state,
      pinnedThreadKeys: nextPinnedThreadKeys,
    };
  }

  return {
    ...state,
    pinnedThreadKeys: {
      ...state.pinnedThreadKeys,
      [threadId]: true,
    },
  };
}

export function toggleThreadPinned(state: UiState, threadId: string): UiState {
  return setThreadPinned(state, threadId, state.pinnedThreadKeys[threadId] !== true);
}

export function clearThreadUi(state: UiState, threadId: string): UiState {
  const hasPinnedState = threadId in state.pinnedThreadKeys;
  const hasVisitedState = threadId in state.threadLastVisitedAtById;
  const hasChangedFilesState = threadId in state.threadChangedFilesExpandedById;
  const hasTurnFoldState = threadId in state.threadTurnFoldExpandedById;
  const hasWorkGroupState = threadId in state.threadWorkGroupExpandedById;
  const hasWorkEntryState = threadId in state.threadWorkEntryExpandedById;
  if (
    !hasPinnedState &&
    !hasVisitedState &&
    !hasChangedFilesState &&
    !hasTurnFoldState &&
    !hasWorkGroupState &&
    !hasWorkEntryState
  ) {
    return state;
  }
  const nextPinnedThreadKeys = { ...state.pinnedThreadKeys };
  const nextThreadLastVisitedAtById = { ...state.threadLastVisitedAtById };
  const nextThreadChangedFilesExpandedById = { ...state.threadChangedFilesExpandedById };
  const nextThreadTurnFoldExpandedById = { ...state.threadTurnFoldExpandedById };
  const nextThreadWorkGroupExpandedById = { ...state.threadWorkGroupExpandedById };
  const nextThreadWorkEntryExpandedById = { ...state.threadWorkEntryExpandedById };
  delete nextPinnedThreadKeys[threadId];
  delete nextThreadLastVisitedAtById[threadId];
  delete nextThreadChangedFilesExpandedById[threadId];
  delete nextThreadTurnFoldExpandedById[threadId];
  delete nextThreadWorkGroupExpandedById[threadId];
  delete nextThreadWorkEntryExpandedById[threadId];
  return {
    ...state,
    pinnedThreadKeys: nextPinnedThreadKeys,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
    threadTurnFoldExpandedById: nextThreadTurnFoldExpandedById,
    threadWorkGroupExpandedById: nextThreadWorkGroupExpandedById,
    threadWorkEntryExpandedById: nextThreadWorkEntryExpandedById,
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  const currentExpanded = currentThreadState[turnId] ?? true;
  if (currentExpanded === expanded) {
    return state;
  }

  if (expanded) {
    if (!(turnId in currentThreadState)) {
      return state;
    }

    const nextThreadState = { ...currentThreadState };
    delete nextThreadState[turnId];
    if (Object.keys(nextThreadState).length === 0) {
      const nextState = { ...state.threadChangedFilesExpandedById };
      delete nextState[threadId];
      return {
        ...state,
        threadChangedFilesExpandedById: nextState,
      };
    }

    return {
      ...state,
      threadChangedFilesExpandedById: {
        ...state.threadChangedFilesExpandedById,
        [threadId]: nextThreadState,
      },
    };
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: false,
      },
    },
  };
}

export function setThreadWorkEntryExpanded(
  state: UiState,
  threadId: string,
  entryId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadWorkEntryExpandedById[threadId] ?? {};
  if (currentThreadState[entryId] === expanded) {
    return state;
  }
  return {
    ...state,
    threadWorkEntryExpandedById: {
      ...state.threadWorkEntryExpandedById,
      [threadId]: {
        ...currentThreadState,
        [entryId]: expanded,
      },
    },
  };
}

function setThreadScopedExpanded(
  byThread: Record<string, Record<string, boolean>>,
  threadId: string,
  itemId: string,
  expanded: boolean,
): Record<string, Record<string, boolean>> | null {
  const currentThreadState = byThread[threadId] ?? {};
  if (currentThreadState[itemId] === expanded) {
    return null;
  }
  return {
    ...byThread,
    [threadId]: {
      ...currentThreadState,
      [itemId]: expanded,
    },
  };
}

export function setThreadTurnFoldExpanded(
  state: UiState,
  threadId: string,
  foldId: string,
  expanded: boolean,
): UiState {
  const next = setThreadScopedExpanded(
    state.threadTurnFoldExpandedById,
    threadId,
    foldId,
    expanded,
  );
  return next ? { ...state, threadTurnFoldExpandedById: next } : state;
}

export function setThreadWorkGroupExpanded(
  state: UiState,
  threadId: string,
  groupId: string,
  expanded: boolean,
): UiState {
  const next = setThreadScopedExpanded(
    state.threadWorkGroupExpandedById,
    threadId,
    groupId,
    expanded,
  );
  return next ? { ...state, threadWorkGroupExpandedById: next } : state;
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function setWideComposerControlsAutoCollapse(state: UiState, enabled: boolean): UiState {
  if (state.wideComposerControlsAutoCollapse === enabled) {
    return state;
  }
  return {
    ...state,
    wideComposerControlsAutoCollapse: enabled,
  };
}

export function setAlwaysUseBuildMode(state: UiState, enabled: boolean): UiState {
  if (state.alwaysUseBuildMode === enabled) {
    return state;
  }
  return {
    ...state,
    alwaysUseBuildMode: enabled,
  };
}

export function toggleProject(state: UiState, projectId: string): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(state: UiState, projectId: string, expanded: boolean): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function createProjectFolder(
  state: UiState,
  name: string,
  initialProjectKeys: readonly string[] = [],
  options?: { folderId?: string; now?: string },
): UiState {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return state;
  }
  const folderId = options?.folderId?.trim() || makeProjectFolderId();
  if (!folderId || state.projectFoldersById[folderId] !== undefined) {
    return state;
  }
  const timestamp = options?.now ?? nowIso();
  const projectKeys = uniqueNonEmptyStrings(initialProjectKeys);
  const projectKeySet = new Set(projectKeys);
  const projectFoldersByIdWithoutMoved = removeProjectKeysFromAllFolders(
    state.projectFoldersById,
    projectKeySet,
    timestamp,
  );
  const projectFoldersById = {
    ...projectFoldersByIdWithoutMoved,
    [folderId]: {
      id: folderId,
      name: trimmedName,
      projectKeys,
      expanded: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
  const projectFolderOrder = [...state.projectFolderOrder, folderId];
  const projectTreeOrder = normalizeProjectTreeOrder({
    projectKeys: state.projectOrder,
    rootProjectKeys: rootProjectKeysForProjectKeys(state.projectOrder),
    foldersById: projectFoldersById,
    folderOrder: projectFolderOrder,
    treeOrder: [
      ...removeProjectTreeItemsForProjectKeys(state.projectTreeOrder, projectKeys),
      projectFolderTreeItemId(folderId),
    ],
  });
  return {
    ...state,
    projectFoldersById,
    projectFolderOrder,
    projectTreeOrder,
  };
}

export function renameProjectFolder(
  state: UiState,
  folderId: string,
  name: string,
  updatedAt = nowIso(),
): UiState {
  const folder = state.projectFoldersById[folderId];
  const trimmedName = name.trim();
  if (!folder || !trimmedName || folder.name === trimmedName) {
    return state;
  }
  return {
    ...state,
    projectFoldersById: {
      ...state.projectFoldersById,
      [folderId]: {
        ...folder,
        name: trimmedName,
        updatedAt,
      },
    },
  };
}

export function deleteProjectFolder(state: UiState, folderId: string): UiState {
  if (state.projectFoldersById[folderId] === undefined) {
    return state;
  }
  const { [folderId]: _removed, ...projectFoldersById } = state.projectFoldersById;
  const projectFolderOrder = state.projectFolderOrder.filter((id) => id !== folderId);
  const projectTreeOrder = normalizeProjectTreeOrder({
    projectKeys: state.projectOrder,
    rootProjectKeys: rootProjectKeysForProjectKeys(state.projectOrder),
    foldersById: projectFoldersById,
    folderOrder: projectFolderOrder,
    treeOrder: state.projectTreeOrder.filter(
      (itemId) => itemId !== projectFolderTreeItemId(folderId),
    ),
  });
  return {
    ...state,
    projectFoldersById,
    projectFolderOrder,
    projectTreeOrder,
  };
}

export function setProjectFolderExpanded(
  state: UiState,
  folderId: string,
  expanded: boolean,
): UiState {
  const folder = state.projectFoldersById[folderId];
  if (!folder || folder.expanded === expanded) {
    return state;
  }
  return {
    ...state,
    projectFoldersById: {
      ...state.projectFoldersById,
      [folderId]: {
        ...folder,
        expanded,
        updatedAt: nowIso(),
      },
    },
  };
}

export function moveProjectsToFolder(
  state: UiState,
  projectKeysInput: readonly string[],
  folderId: string,
  targetIndex?: number,
): UiState {
  const folder = state.projectFoldersById[folderId];
  const projectKeys = uniqueNonEmptyStrings(projectKeysInput).filter((projectKey) =>
    state.projectOrder.includes(projectKey),
  );
  if (!folder || projectKeys.length === 0) {
    return state;
  }
  const timestamp = nowIso();
  const projectKeySet = new Set(projectKeys);
  const withoutMoved = removeProjectKeysFromAllFolders(
    state.projectFoldersById,
    projectKeySet,
    timestamp,
  );
  const targetFolder = withoutMoved[folderId] ?? folder;
  const targetKeys = targetFolder.projectKeys.filter(
    (projectKey) => !projectKeySet.has(projectKey),
  );
  const nextTargetKeys = insertAt(targetKeys, projectKeys, targetIndex);
  const projectFoldersById = {
    ...withoutMoved,
    [folderId]: {
      ...targetFolder,
      projectKeys: nextTargetKeys,
      updatedAt: timestamp,
    },
  };
  const projectTreeOrder = normalizeProjectTreeOrder({
    projectKeys: state.projectOrder,
    rootProjectKeys: rootProjectKeysForProjectKeys(state.projectOrder),
    foldersById: projectFoldersById,
    folderOrder: state.projectFolderOrder,
    treeOrder: removeProjectTreeItemsForProjectKeys(state.projectTreeOrder, projectKeys),
  });
  return {
    ...state,
    projectFoldersById,
    projectTreeOrder,
  };
}

export function moveProjectsToRoot(
  state: UiState,
  projectKeysInput: readonly string[],
  targetIndex?: number,
): UiState {
  const projectKeys = uniqueNonEmptyStrings(projectKeysInput).filter((projectKey) =>
    state.projectOrder.includes(projectKey),
  );
  if (projectKeys.length === 0) {
    return state;
  }
  const projectKeySet = new Set(projectKeys);
  const movedRootProjectKeys = rootProjectKeysForProjectKeys(projectKeys);
  const projectFoldersById = removeProjectKeysFromAllFolders(
    state.projectFoldersById,
    projectKeySet,
    nowIso(),
  );
  const rootOrderWithoutMoved = removeProjectTreeItemsForProjectKeys(
    state.projectTreeOrder,
    projectKeys,
  );
  const projectTreeOrder = normalizeProjectTreeOrder({
    projectKeys: state.projectOrder,
    rootProjectKeys: rootProjectKeysForProjectKeys(state.projectOrder),
    foldersById: projectFoldersById,
    folderOrder: state.projectFolderOrder,
    treeOrder: insertAt(
      rootOrderWithoutMoved,
      movedRootProjectKeys.map((projectKey) => projectTreeItemId(projectKey)),
      targetIndex,
    ),
  });
  return {
    ...state,
    projectFoldersById,
    projectTreeOrder,
  };
}

export function moveProjectsBetweenFolders(
  state: UiState,
  projectKeys: readonly string[],
  _sourceFolderId: string,
  targetFolderId: string,
  targetIndex?: number,
): UiState {
  return moveProjectsToFolder(state, projectKeys, targetFolderId, targetIndex);
}

export function reorderProjects(
  state: UiState,
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = state.projectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...state.projectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

export function reorderProjectTreeItem(
  state: UiState,
  activeItemId: UiProjectTreeItemId,
  overItemId: UiProjectTreeItemId,
): UiState {
  if (activeItemId === overItemId) {
    return state;
  }
  const activeParsed = parseProjectTreeItemId(activeItemId);
  const overParsed = parseProjectTreeItemId(overItemId);
  if (!activeParsed || !overParsed) {
    return state;
  }
  const activeIndex = state.projectTreeOrder.indexOf(activeItemId);
  const overIndex = state.projectTreeOrder.indexOf(overItemId);
  if (activeIndex < 0 || overIndex < 0) {
    return state;
  }
  const projectTreeOrder = [...state.projectTreeOrder];
  const [removed] = projectTreeOrder.splice(activeIndex, 1);
  if (!removed) {
    return state;
  }
  const insertIndex = overIndex;
  projectTreeOrder.splice(insertIndex, 0, removed);
  const nextState = {
    ...state,
    projectTreeOrder,
  };
  if (activeParsed.kind === "project" && overParsed.kind === "project") {
    return reorderProjects(nextState, [activeParsed.projectKey], [overParsed.projectKey]);
  }
  return nextState;
}

interface UiStateStore extends UiState {
  setSidebarMode: (mode: SidebarMode) => void;
  syncProjects: (projects: readonly SyncProjectInput[], scope: UiSyncScope) => void;
  syncThreads: (threads: readonly SyncThreadInput[], scope: UiSyncScope) => void;
  markThreadVisited: (threadId: string, visitedAt?: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadPinned: (threadId: string, pinned: boolean) => void;
  toggleThreadPinned: (threadId: string) => void;
  clearThreadUi: (threadId: string) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setThreadTurnFoldExpanded: (threadId: string, foldId: string, expanded: boolean) => void;
  setThreadWorkGroupExpanded: (threadId: string, groupId: string, expanded: boolean) => void;
  setThreadWorkEntryExpanded: (threadId: string, entryId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setWideComposerControlsAutoCollapse: (enabled: boolean) => void;
  setAlwaysUseBuildMode: (enabled: boolean) => void;
  toggleProject: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  createProjectFolder: (name: string, initialProjectKeys?: readonly string[]) => void;
  renameProjectFolder: (folderId: string, name: string) => void;
  deleteProjectFolder: (folderId: string) => void;
  setProjectFolderExpanded: (folderId: string, expanded: boolean) => void;
  moveProjectsToFolder: (
    projectKeys: readonly string[],
    folderId: string,
    targetIndex?: number,
  ) => void;
  moveProjectsToRoot: (projectKeys: readonly string[], targetIndex?: number) => void;
  moveProjectsBetweenFolders: (
    projectKeys: readonly string[],
    sourceFolderId: string,
    targetFolderId: string,
    targetIndex?: number,
  ) => void;
  reorderProjects: (
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
  reorderProjectTreeItem: (
    activeItemId: UiProjectTreeItemId,
    overItemId: UiProjectTreeItemId,
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  syncProjects: (projects, scope) => set((state) => syncProjects(state, projects, scope)),
  syncThreads: (threads, scope) => set((state) => syncThreads(state, threads, scope)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  setThreadPinned: (threadId, pinned) => set((state) => setThreadPinned(state, threadId, pinned)),
  toggleThreadPinned: (threadId) => set((state) => toggleThreadPinned(state, threadId)),
  clearThreadUi: (threadId) => set((state) => clearThreadUi(state, threadId)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setThreadTurnFoldExpanded: (threadId, foldId, expanded) =>
    set((state) => setThreadTurnFoldExpanded(state, threadId, foldId, expanded)),
  setThreadWorkGroupExpanded: (threadId, groupId, expanded) =>
    set((state) => setThreadWorkGroupExpanded(state, threadId, groupId, expanded)),
  setThreadWorkEntryExpanded: (threadId, entryId, expanded) =>
    set((state) => setThreadWorkEntryExpanded(state, threadId, entryId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  setWideComposerControlsAutoCollapse: (enabled) =>
    set((state) => setWideComposerControlsAutoCollapse(state, enabled)),
  setAlwaysUseBuildMode: (enabled) => set((state) => setAlwaysUseBuildMode(state, enabled)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  createProjectFolder: (name, initialProjectKeys = []) =>
    set((state) => createProjectFolder(state, name, initialProjectKeys)),
  renameProjectFolder: (folderId, name) =>
    set((state) => renameProjectFolder(state, folderId, name)),
  deleteProjectFolder: (folderId) => set((state) => deleteProjectFolder(state, folderId)),
  setProjectFolderExpanded: (folderId, expanded) =>
    set((state) => setProjectFolderExpanded(state, folderId, expanded)),
  moveProjectsToFolder: (projectKeys, folderId, targetIndex) =>
    set((state) => moveProjectsToFolder(state, projectKeys, folderId, targetIndex)),
  moveProjectsToRoot: (projectKeys, targetIndex) =>
    set((state) => moveProjectsToRoot(state, projectKeys, targetIndex)),
  moveProjectsBetweenFolders: (projectKeys, sourceFolderId, targetFolderId, targetIndex) =>
    set((state) =>
      moveProjectsBetweenFolders(state, projectKeys, sourceFolderId, targetFolderId, targetIndex),
    ),
  reorderProjects: (draggedProjectIds, targetProjectIds) =>
    set((state) => reorderProjects(state, draggedProjectIds, targetProjectIds)),
  reorderProjectTreeItem: (activeItemId, overItemId) =>
    set((state) => reorderProjectTreeItem(state, activeItemId, overItemId)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
