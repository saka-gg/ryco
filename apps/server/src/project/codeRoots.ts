/**
 * CodeRoots - where this node keeps its projects: the "normal code directory" new projects go in
 * by default, and the folders a folder search starts from.
 *
 * One resolver answers for every default location: the add-project and copy dialogs
 * (`projects.pathHints`), a promoted chat's default parent (`resolvePromotionParent`) and Agent
 * Control's destination suggestion all read {@link resolveNodeCodeRoots}, so they never disagree.
 *
 * @module CodeRoots
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { PROJECT_COPY_MAX_CODE_ROOTS, type NodeCodeRootSource } from "@ryco/contracts/project-copy";

import { expandHomePath } from "../pathExpansion.ts";
import { foldPathCase } from "./projectDestination.ts";

/**
 * Home folders people keep code in, in the order a default is picked from. Both `Code` and
 * `code` are listed for case-sensitive volumes; on the others they are one folder.
 */
export const WELL_KNOWN_CODE_DIRECTORIES = [
  "Code",
  "Developer",
  "dev",
  "src",
  "projects",
  "repos",
  "code",
  "workspace",
  "git",
] as const;

export interface CodeRootsInput {
  /** The configured workspace access root (`--restrict-to-cwd`), when restricted. */
  readonly workspaceAccessRoot: string | undefined;
  /** The "Add project base directory" setting; empty when unset. */
  readonly addProjectBaseDirectory: string;
  readonly homeDir: string;
  /** Workspace roots of the node's live, non-chat projects. */
  readonly projectRoots: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform | undefined;
}

export interface ResolvedCodeRoot {
  readonly path: string;
  readonly source: NodeCodeRootSource;
  /** Projects rooted below it. */
  readonly projectCount: number;
}

export interface ResolvedCodeRoots {
  /**
   * The workspace access root when restricted, else the `addProjectBaseDirectory` setting, else
   * the parent holding at least two of the node's projects, else the first existing well-known
   * folder, else home.
   */
  readonly defaultProjectDirectory: string;
  readonly defaultProjectDirectorySource: NodeCodeRootSource;
  /** Existing directories only, best first, at most `PROJECT_COPY_MAX_CODE_ROOTS`, home last. */
  readonly codeRoots: ReadonlyArray<ResolvedCodeRoot>;
}

interface CodeRootCandidate {
  readonly path: string;
  readonly source: NodeCodeRootSource;
  /** Set for project parents: the projects directly inside it. */
  readonly projectCount?: number;
}

export interface ProjectParent {
  readonly path: string;
  readonly projectCount: number;
}

/**
 * The folders the node's projects sit in, the one holding the most first; ties go to the
 * shorter, then the alphabetically first path, so the answer does not depend on project order.
 */
export const projectParentDirectories = (
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<ProjectParent> => {
  const parents = new Map<string, { path: string; projectCount: number }>();
  for (const root of projectRoots) {
    const resolved = path.resolve(root);
    const parent = path.dirname(resolved);
    if (parent === resolved) continue;
    const key = foldPathCase(parent, platform);
    const known = parents.get(key);
    if (known === undefined) parents.set(key, { path: parent, projectCount: 1 });
    else known.projectCount += 1;
  }
  return [...parents.values()].toSorted(
    (left, right) =>
      right.projectCount - left.projectCount ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
  );
};

/** The setting as an absolute path (`~` expanded), or null when unset or not absolute. */
const configuredBaseDirectory = (setting: string): string | null => {
  const configured = setting.trim();
  if (!configured) return null;
  const expanded = expandHomePath(configured);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
};

/** The directory's realpath, or null when it is missing, unreadable or not a directory. */
const realDirectory = async (candidate: string): Promise<string | null> => {
  try {
    if (!(await stat(candidate)).isDirectory()) return null;
    return await realpath(candidate);
  } catch {
    return null;
  }
};

/** Paths cross the wire as trimmed strings; a folder whose name ends in a space cannot. */
const isTrimmedPath = (candidate: string) => candidate === candidate.trim();

const isWithin = (root: string, candidate: string, platform: NodeJS.Platform) => {
  const foldedRoot = foldPathCase(root, platform);
  const foldedCandidate = foldPathCase(candidate, platform);
  return (
    foldedCandidate === foldedRoot ||
    foldedCandidate.startsWith(foldedRoot.endsWith(path.sep) ? foldedRoot : foldedRoot + path.sep)
  );
};

/** Projects rooted strictly below `root`, matched by the root as given and by its realpath. */
const countProjectsBelow = (
  roots: ReadonlyArray<string>,
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform,
) => {
  let count = 0;
  for (const projectRoot of projectRoots) {
    const resolved = path.resolve(projectRoot);
    if (
      roots.some(
        (root) =>
          isWithin(root, resolved, platform) &&
          foldPathCase(root, platform) !== foldPathCase(resolved, platform),
      )
    ) {
      count += 1;
    }
  }
  return count;
};

/**
 * The node's code roots and its "normal code directory". Reads only the file system (a stat and
 * realpath per candidate, in parallel); the caller supplies the settings and projects.
 *
 * The default deliberately keeps a configured base directory even when it does not exist yet,
 * as chat promotion always has; the code roots list only existing directories, inside the access
 * root when restricted, one per realpath.
 */
export const resolveNodeCodeRoots = async (input: CodeRootsInput): Promise<ResolvedCodeRoots> => {
  const platform = input.platform ?? process.platform;
  const accessRoot =
    input.workspaceAccessRoot === undefined ? undefined : path.resolve(input.workspaceAccessRoot);
  const configured = configuredBaseDirectory(input.addProjectBaseDirectory);
  const parents = projectParentDirectories(input.projectRoots, platform);
  const parentCandidate = (parent: ProjectParent): CodeRootCandidate => ({
    path: parent.path,
    source: "existing-projects",
    projectCount: parent.projectCount,
  });
  const candidates: ReadonlyArray<CodeRootCandidate> = [
    ...(accessRoot === undefined ? [] : [{ path: accessRoot, source: "access-root" as const }]),
    ...(configured === null ? [] : [{ path: configured, source: "setting" as const }]),
    ...parents.filter((parent) => parent.projectCount >= 2).map(parentCandidate),
    ...WELL_KNOWN_CODE_DIRECTORIES.map((name) => ({
      path: path.join(input.homeDir, name),
      source: "well-known" as const,
    })),
    ...parents.filter((parent) => parent.projectCount < 2).map(parentCandidate),
    { path: path.resolve(input.homeDir), source: "home" as const },
  ];
  const canonical = await Promise.all(candidates.map((candidate) => realDirectory(candidate.path)));
  const canonicalAccessRoot = accessRoot === undefined ? undefined : (canonical[0] ?? accessRoot);

  const seen = new Set<string>();
  const existing: Array<{
    readonly path: string;
    readonly canonical: string;
    readonly source: NodeCodeRootSource;
  }> = [];
  for (const [index, candidate] of candidates.entries()) {
    const real = canonical[index];
    if (real === null || real === undefined || !isTrimmedPath(candidate.path)) continue;
    if (canonicalAccessRoot !== undefined && !isWithin(canonicalAccessRoot, real, platform)) {
      continue;
    }
    const key = foldPathCase(real, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push({ path: candidate.path, canonical: real, source: candidate.source });
  }
  // Home is the broadest place to look, so it keeps its slot when the list is full.
  const home = existing.at(-1)?.source === "home" ? existing.at(-1) : undefined;
  const kept =
    existing.length <= PROJECT_COPY_MAX_CODE_ROOTS
      ? existing
      : home === undefined
        ? existing.slice(0, PROJECT_COPY_MAX_CODE_ROOTS)
        : [...existing.slice(0, PROJECT_COPY_MAX_CODE_ROOTS - 1), home];
  const codeRoots = kept.map((root) => ({
    path: root.path,
    source: root.source,
    projectCount: countProjectsBelow([root.path, root.canonical], input.projectRoots, platform),
  }));

  const firstExisting = (accept: (candidate: CodeRootCandidate) => boolean) =>
    candidates.find(
      (candidate, index) =>
        canonical[index] !== null && isTrimmedPath(candidate.path) && accept(candidate),
    );
  const fallback =
    firstExisting(
      (candidate) => candidate.source === "existing-projects" && (candidate.projectCount ?? 0) >= 2,
    ) ??
    firstExisting((candidate) => candidate.source === "well-known") ??
    ({ path: path.resolve(input.homeDir), source: "home" } as const);
  const defaultDirectory =
    accessRoot !== undefined
      ? { path: accessRoot, source: "access-root" as const }
      : configured !== null
        ? { path: configured, source: "setting" as const }
        : fallback;
  return {
    defaultProjectDirectory: defaultDirectory.path,
    defaultProjectDirectorySource: defaultDirectory.source,
    codeRoots,
  };
};
