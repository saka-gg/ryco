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
import { tmpdir } from "node:os";
import path from "node:path";

import { PROJECT_COPY_MAX_CODE_ROOTS, type NodeCodeRootSource } from "@ryco/contracts/project-copy";

import { expandHomePath } from "../pathExpansion.ts";
import { foldPathCase, hasGitEntry } from "./projectDestination.ts";
import { isCanonicalPathInside } from "../pathContainment.ts";

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
  /**
   * Folders the OS empties: no folder in them, at any depth, is the default. `os.tmpdir()`,
   * `/tmp` and `/var/tmp` by default.
   */
  readonly temporaryDirectories?: ReadonlyArray<string> | undefined;
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
   * the folder holding at least two of the node's projects (a monorepo counted once, at the
   * repository; never inside a working tree or a temporary directory), else the first existing
   * well-known folder, else home.
   */
  readonly defaultProjectDirectory: string;
  readonly defaultProjectDirectorySource: NodeCodeRootSource;
  /** Existing directories only, best first, at most `PROJECT_COPY_MAX_CODE_ROOTS`, home last. */
  readonly codeRoots: ReadonlyArray<ResolvedCodeRoot>;
}

interface CodeRootCandidate {
  readonly path: string;
  readonly source: NodeCodeRootSource;
  /** A folder holding projects that may be the default: two or more, and not temporary. */
  readonly holdsProjects?: boolean;
}

/** At most this many folders at and above a project root are asked for a `.git` entry. */
const PLACEMENT_MAX_LEVELS = 32;

export interface ProjectParent {
  readonly path: string;
  readonly projectCount: number;
}

/**
 * The folders the given roots sit in (each root counted once per entry), the one holding the
 * most first; ties go to the shorter, then the alphabetically first path, so the answer does not
 * depend on project order.
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

const isWithin = (root: string, candidate: string, platform: NodeJS.Platform) =>
  isCanonicalPathInside({
    root: foldPathCase(root, platform),
    candidate: foldPathCase(candidate, platform),
    allowRoot: true,
  });

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
 * Where a project sits among its parent's folders: the outermost git working tree holding its
 * root, so a monorepo's subfolder projects sit where the repository does, else the root itself.
 * Inside home only folders below home are asked (a home folder under version control, such as a
 * dotfiles checkout, does not hold every project), elsewhere folders below the filesystem root.
 */
export const projectPlacement = async (
  projectRoot: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> => {
  const resolved = path.resolve(projectRoot);
  const home = path.resolve(homeDir);
  const stop = foldPathCase(
    isWithin(home, resolved, platform) ? home : path.parse(resolved).root,
    platform,
  );
  const levels: Array<string> = [];
  for (
    let folder = resolved;
    levels.length < PLACEMENT_MAX_LEVELS &&
    foldPathCase(folder, platform) !== stop &&
    path.dirname(folder) !== folder;
    folder = path.dirname(folder)
  ) {
    levels.push(folder);
  }
  const marked = await Promise.all(levels.map(hasGitEntry));
  return levels[marked.lastIndexOf(true)] ?? resolved;
};

const defaultTemporaryDirectories = (platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform === "win32" ? [tmpdir()] : [tmpdir(), "/tmp", "/var/tmp"];

/**
 * The node's code roots and its "normal code directory". Reads only the file system (a stat and
 * realpath per candidate, and a `.git` probe per folder between a project and home, in
 * parallel); the caller supplies the settings and projects.
 *
 * A folder holding projects counts each folder in it once: two subfolder projects of a monorepo
 * are the repository, so the folder holding the repository is where they are, never a folder
 * inside its working tree (which stays a place to search, ranked last). A folder in a temporary
 * directory, at any depth, is never the default either: the OS empties it.
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
  const realpaths = new Map<string, Promise<string | null>>();
  const realOf = (candidate: string) => {
    let known = realpaths.get(candidate);
    if (known === undefined) {
      known = realDirectory(candidate);
      realpaths.set(candidate, known);
    }
    return known;
  };

  const roots = input.projectRoots.map((root) => path.resolve(root));
  const placements = await Promise.all(
    roots.map((root) => projectPlacement(root, input.homeDir, platform)),
  );
  const distinctPlacements = new Map<string, string>();
  for (const placement of placements) {
    distinctPlacements.set(foldPathCase(placement, platform), placement);
  }
  const parents = projectParentDirectories([...distinctPlacements.values()], platform);
  // Folders inside a working tree that hold subfolder projects: searched, never the default.
  const innerParents = projectParentDirectories(
    roots.filter((root, index) => placements[index] !== root),
    platform,
  );
  const temporaryRoots = (
    await Promise.all(
      (input.temporaryDirectories ?? defaultTemporaryDirectories(platform)).map(realOf),
    )
  ).filter((real): real is string => real !== null);
  const parentHoldsProjects = await Promise.all(
    parents.map(async (parent) => {
      if (parent.projectCount < 2) return false;
      const real = await realOf(parent.path);
      return (
        real !== null && !temporaryRoots.some((temporary) => isWithin(temporary, real, platform))
      );
    }),
  );
  const parentCandidate = (parent: ProjectParent, holdsProjects = false): CodeRootCandidate => ({
    path: parent.path,
    source: "existing-projects",
    holdsProjects,
  });
  const candidates: ReadonlyArray<CodeRootCandidate> = [
    ...(accessRoot === undefined ? [] : [{ path: accessRoot, source: "access-root" as const }]),
    ...(configured === null ? [] : [{ path: configured, source: "setting" as const }]),
    ...parents.flatMap((parent, index) =>
      parentHoldsProjects[index] ? [parentCandidate(parent, true)] : [],
    ),
    ...WELL_KNOWN_CODE_DIRECTORIES.map((name) => ({
      path: path.join(input.homeDir, name),
      source: "well-known" as const,
    })),
    ...parents.flatMap((parent, index) =>
      parentHoldsProjects[index] ? [] : [parentCandidate(parent)],
    ),
    ...innerParents.map((parent) => parentCandidate(parent)),
    { path: path.resolve(input.homeDir), source: "home" as const },
  ];
  const canonical = await Promise.all(candidates.map((candidate) => realOf(candidate.path)));
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
    firstExisting((candidate) => candidate.holdsProjects === true) ??
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
