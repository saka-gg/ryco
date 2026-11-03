// FILE: addProjectSources.ts
// Purpose: The add-project building blocks the command palette and the add-project dialog share:
//          which nodes can take a project, where folder browsing starts, the clone sources and
//          their readiness, repository resolution, destination path validation, and opening or
//          creating the project once a folder is chosen.
// Layer: Web UI logic. Rendering stays with each surface; nothing here reads a store reactively.

import { isSavedEnvironmentSwitchedOff } from "@ryco/client-runtime/connection";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type {
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  SourceControlCloneRepositoryInput,
  SourceControlDiscoveryResult,
  SourceControlProviderKind,
  SourceControlRepositoryInfo,
} from "@ryco/contracts";
import type { SidebarThreadSortOrder, ThreadEnvMode } from "@ryco/contracts/settings";
import { Option } from "effect";
import { LinkIcon } from "lucide-react";
import { createElement, type ReactNode } from "react";

import { isLocalHubAlias, resolveDeviceName } from "../../deviceName.logic";
import {
  findProjectByPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveInitialProjectBrowsePath,
  resolveProjectPathForDispatch,
} from "../../lib/projectPaths";
import { getLatestThreadForProject, type ThreadSortInput } from "../../lib/threadSort";
import { buildProjectCreateCommand } from "../../lib/projectCreateCommand";
import { isMacPlatform, isWindowsPlatform, newProjectId } from "../../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../../logicalProject";
import type { Project, Thread } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import { AzureDevOpsIcon, BitbucketIcon, ForgejoIcon, GitHubIcon, GitLabIcon } from "../Icons";

/* ───────── Nodes ───────── */

/** A node a project can be added to, as the node step lists it. */
export interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
}

interface SavedEnvironmentLabels {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Set while the machine is switched off. */
  readonly disabledAt?: string | undefined;
}

interface SavedEnvironmentRuntimeLabels {
  readonly descriptor?: { readonly label: string } | null;
}

/**
 * The primary environment first, then every saved one by label. A saved record
 * that is the local Hub's alias of the primary is the same machine and is left
 * out; saved labels prefer the Desktop or hosted machine catalog's name.
 */
export function buildAddProjectEnvironmentOptions(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentLabel: string | null;
  readonly savedEnvironments: Readonly<Record<EnvironmentId, SavedEnvironmentLabels>>;
  readonly savedEnvironmentRuntimeById: Readonly<
    Record<EnvironmentId, SavedEnvironmentRuntimeLabels | undefined>
  >;
  readonly localHubEnvironmentId: EnvironmentId | null;
  /** The Desktop machine catalog in Electron, the hosted node list otherwise. */
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}): AddProjectEnvironmentOption[] {
  const options: AddProjectEnvironmentOption[] = [];
  const seenEnvironmentIds = new Set<EnvironmentId>();
  const { primaryEnvironmentId } = input;

  if (primaryEnvironmentId) {
    seenEnvironmentIds.add(primaryEnvironmentId);
    options.push({
      environmentId: primaryEnvironmentId,
      label: resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: primaryEnvironmentId,
        runtimeLabel: input.primaryEnvironmentLabel,
      }),
      isPrimary: true,
    });
  }

  for (const record of Object.values(input.savedEnvironments)) {
    if (
      // Left out while switched off, as in the sidebar.
      isSavedEnvironmentSwitchedOff(record) ||
      seenEnvironmentIds.has(record.environmentId) ||
      isLocalHubAlias(record.environmentId, primaryEnvironmentId, input.localHubEnvironmentId)
    ) {
      continue;
    }

    const runtimeState = input.savedEnvironmentRuntimeById[record.environmentId];
    options.push({
      environmentId: record.environmentId,
      label: resolveDeviceName({
        environmentId: record.environmentId,
        machines: input.machines,
        fallback: resolveEnvironmentOptionLabel({
          isPrimary: false,
          environmentId: record.environmentId,
          runtimeLabel: runtimeState?.descriptor?.label ?? null,
          savedLabel: record.label,
        }),
      }),
      isPrimary: false,
    });
  }

  options.sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) {
      return left.isPrimary ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });

  return options;
}

/** A node's `platform.os` as the `navigator.platform` string the path helpers expect. */
export function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

interface SavedEnvironmentRuntimeConfig {
  readonly descriptor?: { readonly platform: { readonly os: string } } | null;
  readonly serverConfig?: {
    readonly environment: { readonly platform: { readonly os: string } };
    readonly workspaceAccessRoot?: string | undefined;
    readonly settings: { readonly addProjectBaseDirectory?: string | undefined };
  } | null;
}

/**
 * The platform string for a node's paths: the primary's from its descriptor, a
 * saved node's from its descriptor or server config, else this browser's.
 */
export function resolveAddProjectBrowsePlatform(input: {
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly readPrimaryPlatformOs: () => string | null;
  readonly savedEnvironmentRuntimeById: Readonly<
    Record<EnvironmentId, SavedEnvironmentRuntimeConfig | undefined>
  >;
}): string {
  const { environmentId, primaryEnvironmentId } = input;
  const runtime = environmentId ? input.savedEnvironmentRuntimeById[environmentId] : undefined;
  const os =
    environmentId && primaryEnvironmentId && environmentId === primaryEnvironmentId
      ? input.readPrimaryPlatformOs()
      : environmentId
        ? (runtime?.descriptor?.platform.os ??
          runtime?.serverConfig?.environment.platform.os ??
          null)
        : null;
  return getEnvironmentBrowsePlatform(os);
}

/**
 * Where folder browsing starts on a node: its workspace access root when
 * restricted, else its `addProjectBaseDirectory` setting, else home.
 */
export function resolveAddProjectInitialPath(input: {
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primaryServerConfig: { readonly workspaceAccessRoot?: string | undefined } | null;
  readonly primarySettings: { readonly addProjectBaseDirectory?: string | undefined };
  readonly savedEnvironmentRuntimeById: Readonly<
    Record<EnvironmentId, SavedEnvironmentRuntimeConfig | undefined>
  >;
}): string {
  const { environmentId, primaryEnvironmentId } = input;
  const isPrimary =
    environmentId !== null &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId;
  const savedServerConfig = environmentId
    ? input.savedEnvironmentRuntimeById[environmentId]?.serverConfig
    : null;
  const environmentServerConfig = isPrimary ? input.primaryServerConfig : savedServerConfig;
  const environmentSettings = isPrimary ? input.primarySettings : savedServerConfig?.settings;
  return resolveInitialProjectBrowsePath({
    workspaceAccessRoot: environmentServerConfig?.workspaceAccessRoot,
    configuredBaseDirectory: environmentSettings?.addProjectBaseDirectory,
  });
}

/** "Finder", "Explorer" or "Files": the native folder picker's name on this device. */
export function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "Explorer";
  }
  return "Files";
}

/** The native folder picker opens on this device only: the Desktop app's own node. */
export function canPickProjectFolderNatively(input: {
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    input.environmentId !== null &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined
  );
}

/* ───────── Clone sources ───────── */

export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops"
>;
export type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

export const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "forgejo",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "forgejo",
  "bitbucket",
  "azure-devops",
];

/** The label a provider source's "Setup Required" control carries. */
export const ADD_PROJECT_SETUP_REQUIRED_LABEL = "Setup Required";
/** Its tooltip when the provider gave no hint of its own. */
export const ADD_PROJECT_SETUP_REQUIRED_FALLBACK_HINT =
  "Open Settings -> Source Control to configure this provider.";

export function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "forgejo":
      return "Forgejo";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

export function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "forgejo":
      return "owner/repo";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

export function remoteProjectSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

const REMOTE_PROJECT_SOURCE_ICONS = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  forgejo: ForgejoIcon,
  bitbucket: BitbucketIcon,
  "azure-devops": AzureDevOpsIcon,
  url: LinkIcon,
} satisfies Record<AddProjectRemoteSource, unknown>;

export function remoteProjectSourceIcon(
  source: AddProjectRemoteSource,
  className: string,
): ReactNode {
  return createElement(REMOTE_PROJECT_SOURCE_ICONS[source], { className });
}

/** What the repository field asks for, by source. */
export function remoteRepositoryInputPlaceholder(source: AddProjectRemoteSource): string {
  if (source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${remoteProjectSourceLabel(source)} repository (${remoteProjectSourcePathHint(source)})`;
}

export type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>;

/**
 * Whether each clone source can be used on a node, from its source-control
 * discovery: a plain Git URL always can; a provider needs its CLI available and
 * authenticated, else it carries the provider's setup hint.
 */
export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    ready: false,
    hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
  } as const;
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    forgejo: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return defaultReadiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  const readiness = { ...defaultReadiness };

  for (const source of REMOTE_PROJECT_SOURCES) {
    const kind = remoteProjectSourceProvider(source);
    if (!kind) continue;
    const provider = providerByKind.get(kind);
    if (!provider) {
      readiness[source] = unavailable;
      continue;
    }
    if (provider.status !== "available") {
      readiness[source] = { ready: false, hint: provider.installHint };
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { ready: true, hint: null };
  }

  return readiness;
}

/** Ready providers first, then by label. */
function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return REMOTE_PROJECT_PROVIDER_SOURCES.toSorted((left, right) => {
    const leftReady = readinessBySource[left].ready;
    const rightReady = readinessBySource[right].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right));
  });
}

/** One clone source as a source list shows it. */
export interface AddProjectRemoteSourceOption {
  readonly source: AddProjectRemoteSource;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly ready: boolean;
  /** Why it is not ready (the "Setup Required" tooltip); null when ready. */
  readonly hint: string | null;
}

/** The clone sources in list order: Git URL, then ready providers, then the rest. */
export function listAddProjectRemoteSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): AddProjectRemoteSourceOption[] {
  const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
    "url",
    ...sortAddProjectProviderSources(readinessBySource),
  ];
  return orderedSources.map((source) => {
    const label = remoteProjectSourceLabel(source);
    const readiness = readinessBySource[source];
    return {
      source,
      label,
      title: source === "url" ? "Git URL" : `${label} repository`,
      description:
        source === "url"
          ? "Clone from a remote URL"
          : `Clone ${label} ${remoteProjectSourcePathHint(source)}`,
      ready: readiness.ready,
      hint: readiness.hint,
    };
  });
}

/* ───────── Repositories ───────── */

export function repositorySlugFromNameWithOwner(nameWithOwner: string): string {
  return nameWithOwner.split("/").at(-1)?.trim() ?? nameWithOwner;
}

export function remoteRepositoryItemValue(repository: SourceControlRepositoryInfo): string {
  return `remote-repository:${repository.provider}:${encodeURIComponent(repository.nameWithOwner)}`;
}

/** The URL a provider repository is cloned from: SSH, except Bitbucket, which clones over HTTPS. */
export function cloneUrlForRemoteProjectSource(
  source: AddProjectRemoteSource,
  repository: SourceControlRepositoryInfo,
): string {
  return source === "bitbucket" ? repository.url : repository.sshUrl;
}

/** A repository name without an owner or URL ("ryco", not "sak0a/ryco"). */
export function isBareRepositoryInput(input: string): boolean {
  return !input.includes("/") && !input.includes(":");
}

/** A repository the clone flow settled on. */
export interface ResolvedRemoteRepository {
  readonly repositoryInput: string;
  readonly repository: SourceControlRepositoryInfo | null;
  readonly remoteUrl: string;
}

export type RemoteRepositoryResolution =
  | { readonly kind: "resolved"; readonly resolved: ResolvedRemoteRepository }
  | { readonly kind: "lookup"; readonly provider: AddProjectRemoteProviderKind };

/**
 * What the typed repository is without asking the node: a Git URL is used as
 * typed, and a bare name that the current search narrowed to one repository is
 * that repository. Anything else needs a provider lookup.
 */
export function resolveRemoteRepositoryInput(input: {
  readonly source: AddProjectRemoteSource;
  readonly rawRepository: string;
  /** The query the search results below answer. */
  readonly searchQuery: string;
  readonly searchedRepositories: ReadonlyArray<SourceControlRepositoryInfo>;
}): RemoteRepositoryResolution {
  const provider = remoteProjectSourceProvider(input.source);
  if (!provider) {
    return {
      kind: "resolved",
      resolved: {
        repositoryInput: input.rawRepository,
        repository: null,
        remoteUrl: input.rawRepository,
      },
    };
  }
  if (
    isBareRepositoryInput(input.rawRepository) &&
    input.searchQuery === input.rawRepository &&
    input.searchedRepositories.length === 1
  ) {
    const repository = input.searchedRepositories[0]!;
    return {
      kind: "resolved",
      resolved: {
        repositoryInput: repository.nameWithOwner,
        repository,
        remoteUrl: cloneUrlForRemoteProjectSource(input.source, repository),
      },
    };
  }
  return { kind: "lookup", provider };
}

/** Looks the typed repository up with the node's provider CLI. */
export async function lookupRemoteRepository(input: {
  readonly api: EnvironmentApi;
  readonly provider: AddProjectRemoteProviderKind;
  readonly rawRepository: string;
}): Promise<ResolvedRemoteRepository> {
  const repository = await input.api.sourceControl.lookupRepository({
    provider: input.provider,
    repository: input.rawRepository,
  });
  return {
    repositoryInput: input.rawRepository,
    repository,
    remoteUrl: cloneUrlForRemoteProjectSource(input.provider, repository),
  };
}

/** The clone request for a settled repository; Bitbucket clones over HTTPS. */
export function buildCloneRepositoryInput(input: {
  readonly source: AddProjectRemoteSource;
  readonly repository: SourceControlRepositoryInfo | null;
  readonly remoteUrl: string;
  readonly destinationPath: string;
}): SourceControlCloneRepositoryInput {
  const cloneProvider = remoteProjectSourceProvider(input.source);
  return {
    ...(cloneProvider && input.repository
      ? {
          provider: cloneProvider,
          repository: input.repository.nameWithOwner,
          remoteUrl: input.remoteUrl,
          ...(input.source === "bitbucket" ? { protocol: "https" as const } : {}),
        }
      : {
          remoteUrl: input.remoteUrl,
        }),
    destinationPath: input.destinationPath,
  };
}

/* ───────── Paths ───────── */

export type AddProjectPathValidation =
  | { readonly ok: true; readonly path: string }
  /** `reason` is null for an empty path, which is ignored without a message. */
  | { readonly ok: false; readonly reason: string | null };

/**
 * A typed project or clone destination, checked against the node: Windows paths
 * only on Windows, relative paths only beside an active project (resolved
 * against it), and trailing separators trimmed.
 */
export function validateAddProjectPath(
  rawPath: string,
  input: { readonly platform: string; readonly currentProjectCwd: string | null },
): AddProjectPathValidation {
  const trimmed = rawPath.trim();
  if (isUnsupportedWindowsProjectPath(trimmed, input.platform)) {
    return { ok: false, reason: "Windows-style paths are only supported on Windows." };
  }
  if (isExplicitRelativeProjectPath(trimmed) && !input.currentProjectCwd) {
    return { ok: false, reason: "Relative paths require an active project." };
  }
  const path = resolveProjectPathForDispatch(trimmed, input.currentProjectCwd);
  return path.length === 0 ? { ok: false, reason: null } : { ok: true, path };
}

/* ───────── Opening the project ───────── */

export type OpenOrCreateProjectOutcome =
  | { readonly kind: "opened-existing"; readonly projectId: ProjectId }
  | { readonly kind: "created"; readonly projectId: ProjectId }
  | { readonly kind: "create-failed"; readonly error: unknown };

/**
 * Adds the folder at `cwd` on a node as a project and lands on it. A folder that
 * already is a project there opens instead: its group expands and its latest
 * thread opens, or a new thread starts when it has none. Otherwise the project is
 * created (a missing folder is created with it) and a new thread starts. Only a
 * failed create resolves `create-failed`; a failed new thread is ignored.
 */
export async function openOrCreateProjectAtPath<
  TThread extends Pick<Thread, "environmentId" | "id" | "projectId" | "archivedAt"> &
    ThreadSortInput,
>(input: {
  readonly api: EnvironmentApi;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<TThread>;
  readonly settings: ProjectGroupingSettings & {
    readonly sidebarThreadSortOrder: SidebarThreadSortOrder;
    readonly defaultThreadEnvMode: ThreadEnvMode;
  };
  readonly openThread: (threadRef: ScopedThreadRef) => Promise<void>;
  readonly handleNewThread: (
    projectRef: ScopedProjectRef,
    options: { readonly envMode: ThreadEnvMode },
  ) => Promise<void>;
}): Promise<OpenOrCreateProjectOutcome> {
  const { environmentId, settings } = input;
  const existing = findProjectByPath(
    input.projects.filter((project) => project.environmentId === environmentId),
    input.cwd,
  );
  if (existing) {
    useUiStateStore
      .getState()
      .setProjectExpanded(deriveLogicalProjectKeyFromSettings(existing, settings), true);
    const latestThread = getLatestThreadForProject(
      input.threads.filter((thread) => thread.environmentId === existing.environmentId),
      existing.id,
      settings.sidebarThreadSortOrder,
    );
    if (latestThread) {
      await input.openThread(scopeThreadRef(latestThread.environmentId, latestThread.id));
    } else {
      await input
        .handleNewThread(scopeProjectRef(existing.environmentId, existing.id), {
          envMode: settings.defaultThreadEnvMode,
        })
        .catch(() => undefined);
    }
    return { kind: "opened-existing", projectId: existing.id };
  }

  try {
    const projectId = newProjectId();
    await input.api.orchestration.dispatchCommand(
      buildProjectCreateCommand({
        projectId,
        workspaceRoot: input.cwd,
        createWorkspaceRootIfMissing: true,
      }),
    );
    await input
      .handleNewThread(scopeProjectRef(environmentId, projectId), {
        envMode: settings.defaultThreadEnvMode,
      })
      .catch(() => undefined);
    return { kind: "created", projectId };
  } catch (error) {
    return { kind: "create-failed", error };
  }
}
