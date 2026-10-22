import { canonicalRepositoryPath } from "@ryco/shared/git";
import { isUncPath, isWindowsDrivePath } from "@ryco/shared/path";
import type { RepositoryIdentity, SidebarProjectGroupingMode } from "@ryco/contracts";

import type { WorkspaceLogicalProject, WorkspacePhysicalProjectVariant } from "./types.js";

export interface LogicalProjectSource {
  readonly environmentId: string;
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly repositoryIdentity?: RepositoryIdentity | null;
}

function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]?$/.test(value);
}

function getAbsolutePathKind(value: string): "unix" | "windows" | null {
  if (isWindowsDrivePath(value) || isUncPath(value)) return "windows";
  if (value.startsWith("/")) return "unix";
  return null;
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) return value;
  const trimmed =
    getAbsolutePathKind(value) === "unix"
      ? value.replace(/\/+$/g, "")
      : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) return value;
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = trimTrailingPathSeparators(value.trim());
  if (isWindowsDrivePath(normalized) || normalized.startsWith("\\\\")) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

/**
 * Where a project sits inside its repository: "" at the root, `apps/web` for a
 * monorepo subfolder (slash-separated); null when its repository root is unknown
 * or does not contain it.
 */
export function deriveRepositoryRelativeProjectPath(
  project: Pick<LogicalProjectSource, "cwd" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) return null;

  const normalizedProjectPath = normalizeProjectPathForComparison(project.cwd);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) return null;
  if (normalizedProjectPath === normalizedRootPath) return "";

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) return null;
  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(
  project: Pick<LogicalProjectSource, "environmentId" | "cwd">,
): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.cwd);
}

function deriveRepositoryScopedKey(
  project: Pick<LogicalProjectSource, "cwd" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  const canonicalKey = project.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) return null;
  if (groupingMode === "repository") return canonicalKey;

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) return canonicalKey;
  return relativeProjectPath.length === 0
    ? canonicalKey
    : `${canonicalKey}::${relativeProjectPath}`;
}

export function deriveLogicalProjectKey(
  project: Pick<LogicalProjectSource, "environmentId" | "id" | "cwd" | "repositoryIdentity">,
  options?: { readonly groupingMode?: SidebarProjectGroupingMode },
): string {
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "separate") return derivePhysicalProjectKey(project);
  return (
    deriveRepositoryScopedKey(project, groupingMode) ??
    derivePhysicalProjectKey(project) ??
    `${project.environmentId}:${project.id}`
  );
}

/**
 * The repository's `owner/name` label. Older nodes also labelled a remote addressed by a path on
 * some disk (`host:/srv/git/demo`) with that path, which names no owner.
 */
function repositoryOwnerLabel(identity: RepositoryIdentity | null | undefined): string | null {
  return identity && canonicalRepositoryPath(identity.canonicalKey) !== null
    ? (identity.displayName ?? null)
    : null;
}

/**
 * The name a logical project goes by wherever it is listed (sidebar, project selector, Hub
 * workspace): the title its checkouts share, so a project keeps its name when it gains a
 * checkout on another node; when their titles differ, the repository's `owner/name`, else its
 * name, else the representative's title.
 */
export function deriveProjectGroupLabel(input: {
  readonly representative: Pick<LogicalProjectSource, "name" | "repositoryIdentity">;
  readonly members: ReadonlyArray<Pick<LogicalProjectSource, "name" | "repositoryIdentity">>;
}): string {
  const sharedTitles = uniqueNonEmptyValues(input.members.map((member) => member.name));
  if (sharedTitles.length === 1) return sharedTitles[0]!;

  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) => repositoryOwnerLabel(member.repositoryIdentity)),
  );
  if (sharedDisplayNames.length === 1) return sharedDisplayNames[0]!;

  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  if (sharedRepositoryNames.length === 1) return sharedRepositoryNames[0]!;
  return input.representative.name;
}

function singleVariantProject(
  variant: WorkspacePhysicalProjectVariant,
  ambiguous: boolean,
): WorkspaceLogicalProject {
  return {
    key: variant.physicalKey,
    label: variant.name,
    repositoryIdentity: variant.repositoryIdentity,
    variants: [variant],
    ambiguous,
  };
}

/**
 * Group repository copies only when every member comes from a distinct environment.
 * Two same-environment matches make the identity ambiguous and keep every copy separate.
 */
export function groupWorkspaceLogicalProjects(
  variants: ReadonlyArray<WorkspacePhysicalProjectVariant>,
  options?: { readonly groupingMode?: SidebarProjectGroupingMode },
): ReadonlyArray<WorkspaceLogicalProject> {
  const grouped = new Map<string, WorkspacePhysicalProjectVariant[]>();
  for (const variant of variants) {
    const key = deriveLogicalProjectKey(
      {
        environmentId: variant.environmentId,
        id: variant.projectId,
        cwd: variant.cwd,
        repositoryIdentity: variant.repositoryIdentity,
      },
      options,
    );
    const members = grouped.get(key) ?? [];
    members.push(variant);
    grouped.set(key, members);
  }

  const projects: WorkspaceLogicalProject[] = [];
  for (const [key, members] of grouped) {
    const countsByEnvironment = new Map<string, number>();
    for (const member of members) {
      countsByEnvironment.set(
        member.environmentId,
        (countsByEnvironment.get(member.environmentId) ?? 0) + 1,
      );
    }
    const ambiguous = Array.from(countsByEnvironment.values()).some((count) => count > 1);
    if (ambiguous || members.length === 1) {
      projects.push(...members.map((member) => singleVariantProject(member, ambiguous)));
      continue;
    }

    const sorted = members.toSorted((left, right) => {
      const leftRecent = left.lastUsedAt ?? left.lastLiveAt ?? 0;
      const rightRecent = right.lastUsedAt ?? right.lastLiveAt ?? 0;
      return rightRecent - leftRecent || left.physicalKey.localeCompare(right.physicalKey);
    });
    const representative = sorted[0]!;
    projects.push({
      key,
      label: deriveProjectGroupLabel({ representative, members }),
      repositoryIdentity: representative.repositoryIdentity,
      variants: sorted,
      ambiguous: false,
    });
  }

  return projects.toSorted(
    (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
  );
}
