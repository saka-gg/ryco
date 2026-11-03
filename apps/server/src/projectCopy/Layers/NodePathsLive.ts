/**
 * NodePathsLive - where projects live on this node, for the add-project and copy dialogs, the
 * import's preflight and Agent Control.
 *
 * Code roots come from the shared resolver (`project/codeRoots.ts`) that chat promotion also
 * uses; destination verdicts build on `project/projectDestination.ts`, chat promotion's checks,
 * storage admission's fence included; folder search is `projectCopy/directorySearch.ts`.
 *
 * @module NodePathsLive
 */
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { OrchestrationProjectShell, RepositoryIdentity } from "@ryco/contracts";
import {
  FILESYSTEM_SEARCH_DIRECTORIES_DEFAULT_DEPTH,
  FILESYSTEM_SEARCH_DIRECTORIES_DEFAULT_LIMIT,
  type FilesystemDirectoryMatch,
  ProjectCopyError,
  type ProjectCopyErrorCode,
  type ProjectDestinationPreview,
  type ProjectDestinationState,
} from "@ryco/contracts/project-copy";
import { isChatProject } from "@ryco/shared/projectKind";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import {
  ProjectionSnapshotQuery,
  readProjectShells,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ChatFolders } from "../../project/chatFolders.ts";
import { resolveNodeCodeRoots } from "../../project/codeRoots.ts";
import {
  canonicalChatsRoot,
  firstFreeDestination,
  foldPathCase,
  isDirectoryPath,
  isWritableDirectory,
  locateDestination,
  parseDestinationPath,
} from "../../project/projectDestination.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { canonicalizeWorktreePath } from "../../project/worktreeRoot.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { type StoragePathBlocker, storagePathBlocker } from "../../storage/lifecycle.ts";
import { containsPath } from "../../workspace/checkoutInspection.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { projectDestinationReservationKey } from "../destinationReservation.ts";
import { type DirectorySearchInput, searchDirectories } from "../directorySearch.ts";
import { privacyGuardedFolderOf } from "../privacyGuardedFolders.ts";
import {
  NodePaths,
  type NodeCodeRoots,
  type NodePathsShape,
  type ProjectDestinationJudgement,
} from "../Services/NodePaths.ts";

const ACCESS_OPERATION = "project destination";
const SEARCH_OPERATION = "folder search";
/** `ProjectCopyError.message` holds at most this many characters. */
const ERROR_MESSAGE_MAX_CHARS = 2_000;

const INVALID_DETAIL = "Use an absolute path on this node, or one starting with ~/.";
const ACCESS_DENIED_DETAIL = "This node's workspace access policy does not allow that location.";
const RETIRED_CHECKOUT_DETAIL =
  "Ryco removed a workspace checkout at that location and keeps new work out of it. Choose another folder.";
const RELOCATION_DETAIL = "Ryco is moving a folder there right now. Choose another folder.";
const INSIDE_CHATS_DETAIL = "Choose a location outside the chats folder.";
const UNRESOLVABLE_DETAIL =
  "A folder on that path cannot be read, or a symbolic link on it points nowhere.";
const EXISTING_PROJECT_DETAIL = "A project on this node already uses this folder.";
const privacyGuardedDetail = (folder: string) =>
  `macOS guards ${path.basename(folder)} with a privacy prompt, so Ryco only looks inside it when you choose a folder there.`;

/** The projects this service reads: the live ones, chats included. */
export type NodePathsProject = Pick<
  OrchestrationProjectShell,
  "id" | "kind" | "workspaceRoot" | "repositoryIdentity"
>;

/** A collaborator's failure; only its message would matter, and it is not shown to clients. */
export interface NodePathsDependencyError {
  readonly message: string;
}

export interface NodePathsDependencies {
  readonly policy: WorkspaceAccessPolicyShape;
  /** The configured workspace access root (`--restrict-to-cwd`), when restricted. */
  readonly workspaceAccessRoot: string | undefined;
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
  /** The node's live projects, chats included. */
  readonly projects: Effect.Effect<ReadonlyArray<NodePathsProject>, NodePathsDependencyError>;
  /** The chats root by realpath; undefined when the node offers no chats. */
  readonly chatsRoot: Effect.Effect<string | undefined>;
  /**
   * Storage admission for a canonical path (`storagePathBlocker` in `storage/lifecycle.ts`), the
   * fence turn, session and terminal starts pass. A destination it refuses is never usable.
   */
  readonly storageAdmission: (
    canonicalPath: string,
  ) => Effect.Effect<StoragePathBlocker | null, NodePathsDependencyError>;
  /** The repository identity of a checkout (`RepositoryIdentityResolver.resolve`). */
  readonly repositoryIdentity: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  readonly homeDir?: (() => string) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** Folders the OS empties (`CodeRootsInput.temporaryDirectories`); the OS's own by default. */
  readonly temporaryDirectories?: ReadonlyArray<string> | undefined;
  /** Narrower walk budgets, for tests. */
  readonly searchBudget?:
    | Pick<DirectorySearchInput, "maxDirectories" | "timeBudgetMs" | "maxEntriesPerDirectory">
    | undefined;
}

const failure = (code: ProjectCopyErrorCode, message: string) =>
  new ProjectCopyError({ code, message: message.slice(0, ERROR_MESSAGE_MAX_CHARS) });

/** Storage admission's blocker as a destination verdict. */
const fencedVerdict = (
  blocker: StoragePathBlocker | null,
): { readonly state: ProjectDestinationState; readonly detail: string } | null =>
  blocker === "checkout"
    ? { state: "retired-checkout", detail: RETIRED_CHECKOUT_DETAIL }
    : blocker === "project-relocation"
      ? { state: "exists-not-empty", detail: RELOCATION_DETAIL }
      : null;

interface JudgementFields {
  readonly state: ProjectDestinationState;
  readonly detail?: string | null;
  readonly canonical?: string | null;
  readonly projectRoot?: string | null;
  readonly existingProjectId?: ProjectDestinationPreview["existingProjectId"];
  readonly existingRepositoryCanonicalKey?: string | null;
  readonly suggestedPath?: string | null;
  readonly usable?: boolean;
}

/** A verdict on the destination shown as `resolvedPath`, without its reservation key. */
const judgementAt = (
  resolvedPath: string,
  fields: JudgementFields,
): ProjectDestinationJudgement => ({
  preview: {
    resolvedPath,
    state: fields.state,
    existingProjectId: fields.existingProjectId ?? null,
    existingRepositoryCanonicalKey: fields.existingRepositoryCanonicalKey ?? null,
    suggestedPath: fields.suggestedPath ?? null,
    detail: fields.detail ?? null,
  },
  usable: fields.usable ?? false,
  canonicalPath: fields.canonical ?? null,
  projectRoot: fields.projectRoot ?? null,
  reservationKey: null,
});

type Leaf =
  | { readonly kind: "missing"; readonly parent: "usable" | "missing" | "read-only" }
  | { readonly kind: "symlink" | "file" | "unreadable" }
  | {
      readonly kind: "directory";
      readonly empty: boolean;
      readonly gitRepository: boolean;
      readonly parentWritable: boolean;
    };

/** What is at `destination` (by lstat: a symlink is reported, not followed). */
const inspectLeaf = async (destination: string, canonical: string): Promise<Leaf> => {
  const parent = path.dirname(canonical);
  let entry;
  try {
    entry = await lstat(destination);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unreadable" };
    if (!(await isDirectoryPath(parent))) return { kind: "missing", parent: "missing" };
    return {
      kind: "missing",
      parent: (await isWritableDirectory(parent)) ? "usable" : "read-only",
    };
  }
  if (entry.isSymbolicLink()) return { kind: "symlink" };
  if (!entry.isDirectory()) return { kind: "file" };
  try {
    const [gitRepository, empty, parentWritable] = await Promise.all([
      lstat(path.join(canonical, ".git")).then(
        () => true,
        () => false,
      ),
      opendir(canonical).then(async (handle) => {
        try {
          return (await handle.read()) === null;
        } finally {
          await handle.close();
        }
      }),
      isWritableDirectory(parent),
    ]);
    return { kind: "directory", empty, gitRepository, parentWritable };
  } catch {
    return { kind: "unreadable" };
  }
};

/** `folder` is a real directory (not a symlink) whose realpath lies inside `root`. */
const isFolderInside = async (root: string, folder: string): Promise<boolean> => {
  try {
    return (await lstat(folder)).isDirectory() && containsPath(root, await realpath(folder));
  } catch {
    return false;
  }
};

/** The node paths service over plain dependencies; {@link NodePathsLive} wires the real ones. */
export const makeNodePaths = (deps: NodePathsDependencies): NodePathsShape => {
  const homeDir = () => path.resolve((deps.homeDir ?? homedir)());
  const platform = deps.platform ?? process.platform;
  const accessRoot =
    deps.workspaceAccessRoot === undefined ? undefined : path.resolve(deps.workspaceAccessRoot);

  const readProjects = deps.projects.pipe(
    Effect.mapError(() => failure("internal", "Ryco could not read this node's projects.")),
  );
  const readSettings = deps.settings.getSettings.pipe(
    Effect.mapError(() => failure("internal", "Ryco could not read this node's settings.")),
  );
  const projectRootKey = (root: string) => foldPathCase(path.resolve(root), platform);

  /** The settings and live projects code roots are resolved from, read once per call. */
  const readNodeState = Effect.all([readSettings, readProjects], { concurrency: 2 });

  const codeRootsOf = (
    settings: { readonly addProjectBaseDirectory: string },
    projects: ReadonlyArray<NodePathsProject>,
  ): Effect.Effect<NodeCodeRoots> =>
    Effect.promise(() =>
      resolveNodeCodeRoots({
        workspaceAccessRoot: accessRoot,
        addProjectBaseDirectory: settings.addProjectBaseDirectory,
        homeDir: homeDir(),
        projectRoots: projects
          .filter((project) => !isChatProject(project))
          .map((project) => project.workspaceRoot),
        platform,
        temporaryDirectories: deps.temporaryDirectories,
      }),
    );

  const resolveCodeRoots: NodePathsShape["resolveCodeRoots"] = Effect.fn(
    "NodePaths.resolveCodeRoots",
  )(function* () {
    const [settings, projects] = yield* readNodeState;
    return yield* codeRootsOf(settings, projects);
  });

  const pathHints: NodePathsShape["pathHints"] = Effect.fn("NodePaths.pathHints")(function* () {
    const roots = yield* resolveCodeRoots();
    return {
      homeDirectory: homeDir(),
      pathSeparator: platform === "win32" ? "\\" : "/",
      defaultProjectDirectory: roots.defaultProjectDirectory,
      defaultProjectDirectorySource: roots.defaultProjectDirectorySource,
      codeRoots: roots.codeRoots,
      workspaceAccessRoot: accessRoot ?? null,
    } as const;
  });

  /**
   * The roots a search walks, as given (resolved): each an absolute path on this node that the
   * access policy allows. A root the caller named that the policy refuses fails the search; a
   * missing one, or a default root the policy refuses, is left out.
   */
  const authorizeRoots = Effect.fn("NodePaths.authorizeRoots")(function* (
    requested: ReadonlyArray<string>,
    explicit: boolean,
  ) {
    const roots: Array<string> = [];
    const seen = new Set<string>();
    for (const raw of requested) {
      const root = parseDestinationPath(raw, { homeDir: homeDir(), platform });
      if (root === null) {
        return yield* failure("invalid", `Search roots must be absolute paths on this node.`);
      }
      const check = (assertion: WorkspaceAccessPolicyShape["assertPath"]) =>
        assertion({ path: root, operation: SEARCH_OPERATION }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      const exists = yield* Effect.promise(() => isDirectoryPath(root));
      // Where it would be, so a missing root outside the policy reads as refused too; then an
      // existing one by its realpath.
      const allowed =
        (yield* check(deps.policy.assertPath)) &&
        (!exists || (yield* check(deps.policy.assertExistingPath)));
      if (!allowed) {
        if (explicit) return yield* failure("access-denied", ACCESS_DENIED_DETAIL);
        continue;
      }
      const key = foldPathCase(root, platform);
      if (!exists || seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    }
    return roots;
  });

  const search: NodePathsShape["searchDirectories"] = Effect.fn("NodePaths.searchDirectories")(
    function* (input) {
      const [settings, projects] = yield* readNodeState;
      // Also for named roots: the code roots decide which privacy-guarded folders may be opened.
      const codeRoots = yield* codeRootsOf(settings, projects);
      const roots = yield* authorizeRoots(
        input.roots ?? codeRoots.codeRoots.map((root) => root.path),
        input.roots !== undefined,
      );
      const outcome = yield* Effect.tryPromise({
        try: (signal) =>
          searchDirectories({
            roots,
            query: input.query,
            limit: input.limit ?? FILESYSTEM_SEARCH_DIRECTORIES_DEFAULT_LIMIT,
            maxDepth: input.maxDepth ?? FILESYSTEM_SEARCH_DIRECTORIES_DEFAULT_DEPTH,
            homeDir: homeDir(),
            platform,
            codeRoots: codeRoots.codeRoots.map((root) => root.path),
            signal,
            ...deps.searchBudget,
          }),
        catch: () => failure("internal", "The folder search failed."),
      });
      const byRoot = new Map<string, NodePathsProject>();
      for (const project of projects) {
        if (!isChatProject(project)) byRoot.set(projectRootKey(project.workspaceRoot), project);
      }
      const matches = outcome.hits.map((hit): FilesystemDirectoryMatch => {
        const project = byRoot.get(foldPathCase(hit.path, platform));
        return {
          ...hit,
          projectId: project?.id ?? null,
          repositoryCanonicalKey: project?.repositoryIdentity?.canonicalKey ?? null,
        };
      });
      return {
        matches,
        roots,
        truncated: outcome.truncated,
        limitReached: outcome.limitReached,
        scannedDirectories: outcome.scannedDirectories,
      };
    },
  );

  /**
   * The macOS privacy-guarded home folder `destination` is or lies in, unless it lies in a code
   * root there or in the default project directory; null otherwise. Reads nothing inside the
   * folder, and the code roots only for a path in one.
   */
  const privacyGuardedDestination = Effect.fn("NodePaths.privacyGuardedDestination")(function* (
    destination: string,
  ) {
    const guardedFolder = (openRoots: ReadonlyArray<string>) =>
      privacyGuardedFolderOf({ candidate: destination, homeDir: homeDir(), platform, openRoots });
    if (guardedFolder([]) === null) return null;
    const roots = yield* resolveCodeRoots();
    return guardedFolder([
      roots.defaultProjectDirectory,
      ...roots.codeRoots.map((root) => root.path),
    ]);
  });

  /** The verdict without its reservation key, which costs a few more filesystem reads. */
  const judgeDestination: NodePathsShape["judgeProjectDestination"] = Effect.fn(
    "NodePaths.judgeProjectDestination",
  )(function* (input) {
    const relative = input.relativeRootInRepository ?? "";
    // A place nobody chose, inside a folder macOS guards: judged by its path alone (A34).
    if (input.suggested === true) {
      const parsed = parseDestinationPath(input.path, { homeDir: homeDir(), platform });
      const guarded = parsed === null ? null : yield* privacyGuardedDestination(parsed);
      if (parsed !== null && guarded !== null) {
        return judgementAt(parsed, {
          state: "access-denied",
          detail: privacyGuardedDetail(guarded),
        });
      }
    }

    const chatsRoot = yield* deps.chatsRoot;
    const allowed = (candidate: string) =>
      deps.policy.assertPath({ path: candidate, operation: ACCESS_OPERATION }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    const fenced = (canonical: string) =>
      deps.storageAdmission(canonical).pipe(
        Effect.map(fencedVerdict),
        Effect.mapError(() => failure("internal", "Ryco could not check that location.")),
      );
    const located = yield* locateDestination({
      raw: input.path,
      homeDir: homeDir(),
      policy: deps.policy,
      operation: ACCESS_OPERATION,
      excludedRoots:
        chatsRoot === undefined ? [] : [{ root: chatsRoot, reason: "inside-chats" as const }],
      fenced,
    });

    /** A free sibling the access policy and storage admission also allow, else null. */
    const suggest = Effect.fn("NodePaths.suggestDestination")(function* (destination: string) {
      const candidate = yield* Effect.promise(() =>
        firstFreeDestination(destination, { skipBase: true }),
      );
      if (candidate === null || !(yield* allowed(candidate))) return null;
      const canonical = yield* Effect.promise(() =>
        canonicalizeWorktreePath(candidate).catch(() => null),
      );
      if (canonical === null || !(yield* allowed(canonical))) return null;
      return (yield* fenced(canonical)) === null ? candidate : null;
    });

    const judgement = (fields: JudgementFields) => judgementAt(located.destination, fields);

    switch (located.status) {
      case "invalid":
        return judgement({ state: "invalid", detail: INVALID_DETAIL });
      case "access-denied":
        return judgement({ state: "access-denied", detail: ACCESS_DENIED_DETAIL });
      case "unresolvable":
        return located.leafExists
          ? judgement({
              state: "exists-not-empty",
              detail: UNRESOLVABLE_DETAIL,
              suggestedPath: yield* suggest(located.destination),
            })
          : judgement({ state: "invalid", detail: UNRESOLVABLE_DETAIL });
      case "excluded":
        return judgement({
          state: "invalid",
          detail: INSIDE_CHATS_DETAIL,
          canonical: located.canonical,
        });
      case "fenced":
        return judgement({
          ...located.verdict,
          canonical: located.canonical,
          suggestedPath: yield* suggest(located.destination),
        });
      case "located":
        break;
    }

    const canonical = located.canonical;
    const segments = relative === "" ? [] : relative.split("/");
    const projectRoot = path.join(canonical, ...segments);
    // The project is registered at its root: the policy and the fence apply there too.
    if (relative !== "") {
      if (!(yield* allowed(projectRoot))) {
        return judgement({ state: "access-denied", detail: ACCESS_DENIED_DETAIL, canonical });
      }
      const rootFence = yield* fenced(projectRoot);
      if (rootFence !== null) {
        return judgement({
          ...rootFence,
          canonical,
          suggestedPath: yield* suggest(located.destination),
        });
      }
    }

    const leaf = yield* Effect.promise(() => inspectLeaf(located.destination, canonical));
    const parent = path.dirname(canonical);
    const { state, detail } = ((): {
      readonly state: ProjectDestinationState;
      readonly detail: string | null;
    } => {
      switch (leaf.kind) {
        case "missing":
          return leaf.parent === "usable"
            ? { state: "available", detail: null }
            : {
                state: "invalid",
                detail:
                  leaf.parent === "missing"
                    ? `The folder it would go in, ${parent}, does not exist.`
                    : `Ryco cannot create folders in ${parent}.`,
              };
        case "symlink":
          return { state: "exists-not-empty", detail: "A symbolic link is at that location." };
        case "file":
          return { state: "exists-not-empty", detail: "A file is at that location." };
        case "unreadable":
          return { state: "exists-not-empty", detail: "That folder cannot be read." };
        case "directory":
          if (leaf.gitRepository) return { state: "is-git-repository", detail: null };
          if (!leaf.empty) return { state: "exists-not-empty", detail: null };
          // The import moves its checkout in from a sibling, so it needs the parent writable.
          return leaf.parentWritable
            ? { state: "exists-empty", detail: null }
            : { state: "invalid", detail: `Ryco cannot create folders in ${parent}.` };
      }
    })();

    const projects = yield* readProjects;
    const rootKeys = new Set([
      projectRootKey(path.join(located.destination, ...segments)),
      projectRootKey(projectRoot),
    ]);
    const existingProject = projects.find((project) =>
      rootKeys.has(projectRootKey(project.workspaceRoot)),
    );
    const existingRepositoryCanonicalKey =
      state === "is-git-repository"
        ? ((yield* deps.repositoryIdentity(canonical))?.canonicalKey ?? null)
        : null;
    const createUsable =
      (state === "available" || state === "exists-empty") && existingProject === undefined;
    const usable =
      input.intent === "create"
        ? createUsable
        : state === "is-git-repository" &&
          existingProject === undefined &&
          (relative === "" ||
            (yield* Effect.promise(() => isFolderInside(canonical, projectRoot))));
    return judgement({
      state,
      detail: existingProject === undefined ? detail : (detail ?? EXISTING_PROJECT_DETAIL),
      canonical,
      projectRoot,
      existingProjectId: existingProject?.id ?? null,
      existingRepositoryCanonicalKey,
      suggestedPath:
        createUsable || state === "invalid" ? null : yield* suggest(located.destination),
      usable,
    });
  });

  /**
   * The verdict, a usable one keyed the way the import job and the legacy clone reserve a
   * destination (`projectDestinationReservationKey`), so all three agree on one definition.
   */
  const judgeProjectDestination: NodePathsShape["judgeProjectDestination"] = (input) =>
    judgeDestination(input).pipe(
      Effect.flatMap((judged) =>
        judged.usable && judged.canonicalPath !== null
          ? projectDestinationReservationKey(judged.canonicalPath).pipe(
              Effect.map((reservationKey) => ({ ...judged, reservationKey })),
            )
          : Effect.succeed(judged),
      ),
    );

  const previewDestination: NodePathsShape["previewDestination"] = (input) =>
    judgeDestination({ path: input.path, intent: "create", suggested: input.suggested }).pipe(
      Effect.map((judged) => judged.preview),
    );

  return NodePaths.of({
    pathHints,
    searchDirectories: search,
    previewDestination,
    judgeProjectDestination,
    resolveCodeRoots,
  });
};

/**
 * The node paths service over the node's settings, projections, chats folder, storage admission
 * and repository identities. Provided beneath the runtime services with the other project copy
 * services.
 */
export const NodePathsLive = Layer.effect(
  NodePaths,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const policy = yield* WorkspaceAccessPolicy;
    const settings = yield* ServerSettingsService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    const identities = yield* RepositoryIdentityResolver;
    // Absent only where the node offers no chats at all (narrow route tests).
    const chatFolders = yield* Effect.serviceOption(ChatFolders);
    return makeNodePaths({
      policy,
      workspaceAccessRoot: config.workspaceAccessRoot,
      settings,
      projects: readProjectShells(snapshots),
      chatsRoot: Option.match(chatFolders, {
        onNone: () => Effect.succeed(undefined),
        onSome: canonicalChatsRoot,
      }),
      storageAdmission: (canonical) => storagePathBlocker(sql, canonical),
      repositoryIdentity: identities.resolve,
    });
  }),
);
