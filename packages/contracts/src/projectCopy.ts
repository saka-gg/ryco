/**
 * Cross-node project copy contracts.
 *
 * Nodes never talk to each other: a client connected to both reads the source
 * node (`projects.pathHints`, `projects.exportInspect`, `projects.export*`),
 * uploads the artifacts to the destination in chunks (`projects.transfer*`) and
 * starts a durable import job there (`projects.importStart`), which it can then
 * follow, cancel, list and discard. A node announces all of it with
 * `ExecutionEnvironmentCapabilities.projectCopy`.
 *
 * Every id is client-minted, so each call is idempotent by its id. Inputs the
 * destination joins into paths or passes to git (ids, relative paths, branch and
 * remote names, object ids, remote URLs) are bounded by pattern here; the
 * server still checks them against the file system and git.
 *
 * Exported as `@ryco/contracts/project-copy`, not from the package root.
 *
 * @module projectCopy
 */
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  UuidV4,
  rejectExcessProperties,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectCustomSystemPrompt,
  ProjectMetadataDir,
  ProjectScript,
  RuntimeMode,
} from "./orchestration.ts";
import { PROJECT_PREFERENCE_VALUES, ThreadEnvMode } from "./settings.ts";
import {
  GitBranchName,
  PROJECT_COPY_ABSOLUTE_PATH_MAX_CHARS,
  PortableProjectId,
  ProjectCopyAbsolutePath,
  ProjectCopyRemoteUrl,
  ProjectDestinationState,
  ProjectImportId,
  ProjectImportSetup,
} from "./projectCopyPrimitives.ts";

// The fields a copy plan names live apart so the app can decode plans without
// the rest of these schemas; this module still exports them.
export * from "./projectCopyPrimitives.ts";

// ── Limits ────────────────────────────────────────────────────────────

/**
 * Raw bytes per chunk that every node takes over any connection: its base64 (≈213 KiB) fits one
 * 256 KiB relay data chunk.
 */
export const PROJECT_COPY_CHUNK_BYTES = 160 * 1024;
/** Base64 characters of one full chunk. */
export const PROJECT_COPY_CHUNK_BASE64_MAX_CHARS = Math.ceil(PROJECT_COPY_CHUNK_BYTES / 3) * 4;
/**
 * The largest raw chunk over a direct connection. A node announces what it takes and serves over
 * the caller's connection as `maxChunkBytes` in its `projects.exportStart` and
 * `projects.transferBegin` answers: this over a direct connection, `PROJECT_COPY_CHUNK_BYTES`
 * over the relay. Older nodes announce nothing and take `PROJECT_COPY_CHUNK_BYTES`.
 */
export const PROJECT_COPY_DIRECT_CHUNK_BYTES = 1024 * 1024;
/** Base64 characters of one full direct chunk. */
export const PROJECT_COPY_DIRECT_CHUNK_BASE64_MAX_CHARS =
  Math.ceil(PROJECT_COPY_DIRECT_CHUNK_BYTES / 3) * 4;
/** Per bundle or patch transfer, on a direct connection. */
export const PROJECT_COPY_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
/**
 * Raw artifact total of one copy per relayed node: the Hub's per-channel budget
 * (50 MiB both ways) leaves room for base64 and the user's own session.
 */
export const PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
export const PROJECT_COPY_MAX_AVATAR_BYTES = 1024 * 1024;
export const PROJECT_COPY_DEFAULT_PATCH_LIMIT_BYTES = 64 * 1024 * 1024;
/** Opted-in ignored files (e.g. `.env`) per export, each at most 1 MiB. */
export const PROJECT_COPY_MAX_IGNORED_PATHS = 32;
export const PROJECT_COPY_MAX_IGNORED_FILE_BYTES = 1024 * 1024;
export const PROJECT_COPY_RELATIVE_PATH_MAX_CHARS = 1_024;
export const PROJECT_COPY_MAX_REMOTES = 32;
export const PROJECT_COPY_MAX_SCRIPTS = 100;
export const PROJECT_COPY_TITLE_MAX_CHARS = 500;
/** The follow-up setup thread's title, as an Agent Control thread title. */
export const PROJECT_COPY_THREAD_TITLE_MAX_CHARS = 200;
export const PROJECT_COPY_MAX_CODE_ROOTS = 8;
/** Snapshot `outputTail`: clone progress and setup output, at most 16 KiB. */
export const PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES = 16 * 1024;
/** `projects.listImports` returns at most this many recent jobs, newest first. */
export const PROJECT_IMPORT_LIST_MAX = 20;

export const FILESYSTEM_SEARCH_DIRECTORIES_QUERY_MAX_CHARS = 256;
export const FILESYSTEM_SEARCH_DIRECTORIES_MAX_ROOTS = 8;
export const FILESYSTEM_SEARCH_DIRECTORIES_DEFAULT_LIMIT = 40;
export const FILESYSTEM_SEARCH_DIRECTORIES_MAX_LIMIT = 100;
export const FILESYSTEM_SEARCH_DIRECTORIES_DEFAULT_DEPTH = 4;
export const FILESYSTEM_SEARCH_DIRECTORIES_MAX_DEPTH = 6;

// ── Ids ───────────────────────────────────────────────────────────────

export const ProjectExportId = UuidV4.pipe(Schema.brand("ProjectExportId"));
export type ProjectExportId = typeof ProjectExportId.Type;
export const ProjectTransferId = UuidV4.pipe(Schema.brand("ProjectTransferId"));
export type ProjectTransferId = typeof ProjectTransferId.Type;
/** Server-minted, looked up in its export's own table and never joined into a path. */
export const ProjectExportArtifactId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/),
);
export type ProjectExportArtifactId = typeof ProjectExportArtifactId.Type;

// ── Input hygiene ─────────────────────────────────────────────────────

/** Lowercase hex sha-256 of an artifact's raw bytes. */
export const ProjectCopySha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
/** A full SHA-1 or SHA-256 git object id. */
export const GitObjectId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, { message: "Expected a full git object id" }),
);
export type GitObjectId = typeof GitObjectId.Type;

export const GitRemoteName = Schema.String.check(
  Schema.isPattern(/^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
    message: "Expected a git remote name of letters, digits, '.', '_' or '-'",
  }),
);
export type GitRemoteName = typeof GitRemoteName.Type;

/**
 * A relative, slash-separated path inside a repository: no `.`, `..`, `.git` or
 * empty segment; no leading `/`, `~`, `:` or drive letter; no backslash or
 * control character. The `s` flag lets the lookaheads see past U+2028/U+2029
 * (see `GitBranchName`).
 */
export const ProjectCopyRelativePath = Schema.String.check(
  Schema.isMaxLength(PROJECT_COPY_RELATIVE_PATH_MAX_CHARS),
  Schema.isPattern(
    // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
    /^(?![/~:])(?![a-z]:)(?!.*\/\/)(?!.*\/$)(?!(?:.*\/)?(?:\.\.?|\.git)(?:\/|$))[^\\\x00-\x1f\x7f]+$/is,
    { message: "Expected a relative path inside the repository" },
  ),
);
export type ProjectCopyRelativePath = typeof ProjectCopyRelativePath.Type;

/** `""` (the repository root) or the monorepo subfolder the project is rooted at. */
export const ProjectCopyRelativeRoot = Schema.Union([Schema.Literal(""), ProjectCopyRelativePath]);
export type ProjectCopyRelativeRoot = typeof ProjectCopyRelativeRoot.Type;

// The node checks a chunk against the limit of the caller's connection (`maxChunkBytes`).
const Base64Chunk = Schema.String.check(
  Schema.isMaxLength(PROJECT_COPY_DIRECT_CHUNK_BASE64_MAX_CHARS),
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
);

// ── Node path hints: `projects.pathHints` ─────────────────────────────

export const NodePathHintsInput = Schema.Struct({}).pipe(rejectExcessProperties);
export type NodePathHintsInput = typeof NodePathHintsInput.Type;

export const NodeCodeRootSource = Schema.Literals([
  "access-root",
  "setting",
  "existing-projects",
  "well-known",
  "home",
]);
export type NodeCodeRootSource = typeof NodeCodeRootSource.Type;

export const NodeCodeRoot = Schema.Struct({
  path: TrimmedNonEmptyString,
  source: NodeCodeRootSource,
  /** Non-chat projects rooted under it. */
  projectCount: NonNegativeInt,
});
export type NodeCodeRoot = typeof NodeCodeRoot.Type;

export const NodePathHints = Schema.Struct({
  homeDirectory: TrimmedNonEmptyString,
  pathSeparator: Schema.Literals(["/", "\\"]),
  /**
   * The node's "normal code directory": the workspace access root when restricted,
   * else the `addProjectBaseDirectory` setting, else the common parent of ≥ 2
   * existing projects, else the first existing well-known folder, else home.
   */
  defaultProjectDirectory: TrimmedNonEmptyString,
  defaultProjectDirectorySource: NodeCodeRootSource,
  /** Existing directories only, best first. */
  codeRoots: Schema.Array(NodeCodeRoot).check(Schema.isMaxLength(PROJECT_COPY_MAX_CODE_ROOTS)),
  workspaceAccessRoot: Schema.NullOr(TrimmedNonEmptyString),
});
export type NodePathHints = typeof NodePathHints.Type;

// ── Folder search: `filesystem.searchDirectories` ─────────────────────

export const FilesystemSearchDirectoriesInput = Schema.Struct({
  /** Empty lists the roots shallowly, git repositories first. */
  query: Schema.String.check(Schema.isMaxLength(FILESYSTEM_SEARCH_DIRECTORIES_QUERY_MAX_CHARS)),
  /** The node's code roots when absent. */
  roots: Schema.optional(
    Schema.Array(ProjectCopyAbsolutePath).check(
      Schema.isMaxLength(FILESYSTEM_SEARCH_DIRECTORIES_MAX_ROOTS),
    ),
  ),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: FILESYSTEM_SEARCH_DIRECTORIES_MAX_LIMIT }),
    ),
  ),
  maxDepth: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: FILESYSTEM_SEARCH_DIRECTORIES_MAX_DEPTH }),
    ),
  ),
}).pipe(rejectExcessProperties);
export type FilesystemSearchDirectoriesInput = typeof FilesystemSearchDirectoriesInput.Type;

export const FilesystemDirectoryMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  parentPath: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  isGitRepository: Schema.Boolean,
  /** From `.git/HEAD`; null when unknown or detached. */
  gitBranch: Schema.NullOr(Schema.String),
  /** An existing non-chat project rooted here on this node. */
  projectId: Schema.NullOr(ProjectId),
  repositoryCanonicalKey: Schema.NullOr(Schema.String),
  score: Schema.Finite,
});
export type FilesystemDirectoryMatch = typeof FilesystemDirectoryMatch.Type;

export const FilesystemSearchDirectoriesResult = Schema.Struct({
  matches: Schema.Array(FilesystemDirectoryMatch),
  roots: Schema.Array(Schema.String),
  /**
   * The walk stopped at its directory or time budget, so some folders were not searched. One
   * directory read only in part (past the per-directory entry budget) does not set it.
   */
  truncated: Schema.Boolean,
  /**
   * More folders matched than `limit`: `matches` are the best of them. Absent from nodes that
   * predate it, whose `truncated` also covered directories read only in part.
   */
  limitReached: Schema.optional(Schema.Boolean),
  scannedDirectories: NonNegativeInt,
});
export type FilesystemSearchDirectoriesResult = typeof FilesystemSearchDirectoriesResult.Type;

// ── Destination preview: `projects.previewDestination` ────────────────

export const ProjectDestinationPreviewInput = Schema.Struct({
  /** Absolute or `~`-relative; anything else is judged `invalid`, never resolved. */
  path: Schema.String.check(Schema.isMaxLength(PROJECT_COPY_ABSOLUTE_PATH_MAX_CHARS)),
  /**
   * The client suggests this place on its own (A35); the user did not choose it. On macOS a
   * place in a privacy-guarded home folder (Desktop, Documents, Downloads, …) that holds none of
   * the node's code roots is then judged `access-denied` without being opened (A34).
   */
  suggested: Schema.optional(Schema.Boolean),
}).pipe(rejectExcessProperties);
export type ProjectDestinationPreviewInput = typeof ProjectDestinationPreviewInput.Type;

export const ProjectDestinationPreview = Schema.Struct({
  resolvedPath: Schema.String,
  state: ProjectDestinationState,
  existingProjectId: Schema.NullOr(ProjectId),
  /** When it is a git repository with a primary remote. */
  existingRepositoryCanonicalKey: Schema.NullOr(Schema.String),
  /** The first free `<path>-2`, `-3`, … when the path is not available. */
  suggestedPath: Schema.NullOr(Schema.String),
  /** Why the path is `access-denied`, `retired-checkout` or `invalid`. */
  detail: Schema.NullOr(Schema.String),
});
export type ProjectDestinationPreview = typeof ProjectDestinationPreview.Type;

// ── Remote access: `projects.checkRemoteAccess` ───────────────────────

export const ProjectCheckRemoteAccessInput = Schema.Struct({
  remoteUrl: ProjectCopyRemoteUrl,
}).pipe(rejectExcessProperties);
export type ProjectCheckRemoteAccessInput = typeof ProjectCheckRemoteAccessInput.Type;

export const ProjectCheckRemoteAccessResult = Schema.Struct({
  reachable: Schema.Boolean,
  /** The https ↔ ssh form that answered when the given one did not. */
  alternateRemoteUrl: Schema.NullOr(Schema.String),
  /** git's reason when unreachable, e.g. `host-key-unknown <host>`. */
  detail: Schema.NullOr(Schema.String),
});
export type ProjectCheckRemoteAccessResult = typeof ProjectCheckRemoteAccessResult.Type;

// ── Source export: `projects.exportInspect` / `projects.export*` ──────

/** What one export artifact (and the transfer that carries it) holds. */
export const ProjectExportArtifactKind = Schema.Literals([
  "commits-bundle",
  "repository-bundle",
  "changes-patch",
  "avatar",
]);
export type ProjectExportArtifactKind = typeof ProjectExportArtifactKind.Type;

export const ProjectExportRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Userinfo stripped. */
  url: TrimmedNonEmptyString,
});
export type ProjectExportRemote = typeof ProjectExportRemote.Type;

export const ProjectExportRepository = Schema.Struct({
  rootPath: TrimmedNonEmptyString,
  isGitRepository: Schema.Boolean,
  branch: Schema.NullOr(Schema.String),
  /** Null for a non-git folder or an unborn HEAD. */
  headOid: Schema.NullOr(Schema.String),
  isDetached: Schema.Boolean,
  remotes: Schema.Array(ProjectExportRemote),
  /** The identity remote (`upstream`, then `origin`, then the first); `canonicalKey` is its. */
  primaryRemoteName: Schema.NullOr(Schema.String),
  /**
   * The remote a copy clones from and `pushedState` is measured against: the project's preferred
   * remote when the checkout has it, else `origin`, else the identity remote. A copy recreates
   * the other remotes, so it keeps the source's identity.
   */
  cloneRemoteName: Schema.NullOr(Schema.String),
  canonicalKey: Schema.NullOr(Schema.String),
  isShallow: Schema.Boolean,
  hasSubmodules: Schema.Boolean,
  usesLfs: Schema.Boolean,
});
export type ProjectExportRepository = typeof ProjectExportRepository.Type;

/** Measured against the clone remote's advertised refs (`ls-remote`). */
export const ProjectExportPushedState = Schema.Struct({
  headOnRemote: Schema.Boolean,
  /** `origin/feature` when the branch exists on the clone remote. */
  upstreamBranch: Schema.NullOr(Schema.String),
  unpushedCommitCount: NonNegativeInt,
});
export type ProjectExportPushedState = typeof ProjectExportPushedState.Type;

export const ProjectExportIgnoredCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
});
export type ProjectExportIgnoredCandidate = typeof ProjectExportIgnoredCandidate.Type;

export const ProjectExportWorkingTree = Schema.Struct({
  trackedChangeCount: NonNegativeInt,
  untrackedCount: NonNegativeInt,
  hasConflicts: Schema.Boolean,
  /** Ignored files that may be opted in (`.env*`, `*.local`, each ≤ 1 MiB). */
  ignoredCandidates: Schema.Array(ProjectExportIgnoredCandidate),
});
export type ProjectExportWorkingTree = typeof ProjectExportWorkingTree.Type;

/**
 * The project's own overrides of node settings that a copy carries: the keys of the project
 * preference registry (`PROJECT_PREFERENCE_VALUES`) the project sets for itself. An absent key
 * inherits the destination node's setting. Each value is bounded by the registry's own schema and
 * an unknown key is refused, so a key added to the registry is carried without a change here.
 *
 * Two project preferences stay behind because they only hold on the source node:
 * - the initial model (`initialModelSelection`) names a provider instance configured there;
 * - the worktree root (`projectWorktreeRoots`) is an absolute path on its disk.
 */
export const ProjectCopyOverrides = Schema.Struct(
  Struct.map(PROJECT_PREFERENCE_VALUES.fields, Schema.optionalKey),
).pipe(rejectExcessProperties);
export type ProjectCopyOverrides = typeof ProjectCopyOverrides.Type;

export const ProjectExportSettings = Schema.Struct({
  title: TrimmedNonEmptyString,
  scripts: Schema.Array(ProjectScript),
  customSystemPrompt: Schema.NullOr(ProjectCustomSystemPrompt),
  preferredRemoteName: Schema.NullOr(Schema.String),
  projectMetadataDir: ProjectMetadataDir,
  hasCustomAvatar: Schema.Boolean,
  overrides: ProjectCopyOverrides,
  /** `""` or the monorepo subfolder of the project root. */
  relativeRootInRepository: Schema.String,
});
export type ProjectExportSettings = typeof ProjectExportSettings.Type;

const projectExportSourceFields = {
  repository: ProjectExportRepository,
  pushedState: ProjectExportPushedState,
  workingTree: ProjectExportWorkingTree,
  settings: ProjectExportSettings,
};

export const ProjectExportInspectInput = Schema.Struct({
  projectId: ProjectId,
  /** One of the project's registered worktrees; the project root when absent. */
  checkoutPath: Schema.optional(ProjectCopyAbsolutePath),
}).pipe(rejectExcessProperties);
export type ProjectExportInspectInput = typeof ProjectExportInspectInput.Type;

/** What an export of each artifact would hold, without creating it. */
export const ProjectExportArtifactEstimate = Schema.Struct({
  kind: ProjectExportArtifactKind,
  estimatedBytes: NonNegativeInt,
  /** Set when the export would skip this artifact, e.g. "nothing unpushed". */
  skippedReason: Schema.NullOr(Schema.String),
});
export type ProjectExportArtifactEstimate = typeof ProjectExportArtifactEstimate.Type;

export const ProjectExportInspection = Schema.Struct({
  projectId: ProjectId,
  ...projectExportSourceFields,
  estimates: Schema.Array(ProjectExportArtifactEstimate),
});
export type ProjectExportInspection = typeof ProjectExportInspection.Type;

export const ProjectExportInclude = Schema.Struct({
  /** A bundle of the commits the primary remote lacks, always including HEAD. */
  commits: Schema.Boolean,
  /** A binary patch of staged, unstaged and untracked (not ignored) changes. */
  workingTreeChanges: Schema.Boolean,
  /** Opted-in ignored files; each must be one of the export's ignored candidates. */
  ignoredPaths: Schema.Array(ProjectCopyRelativePath).check(
    Schema.isMaxLength(PROJECT_COPY_MAX_IGNORED_PATHS),
  ),
  /** Branches, tags and remote-tracking refs, for a repository without a usable remote. */
  wholeRepository: Schema.Boolean,
  avatar: Schema.Boolean,
}).pipe(rejectExcessProperties);
export type ProjectExportInclude = typeof ProjectExportInclude.Type;

export const ProjectExportStartInput = Schema.Struct({
  exportId: ProjectExportId,
  projectId: ProjectId,
  checkoutPath: Schema.optional(ProjectCopyAbsolutePath),
  include: ProjectExportInclude,
  /** `PROJECT_COPY_DEFAULT_PATCH_LIMIT_BYTES` when absent. */
  patchLimitBytes: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_COPY_MAX_ARTIFACT_BYTES)),
  ),
}).pipe(rejectExcessProperties);
export type ProjectExportStartInput = typeof ProjectExportStartInput.Type;

export const ProjectExportArtifact = Schema.Struct({
  artifactId: ProjectExportArtifactId,
  kind: ProjectExportArtifactKind,
  byteLength: NonNegativeInt,
  sha256: ProjectCopySha256,
  /**
   * True when it holds opted-in ignored files (a changes patch with `.env`). Declare it at
   * `transferBegin`: neither node lets these bytes cross an unencrypted connection (A33).
   */
  carriesIgnoredFiles: Schema.optional(Schema.Boolean),
});
export type ProjectExportArtifact = typeof ProjectExportArtifact.Type;

export const ProjectExportSkippedArtifact = Schema.Struct({
  kind: ProjectExportArtifactKind,
  /** e.g. "nothing unpushed", "over limit", "conflicts", "insecure-channel". */
  reason: Schema.String,
});
export type ProjectExportSkippedArtifact = typeof ProjectExportSkippedArtifact.Type;

export const ProjectExportResult = Schema.Struct({
  exportId: ProjectExportId,
  ...projectExportSourceFields,
  artifacts: Schema.Array(ProjectExportArtifact),
  skipped: Schema.Array(ProjectExportSkippedArtifact),
  /** Artifacts are deleted 30 minutes after the last read, or on dispose. */
  expiresAt: IsoDateTime,
  /**
   * The largest `length` `projects.exportReadChunk` serves over the caller's connection; absent
   * on older nodes, which serve `PROJECT_COPY_CHUNK_BYTES`.
   */
  maxChunkBytes: Schema.optional(PositiveInt),
});
export type ProjectExportResult = typeof ProjectExportResult.Type;

export const ProjectExportReadChunkInput = Schema.Struct({
  exportId: ProjectExportId,
  artifactId: ProjectExportArtifactId,
  offset: NonNegativeInt,
  /** At most the `maxChunkBytes` the export's start announced (`PROJECT_COPY_CHUNK_BYTES` if none). */
  length: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_COPY_DIRECT_CHUNK_BYTES)),
}).pipe(rejectExcessProperties);
export type ProjectExportReadChunkInput = typeof ProjectExportReadChunkInput.Type;

export const ProjectExportReadChunkResult = Schema.Struct({
  dataBase64: Base64Chunk,
  offset: NonNegativeInt,
  /** Raw bytes in this chunk. */
  length: NonNegativeInt,
  eof: Schema.Boolean,
});
export type ProjectExportReadChunkResult = typeof ProjectExportReadChunkResult.Type;

export const ProjectExportDisposeInput = Schema.Struct({
  exportId: ProjectExportId,
}).pipe(rejectExcessProperties);
export type ProjectExportDisposeInput = typeof ProjectExportDisposeInput.Type;

// ── Transfer: `projects.transfer*` on the destination ─────────────────

/** Which import field may claim the transfer: it must match there. */
export const ProjectTransferPurpose = ProjectExportArtifactKind;
export type ProjectTransferPurpose = ProjectExportArtifactKind;

/** Idempotent for the same id, purpose, length and digest. */
export const ProjectTransferBeginInput = Schema.Struct({
  transferId: ProjectTransferId,
  purpose: ProjectTransferPurpose,
  /** At most `PROJECT_COPY_MAX_ARTIFACT_BYTES` (`PROJECT_COPY_MAX_AVATAR_BYTES` for an avatar). */
  byteLength: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_COPY_MAX_ARTIFACT_BYTES)),
  sha256: ProjectCopySha256,
  /**
   * The artifact's `carriesIgnoredFiles`. The node then refuses the transfer's begin and appends
   * over an unencrypted connection (`access-denied`), as the source refuses to read them out
   * there (A33). Part of the begin's identity.
   */
  carriesIgnoredFiles: Schema.optional(Schema.Boolean),
}).pipe(rejectExcessProperties);
export type ProjectTransferBeginInput = typeof ProjectTransferBeginInput.Type;

/** `receivedBytes` lets a client resume after a reconnect. */
export const ProjectTransferProgress = Schema.Struct({
  transferId: ProjectTransferId,
  receivedBytes: NonNegativeInt,
  /**
   * In `projects.transferBegin`'s answer: the largest chunk `projects.transferAppend` takes over
   * the caller's connection. Absent on older nodes, which take `PROJECT_COPY_CHUNK_BYTES`.
   */
  maxChunkBytes: Schema.optional(PositiveInt),
});
export type ProjectTransferProgress = typeof ProjectTransferProgress.Type;

/**
 * Appends at `offset == receivedBytes`. A range already written is a no-op when
 * its bytes match and a `conflict` when they differ. A chunk a few chunks ahead
 * (sent while the ones before it are in flight) waits a while for them; a
 * bigger gap, or one that does not close in time, fails with the node's
 * `receivedBytes`.
 */
export const ProjectTransferAppendInput = Schema.Struct({
  transferId: ProjectTransferId,
  offset: NonNegativeInt,
  dataBase64: Base64Chunk.check(Schema.isMinLength(1)),
}).pipe(rejectExcessProperties);
export type ProjectTransferAppendInput = typeof ProjectTransferAppendInput.Type;

export const ProjectTransferIdInput = Schema.Struct({
  transferId: ProjectTransferId,
}).pipe(rejectExcessProperties);
export type ProjectTransferIdInput = typeof ProjectTransferIdInput.Type;

/** Verifies length and digest; later appends fail. */
export const ProjectTransferCommitInput = ProjectTransferIdInput;
export type ProjectTransferCommitInput = ProjectTransferIdInput;
export const ProjectTransferAbortInput = ProjectTransferIdInput;
export type ProjectTransferAbortInput = ProjectTransferIdInput;

export const ProjectTransferCommitResult = Schema.Struct({
  transferId: ProjectTransferId,
  byteLength: NonNegativeInt,
  sha256: ProjectCopySha256,
});
export type ProjectTransferCommitResult = typeof ProjectTransferCommitResult.Type;

// ── Import: `projects.importStart` and the job on the destination ─────

export const ProjectCopyRemote = Schema.Struct({
  name: GitRemoteName,
  url: ProjectCopyRemoteUrl,
}).pipe(rejectExcessProperties);
export type ProjectCopyRemote = typeof ProjectCopyRemote.Type;

export const ProjectImportSource = Schema.Union([
  /** `git clone --no-checkout --origin <remoteName>`; the checkout step picks the branch. */
  Schema.Struct({
    kind: Schema.Literal("clone"),
    remoteUrl: ProjectCopyRemoteUrl,
    remoteName: GitRemoteName,
  }).pipe(rejectExcessProperties),
  /** A fresh repository fetched from a committed `repository-bundle` transfer. */
  Schema.Struct({
    kind: Schema.Literal("repository-bundle"),
    transferId: ProjectTransferId,
  }).pipe(rejectExcessProperties),
  /**
   * Links a checkout already at `destinationPath`; its canonical key must match.
   * The job never owns or deletes that directory.
   */
  Schema.Struct({
    kind: Schema.Literal("existing-checkout"),
    expectedCanonicalKey: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  }).pipe(rejectExcessProperties),
]);
export type ProjectImportSource = typeof ProjectImportSource.Type;

/** Fetched from a `commits-bundle` transfer; the branch and oid live in `checkout`. */
export const ProjectImportCommits = Schema.Struct({
  transferId: ProjectTransferId,
}).pipe(rejectExcessProperties);
export type ProjectImportCommits = typeof ProjectImportCommits.Type;

/**
 * Where the checkout ends. `headOid` is authoritative when set (a missing oid
 * fails the import); a null `branch` detaches. A null `checkout` takes the
 * remote's default branch.
 */
export const ProjectImportCheckout = Schema.Struct({
  branch: Schema.NullOr(GitBranchName),
  headOid: Schema.NullOr(GitObjectId),
}).pipe(rejectExcessProperties);
export type ProjectImportCheckout = typeof ProjectImportCheckout.Type;

/** Applied only when HEAD equals `baseOid`; otherwise kept for a manual apply. */
export const ProjectImportChanges = Schema.Struct({
  transferId: ProjectTransferId,
  baseOid: GitObjectId,
  /**
   * The opted-in ignored files the patch carries (the export's `include.ignoredPaths`). Each
   * one the destination's repository does not ignore goes into its `.git/info/exclude`, so it
   * is never committed or checkpointed there.
   */
  ignoredPaths: Schema.Array(ProjectCopyRelativePath).check(
    Schema.isMaxLength(PROJECT_COPY_MAX_IGNORED_PATHS),
  ),
}).pipe(rejectExcessProperties);
export type ProjectImportChanges = typeof ProjectImportChanges.Type;

export const ProjectImportSettings = Schema.Struct({
  scripts: Schema.Array(ProjectScript).check(Schema.isMaxLength(PROJECT_COPY_MAX_SCRIPTS)),
  customSystemPrompt: Schema.NullOr(ProjectCustomSystemPrompt),
  preferredRemoteName: Schema.NullOr(GitRemoteName),
  projectMetadataDir: ProjectMetadataDir,
  /** Written as the new project's overrides; `{}` keeps every node setting. */
  overrides: ProjectCopyOverrides,
}).pipe(rejectExcessProperties);
export type ProjectImportSettings = typeof ProjectImportSettings.Type;

/**
 * An agent thread the destination starts in the new project after setup, with
 * the setup's exit code and output when it failed.
 */
export const ProjectImportFollowUpThread = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_COPY_THREAD_TITLE_MAX_CHARS)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  runtimeMode: RuntimeMode,
  envMode: ThreadEnvMode,
  /** Resolved against the destination's providers. */
  modelSelection: ModelSelection,
}).pipe(rejectExcessProperties);
export type ProjectImportFollowUpThread = typeof ProjectImportFollowUpThread.Type;

/** Display only: the destination never relaxes a check because of it. */
export const ProjectImportOrigin = Schema.Struct({
  kind: Schema.Literals(["user", "agent-control"]),
  sourceLabel: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  proposalId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
}).pipe(rejectExcessProperties);
export type ProjectImportOrigin = typeof ProjectImportOrigin.Type;

/**
 * Idempotent by `importId`: the same id with the same input returns the job's
 * snapshot; the same id with a different input fails `conflict`.
 */
export const ProjectImportStartInput = Schema.Struct({
  importId: ProjectImportId,
  /** Client-minted id of the new project on the destination. */
  projectId: PortableProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_COPY_TITLE_MAX_CHARS)),
  /** The repository directory: missing or empty (or the checkout to link). */
  destinationPath: ProjectCopyAbsolutePath,
  source: ProjectImportSource,
  /** Recreated after the clone (never replacing the clone remote); userinfo stripped. */
  remotes: Schema.Array(ProjectCopyRemote).check(Schema.isMaxLength(PROJECT_COPY_MAX_REMOTES)),
  commits: Schema.NullOr(ProjectImportCommits),
  checkout: Schema.NullOr(ProjectImportCheckout),
  changes: Schema.NullOr(ProjectImportChanges),
  /** The project root is `destinationPath/<relativeRootInRepository>`. */
  relativeRootInRepository: ProjectCopyRelativeRoot,
  /** Run `git submodule update --init --recursive` when the checkout has submodules. */
  recurseSubmodules: Schema.Boolean,
  /** Run `git lfs pull` when git-lfs is installed; otherwise warn that large files are pointers. */
  usesLfs: Schema.Boolean,
  settings: Schema.NullOr(ProjectImportSettings),
  avatarTransferId: Schema.NullOr(ProjectTransferId),
  setup: Schema.NullOr(ProjectImportSetup),
  followUpThread: Schema.NullOr(ProjectImportFollowUpThread),
  origin: ProjectImportOrigin,
}).pipe(rejectExcessProperties);
export type ProjectImportStartInput = typeof ProjectImportStartInput.Type;

/**
 * The submodule and LFS steps of a clone whose repository nobody inspected (a source without
 * project copy, a repository URL). Both are asked for: the destination updates submodules only
 * when the checkout has them and pulls Git LFS files only when a path is tracked by LFS, and
 * either step only warns (A14).
 */
export const PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS = {
  recurseSubmodules: true,
  usesLfs: true,
} as const satisfies Pick<ProjectImportStartInput, "recurseSubmodules" | "usesLfs">;

export const ProjectImportStepId = Schema.Literals([
  "preflight",
  "clone",
  "remotes",
  "commits",
  "checkout",
  "changes",
  "submodules",
  "lfs",
  "register",
  "settings",
  "avatar",
  "setup",
  "follow-up",
]);
export type ProjectImportStepId = typeof ProjectImportStepId.Type;

export const ProjectImportStepStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
]);
export type ProjectImportStepStatus = typeof ProjectImportStepStatus.Type;

export const ProjectImportStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ProjectImportStatus = typeof ProjectImportStatus.Type;

export const PROJECT_IMPORT_TERMINAL_STATUSES: ReadonlyArray<ProjectImportStatus> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export const ProjectImportErrorCode = Schema.Literals([
  "destination-unavailable",
  "access-denied",
  "remote-unreachable",
  "clone-failed",
  "commits-failed",
  "checkout-failed",
  "changes-conflict",
  "register-failed",
  "transfer-missing",
  "cancelled",
  "interrupted",
  "internal",
]);
export type ProjectImportErrorCode = typeof ProjectImportErrorCode.Type;

export const ProjectImportStep = Schema.Struct({
  id: ProjectImportStepId,
  status: ProjectImportStepStatus,
  progressPercent: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
  detail: Schema.NullOr(Schema.String),
});
export type ProjectImportStep = typeof ProjectImportStep.Type;

export const ProjectImportError = Schema.Struct({
  step: ProjectImportStepId,
  code: ProjectImportErrorCode,
  message: Schema.String,
});
export type ProjectImportError = typeof ProjectImportError.Type;

export const ProjectImportPreflight = Schema.Struct({
  remoteReachable: Schema.NullOr(Schema.Boolean),
  /** The https ↔ ssh form the clone used instead of the given URL. */
  alternateRemoteUrl: Schema.NullOr(Schema.String),
});
export type ProjectImportPreflight = typeof ProjectImportPreflight.Type;

export const ProjectImportSnapshot = Schema.Struct({
  importId: ProjectImportId,
  projectId: ProjectId,
  title: Schema.String,
  destinationPath: Schema.String,
  status: ProjectImportStatus,
  steps: Schema.Array(ProjectImportStep),
  /** At most `PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES`: clone progress and setup output. */
  outputTail: Schema.String,
  error: Schema.NullOr(ProjectImportError),
  warnings: Schema.Array(Schema.String),
  preflight: Schema.NullOr(ProjectImportPreflight),
  /** A directory the job owns that is left after an interrupted or failed run. */
  leftoverPath: Schema.NullOr(Schema.String),
  /** The thread the `follow-up` step started. */
  followUpThreadId: Schema.NullOr(ThreadId),
  origin: ProjectImportOrigin,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectImportSnapshot = typeof ProjectImportSnapshot.Type;

export const ProjectImportIdInput = Schema.Struct({
  importId: ProjectImportId,
}).pipe(rejectExcessProperties);
export type ProjectImportIdInput = typeof ProjectImportIdInput.Type;

/** The first item is the current snapshot; an unknown id fails `not-found`. */
export const ProjectSubscribeImportInput = ProjectImportIdInput;
export type ProjectSubscribeImportInput = ProjectImportIdInput;
export const ProjectCancelImportInput = ProjectImportIdInput;
export type ProjectCancelImportInput = ProjectImportIdInput;
/** Deletes `leftoverPath` when the job owns it and never registered a project. */
export const ProjectDiscardImportInput = ProjectImportIdInput;
export type ProjectDiscardImportInput = ProjectImportIdInput;

export const ProjectListImportsInput = Schema.Struct({}).pipe(rejectExcessProperties);
export type ProjectListImportsInput = typeof ProjectListImportsInput.Type;

export const ProjectListImportsResult = Schema.Struct({
  /** At most `PROJECT_IMPORT_LIST_MAX`, newest first. */
  imports: Schema.Array(ProjectImportSnapshot),
});
export type ProjectListImportsResult = typeof ProjectListImportsResult.Type;

export const ProjectDiscardImportResult = Schema.Struct({
  deleted: Schema.Boolean,
  /** Why nothing was deleted. */
  reason: Schema.NullOr(Schema.String),
});
export type ProjectDiscardImportResult = typeof ProjectDiscardImportResult.Type;

// ── Errors ────────────────────────────────────────────────────────────

export const ProjectCopyErrorCode = Schema.Literals([
  /** The node does not implement this yet, or a service it needs is not running. */
  "unavailable",
  "not-found",
  "invalid",
  "access-denied",
  /** A reused id with different input, a rewritten range, a reserved destination. */
  "conflict",
  "too-large",
  /** The node's scratch space for transfers is full. */
  "capacity",
  "expired",
  "internal",
]);
export type ProjectCopyErrorCode = typeof ProjectCopyErrorCode.Type;

/** One error for every project-copy RPC; `code` is the stable, machine-readable part. */
export class ProjectCopyError extends Schema.TaggedError<ProjectCopyError>()("ProjectCopyError", {
  code: ProjectCopyErrorCode,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  /** A transfer append past the end: the bytes the node holds, to resume from. */
  receivedBytes: Schema.optional(NonNegativeInt),
}) {}
