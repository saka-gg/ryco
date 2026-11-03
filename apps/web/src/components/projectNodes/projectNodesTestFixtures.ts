// FILE: projectNodesTestFixtures.ts
// Purpose: A fake node for the project-node pickers' and dialogs' browser tests: a small home
//          folder with code roots, Git repositories and one project, served through the
//          environment API members the pickers call, node catalog entries, and saved nodes that
//          keep the connection state a test gives them.
// Layer: Test support only; imported by `*.browser.tsx` files.

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { EnvironmentId, ProjectId, type EnvironmentApi } from "@ryco/contracts";
import type {
  FilesystemDirectoryMatch,
  FilesystemSearchDirectoriesInput,
  NodePathHints,
  ProjectDestinationPreview,
} from "@ryco/contracts/project-copy";
import { vi } from "vite-plus/test";

import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";

export const FAKE_NODE_ID = EnvironmentId.make("environment-mac-mini");
export const FAKE_HOME = "/Users/me";
export const FAKE_PROJECT_ID = ProjectId.make("project-ryco");

/** Child folders by absolute directory. */
const FOLDERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "/": ["Users", "srv"],
  "/Users": ["me"],
  "/Users/me": [".dotfiles", "Code", "Documents", "Dropbox"],
  "/Users/me/.dotfiles": [],
  "/Users/me/Code": ["playground", "ryco", "ryco-hub"],
  "/Users/me/Code/playground": ["notes"],
  "/Users/me/Code/playground/notes": [],
  "/Users/me/Code/ryco": ["apps", "packages"],
  "/Users/me/Code/ryco/apps": [],
  "/Users/me/Code/ryco/packages": [],
  "/Users/me/Code/ryco-hub": ["src"],
  "/Users/me/Code/ryco-hub/src": [],
  "/Users/me/Documents": [],
  "/Users/me/Dropbox": ["Code"],
  "/Users/me/Dropbox/Code": ["Web"],
  "/Users/me/Dropbox/Code/Web": ["cs2inspect-web", "homebrew-tap"],
  "/Users/me/Dropbox/Code/Web/cs2inspect-web": [],
  "/Users/me/Dropbox/Code/Web/homebrew-tap": [],
  "/srv": [],
};

/** Git repositories: branch and canonical repository key. */
const REPOSITORIES: Readonly<Record<string, { branch: string; key: string | null }>> = {
  "/Users/me/.dotfiles": { branch: "main", key: "github.com/sak0a/dotfiles" },
  "/Users/me/Code/ryco": { branch: "task/copy-clone", key: "github.com/sak0a/ryco" },
  "/Users/me/Code/ryco-hub": { branch: "main", key: "github.com/sak0a/ryco-hub" },
  "/Users/me/Dropbox/Code/Web/cs2inspect-web": {
    branch: "dev",
    key: "github.com/sak0a/cs2inspect-web",
  },
  "/Users/me/Dropbox/Code/Web/homebrew-tap": { branch: "main", key: null },
};

export const FAKE_PROJECTS = [
  { id: FAKE_PROJECT_ID, name: "ryco", cwd: "/Users/me/Code/ryco" },
] as const;

export const FAKE_PATH_HINTS: NodePathHints = {
  homeDirectory: FAKE_HOME,
  pathSeparator: "/",
  defaultProjectDirectory: "/Users/me/Code",
  defaultProjectDirectorySource: "well-known",
  codeRoots: [
    { path: "/Users/me/Code", source: "well-known", projectCount: 1 },
    { path: "/Users/me/Dropbox/Code/Web", source: "existing-projects", projectCount: 0 },
  ],
  workspaceAccessRoot: null,
};

function resolveFakePath(path: string): string {
  const trimmed = path.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? FAKE_HOME + trimmed.slice(1) : trimmed;
  const withoutTrailing = expanded.replace(/\/+$/u, "");
  return withoutTrailing.length === 0 ? "/" : withoutTrailing;
}

function joinFake(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function matchFor(path: string, depth: number, score: number): FilesystemDirectoryMatch {
  const repository = REPOSITORIES[path];
  const project = FAKE_PROJECTS.find((candidate) => candidate.cwd === path);
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    parentPath: parentOf(path),
    depth,
    isGitRepository: repository !== undefined,
    gitBranch: repository?.branch ?? null,
    projectId: project?.id ?? null,
    repositoryCanonicalKey: repository?.key ?? null,
    score,
  };
}

function searchFake(input: FilesystemSearchDirectoriesInput) {
  const limit = input.limit ?? 40;
  const query = input.query.trim().toLowerCase();
  const roots = input.roots ?? FAKE_PATH_HINTS.codeRoots.map((root) => root.path);
  let matches: FilesystemDirectoryMatch[];
  if (input.roots && query.length === 0) {
    // The shallow listing of the given roots.
    matches = roots.flatMap((root) =>
      (FOLDERS[root] ?? [])
        .filter((name) => !name.startsWith("."))
        .map((name) => matchFor(joinFake(root, name), 1, 1)),
    );
  } else if (query.length === 0) {
    matches = Object.keys(REPOSITORIES)
      .filter((path) => roots.some((root) => path.startsWith(`${root}/`)))
      .map((path) => matchFor(path, 1, 1));
  } else {
    const showHidden = query.startsWith(".");
    matches = Object.keys(FOLDERS)
      .filter((path) => path !== "/" && path.toLowerCase().includes(query))
      .filter((path) => showHidden || !path.includes("/."))
      .toSorted((left, right) => left.length - right.length)
      .map((path) => matchFor(path, path.split("/").length - 3, 1));
  }
  return {
    matches: matches.slice(0, limit),
    roots: [...roots],
    truncated: false,
    limitReached: matches.length > limit,
    scannedDirectories: Object.keys(FOLDERS).length,
  };
}

function previewFake(rawPath: string): ProjectDestinationPreview {
  const path = resolveFakePath(rawPath);
  const project = FAKE_PROJECTS.find((candidate) => candidate.cwd === path);
  const repository = REPOSITORIES[path];
  const children = FOLDERS[path];
  const state =
    children === undefined
      ? FOLDERS[parentOf(path)] === undefined
        ? "invalid"
        : "available"
      : repository
        ? "is-git-repository"
        : children.length > 0
          ? "exists-not-empty"
          : "exists-empty";
  let suggestedPath: string | null = null;
  if (state !== "available") {
    for (let suffix = 2; suggestedPath === null; suffix += 1) {
      if (FOLDERS[`${path}-${suffix}`] === undefined) suggestedPath = `${path}-${suffix}`;
    }
  }
  return {
    resolvedPath: path,
    state,
    existingProjectId: project?.id ?? null,
    existingRepositoryCanonicalKey: repository?.key ?? null,
    suggestedPath,
    detail: state === "invalid" ? "The parent folder doesn't exist." : null,
  };
}

/** The fake node's API; `projectCopy: false` leaves out the project-copy members. */
export function createFakeNodeApi(options: { readonly projectCopy?: boolean } = {}) {
  const browse = vi.fn<EnvironmentApi["filesystem"]["browse"]>(async ({ partialPath }) => {
    const directory = resolveFakePath(partialPath);
    const children = FOLDERS[directory];
    if (children === undefined) {
      throw new Error(`Unable to browse '${directory}'`);
    }
    return {
      parentPath: directory,
      entries: children.map((name) => ({ name, fullPath: joinFake(directory, name) })),
    };
  });
  const searchDirectories = vi.fn(async (input: FilesystemSearchDirectoriesInput) =>
    searchFake(input),
  );
  const pathHints = vi.fn(async () => FAKE_PATH_HINTS);
  const previewDestination = vi.fn(async ({ path }: { path: string }) => previewFake(path));
  const projectCopy = options.projectCopy ?? true;
  const api = {
    filesystem: { browse, ...(projectCopy ? { searchDirectories } : {}) },
    projects: projectCopy ? { pathHints, previewDestination } : {},
  } as unknown as EnvironmentApi;
  return { api, browse, searchDirectories, pathHints, previewDestination };
}

export function fakeNodeEntry(overrides: Partial<NodeCatalogEntry> = {}): NodeCatalogEntry {
  return {
    environmentId: FAKE_NODE_ID,
    label: "Mac mini",
    isPrimary: false,
    isThisDevice: false,
    presence: "online",
    platformOs: "darwin",
    iconKind: null,
    canMutate: true,
    mutateBlockedReason: null,
    projectCopySupport: "yes",
    transport: "direct",
    lastSeenAt: null,
    ...overrides,
  };
}

interface PinnedSavedEnvironmentState {
  readonly connectionState: "connected" | "disconnected";
  readonly role: "client" | null;
}

const pinnedSavedEnvironmentStates = new Map<EnvironmentId, PinnedSavedEnvironmentState>();
let stopPinningSavedEnvironments: (() => void) | null = null;

/**
 * Keeps a saved environment in the state a test gave it. The app's saved-environment
 * supervisor tries to reach every saved node, finds no server in a browser test and records
 * that, which would turn a test's connected node offline.
 */
export function pinSavedEnvironmentState(
  environmentId: EnvironmentId,
  state: PinnedSavedEnvironmentState,
): void {
  pinnedSavedEnvironmentStates.set(environmentId, state);
  stopPinningSavedEnvironments ??= useSavedEnvironmentRuntimeStore.subscribe(() => {
    const store = useSavedEnvironmentRuntimeStore.getState();
    for (const [pinnedId, pinned] of pinnedSavedEnvironmentStates) {
      const runtime = store.byId[pinnedId];
      if (
        runtime &&
        (runtime.connectionState !== pinned.connectionState || runtime.role !== pinned.role)
      ) {
        store.patch(pinnedId, pinned);
      }
    }
  });
}

export function unpinSavedEnvironmentStates(): void {
  stopPinningSavedEnvironments?.();
  stopPinningSavedEnvironments = null;
  pinnedSavedEnvironmentStates.clear();
}
