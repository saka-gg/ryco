/**
 * ProjectExportLive - the source side of a cross-node copy (see `Services/ProjectExport.ts`).
 *
 * `inspect` reads what a copy would carry; `start` builds the requested artifacts under
 * `<stateDir>/project-exports/<exportId>/`, once per export id: a retry with the same input
 * joins the running build or answers with its result. The build runs in the layer's scope, so a
 * caller that disconnects does not cancel it; `dispose` does. Artifacts are looked up by the
 * export's own server-minted ids, never joined into a path, and expire 30 minutes after the last
 * read. A periodic sweep deletes expired exports and whatever an earlier process left behind.
 *
 * `repository.rootPath` is the repository's top level (the folder a copy recreates); the project
 * itself sits `settings.relativeRootInRepository` below it.
 *
 * @module ProjectExportLive
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import nodePath from "node:path";

import {
  DEFAULT_PROJECT_METADATA_DIR,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@ryco/contracts";
import {
  PROJECT_COPY_DEFAULT_PATCH_LIMIT_BYTES,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
  PROJECT_COPY_MAX_ARTIFACT_BYTES,
  PROJECT_COPY_MAX_AVATAR_BYTES,
  type ProjectCopyError,
  type ProjectExportArtifact,
  type ProjectExportArtifactEstimate,
  type ProjectExportArtifactKind,
  type ProjectExportIgnoredCandidate,
  type ProjectExportPushedState,
  type ProjectExportRepository,
  type ProjectExportResult,
  type ProjectExportSettings,
  type ProjectExportSkippedArtifact,
  type ProjectExportWorkingTree,
} from "@ryco/contracts/project-copy";
import { normalizeGitRemoteUrl } from "@ryco/shared/git";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Semaphore,
} from "effect";

import { canonicalJson, sha256Hex } from "../../canonicalJson.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProjectionSnapshotQuery,
  readWorkspacePlacement,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { projectRegistryOverrides } from "../../project/projectPreferences.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { RestartSensitiveWork } from "../../updates/restartSensitiveWork.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import {
  buildChangesPatch,
  buildCommitsBundle,
  buildRepositoryBundle,
  type BuiltArtifact,
  estimateCommitsBundle,
  estimateRepositoryBundle,
  type ExportGit,
  type ExportPushedState,
  type ExportRepositoryFacts,
  type ExportWorkingTreeScan,
  PROJECT_EXPORT_SKIP_REASON,
  projectCopyError,
  projectCopyIo as io,
  readIgnoredCandidates,
  readPushedState,
  readRepositoryFacts,
  scanWorkingTree,
  sumFileSizes,
} from "../exportGit.ts";
import {
  ignoredFilesRefused,
  mayCarryIgnoredFiles,
  type ProjectCopyCallerChannel,
} from "../callerChannel.ts";
import { buildFolderArchive, type FolderScan, scanFolder } from "../exportFolder.ts";
import { sha256File } from "../fileSha256.ts";
import { PROJECT_EXPORTS_DIRECTORY } from "../projectCopyStartup.ts";
import { GitNetwork } from "../Services/GitNetwork.ts";
import {
  ProjectExport,
  type ProjectExportShape,
  type ProjectExportStartRequest,
} from "../Services/ProjectExport.ts";

/** Artifacts are deleted this long after the last read (or after the build, before any read). */
const EXPORT_TTL_MS = 30 * 60 * 1000;
const EXPORT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Builds hash and pack whole repositories: a few at a time, the rest wait. */
const EXPORT_BUILD_CONCURRENCY = 2;
/** The export id names its directory; anything else never reaches a path. */
const EXPORT_DIRECTORY_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ARTIFACT_FILE_NAMES: Record<ProjectExportArtifactKind, string> = {
  "commits-bundle": "commits.bundle",
  "repository-bundle": "repository.bundle",
  "changes-patch": "changes.patch",
  avatar: "avatar.png",
  "folder-archive": "folder.tar.gz",
};
const PATCH_WORK_DIRECTORY = "patch-work";

export interface ProjectExportLiveOptions {
  readonly ttlMs?: number;
  readonly sweepIntervalMs?: number;
  /** Tests run `sweep` themselves. */
  readonly disablePeriodicSweep?: boolean;
}

interface ExportArtifactFile {
  /**
   * `carriesIgnoredFiles` when it holds opted-in ignored files, never read over an unencrypted
   * connection.
   */
  readonly artifact: ProjectExportArtifact;
  readonly filePath: string;
}

interface ExportSource {
  readonly facts: ExportRepositoryFacts | null;
  readonly pushed: ExportPushedState | null;
  readonly scan: ExportWorkingTreeScan | null;
  /** The walk of a plain folder; null for a git repository. */
  readonly folderScan: FolderScan | null;
  /** The folder the export reads: the project root or one of its worktrees. */
  readonly checkout: string;
  readonly repository: ProjectExportRepository;
  readonly pushedState: ProjectExportPushedState;
  readonly workingTree: ProjectExportWorkingTree;
  readonly settings: ProjectExportSettings;
}

interface ExportBuild {
  readonly source: ExportSource;
  readonly artifacts: ReadonlyArray<ExportArtifactFile>;
  readonly skipped: ReadonlyArray<ProjectExportSkippedArtifact>;
}

interface ExportEntry {
  readonly exportId: string;
  /** Digest of the start input: a retry must ask for the same export. */
  readonly digest: string;
  readonly directory: string;
  readonly carriesIgnoredFiles: boolean;
  readonly done: Deferred.Deferred<ProjectExportResult, ProjectCopyError>;
  fiber: Fiber.Fiber<ExportBuild, ProjectCopyError> | null;
  ready: {
    readonly result: ProjectExportResult;
    readonly artifacts: ReadonlyMap<string, ExportArtifactFile>;
  } | null;
  expiresAtMs: number;
}

const removeQuietly = (target: string) =>
  Effect.promise(() => fsp.rm(target, { recursive: true, force: true }).catch(() => undefined));

const samePath = (left: string, right: string) =>
  nodePath.resolve(left) === nodePath.resolve(right);

const isoAt = (ms: number) => new Date(ms).toISOString();

const disposedBeforeFinished = () =>
  projectCopyError("not-found", "The export was disposed before it finished.");

const skippedOf = (
  kind: ProjectExportArtifactKind,
  reason: string,
): ProjectExportSkippedArtifact => ({ kind, reason });

export const makeProjectExport = Effect.fn("makeProjectExport")(function* (
  options: ProjectExportLiveOptions = {},
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitDriver = yield* GitVcsDriver;
  const network = yield* GitNetwork;
  const projections = yield* ProjectionSnapshotQuery;
  const avatars = yield* ProjectAvatarStore;
  const serverSettings = yield* ServerSettingsService;
  const layerScope = yield* Effect.scope;
  const buildPermits = yield* Semaphore.make(EXPORT_BUILD_CONCURRENCY);
  const restartWork = yield* RestartSensitiveWork;
  const ttlMs = options.ttlMs ?? EXPORT_TTL_MS;
  const exportsRoot = nodePath.join(config.stateDir, PROJECT_EXPORTS_DIRECTORY);
  const entries = new Map<string, ExportEntry>();

  const git: ExportGit = (command) =>
    gitDriver
      .execute({
        operation: command.operation,
        cwd: command.cwd,
        args: command.args,
        // Non-interactive, C locale: the same environment as every other copy git process.
        env: { ...network.env, ...command.env },
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        allowNonZeroExit: command.allowNonZeroExit ?? false,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        ...(command.maxOutputBytes === undefined ? {} : { maxOutputBytes: command.maxOutputBytes }),
        ...(command.truncateOutputAtMaxBytes === undefined
          ? {}
          : { truncateOutputAtMaxBytes: command.truncateOutputAtMaxBytes }),
        ...(command.readOnly ? { readOnly: true } : {}),
      })
      .pipe(
        Effect.map((result) => ({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated,
        })),
        Effect.mapError((error) => projectCopyError("internal", error.detail)),
      );

  const exportDirectory = (exportId: string) =>
    EXPORT_DIRECTORY_NAME.test(exportId)
      ? Effect.succeed(nodePath.join(exportsRoot, exportId))
      : Effect.fail(projectCopyError("invalid", "Invalid export id."));

  // ── Source ──────────────────────────────────────────────────────────

  const loadProject = (projectId: ProjectId) =>
    projections.getProjectShellById(projectId).pipe(
      Effect.mapError(() => projectCopyError("internal", "Could not read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(projectCopyError("not-found", "Project not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** The project's workspaces: two indexed reads, a shell snapshot only for narrow test doubles. */
  const loadWorktrees = (projectId: ProjectId) =>
    (
      projections.getProjectWorkspaceRows?.(projectId).pipe(Effect.map((rows) => rows.worktrees)) ??
      readWorkspacePlacement(projections).pipe(
        Effect.map((placement) =>
          placement.worktrees.filter((worktree) => worktree.projectId === projectId),
        ),
      )
    ).pipe(Effect.mapError(() => projectCopyError("internal", "Could not read the project.")));

  /** The project root, or one of the project's worktrees whose checkout still exists. */
  const resolveCheckout = (project: OrchestrationProjectShell, checkoutPath: string | undefined) =>
    Effect.gen(function* () {
      let checkout = project.workspaceRoot;
      if (checkoutPath !== undefined && !samePath(checkoutPath, project.workspaceRoot)) {
        const worktrees = yield* loadWorktrees(project.id);
        const worktree = worktrees.find(
          (candidate) =>
            candidate.worktreePath !== null &&
            !candidate.checkoutRemovedAt &&
            samePath(candidate.worktreePath, checkoutPath),
        );
        if (!worktree?.worktreePath) {
          return yield* projectCopyError(
            "invalid",
            "That folder is neither the project's root nor one of its worktrees.",
          );
        }
        checkout = worktree.worktreePath;
      }
      const info = yield* Effect.promise(() => fsp.stat(checkout).catch(() => null));
      if (!info?.isDirectory()) {
        return yield* projectCopyError("invalid", "The project's folder is missing on this node.");
      }
      return checkout;
    });

  const readSource = (
    projectId: ProjectId,
    checkoutPath: string | undefined,
  ): Effect.Effect<ExportSource, ProjectCopyError> =>
    Effect.gen(function* () {
      const project = yield* loadProject(projectId);
      const checkout = yield* resolveCheckout(project, checkoutPath);
      const facts = yield* readRepositoryFacts(git, checkout, project.preferredRemoteName ?? null);
      const [pushed, scan] = facts
        ? yield* Effect.all([readPushedState(git, network, facts), scanWorkingTree(git, facts)], {
            concurrency: "unbounded",
          })
        : [null, null];
      const projectMetadataDir = project.projectMetadataDir ?? DEFAULT_PROJECT_METADATA_DIR;
      // A plain folder travels as its files: walked once here, packed from the same list.
      const folderScan = facts
        ? null
        : yield* scanFolder({ root: checkout, metadataDir: projectMetadataDir });
      const ignoredCandidates: ReadonlyArray<ProjectExportIgnoredCandidate> =
        facts && scan ? yield* readIgnoredCandidates(facts, scan) : (folderScan?.candidates ?? []);
      // The project's own overrides of node settings. What stays behind, and why, is on
      // `ProjectCopyOverrides`: the initial model and the worktree root only hold on this node.
      const overrides = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => projectRegistryOverrides(settings, project.id)),
        Effect.mapError(() =>
          projectCopyError("internal", "Could not read the project's settings."),
        ),
      );
      const repository: ProjectExportRepository = facts
        ? {
            rootPath: facts.displayRoot,
            isGitRepository: true,
            branch: facts.branch,
            headOid: facts.headOid,
            isDetached: facts.branch === null && facts.headOid !== null,
            remotes: [...facts.remotes].flatMap(([name, url]) => {
              const sanitized = network.sanitizeRemoteUrl(url).trim();
              return sanitized.length > 0 ? [{ name, url: sanitized }] : [];
            }),
            primaryRemoteName: facts.identityRemote?.remoteName ?? null,
            cloneRemoteName: facts.cloneRemote?.remoteName ?? null,
            canonicalKey: facts.identityRemote
              ? normalizeGitRemoteUrl(facts.identityRemote.remoteUrl)
              : null,
            isShallow: facts.isShallow,
            hasSubmodules: facts.hasSubmodules,
            usesLfs: facts.usesLfs,
          }
        : {
            rootPath: nodePath.resolve(checkout),
            isGitRepository: false,
            branch: null,
            headOid: null,
            isDetached: false,
            remotes: [],
            primaryRemoteName: null,
            cloneRemoteName: null,
            canonicalKey: null,
            isShallow: false,
            hasSubmodules: false,
            usesLfs: false,
          };
      return {
        facts,
        pushed,
        scan,
        folderScan,
        checkout,
        repository,
        pushedState: pushed?.state ?? {
          headOnRemote: false,
          upstreamBranch: null,
          unpushedCommitCount: 0,
        },
        workingTree: {
          trackedChangeCount: scan?.trackedChanged.length ?? 0,
          untrackedCount:
            (scan?.untrackedFiles.length ?? 0) + (scan?.nestedRepositories.length ?? 0),
          hasConflicts: scan?.hasConflicts ?? false,
          ignoredCandidates,
        },
        settings: {
          title: project.title,
          scripts: project.scripts,
          customSystemPrompt: project.customSystemPrompt ?? null,
          preferredRemoteName: project.preferredRemoteName ?? null,
          projectMetadataDir,
          hasCustomAvatar: (project.customAvatarContentHash ?? null) !== null,
          overrides,
          relativeRootInRepository: facts?.relativeRoot ?? "",
        },
      };
    });

  const readAvatar = (projectId: ProjectId, settings: ProjectExportSettings) =>
    settings.hasCustomAvatar ? avatars.read(projectId) : Effect.succeed(null);

  // ── Inspect ─────────────────────────────────────────────────────────

  const estimate = (
    kind: ProjectExportArtifactKind,
    estimatedBytes: number,
    skippedReason: string | null = null,
  ): ProjectExportArtifactEstimate => ({ kind, estimatedBytes, skippedReason });

  const estimateArtifacts = (projectId: ProjectId, source: ExportSource) =>
    Effect.gen(function* () {
      const { facts, pushed, scan } = source;
      const avatar = yield* readAvatar(projectId, source.settings);
      const avatarEstimate = avatar
        ? estimate("avatar", avatar.bytes.length)
        : estimate("avatar", 0, PROJECT_EXPORT_SKIP_REASON.noCustomAvatar);
      if (!facts || !pushed || !scan) {
        return [
          estimate("commits-bundle", 0, PROJECT_EXPORT_SKIP_REASON.notGitRepository),
          estimate("repository-bundle", 0, PROJECT_EXPORT_SKIP_REASON.notGitRepository),
          estimate("changes-patch", 0, PROJECT_EXPORT_SKIP_REASON.notGitRepository),
          avatarEstimate,
        ];
      }
      const root = facts.repositoryRoot;
      const commits =
        pushed.exclusion === null
          ? estimate("commits-bundle", 0, PROJECT_EXPORT_SKIP_REASON.noCommits)
          : facts.cloneRemote === null
            ? estimate("commits-bundle", 0, PROJECT_EXPORT_SKIP_REASON.noRemote)
            : pushed.state.unpushedCommitCount === 0
              ? estimate("commits-bundle", 0, PROJECT_EXPORT_SKIP_REASON.nothingUnpushed)
              : estimate(
                  "commits-bundle",
                  yield* estimateCommitsBundle(git, root, pushed.exclusion),
                );
      const repository =
        facts.headOid === null
          ? estimate("repository-bundle", 0, PROJECT_EXPORT_SKIP_REASON.noCommits)
          : facts.isShallow
            ? estimate("repository-bundle", 0, PROJECT_EXPORT_SKIP_REASON.shallow)
            : estimate("repository-bundle", yield* estimateRepositoryBundle(git, root));
      const changedPaths = [...scan.trackedChanged, ...scan.untrackedFiles];
      const sized = yield* sumFileSizes(
        root,
        changedPaths,
        4 * PROJECT_COPY_DEFAULT_PATCH_LIMIT_BYTES,
      );
      const changes =
        facts.headOid === null
          ? estimate("changes-patch", 0, PROJECT_EXPORT_SKIP_REASON.noCommits)
          : scan.hasConflicts
            ? estimate("changes-patch", 0, PROJECT_EXPORT_SKIP_REASON.conflicts)
            : scan.truncated || sized.overLimit
              ? estimate("changes-patch", sized.total, PROJECT_EXPORT_SKIP_REASON.overLimit)
              : changedPaths.length === 0 && scan.nestedRepositories.length === 0
                ? estimate("changes-patch", 0, PROJECT_EXPORT_SKIP_REASON.noChanges)
                : estimate("changes-patch", sized.total);
      return [commits, repository, changes, avatarEstimate];
    });

  const inspect: ProjectExportShape["inspect"] = Effect.fn("ProjectExport.inspect")(
    function* (input) {
      const source = yield* readSource(input.projectId, input.checkoutPath);
      return {
        projectId: input.projectId,
        repository: source.repository,
        pushedState: source.pushedState,
        workingTree: source.workingTree,
        settings: source.settings,
        ...(source.folderScan === null ? {} : { folder: source.folderScan.folder }),
        estimates: yield* estimateArtifacts(input.projectId, source),
      };
    },
  );

  // ── Build ───────────────────────────────────────────────────────────

  /** Sizes and hashes a written artifact; one over its transfer limit is deleted and skipped. */
  const register = (
    kind: ProjectExportArtifactKind,
    filePath: string,
    carriesIgnoredFiles: boolean,
  ): Effect.Effect<ExportArtifactFile | ProjectExportSkippedArtifact, ProjectCopyError> =>
    Effect.gen(function* () {
      const byteLength = (yield* io("Reading an export artifact", () => fsp.stat(filePath))).size;
      const limit =
        kind === "avatar" ? PROJECT_COPY_MAX_AVATAR_BYTES : PROJECT_COPY_MAX_ARTIFACT_BYTES;
      if (byteLength > limit) {
        yield* removeQuietly(filePath);
        return skippedOf(kind, PROJECT_EXPORT_SKIP_REASON.overLimit);
      }
      return {
        artifact: {
          artifactId: randomBytes(16).toString("base64url"),
          kind,
          byteLength,
          // Streamed: artifacts are never read whole into memory.
          sha256: (yield* io("Hashing an export artifact", () => sha256File(filePath))).sha256,
          ...(carriesIgnoredFiles ? { carriesIgnoredFiles: true } : {}),
        },
        filePath,
      };
    });

  const build = (request: ProjectExportStartRequest, directory: string) =>
    Effect.gen(function* () {
      const { input, channel } = request;
      const source = yield* readSource(input.projectId, input.checkoutPath);
      const candidates = new Set(source.workingTree.ignoredCandidates.map((entry) => entry.path));
      const requestedIgnored = [...new Set(input.include.ignoredPaths)];
      const unknown = requestedIgnored.filter((entry) => !candidates.has(entry));
      if (unknown.length > 0) {
        return yield* projectCopyError(
          "invalid",
          `Not among this checkout's ignored files: ${unknown.slice(0, 3).join(", ")}`,
        );
      }
      const skipped: ProjectExportSkippedArtifact[] = [];
      // The Hub or the network could read them over an unencrypted connection (amendment 33).
      const ignoredPaths = mayCarryIgnoredFiles(channel) ? requestedIgnored : [];
      if (ignoredPaths.length < requestedIgnored.length) {
        skipped.push(
          skippedOf(
            source.folderScan === null ? "changes-patch" : "folder-archive",
            PROJECT_EXPORT_SKIP_REASON.insecureChannel,
          ),
        );
      }

      yield* removeQuietly(directory);
      yield* io("Preparing the export", () => fsp.mkdir(directory, { recursive: true }));
      const artifacts: ExportArtifactFile[] = [];
      const fileOf = (kind: ProjectExportArtifactKind) =>
        nodePath.join(directory, ARTIFACT_FILE_NAMES[kind]);
      const collect = (
        kind: ProjectExportArtifactKind,
        built: BuiltArtifact,
        carriesIgnoredFiles = false,
      ) =>
        Effect.gen(function* () {
          skipped.push(...built.skipped);
          if (!built.built) return;
          const registered = yield* register(kind, fileOf(kind), carriesIgnoredFiles);
          if ("artifact" in registered) artifacts.push(registered);
          else skipped.push(registered);
        });
      const { facts, pushed, scan } = source;
      const notGit = (kind: ProjectExportArtifactKind) =>
        skipped.push(skippedOf(kind, PROJECT_EXPORT_SKIP_REASON.notGitRepository));

      if (input.include.commits) {
        if (facts && pushed) {
          yield* collect(
            "commits-bundle",
            yield* buildCommitsBundle({ git, facts, pushed, file: fileOf("commits-bundle") }),
          );
        } else notGit("commits-bundle");
      }
      if (input.include.wholeRepository) {
        if (facts) {
          yield* collect(
            "repository-bundle",
            yield* buildRepositoryBundle({ git, facts, file: fileOf("repository-bundle") }),
          );
        } else notGit("repository-bundle");
      }
      if (input.include.folderFiles === true) {
        const folderScan = source.folderScan;
        if (folderScan === null) {
          skipped.push(skippedOf("folder-archive", PROJECT_EXPORT_SKIP_REASON.gitRepository));
        } else if (folderScan.folder.skippedReason !== null) {
          skipped.push(skippedOf("folder-archive", folderScan.folder.skippedReason));
        } else {
          yield* buildFolderArchive({
            root: source.checkout,
            scan: folderScan,
            includePaths: ignoredPaths,
            file: fileOf("folder-archive"),
          });
          yield* collect("folder-archive", { built: true, skipped: [] }, ignoredPaths.length > 0);
        }
      }
      // A plain folder's opted-in files travel in its archive, not in a patch.
      const patchIgnoredPaths = source.folderScan === null ? ignoredPaths : [];
      if (input.include.workingTreeChanges || patchIgnoredPaths.length > 0) {
        if (facts && scan) {
          const workDirectory = nodePath.join(directory, PATCH_WORK_DIRECTORY);
          const patch = yield* buildChangesPatch({
            git,
            fs,
            path,
            facts,
            scan,
            workingTreeChanges: input.include.workingTreeChanges,
            ignoredPaths,
            limitBytes: input.patchLimitBytes ?? PROJECT_COPY_DEFAULT_PATCH_LIMIT_BYTES,
            workDirectory,
            file: fileOf("changes-patch"),
          }).pipe(Effect.ensuring(removeQuietly(workDirectory)));
          yield* collect("changes-patch", patch, ignoredPaths.length > 0);
        } else notGit("changes-patch");
      }
      if (input.include.avatar) {
        const avatar = yield* readAvatar(input.projectId, source.settings);
        if (avatar === null) {
          skipped.push(skippedOf("avatar", PROJECT_EXPORT_SKIP_REASON.noCustomAvatar));
        } else if (avatar.bytes.length > PROJECT_COPY_MAX_AVATAR_BYTES) {
          skipped.push(skippedOf("avatar", PROJECT_EXPORT_SKIP_REASON.overLimit));
        } else {
          yield* io("Writing the avatar", () => fsp.writeFile(fileOf("avatar"), avatar.bytes));
          yield* collect("avatar", { built: true, skipped: [] });
        }
      }
      return { source, artifacts, skipped } satisfies ExportBuild;
    });

  const resultOf = (
    exportId: ProjectExportResult["exportId"],
    built: ExportBuild,
    expiresAtMs: number,
  ) =>
    ({
      exportId,
      repository: built.source.repository,
      pushedState: built.source.pushedState,
      workingTree: built.source.workingTree,
      settings: built.source.settings,
      ...(built.source.folderScan === null ? {} : { folder: built.source.folderScan.folder }),
      artifacts: built.artifacts.map((file) => file.artifact),
      skipped: built.skipped,
      expiresAt: isoAt(expiresAtMs),
    }) satisfies ProjectExportResult;

  /**
   * Forgets the entry and deletes its files, unless a newer build of the same id (after an
   * expiry) owns the directory by now.
   */
  const discard = (entry: ExportEntry) =>
    Effect.suspend(() => {
      const current = entries.get(entry.exportId);
      if (current === entry) entries.delete(entry.exportId);
      return current === undefined || current === entry
        ? removeQuietly(entry.directory)
        : Effect.void;
    });

  const settle = (
    entry: ExportEntry,
    exportId: ProjectExportResult["exportId"],
    exit: Exit.Exit<ExportBuild, ProjectCopyError>,
  ) =>
    Effect.gen(function* () {
      if (Exit.isSuccess(exit)) {
        const now = yield* Clock.currentTimeMillis;
        entry.expiresAtMs = now + ttlMs;
        const result = resultOf(exportId, exit.value, entry.expiresAtMs);
        entry.ready = {
          result,
          artifacts: new Map(exit.value.artifacts.map((file) => [file.artifact.artifactId, file])),
        };
        yield* Deferred.succeed(entry.done, result);
        return;
      }
      yield* discard(entry);
      const failure = Cause.findErrorOption(exit.cause);
      const interrupted = Cause.hasInterruptsOnly(exit.cause);
      if (Option.isNone(failure) && !interrupted) {
        yield* Effect.logWarning("project export failed", { cause: Cause.pretty(exit.cause) });
      }
      yield* Deferred.fail(
        entry.done,
        Option.getOrElse(failure, () =>
          interrupted
            ? disposedBeforeFinished()
            : projectCopyError("internal", "The export failed unexpectedly."),
        ),
      );
    });

  /** The export's result, with its current expiry and what this caller's chunks may hold. */
  const answer = (entry: ExportEntry, maxChunkBytes: number) =>
    Deferred.await(entry.done).pipe(
      Effect.map((result) => ({
        ...result,
        expiresAt: isoAt(entry.expiresAtMs),
        maxChunkBytes,
      })),
    );

  const start: ProjectExportShape["start"] = Effect.fn("ProjectExport.start")(function* (request) {
    const { input, channel } = request;
    const maxChunkBytes = request.maxChunkBytes ?? PROJECT_COPY_DIRECT_CHUNK_BYTES;
    const directory = yield* exportDirectory(input.exportId);
    const digest = sha256Hex(
      canonicalJson({
        projectId: input.projectId,
        checkoutPath: input.checkoutPath ?? null,
        include: input.include,
        patchLimitBytes: input.patchLimitBytes ?? null,
      }),
    );
    const done = yield* Deferred.make<ProjectExportResult, ProjectCopyError>();
    const now = yield* Clock.currentTimeMillis;
    // No yield between the lookup and the insert: one build per export id.
    let existing = entries.get(input.exportId);
    if (existing?.ready && now >= existing.expiresAtMs) {
      // Expired but not swept yet: build again (the build starts by clearing the directory).
      entries.delete(input.exportId);
      existing = undefined;
    }
    if (existing) {
      if (existing.digest !== digest) {
        return yield* projectCopyError(
          "conflict",
          "This export id was already used for a different export.",
        );
      }
      if (existing.carriesIgnoredFiles && !mayCarryIgnoredFiles(channel)) {
        return yield* ignoredFilesRefused("This export");
      }
      return yield* answer(existing, maxChunkBytes);
    }
    const entry: ExportEntry = {
      exportId: input.exportId,
      digest,
      directory,
      carriesIgnoredFiles: input.include.ignoredPaths.length > 0 && mayCarryIgnoredFiles(channel),
      done,
      fiber: null,
      ready: null,
      expiresAtMs: Number.POSITIVE_INFINITY,
    };
    entries.set(input.exportId, entry);
    // In the layer's scope: a caller that disconnects leaves the build running for its retry. A
    // restart (a node updating itself) waits for it.
    entry.fiber = yield* buildPermits
      .withPermits(1)(build(request, directory))
      .pipe(
        restartWork.track,
        Effect.onExit((exit) => settle(entry, input.exportId, exit)),
        Effect.forkIn(layerScope),
      );
    return yield* answer(entry, maxChunkBytes);
  });

  // ── Read, dispose, sweep ────────────────────────────────────────────

  const readChunk: ProjectExportShape["readChunk"] = Effect.fn("ProjectExport.readChunk")(
    function* (
      input,
      channel?: ProjectCopyCallerChannel,
      maxChunkBytes: number = PROJECT_COPY_DIRECT_CHUNK_BYTES,
    ) {
      if (input.length > maxChunkBytes) {
        return yield* projectCopyError(
          "invalid",
          `A chunk may hold at most ${maxChunkBytes} bytes over this connection.`,
        );
      }
      const entry = entries.get(input.exportId);
      if (!entry) {
        return yield* projectCopyError("not-found", "This export is unknown or has expired.");
      }
      if (!entry.ready) {
        return yield* projectCopyError("conflict", "This export is still being prepared.");
      }
      const now = yield* Clock.currentTimeMillis;
      if (now >= entry.expiresAtMs) {
        yield* discard(entry);
        return yield* projectCopyError("expired", "This export has expired.");
      }
      const file = entry.ready.artifacts.get(input.artifactId);
      if (!file) return yield* projectCopyError("not-found", "Unknown export artifact.");
      if (file.artifact.carriesIgnoredFiles === true && !mayCarryIgnoredFiles(channel)) {
        return yield* ignoredFilesRefused("This artifact");
      }
      const { byteLength } = file.artifact;
      if (input.offset > byteLength) {
        return yield* projectCopyError("invalid", "The offset is past the end of the artifact.");
      }
      entry.expiresAtMs = now + ttlMs;
      const wanted = Math.min(input.length, byteLength - input.offset);
      const bytes = yield* Effect.acquireUseRelease(
        io("Reading an export artifact", () => fsp.open(file.filePath, "r")),
        (handle) =>
          io("Reading an export artifact", async () => {
            const buffer = Buffer.alloc(wanted);
            const { bytesRead } = await handle.read(buffer, 0, wanted, input.offset);
            return buffer.subarray(0, bytesRead);
          }),
        (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
      ).pipe(
        Effect.catch(() =>
          Effect.fail(projectCopyError("not-found", "This export's files are gone.")),
        ),
      );
      return {
        dataBase64: bytes.toString("base64"),
        offset: input.offset,
        length: bytes.length,
        eof: input.offset + bytes.length >= byteLength,
      };
    },
  );

  const dispose: ProjectExportShape["dispose"] = Effect.fn("ProjectExport.dispose")(
    function* (input) {
      const directory = yield* exportDirectory(input.exportId);
      const entry = entries.get(input.exportId);
      if (entry) {
        entries.delete(input.exportId);
        // Interrupting waits for the build's git processes to exit before the files go.
        if (!entry.ready && entry.fiber) yield* Fiber.interrupt(entry.fiber);
        // A build interrupted before it ran never settled: release whoever waits for it.
        yield* Deferred.fail(entry.done, disposedBeforeFinished());
      }
      yield* removeQuietly(directory);
    },
  );

  const sweep: ProjectExportShape["sweep"] = () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries.values()) {
        if (entry.ready && now >= entry.expiresAtMs) yield* discard(entry);
      }
      // Directories no live export owns: expired ones whose delete failed, or an earlier
      // process's. A build registers its id before it creates its directory.
      const names = yield* Effect.promise(() => fsp.readdir(exportsRoot).catch(() => []));
      for (const name of names) {
        if (!entries.has(name)) yield* removeQuietly(nodePath.join(exportsRoot, name));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project export sweep failed", { cause: Cause.pretty(cause) }),
      ),
    );

  yield* io("Preparing the export directory", () => fsp.mkdir(exportsRoot, { recursive: true }));
  if (options.disablePeriodicSweep !== true) {
    // The first pass right away clears what an earlier process left behind.
    yield* Effect.forkScoped(
      sweep().pipe(
        Effect.repeat(
          Schedule.spaced(Duration.millis(options.sweepIntervalMs ?? EXPORT_SWEEP_INTERVAL_MS)),
        ),
      ),
    );
  }

  return ProjectExport.of({ inspect, start, readChunk, dispose, sweep });
});

/**
 * The live export service. Needs `ServerConfig` (its state directory), `GitVcsDriver`,
 * `GitNetwork`, `ProjectionSnapshotQuery`, `ProjectAvatarStore` and `ServerSettingsService` (the
 * project's overrides); schedules its own sweep.
 */
export const makeProjectExportLive = (options?: ProjectExportLiveOptions) =>
  Layer.effect(ProjectExport, makeProjectExport(options));

export const ProjectExportLive = makeProjectExportLive();
