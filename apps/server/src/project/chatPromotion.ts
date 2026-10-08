/**
 * ChatPromotion - "Turn into project…" for a chat without a project.
 *
 * A chat is a `kind: "chat"` project whose folder lives under the chats root. Promotion moves that
 * folder to a destination the user picks and then turns the same project record into a regular
 * project. Threads never change project, so every conversation stays attached.
 *
 * Every move is journaled in `project_relocations` before its sessions stop and its files move.
 * While the row is unsettled, storage admission (`storage/lifecycle.ts`) refuses turns, provider
 * sessions and terminals in either folder. Startup recovery (`recoverProjectRelocations`) then
 * finishes or undoes a move that an earlier process could not complete, and it never deletes a
 * folder Ryco did not create.
 *
 * @module ChatPromotion
 */
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  CommandId,
  type DiagnosticsTerminalProcess,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProjectChatDestinationStatus,
  ProjectChatError,
  type ProjectId,
  type ProjectsPromoteChatInput,
  type ProjectsPromoteChatPreviewInput,
  type ProjectsPromoteChatPreviewResult,
  type ProjectsPromoteChatResult,
  type ProviderSession,
  type ThreadId,
} from "@ryco/contracts";
import { directorySlug } from "@ryco/shared/directorySlug";
import { isChatProject } from "@ryco/shared/projectKind";
import { Cause, Effect, Option, Result } from "effect";

import type { ServerConfigShape } from "../config.ts";
import {
  isCheckpointRevertPending,
  threadBusyReason,
} from "../orchestration/checkpointRevertPolicy.ts";
import { hasActionableContextHandoff } from "../orchestration/commandInvariants.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadShellSettlementInput } from "../orchestration/threadSettlementInput.ts";
import { expandHomePath } from "../pathExpansion.ts";
import type {
  ProjectionProject,
  ProjectionProjectRepositoryShape,
} from "../persistence/Services/ProjectionProjects.ts";
import type {
  ProjectionThread,
  ProjectionThreadRepositoryShape,
} from "../persistence/Services/ProjectionThreads.ts";
import type {
  ProjectRelocation,
  ProjectRelocationRepositoryShape,
} from "../persistence/Services/ProjectRelocations.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import { type StoragePathBlocker, storageLifecycleLock } from "../storage/lifecycle.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import { isTerminalAlive, isTerminalWorking } from "../terminal/terminalActivity.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { containsPath, samePath } from "../workspace/checkoutInspection.ts";
import type { WorkspaceAccessPolicyShape } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import type { ChatFoldersShape } from "./chatFolders.ts";
import { canonicalizeWorktreePath, resolveExistingAncestor } from "./worktreeRoot.ts";

/** The preview's walk stops here; its counts are then lower limits. */
export const PROMOTION_SCAN_MAX_ENTRIES = 20_000;
/** `-2` … `-100`; past that the plain name is suggested and judged as taken. */
const DEFAULT_DESTINATION_MAX_SUFFIX = 100;
const SCAN_STAT_BATCH = 64;
const GIT_PROBE_TIMEOUT_MS = 5_000;
const ACCESS_OPERATION = "chat promotion";

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** The original error behind an `Effect.tryPromise` failure. */
const unwrapCause = (cause: unknown): unknown =>
  Cause.isUnknownError(cause) ? unwrapCause(cause.cause) : cause;

const errnoCode = (cause: unknown): string | undefined => {
  const original = unwrapCause(cause);
  return typeof original === "object" && original !== null && "code" in original
    ? String((original as { readonly code: unknown }).code)
    : undefined;
};

const describeCause = (cause: unknown): string => {
  const original = unwrapCause(cause);
  return original instanceof Error ? original.message : String(original);
};

const exists = async (target: string) => {
  try {
    await lstat(target);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
};

/** Copy a folder's contents into an existing, empty folder. Symlinks are copied, never followed. */
export async function copyFolderContents(source: string, destination: string): Promise<void> {
  const copyEntry = async (from: string, to: string): Promise<void> => {
    const entry = await lstat(from);
    if (entry.isSymbolicLink()) {
      // Verbatim: a relative link keeps pointing at the same sibling, an absolute one is unchanged.
      await symlink(await readlink(from), to);
      return;
    }
    if (entry.isFile()) {
      await copyFile(from, to, fsConstants.COPYFILE_EXCL);
      await chmod(to, entry.mode & 0o7777);
      await utimes(to, entry.atime, entry.mtime);
      return;
    }
    if (entry.isDirectory()) {
      // Writable while children are copied; the original mode is applied last.
      await mkdir(to, { mode: 0o700 });
      await copyChildren(from, to);
      await chmod(to, entry.mode & 0o7777);
      await utimes(to, entry.atime, entry.mtime);
      return;
    }
    throw new Error(`Cannot copy the special file ${from}.`);
  };
  const copyChildren = async (from: string, to: string): Promise<void> => {
    const directory = await opendir(from);
    for await (const child of directory) {
      await copyEntry(path.join(from, child.name), path.join(to, child.name));
    }
  };
  const root = await lstat(source);
  await copyChildren(source, destination);
  await chmod(destination, root.mode & 0o7777);
  await utimes(destination, root.atime, root.mtime);
}

export interface TreeManifestEntry {
  readonly kind: "directory" | "file" | "symlink" | "other";
  /** Bytes of a file; 0 otherwise (folder sizes differ between filesystems). */
  readonly size: number;
  readonly linkTarget: string | null;
  readonly modifiedMs: number;
}

/** Every entry below `root`, by `/`-separated relative path. */
export async function readTreeManifest(
  root: string,
): Promise<ReadonlyMap<string, TreeManifestEntry>> {
  const manifest = new Map<string, TreeManifestEntry>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const child of handle) {
      const absolute = path.join(directory, child.name);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const entry = await lstat(absolute);
      const kind = entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : entry.isFile()
            ? "file"
            : "other";
      manifest.set(relative, {
        kind,
        size: kind === "file" ? entry.size : 0,
        linkTarget: kind === "symlink" ? await readlink(absolute) : null,
        modifiedMs: kind === "file" ? entry.mtimeMs : 0,
      });
      if (kind === "directory") await walk(absolute, relative);
    }
  };
  await walk(root, "");
  return manifest;
}

/**
 * Same entries, kinds, sizes and link targets. `compareModifiedTimes` also notices a file edited
 * in place without changing its size; only use it to compare a folder with itself, since a copy's
 * timestamps can lose precision.
 */
export const sameManifest = (
  left: ReadonlyMap<string, TreeManifestEntry>,
  right: ReadonlyMap<string, TreeManifestEntry>,
  options: { readonly compareModifiedTimes: boolean },
): boolean => {
  if (left.size !== right.size) return false;
  for (const [relative, entry] of left) {
    const other = right.get(relative);
    if (
      other === undefined ||
      other.kind !== entry.kind ||
      other.size !== entry.size ||
      other.linkTarget !== entry.linkTarget ||
      (options.compareModifiedTimes && other.modifiedMs !== entry.modifiedMs)
    ) {
      return false;
    }
  }
  return true;
};

/** The file operations a move performs; injected by tests to simulate other disks and failures. */
export interface ChatPromotionFileSystem {
  readonly rename: (from: string, to: string) => Promise<void>;
  /** Create the destination folder itself; fails when anything already exists there. */
  readonly makeDirectory: (target: string, mode: number) => Promise<void>;
  readonly copyContents: (from: string, to: string) => Promise<void>;
  readonly removeTree: (target: string) => Promise<void>;
}

/**
 * Remove a folder tree. A copy keeps read-only folders read-only (a `chmod -R a-w` tree, an
 * extracted archive), and `rm` cannot empty those: on a permission error every folder in the tree
 * is made writable by its owner, then the removal is retried. Symlinks are never followed.
 */
export async function removeFolderTree(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
    return;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw cause;
  }
  const makeWritable = async (directory: string): Promise<void> => {
    const entry = await lstat(directory).catch(() => null);
    if (entry === null || !entry.isDirectory()) return;
    // Before reading it: a folder without read or search permission cannot be listed.
    await chmod(directory, (entry.mode & 0o7777) | 0o700);
    for await (const child of await opendir(directory)) {
      if (child.isDirectory()) await makeWritable(path.join(directory, child.name));
    }
  };
  await makeWritable(target);
  await rm(target, { recursive: true, force: true });
}

export const nodeChatPromotionFileSystem: ChatPromotionFileSystem = {
  rename,
  makeDirectory: (target, mode) => mkdir(target, { mode }),
  copyContents: copyFolderContents,
  removeTree: removeFolderTree,
};

export interface ChatFolderScan {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/** Count files (anything but folders) and their bytes, visiting at most `maxEntries` entries. */
export async function scanChatFolder(root: string, maxEntries: number): Promise<ChatFolderScan> {
  let visited = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const files: string[] = [];
    const handle = await opendir(directory);
    for await (const child of handle) {
      // Leaving the loop closes the handle.
      if (visited >= maxEntries) break;
      visited += 1;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) pending.push(absolute);
      else {
        fileCount += 1;
        if (child.isFile()) files.push(absolute);
      }
    }
    for (let index = 0; index < files.length; index += SCAN_STAT_BATCH) {
      const sizes = await Promise.all(
        files.slice(index, index + SCAN_STAT_BATCH).map((file) =>
          lstat(file).then(
            (entry) => entry.size,
            () => 0,
          ),
        ),
      );
      for (const size of sizes) totalBytes += size;
    }
    if (visited >= maxEntries) return { fileCount, totalBytes, truncated: true };
  }
  return { fileCount, totalBytes, truncated: false };
}

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

const isDirectory = (target: string) =>
  stat(target).then(
    (entry) => entry.isDirectory(),
    () => false,
  );

/**
 * Where a promoted chat goes by default: the workspace access root under `--restrict-to-cwd`,
 * else the "Add project base directory" setting, else `~/Code` when it exists, else home.
 */
export const resolvePromotionParent = async (input: {
  readonly workspaceAccessRoot: string | undefined;
  readonly addProjectBaseDirectory: string;
  readonly homeDir: string;
}): Promise<string> => {
  if (input.workspaceAccessRoot !== undefined) return path.resolve(input.workspaceAccessRoot);
  const configured = input.addProjectBaseDirectory.trim();
  if (configured) {
    const expanded = expandHomePath(configured);
    if (path.isAbsolute(expanded)) return path.resolve(expanded);
  }
  const code = path.join(input.homeDir, "Code");
  return (await isDirectory(code)) ? code : input.homeDir;
};

/** `<parent>/<slug>`, or the first free `<slug>-2`, `<slug>-3`, … */
export const suggestPromotionDestination = async (parent: string, title: string) => {
  const slug = directorySlug(title, "project");
  const base = path.join(parent, slug);
  if (!(await exists(base).catch(() => true))) return base;
  for (let suffix = 2; suffix <= DEFAULT_DESTINATION_MAX_SUFFIX; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await exists(candidate).catch(() => true))) return candidate;
  }
  return base;
};

/** Every verdict but `available`: the destination cannot be promoted to. */
type RefusedDestinationStatus = Exclude<ProjectChatDestinationStatus, "available">;

export interface PromotionDestination {
  /** What was judged, for display: trimmed, with `~` expanded and the path normalized. */
  readonly destination: string;
  /** The folder a move creates: symlinks in the existing parent resolved. Set when available. */
  readonly canonical: string | null;
  readonly status: ProjectChatDestinationStatus;
}

/**
 * The verdict for a destination storage admission (`storage/lifecycle.ts`) refuses. That fence
 * refuses every turn, provider session and terminal at or below a checkout Ryco removed (forever),
 * at or below a completed checkout move's old path (forever), and while a checkout removal or move
 * is in progress, so a project moved there could not run. Another chat moving into it reads like
 * the destination lock: taken.
 */
export const fencedDestinationStatus = (
  blocker: StoragePathBlocker | null,
): RefusedDestinationStatus | null =>
  blocker === "checkout" ? "retired-checkout" : blocker === "project-relocation" ? "exists" : null;

/**
 * Judge a destination for a chat folder whose canonical path is `source`. Only `available` can be
 * promoted to: an absolute path that does not exist yet, whose parent is a writable folder, that
 * the workspace access policy and storage admission (`fenced`) allow, and that is neither inside
 * the chat's folder nor the chats root.
 */
export const judgePromotionDestination = Effect.fn("judgePromotionDestination")(function* (input: {
  readonly raw: string;
  readonly source: string;
  readonly chatsRoot: string | undefined;
  readonly policy: WorkspaceAccessPolicyShape;
  /** Storage admission's verdict for a canonical path, or null when it admits the path. */
  readonly fenced: (
    canonical: string,
  ) => Effect.Effect<RefusedDestinationStatus | null, ProjectChatError>;
}) {
  const trimmed = input.raw.trim();
  const expanded = expandHomePath(trimmed);
  const verdict = (
    destination: string,
    status: ProjectChatDestinationStatus,
    canonical: string | null = null,
  ): PromotionDestination => ({ destination, status, canonical });
  if (
    !trimmed ||
    // Filesystem input must not contain control characters.
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(trimmed) ||
    !path.isAbsolute(expanded) ||
    (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(expanded))
  ) {
    return verdict(trimmed, "invalid");
  }
  const destination = path.resolve(expanded);
  // A filesystem root has no parent to create it in.
  if (path.dirname(destination) === destination) return verdict(destination, "invalid");
  const allowed = (candidate: string) =>
    input.policy.assertPath({ path: candidate, operation: ACCESS_OPERATION }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  if (!(yield* allowed(destination))) return verdict(destination, "access-denied");
  const leafExists = yield* Effect.promise(() => exists(destination).catch(() => true));
  const canonical = yield* Effect.promise(() =>
    canonicalizeWorktreePath(destination).catch(() => null),
  );
  if (canonical === null) return verdict(destination, leafExists ? "exists" : "invalid");
  // A symlinked parent can lead out of the allowed root.
  if (!(yield* allowed(canonical))) return verdict(destination, "access-denied");
  if (containsPath(input.source, canonical)) return verdict(destination, "inside-source");
  if (input.chatsRoot !== undefined && containsPath(input.chatsRoot, canonical)) {
    return verdict(destination, "inside-chats");
  }
  // Before `exists`: another name in the same place would be refused just the same.
  const fenced = yield* input.fenced(canonical);
  if (fenced !== null) return verdict(destination, fenced);
  if (leafExists) return verdict(destination, "exists");
  const parentUsable = yield* Effect.promise(async () => {
    const parent = path.dirname(canonical);
    if (!(await isDirectory(parent))) return false;
    return access(parent, fsConstants.W_OK | fsConstants.X_OK).then(
      () => true,
      () => false,
    );
  });
  return parentUsable
    ? verdict(destination, "available", canonical)
    : verdict(destination, "invalid");
});

const destinationErrors: Record<
  RefusedDestinationStatus,
  { readonly reason: ProjectChatError["reason"]; readonly message: string }
> = {
  exists: {
    reason: "destination-exists",
    message: "Something already exists at that location. Choose a new folder name.",
  },
  invalid: {
    reason: "destination-invalid",
    message:
      "Choose an absolute location whose parent folder exists and is writable on this machine.",
  },
  "access-denied": {
    reason: "access-denied",
    message: "This server's workspace access policy does not allow that location.",
  },
  "inside-chats": {
    reason: "destination-inside-chats",
    message: "Choose a location outside the chats folder.",
  },
  "inside-source": {
    reason: "destination-inside-source",
    message: "The new location cannot be inside the chat's own folder.",
  },
  "retired-checkout": {
    reason: "destination-retired-checkout",
    message:
      "Ryco removed a workspace checkout at that location and keeps new work out of it. Choose another folder.",
  },
};

const refuseDestination = (status: RefusedDestinationStatus) =>
  new ProjectChatError(destinationErrors[status]);

// ---------------------------------------------------------------------------
// Busy threads
// ---------------------------------------------------------------------------

/**
 * Why a chat thread cannot move now, or null. The context-handoff send path's idle rules (no
 * running or starting turn, pending approval or question, queued turn start or active handoff),
 * plus background work and a pending checkpoint revert.
 */
export const chatThreadBusyReason = (input: {
  readonly shell: OrchestrationThreadShell;
  readonly thread: OrchestrationThread | null;
  readonly nowMs: number;
}): string | null => {
  switch (
    threadBusyReason(threadShellSettlementInput(input.shell, new Date(input.nowMs).toISOString()))
  ) {
    case "session-starting":
    case "session-running":
      return "a turn is running";
    case "pending-approval":
      return "an approval is waiting";
    case "pending-user-input":
      return "a question is waiting for an answer";
    case "queued-turn":
      return "a message is still starting";
    case null:
      break;
  }
  if (input.shell.backgroundLiveness) return "background work is still running";
  if (input.thread !== null) {
    if (hasActionableContextHandoff(input.thread)) return "it is switching models";
    if (isCheckpointRevertPending(input.thread.activities, input.nowMs)) {
      return "a revert is in progress";
    }
  }
  return null;
};

export interface ChatTerminalActivity {
  /** Terminals that keep the chat from moving, by the thread that opened them. */
  readonly busy: ReadonlyArray<{ readonly threadId: string; readonly reason: string }>;
  /** Chat threads whose idle shells a move closes; their history is kept. */
  readonly idleThreadIds: ReadonlySet<string>;
}

/**
 * The live terminals of a chat's threads, or in its folder, as worktree removal judges them: a
 * terminal running a command keeps the chat busy, and so does another conversation's terminal in
 * the folder; a chat thread's idle shell is closed.
 */
export const chatTerminalActivity = (input: {
  readonly terminals: ReadonlyArray<DiagnosticsTerminalProcess>;
  readonly threadIds: ReadonlySet<string>;
  readonly folder: string;
}): ChatTerminalActivity => {
  const busy: Array<{ readonly threadId: string; readonly reason: string }> = [];
  const idleThreadIds = new Set<string>();
  for (const terminal of input.terminals) {
    if (!isTerminalAlive(terminal)) continue;
    const owned = input.threadIds.has(terminal.threadId);
    const inFolder =
      containsPath(input.folder, terminal.cwd) ||
      (terminal.worktreePath !== null && containsPath(input.folder, terminal.worktreePath));
    if (!owned && !inFolder) continue;
    if (isTerminalWorking(terminal)) {
      busy.push({ threadId: terminal.threadId, reason: "a terminal is running a command" });
    } else if (!owned) {
      busy.push({
        threadId: terminal.threadId,
        reason: "another conversation has a terminal open in its folder",
      });
    } else {
      idleThreadIds.add(terminal.threadId);
    }
  }
  return { busy, idleThreadIds };
};

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

// Process-wide: the WS context is rebuilt per connection, but a folder moves only once, and
// startup recovery must never touch a move this process is still making.
const relocationLocks = new Set<string>();

const destinationLockKey = (canonical: string) =>
  `path:${process.platform === "darwin" || process.platform === "win32" ? canonical.toLowerCase() : canonical}`;

/** Run `effect` holding every key, or `whenHeld` at once when another holder has one of them. */
const withRelocationLocks = <A, E, R, B, E2, R2>(
  keys: ReadonlyArray<string>,
  whenHeld: Effect.Effect<B, E2, R2>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | B, E | E2, R | R2> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      if (keys.some((key) => relocationLocks.has(key))) return false;
      for (const key of keys) relocationLocks.add(key);
      return true;
    }),
    (acquired): Effect.Effect<A | B, E | E2, R | R2> => (acquired ? effect : whenHeld),
    (acquired) =>
      acquired
        ? Effect.sync(() => {
            for (const key of keys) relocationLocks.delete(key);
          })
        : Effect.void,
  );

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

const promotionError = (reason: ProjectChatError["reason"], message: string) =>
  new ProjectChatError({ reason, message });

/** Tells the user about a copy Ryco made but could not remove; nothing refers to it. */
const leftoverCopyMessage = (destination: string) =>
  `An incomplete copy remains at ${destination}. You can delete it.`;

/** Failures of collaborating services; promotion only reports their message. */
export interface ChatPromotionDependencyError {
  readonly message: string;
}

export interface InitializePromotedGitResult {
  /** Absent when no first commit was requested. */
  readonly initialCommitCreated?: boolean;
  readonly commitError?: string;
}

export interface ChatPromotionDependencies {
  /** Deleted rows still resolve, so a vanished chat reads as "not found", not as a failure. */
  readonly projects: Pick<ProjectionProjectRepositoryShape, "getById">;
  readonly threads: Pick<ProjectionThreadRepositoryShape, "listByProjectId">;
  readonly snapshots: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getThreadDetailById"
  >;
  readonly relocations: ProjectRelocationRepositoryShape;
  readonly chatFolders: Pick<ChatFoldersShape, "capability">;
  readonly policy: WorkspaceAccessPolicyShape;
  readonly config: Pick<ServerConfigShape, "workspaceAccessRoot">;
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
  readonly providers: {
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<Pick<ProviderSession, "threadId" | "status" | "cwd">>
    >;
    readonly stopSession: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, ChatPromotionDependencyError>;
  };
  /** A move closes the chat threads' idle terminals (history kept) and waits for busy ones. */
  readonly terminals: Pick<TerminalManagerShape, "listDiagnostics" | "close">;
  /**
   * Server-internal dispatch. The client normalizer refuses kind changes and a chat's new root,
   * because only this flow may make them.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, ChatPromotionDependencyError>;
  /** `git init`, the main workspace, `.gitignore` and the first commit, on the promoted project. */
  readonly initializeGit: (
    projectId: ProjectId,
    options: { readonly writeGitignore: boolean; readonly initialCommit: boolean },
  ) => Effect.Effect<InitializePromotedGitResult, ChatPromotionDependencyError>;
  /**
   * Storage admission for a canonical path (`storagePathBlocker` in `storage/lifecycle.ts`), the
   * fence turn, session and terminal starts pass. A destination it refuses is never promoted to.
   */
  readonly storageAdmission: (
    canonicalPath: string,
  ) => Effect.Effect<StoragePathBlocker | null, ChatPromotionDependencyError>;
  /** Probes Git for the preview; absent means Git is reported unavailable. */
  readonly git?: Pick<GitVcsDriverShape, "execute"> | undefined;
  readonly fs?: ChatPromotionFileSystem;
  readonly homeDir?: () => string;
  readonly now?: () => Date;
}

export interface ChatPromotionShape {
  /** Read-only: never creates, moves or locks anything. */
  readonly preview: (
    input: ProjectsPromoteChatPreviewInput,
  ) => Effect.Effect<ProjectsPromoteChatPreviewResult, ProjectChatError>;
  readonly promote: (
    input: ProjectsPromoteChatInput,
  ) => Effect.Effect<ProjectsPromoteChatResult, ProjectChatError>;
}

const isLiveThread = (thread: ProjectionThread) => thread.deletedAt === null;

export const makeChatPromotion = (deps: ChatPromotionDependencies): ChatPromotionShape => {
  const fs = deps.fs ?? nodeChatPromotionFileSystem;
  const now = deps.now ?? (() => new Date());
  const homeDir = deps.homeDir ?? homedir;
  const unreadable = () => promotionError("not-found", "This chat could not be read.");

  const loadChat = Effect.fn("ChatPromotion.loadChat")(function* (projectId: ProjectId) {
    const project = yield* deps.projects.getById({ projectId }).pipe(Effect.mapError(unreadable));
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* promotionError("not-found", "This chat no longer exists.");
    }
    if (!isChatProject(project.value)) {
      return yield* promotionError(
        "not-chat",
        "Only a chat without a project can be turned into one.",
      );
    }
    return project.value;
  });

  /** The chat's folder by realpath; the move and every containment check use this path. */
  const canonicalSource = (project: ProjectionProject) =>
    Effect.tryPromise(async () => {
      const source = await realpath(project.workspaceRoot);
      if (!(await isDirectory(source))) throw new Error("not a directory");
      return source;
    }).pipe(
      Effect.mapError(() =>
        promotionError(
          "not-found",
          `This chat's folder is missing. It was at ${project.workspaceRoot}.`,
        ),
      ),
    );

  const chatsRoot = deps.chatFolders.capability.pipe(
    Effect.flatMap((capability) =>
      capability.root === undefined
        ? Effect.succeed(undefined)
        : Effect.promise(() =>
            canonicalizeWorktreePath(capability.root!).catch(() => capability.root),
          ),
    ),
  );

  /** Storage admission's verdict for a destination; see {@link fencedDestinationStatus}. */
  const fencedDestination = (canonical: string) =>
    deps.storageAdmission(canonical).pipe(
      Effect.map(fencedDestinationStatus),
      Effect.mapError(() =>
        promotionError("move-failed", "Ryco could not check that location. Nothing was changed."),
      ),
    );

  const busyThreads = Effect.fn("ChatPromotion.busyThreads")(function* (
    threads: ReadonlyArray<ProjectionThread>,
    source: string,
  ) {
    const nowMs = now().getTime();
    const busy: Array<{ readonly threadId: ThreadId; readonly reason: string }> = [];
    const terminals = chatTerminalActivity({
      terminals: yield* deps.terminals.listDiagnostics,
      threadIds: new Set<string>(threads.map((thread) => thread.threadId)),
      folder: source,
    });
    for (const { threadId } of threads) {
      const shell = yield* deps.snapshots
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(unreadable));
      if (Option.isNone(shell)) continue;
      const quickReason = chatThreadBusyReason({ shell: shell.value, thread: null, nowMs });
      const reason =
        quickReason ??
        chatThreadBusyReason({
          shell: shell.value,
          thread: Option.getOrNull(
            yield* deps.snapshots.getThreadDetailById(threadId).pipe(Effect.mapError(unreadable)),
          ),
          nowMs,
        }) ??
        terminals.busy.find((terminal) => terminal.threadId === threadId)?.reason ??
        null;
      if (reason !== null) busy.push({ threadId, reason });
    }
    return busy;
  });

  const liveThreads = (projectId: ProjectId) =>
    deps.threads.listByProjectId({ projectId }).pipe(
      Effect.map((threads) => threads.filter(isLiveThread)),
      Effect.mapError(unreadable),
    );

  /** Whether Git runs, and whether a commit made at `cwd` would have an author. */
  const probeGit = (cwd: string) =>
    Effect.gen(function* () {
      const git = deps.git;
      if (git === undefined) return { gitAvailable: false, gitIdentityConfigured: false };
      const read = (key: string) =>
        git
          .execute({
            operation: "projects.promoteChatPreview.gitConfig",
            cwd,
            args: ["config", "--get", key],
            allowNonZeroExit: true,
            timeoutMs: GIT_PROBE_TIMEOUT_MS,
            maxOutputBytes: 4_096,
          })
          .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));
      const identity = yield* Effect.all([read("user.name"), read("user.email")], {
        concurrency: 2,
      }).pipe(Effect.result);
      if (Result.isFailure(identity)) return { gitAvailable: false, gitIdentityConfigured: false };
      const [name, email] = identity.success;
      return {
        gitAvailable: true,
        gitIdentityConfigured:
          (name || process.env.GIT_AUTHOR_NAME?.trim() || "").length > 0 &&
          (email || process.env.GIT_AUTHOR_EMAIL?.trim() || process.env.EMAIL?.trim() || "")
            .length > 0,
      };
    });

  const preview: ChatPromotionShape["preview"] = Effect.fn("ChatPromotion.preview")(
    function* (input) {
      const project = yield* loadChat(input.projectId);
      const source = yield* canonicalSource(project);
      const settings = yield* deps.settings.getSettings.pipe(
        Effect.mapError(() => promotionError("not-found", "Server settings could not be read.")),
      );
      const parent = yield* Effect.promise(() =>
        resolvePromotionParent({
          workspaceAccessRoot: deps.config.workspaceAccessRoot,
          addProjectBaseDirectory: settings.addProjectBaseDirectory,
          homeDir: homeDir(),
        }),
      );
      const defaultDestination = yield* Effect.promise(() =>
        suggestPromotionDestination(parent, project.title),
      );
      const judged = yield* judgePromotionDestination({
        raw: input.destination ?? defaultDestination,
        source,
        chatsRoot: yield* chatsRoot,
        policy: deps.policy,
        fenced: fencedDestination,
      });
      // Probes run where the destination will be, so its Git config and device apply.
      const probeCwd = yield* Effect.promise(() =>
        judged.status === "invalid" || judged.status === "access-denied"
          ? Promise.resolve(source)
          : resolveExistingAncestor(judged.destination).catch(() => source),
      );
      const [scan, busy, git, crossDevice] = yield* Effect.all(
        [
          Effect.promise(() =>
            scanChatFolder(source, PROMOTION_SCAN_MAX_ENTRIES).catch((): ChatFolderScan => ({
              fileCount: 0,
              totalBytes: 0,
              truncated: true,
            })),
          ),
          liveThreads(input.projectId).pipe(
            Effect.flatMap((threads) => busyThreads(threads, source)),
          ),
          probeGit(probeCwd),
          Effect.promise(() =>
            Promise.all([stat(source), stat(probeCwd)]).then(
              ([from, to]) => from.dev !== to.dev,
              () => false,
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return {
        projectId: input.projectId,
        source,
        defaultDestination,
        destination: judged.destination,
        destinationStatus: judged.status,
        fileCount: scan.fileCount,
        totalBytes: scan.totalBytes,
        countTruncated: scan.truncated,
        busyThreadIds: busy.map((thread) => thread.threadId),
        gitAvailable: git.gitAvailable,
        gitIdentityConfigured: git.gitIdentityConfigured,
        crossDevice,
      } satisfies ProjectsPromoteChatPreviewResult;
    },
  );

  /** Stop every provider session that runs in the chat or for its threads, and confirm it. */
  const stopChatSessions = Effect.fn("ChatPromotion.stopChatSessions")(function* (
    threadIds: ReadonlySet<string>,
    source: string,
  ) {
    const open = (sessions: ReadonlyArray<Pick<ProviderSession, "threadId" | "status" | "cwd">>) =>
      sessions.filter(
        (session) =>
          session.status !== "closed" &&
          (threadIds.has(session.threadId) ||
            (session.cwd !== undefined && containsPath(source, session.cwd))),
      );
    for (const session of open(yield* deps.providers.listSessions())) {
      yield* deps.providers.stopSession({ threadId: session.threadId }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("chat promotion could not stop a provider session", {
            threadId: session.threadId,
            cause: cause.message,
          }),
        ),
      );
      yield* deps
        .dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`server:chat-promotion-session-stop:${crypto.randomUUID()}`),
          threadId: session.threadId,
          createdAt: now().toISOString(),
        })
        .pipe(Effect.ignore({ log: true }));
    }
    if (open(yield* deps.providers.listSessions()).length > 0) {
      return yield* promotionError(
        "busy",
        "An agent session in this chat did not stop. Try again in a moment.",
      );
    }
  });

  const describeBusy = (busy: ReadonlyArray<{ readonly reason: string }>) =>
    `This chat is still working (${busy[0]!.reason}). Wait for it to finish, or stop it, then try again.`;

  /** Close the chat threads' idle terminals (history kept); one that does not close is busy. */
  const closeChatTerminals = Effect.fn("ChatPromotion.closeChatTerminals")(function* (
    threadIds: ReadonlySet<string>,
    source: string,
  ) {
    const activity = () =>
      deps.terminals.listDiagnostics.pipe(
        Effect.map((terminals) => chatTerminalActivity({ terminals, threadIds, folder: source })),
      );
    const before = yield* activity();
    if (before.busy.length > 0) return yield* promotionError("busy", describeBusy(before.busy));
    const notClosed = () =>
      promotionError("busy", "A terminal in this chat did not close. Close it, then try again.");
    for (const threadId of before.idleThreadIds) {
      yield* deps.terminals.close({ threadId }).pipe(Effect.mapError(notClosed));
    }
    const after = yield* activity();
    if (after.busy.length > 0) return yield* promotionError("busy", describeBusy(after.busy));
    if (after.idleThreadIds.size > 0) return yield* notClosed();
  });

  /**
   * Empty the folder of everything that could write to it. Runs once the journal fences it, so
   * nothing new starts there, and re-checks the threads: a turn admitted just before the fence is
   * visible by then.
   */
  const vacateChatFolder = Effect.fn("ChatPromotion.vacateChatFolder")(function* (
    threads: ReadonlyArray<ProjectionThread>,
    source: string,
  ) {
    const busy = yield* busyThreads(threads, source);
    if (busy.length > 0) return yield* promotionError("busy", describeBusy(busy));
    const threadIds = new Set<string>(threads.map((thread) => thread.threadId));
    yield* stopChatSessions(threadIds, source);
    yield* closeChatTerminals(threadIds, source);
  });

  /**
   * Journal the move, vacate the folder, move it and commit the project record. Returns the new
   * root. The caller runs it uninterruptibly: a client that disconnects must not strand a half-made
   * move. Only vacating stays `cancellable`, and a cancelled one settles its journal.
   */
  const relocate = Effect.fn("ChatPromotion.relocate")(function* (input: {
    readonly project: ProjectionProject;
    readonly threads: ReadonlyArray<ProjectionThread>;
    readonly source: string;
    readonly destination: string;
    readonly title: string;
    readonly cancellable: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }) {
    const { project, source, destination } = input;
    const createdAt = now().toISOString();
    let journal: ProjectRelocation = {
      relocationId: `relocation-${crypto.randomUUID()}`,
      projectId: project.projectId,
      sourcePath: source,
      destinationPath: destination,
      strategy: "rename",
      state: "pending",
      destinationCreated: false,
      title: input.title,
      error: null,
      createdAt,
      updatedAt: createdAt,
    };
    const unchanged = "The chat was not changed.";
    const journalError = () =>
      promotionError("move-failed", `Ryco could not record the move. ${unchanged}`);
    // Under storage admission, like turn, session and terminal starts: from here on, nothing new
    // starts in either folder until the journal settles. The destination is admitted again in the
    // same step, so no fence can appear between the check and the journal.
    yield* storageLifecycleLock.withPermit(
      Effect.gen(function* () {
        const fenced = yield* fencedDestination(destination);
        if (fenced !== null) return yield* refuseDestination(fenced);
        yield* deps.relocations.create(journal).pipe(Effect.mapError(journalError));
      }),
    );
    const advance = (
      patch: Partial<
        Pick<ProjectRelocation, "state" | "strategy" | "destinationCreated" | "error">
      >,
    ) =>
      Effect.suspend(() => {
        const next = { ...journal, ...patch, updatedAt: now().toISOString() };
        return deps.relocations.update(next).pipe(
          // An unsettled row keeps the folders fenced until the next start: retry a hiccup.
          Effect.retry({ times: 2 }),
          Effect.tap(() =>
            Effect.sync(() => {
              journal = next;
            }),
          ),
        );
      });
    /** Settle a move that did not happen. A journal write failure is only logged: recovery reads the disk. */
    const fail = (reason: ProjectChatError["reason"], message: string, detail = message) =>
      advance({ state: "failed", error: detail }).pipe(
        Effect.ignore({ log: true }),
        Effect.andThen(Effect.fail(promotionError(reason, message))),
      );

    // 1. Vacate: no session, busy thread or terminal may write while the files move.
    yield* input.cancellable(vacateChatFolder(input.threads, source)).pipe(
      Effect.catch((error) => fail(error.reason, error.message)),
      Effect.onInterrupt(() =>
        advance({ state: "failed", error: "cancelled before the move" }).pipe(
          Effect.ignore({ log: true }),
        ),
      ),
    );

    // 2. Move: rename in place, or copy across devices and verify the copy.
    const renamed = yield* Effect.tryPromise(() => fs.rename(source, destination)).pipe(
      Effect.result,
    );
    let sourceBeforeCopy: ReadonlyMap<string, TreeManifestEntry> | null = null;
    if (Result.isFailure(renamed)) {
      const code = errnoCode(renamed.failure);
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        return yield* fail("destination-exists", destinationErrors.exists.message);
      }
      if (code !== "EXDEV") {
        return yield* fail(
          "move-failed",
          `Ryco could not move the chat's folder. ${unchanged}`,
          `rename failed: ${describeCause(renamed.failure)}`,
        );
      }
      const journalFailure = (detail: string) =>
        fail("move-failed", `Ryco could not record the move. ${unchanged}`, detail);
      yield* advance({ strategy: "copy" }).pipe(
        Effect.catch(() => journalFailure("journal write failed before copying")),
      );
      const created = yield* Effect.tryPromise(async () =>
        fs.makeDirectory(destination, ((await lstat(source)).mode & 0o7777) | 0o700),
      ).pipe(Effect.result);
      if (Result.isFailure(created)) {
        return yield* errnoCode(created.failure) === "EEXIST"
          ? fail("destination-exists", destinationErrors.exists.message)
          : fail(
              "move-failed",
              `Ryco could not create the new folder. ${unchanged}`,
              `mkdir failed: ${describeCause(created.failure)}`,
            );
      }
      yield* advance({ destinationCreated: true }).pipe(
        Effect.catch(() =>
          // Nothing is in it yet, and the journal cannot vouch for it: remove it right away.
          Effect.tryPromise(() => rmdir(destination)).pipe(
            Effect.ignore({ log: true }),
            Effect.andThen(journalFailure("journal write failed after creating the folder")),
          ),
        ),
      );
      /**
       * Remove the partial copy and settle the journal. The record still points at the chat's
       * folder, so nothing depends on the copy: one that cannot be removed is named and left,
       * and never keeps the chat fenced.
       */
      const abandonCopy = (reason: ProjectChatError["reason"], message: string, detail: string) =>
        Effect.tryPromise(() => fs.removeTree(destination)).pipe(
          Effect.matchEffect({
            onSuccess: () => fail(reason, message, detail),
            onFailure: (cause) =>
              Effect.logWarning("chat promotion could not remove a partial copy", {
                destination,
                cause: describeCause(cause),
              }).pipe(
                Effect.andThen(
                  fail(
                    reason,
                    `${message} ${leftoverCopyMessage(destination)}`,
                    `${detail}; the partial copy could not be removed: ${describeCause(cause)}`,
                  ),
                ),
              ),
          }),
        );
      const copied = yield* Effect.tryPromise(async () => {
        const before = await readTreeManifest(source);
        await fs.copyContents(source, destination);
        const [after, copy] = await Promise.all([
          readTreeManifest(source),
          readTreeManifest(destination),
        ]);
        return {
          before,
          verified: sameManifest(after, copy, { compareModifiedTimes: false }),
          sourceUnchanged: sameManifest(before, after, { compareModifiedTimes: true }),
        };
      }).pipe(Effect.result);
      if (Result.isFailure(copied)) {
        return yield* abandonCopy(
          "move-failed",
          `Ryco could not copy the chat's folder to the new location. ${unchanged}`,
          `copy failed: ${describeCause(copied.failure)}`,
        );
      }
      // A source that changed mid-copy also fails verification; say why.
      if (!copied.success.sourceUnchanged) {
        return yield* abandonCopy(
          "busy",
          `Files in this chat changed while they were being copied. ${unchanged} Try again.`,
          "source changed during copy",
        );
      }
      if (!copied.success.verified) {
        return yield* abandonCopy(
          "move-failed",
          `The copied folder did not match the chat's folder. ${unchanged}`,
          "copy verification failed",
        );
      }
      sourceBeforeCopy = copied.success.before;
    }

    // 3. Commit the record: the same project, now a regular project at its new root. The journal
    //    says `moved` first, so from here recovery finishes the promotion instead of undoing it.
    const committed = yield* advance({ state: "moved" }).pipe(
      Effect.andThen(
        deps.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(`server:chat-promotion:${journal.relocationId}`),
          projectId: project.projectId,
          expectedUpdatedAt: project.updatedAt,
          kind: "project",
          title: input.title,
          workspaceRoot: destination,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(committed)) {
      const latest = yield* deps.projects.getById({ projectId: project.projectId }).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      const [reason, message]: readonly [ProjectChatError["reason"], string] =
        latest === null || latest.deletedAt !== null
          ? ["not-found", "This chat was deleted while it was being moved."]
          : latest.updatedAt !== project.updatedAt
            ? ["stale", `This chat changed while it was being moved. ${unchanged} Try again.`]
            : [
                "move-failed",
                `Ryco could not update the chat after moving its folder. ${unchanged}`,
              ];
      // Undo. A copy is no longer vouched for once its removal starts, so the journal goes back
      // to `pending` first: recovery must never commit a half-removed copy.
      const undone = yield* (
        journal.strategy === "copy"
          ? advance({ state: "pending" }).pipe(
              Effect.andThen(Effect.tryPromise(() => fs.removeTree(destination))),
            )
          : Effect.tryPromise(() => fs.rename(destination, source))
      ).pipe(Effect.result);
      if (Result.isSuccess(undone)) {
        return yield* fail(
          reason,
          message,
          `record update failed: ${describeCause(committed.failure)}`,
        );
      }
      if (journal.strategy === "copy" && journal.state === "pending") {
        // The record never pointed at the copy and the journal no longer vouches for it: settle,
        // naming what is left, so a copy that cannot be removed never keeps the chat fenced.
        yield* Effect.logWarning("chat promotion could not remove a copy it abandoned", {
          projectId: project.projectId,
          destination,
          cause: describeCause(undone.failure),
        });
        return yield* fail(
          reason,
          `${message} ${leftoverCopyMessage(destination)}`,
          `record update failed: ${describeCause(committed.failure)}; the copy could not be removed: ${describeCause(undone.failure)}`,
        );
      }
      // The journal still says where the files are; startup recovery settles it from the disk:
      // a renamed folder or a `moved` copy finishes the promotion, a `pending` copy is removed.
      yield* Effect.logError(
        "chat promotion could not undo a move after the record update failed",
        {
          projectId: project.projectId,
          source,
          destination,
          cause: describeCause(undone.failure),
        },
      );
      return yield* promotionError(
        "move-failed",
        journal.strategy === "rename" || journal.state === "moved"
          ? `The chat's files are at ${destination}, but the chat could not be updated. Restart Ryco to finish.`
          : `Ryco could not update the chat or remove the copy at ${destination}. Restart Ryco to clean it up. ${unchanged}`,
      );
    }

    // 4. Remove the copied source, unless something changed it after the copy was verified.
    if (sourceBeforeCopy !== null) {
      const before = sourceBeforeCopy;
      yield* Effect.tryPromise(async () => {
        const current = await readTreeManifest(source);
        if (!sameManifest(before, current, { compareModifiedTimes: true })) {
          throw new Error("the chat folder changed after it was copied");
        }
        await fs.removeTree(source);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("chat promotion kept the original folder after copying it", {
            projectId: project.projectId,
            source,
            cause: describeCause(cause),
          }),
        ),
      );
    }
    yield* advance({ state: "done" }).pipe(Effect.ignore({ log: true }));
    return destination;
  });

  /** The project exists at its new root: Git problems are reported and never undo the promotion. */
  const finishWithGit = (input: ProjectsPromoteChatInput, workspaceRoot: string) =>
    Effect.gen(function* () {
      const promoted = {
        projectId: input.projectId,
        workspaceRoot,
        gitInitialized: false,
        initialCommitCreated: false,
      } satisfies ProjectsPromoteChatResult;
      if (!input.initializeGit) return promoted;
      const initialized = yield* deps
        .initializeGit(input.projectId, {
          writeGitignore: input.writeGitignore,
          initialCommit: input.initialCommit,
        })
        .pipe(Effect.result);
      if (Result.isFailure(initialized)) {
        yield* Effect.logWarning("promoted chat could not initialize git", {
          projectId: input.projectId,
          cause: initialized.failure.message,
        });
        return {
          ...promoted,
          commitError:
            "The project was created, but Git could not be initialized. Use Initialize Git in the project to try again.",
        } satisfies ProjectsPromoteChatResult;
      }
      const { initialCommitCreated = false, commitError } = initialized.success;
      return {
        ...promoted,
        gitInitialized: true,
        initialCommitCreated,
        ...(commitError !== undefined ? { commitError } : {}),
      } satisfies ProjectsPromoteChatResult;
    });

  const promote: ChatPromotionShape["promote"] = Effect.fn("ChatPromotion.promote")(
    function* (input) {
      const workspaceRoot = yield* withRelocationLocks(
        [`project:${input.projectId}`],
        Effect.fail(promotionError("busy", "This chat is already being turned into a project.")),
        Effect.gen(function* () {
          const project = yield* loadChat(input.projectId);
          if (
            input.expectedUpdatedAt !== undefined &&
            input.expectedUpdatedAt !== project.updatedAt
          ) {
            return yield* promotionError(
              "stale",
              "This chat changed since the dialog opened. Review it and try again.",
            );
          }
          const unresolved = yield* deps.relocations
            .listUnresolvedByProjectId({ projectId: input.projectId })
            .pipe(Effect.mapError(unreadable));
          if (unresolved.length > 0) {
            return yield* promotionError(
              "busy",
              "An earlier move of this chat did not finish. Restart Ryco to recover it, then try again.",
            );
          }
          const threads = yield* liveThreads(input.projectId);
          if (threads.length === 0) {
            return yield* promotionError(
              "not-found",
              "This chat has no conversations left to turn into a project.",
            );
          }
          const source = yield* canonicalSource(project);
          // Refused early, before anything is journaled; re-checked once the folder is fenced.
          const busy = yield* busyThreads(threads, source);
          if (busy.length > 0) return yield* promotionError("busy", describeBusy(busy));
          const root = yield* chatsRoot;
          if (root !== undefined && containsPath(source, root)) {
            return yield* promotionError(
              "move-failed",
              "This chat's folder contains the chats folder, so Ryco will not move it.",
            );
          }
          const judged = yield* judgePromotionDestination({
            raw: input.destination,
            source,
            chatsRoot: root,
            policy: deps.policy,
            fenced: fencedDestination,
          });
          if (judged.status !== "available" || judged.canonical === null) {
            return yield* refuseDestination(
              judged.status === "available" ? "invalid" : judged.status,
            );
          }
          const destination = judged.canonical;
          return yield* withRelocationLocks(
            [destinationLockKey(destination)],
            Effect.fail(promotionError("destination-exists", destinationErrors.exists.message)),
            Effect.uninterruptibleMask((restore) =>
              relocate({
                project,
                threads,
                source,
                destination,
                title: input.title,
                cancellable: restore,
              }),
            ),
          );
        }),
      );
      return yield* finishWithGit(input, workspaceRoot);
    },
  );

  return { preview, promote };
};

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

export interface ProjectRelocationRecoveryDependencies {
  readonly relocations: ProjectRelocationRepositoryShape;
  readonly projects: Pick<ProjectionProjectRepositoryShape, "getById">;
  /** Server-internal dispatch, as for promotion. */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, ChatPromotionDependencyError>;
  readonly fs?: ChatPromotionFileSystem;
  readonly now?: () => Date;
}

export type ProjectRelocationRecoveryOutcome = "done" | "failed" | "skipped";

/**
 * Settle one journaled move an earlier process left unresolved.
 *
 * - `moved` (the destination was complete): make sure the project points at it, remove a copied
 *   source that is still there and still matches the copy, and mark it done.
 * - `pending` rename, only the destination exists: the rename happened; finish the record.
 * - `pending` copy, only the destination exists: the copy was never verified, and its source may
 *   only be unreachable (an unmounted volume). Never commit or remove it; mark it failed.
 * - `pending`, only the source exists: nothing moved; mark it failed.
 * - `pending`, both exist: an interrupted copy. Keep the source, remove the destination only when
 *   the journal shows Ryco created it, and mark it failed, even when that removal fails: the
 *   record still points at the source, so a leftover copy must not keep the chat fenced.
 */
export const recoverProjectRelocation = Effect.fn("recoverProjectRelocation")(function* (
  deps: ProjectRelocationRecoveryDependencies,
  row: ProjectRelocation,
) {
  const fs = deps.fs ?? nodeChatPromotionFileSystem;
  const now = deps.now ?? (() => new Date());
  const settle = (state: "done" | "failed", error: string | null) =>
    deps.relocations
      .update({ ...row, state, error, updatedAt: now().toISOString() })
      .pipe(Effect.as<ProjectRelocationRecoveryOutcome>(state));
  const [sourceExists, destinationExists] = yield* Effect.tryPromise(() =>
    Promise.all([exists(row.sourcePath), exists(row.destinationPath)]),
  );
  const project = Option.getOrNull(yield* deps.projects.getById({ projectId: row.projectId }));
  const live = project !== null && project.deletedAt === null ? project : null;
  const committed = live !== null && samePath(live.workspaceRoot, row.destinationPath);

  /** Point the chat at its moved folder; false (with the journal failed) when it cannot. */
  const commitRecord = Effect.gen(function* () {
    if (committed) return true;
    if (live === null) {
      yield* settle("failed", `The chat was deleted. Its files remain at ${row.destinationPath}.`);
      return false;
    }
    if (!isChatProject(live) || !samePath(live.workspaceRoot, row.sourcePath)) {
      yield* settle(
        "failed",
        `The project changed before its move finished. Its files remain at ${row.destinationPath}.`,
      );
      return false;
    }
    // The title the user asked for; a journal without one keeps the chat's title.
    yield* deps.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(
        `server:chat-promotion-recovery:${row.relocationId}:${crypto.randomUUID()}`,
      ),
      projectId: row.projectId,
      expectedUpdatedAt: live.updatedAt,
      kind: "project",
      ...(row.title !== null ? { title: row.title } : {}),
      workspaceRoot: row.destinationPath,
    });
    return true;
  });

  if (row.state === "moved" || committed) {
    if (!destinationExists) {
      return yield* settle("failed", `The moved folder is missing from ${row.destinationPath}.`);
    }
    if (!(yield* commitRecord)) return "failed";
    if (row.strategy === "copy" && sourceExists) {
      // Verified before the journal said `moved`, so what remains is a duplicate, unless something
      // outside Ryco wrote to it since (an editor, Finder): then it is kept, as the move keeps it.
      yield* Effect.tryPromise(async () => {
        const [original, copy] = await Promise.all([
          readTreeManifest(row.sourcePath),
          readTreeManifest(row.destinationPath),
        ]);
        if (!sameManifest(original, copy, { compareModifiedTimes: false })) {
          throw new Error("the chat folder changed after it was copied");
        }
        await fs.removeTree(row.sourcePath);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("chat promotion recovery kept a copied source folder", {
            source: row.sourcePath,
            cause: describeCause(cause),
          }),
        ),
      );
    }
    return yield* settle("done", null);
  }
  if (destinationExists && !sourceExists) {
    if (row.strategy === "rename") {
      // A rename is atomic: the folder moved; finish the record.
      if (!(yield* commitRecord)) return "failed";
      return yield* settle("done", null);
    }
    yield* Effect.logWarning("chat promotion recovery kept an unverified copy", {
      source: row.sourcePath,
      destination: row.destinationPath,
    });
    return yield* settle(
      "failed",
      `The move was interrupted while copying, and ${row.sourcePath} could not be found. The chat still points at it. The incomplete copy at ${row.destinationPath} was kept.`,
    );
  }
  if (sourceExists && !destinationExists) {
    return yield* settle(
      "failed",
      "The move was interrupted before it started. The chat was not changed.",
    );
  }
  if (sourceExists && destinationExists) {
    if (row.strategy === "copy" && row.destinationCreated) {
      const removed = yield* Effect.tryPromise(() => fs.removeTree(row.destinationPath)).pipe(
        Effect.result,
      );
      if (Result.isFailure(removed)) {
        yield* Effect.logWarning("chat promotion recovery could not remove an interrupted copy", {
          destination: row.destinationPath,
          cause: describeCause(removed.failure),
        });
        return yield* settle(
          "failed",
          `The move was interrupted. The chat was not changed. ${leftoverCopyMessage(row.destinationPath)}`,
        );
      }
      return yield* settle("failed", "An interrupted copy was removed. The chat was not changed.");
    }
    return yield* settle(
      "failed",
      `The move was interrupted. Both ${row.sourcePath} and ${row.destinationPath} were kept.`,
    );
  }
  return yield* settle(
    "failed",
    `Neither ${row.sourcePath} nor ${row.destinationPath} exists. Recover the chat's files manually.`,
  );
});

/**
 * Settle every unresolved move at startup. Never fails: a row that cannot be settled is logged
 * and retried on the next start. Moves this process is still making are skipped.
 */
export const recoverProjectRelocations = (deps: ProjectRelocationRecoveryDependencies) =>
  Effect.gen(function* () {
    const rows = yield* deps.relocations.listUnresolved();
    for (const row of rows) {
      const outcome = yield* withRelocationLocks(
        [`project:${row.projectId}`],
        Effect.succeed<ProjectRelocationRecoveryOutcome>("skipped"),
        Effect.gen(function* () {
          // Re-read under the lock: a promotion that just finished may have settled it.
          const fresh = yield* deps.relocations.getById({ relocationId: row.relocationId });
          if (
            Option.isNone(fresh) ||
            (fresh.value.state !== "pending" && fresh.value.state !== "moved")
          ) {
            return "skipped" as const;
          }
          return yield* recoverProjectRelocation(deps, fresh.value);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("chat promotion recovery failed; it is retried on the next start", {
                relocationId: row.relocationId,
                projectId: row.projectId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as<ProjectRelocationRecoveryOutcome>("skipped")),
        ),
      );
      if (outcome !== "skipped") {
        yield* Effect.logInfo("chat promotion recovery settled an interrupted move", {
          relocationId: row.relocationId,
          projectId: row.projectId,
          outcome,
        });
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("chat promotion recovery could not run", {
            cause: Cause.pretty(cause),
          }),
    ),
  );
