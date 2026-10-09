/**
 * ChatFolders - the plain directories behind "No project" chats.
 *
 * Every chat is a `kind: "chat"` project whose workspace root is one folder under the chats root:
 * the `chatsRoot` setting, else the Ryco-managed default. Chats are offered only while that root
 * is usable and outside every Git working tree; inside one, each chat would show the parent
 * repository's branch and diff.
 *
 * @module ChatFolders
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  CHAT_PROJECT_TITLE_MAX_CHARS,
  type OrchestrationShellSnapshot,
  ProjectChatError,
  type ProjectId,
  type ProjectsDeleteChatFolderResult,
  type ProviderSession,
  type ServerChatsCapability,
  type ServerChatsUnavailableReason,
  type VcsError,
} from "@ryco/contracts";
import { directorySlug } from "@ryco/shared/directorySlug";
import { isChatProject } from "@ryco/shared/projectKind";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import { resolveManagedChatsRoot, ServerConfig, type ServerConfigShape } from "../config.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";
import type { ProjectionThreadRepositoryShape } from "../persistence/Services/ProjectionThreads.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { containsPath, samePath } from "../workspace/checkoutInspection.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  canonicalizeWorktreePath,
  resolveExistingAncestor,
  validateWorktreeRoot,
} from "./worktreeRoot.ts";

/** A probe that could not finish (timeout, unreadable root) is retried after this delay. */
const FAILED_PROBE_RETRY_MS = 30_000;
const GIT_PROBE_TIMEOUT = Duration.seconds(10);
/**
 * The whole probe's bound (validation and Git). A root on a mount that stopped answering never
 * does: its probe keeps running alone (a stuck filesystem call cannot be cancelled, so it is
 * joined, never stacked), chats read as unavailable meanwhile, and its late answer is published.
 */
const PROBE_TIMEOUT = Duration.seconds(15);
/** How long a config load waits for a first answer before it reports chats as unavailable. */
const CAPABILITY_WAIT = Duration.seconds(2);
/** Fresh suffixes tried after the stable one collides; a full run means something is wrong. */
const CHAT_FOLDER_ALLOCATION_ATTEMPTS = 8;

export class ChatFolderError extends Schema.TaggedError<ChatFolderError>()("ChatFolderError", {
  reason: Schema.Literals(["chats-unavailable", "allocation-failed", "folder-missing"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface AllocateChatFolderInput {
  /** The chat's creation time; its local calendar date prefixes the folder name. */
  readonly createdAt: string;
  /** Seeds the readable part of the name. The name never changes afterwards. */
  readonly titleSeed: string;
  /** Seeds the stable 8-hex suffix. */
  readonly projectId: ProjectId;
}

export interface ChatFoldersShape {
  /**
   * Whether this node offers chats, for `ServerConfig.chats`. Cached until the chats-root setting
   * changes. Never fails, and never waits long: without an answer for the current setting it
   * waits briefly for the probe, then reports chats as unavailable until `changes` says otherwise.
   */
  readonly capability: Effect.Effect<ServerChatsCapability>;
  /** The capability whenever it changes, starting with the current one. */
  readonly changes: Stream.Stream<ServerChatsCapability>;
  /**
   * Create a new, empty chat folder `<root>/<YYYY-MM-DD>-<slug>-<8hex>` and return its realpath.
   * Re-probes the root first, so a root that moved into a Git repository is never used.
   */
  readonly allocateChatFolder: (
    input: AllocateChatFolderInput,
  ) => Effect.Effect<string, ChatFolderError>;
  /**
   * Recreate a chat's own folder after a failed first send removed it. Only folders strictly
   * inside the chats root are recreated; `created` reports whether it was missing.
   */
  readonly ensureChatFolder: (
    folder: string,
  ) => Effect.Effect<{ readonly created: boolean }, ChatFolderError>;
  /** Remove a chat folder only when it is empty and strictly inside the chats root. Never fails. */
  readonly removeEmptyChatFolder: (folder: string) => Effect.Effect<boolean>;
  /** Strict containment on realpaths: true only below (never equal to) the chats root. */
  readonly isInsideChatsRoot: (candidate: string) => Effect.Effect<boolean>;
}

export class ChatFolders extends Context.Service<ChatFolders, ChatFoldersShape>()(
  "ryco/project/ChatFolders",
) {}

/** User-facing explanation for a chats capability that is off. */
export const describeChatsUnavailable = (
  reason: ServerChatsUnavailableReason | undefined,
): string => {
  switch (reason) {
    case "inside-git-repository":
      return "Chats without a project are off because the chats folder is inside a Git repository. Choose another Chats folder in Settings.";
    case "restricted":
      return "Chats without a project are off because this server's workspace access policy does not allow the chats folder.";
    default:
      return "Chats without a project are unavailable because the chats folder cannot be used. Check the Chats folder in Settings.";
  }
};

export const sameChatsCapability = (
  left: ServerChatsCapability | undefined,
  right: ServerChatsCapability | undefined,
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.available === right.available &&
    left.root === right.root &&
    left.unavailableReason === right.unavailableReason);

/** A chat project's title: the seed on one line, bounded like every other chat title. */
export const chatProjectTitle = (titleSeed: string): string => {
  // Filesystem-adjacent text must not carry control characters; titles are single-line.
  // eslint-disable-next-line no-control-regex
  const singleLine = titleSeed.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
  let title = singleLine.slice(0, CHAT_PROJECT_TITLE_MAX_CHARS);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
  return title.trimEnd() || "Chat";
};

const pad2 = (value: number) => String(value).padStart(2, "0");

/** The node-local calendar date: folders are browsed on this machine. */
export const chatFolderDate = (createdAt: string): string => {
  const parsed = new Date(createdAt);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

/** Stable for a project on the first attempt; a collision retry derives a fresh one. */
export const chatFolderSuffix = (projectId: string, attempt: number): string =>
  createHash("sha256")
    .update(attempt === 0 ? projectId : `${projectId}\0${attempt}`)
    .digest("hex")
    .slice(0, 8);

/** One path segment: the slug never contains separators or `..`, the rest is digits and hex. */
export const chatFolderName = (input: AllocateChatFolderInput, attempt = 0): string =>
  `${chatFolderDate(input.createdAt)}-${directorySlug(input.titleSeed, "chat")}-${chatFolderSuffix(input.projectId, attempt)}`;

/** Whether a folder's name is one {@link createChatFolder} could have given this chat. */
export const isChatFolderNameOf = (folder: string, projectId: string): boolean => {
  const name = path.basename(folder);
  for (let attempt = 0; attempt < CHAT_FOLDER_ALLOCATION_ATTEMPTS; attempt += 1) {
    if (name.endsWith(`-${chatFolderSuffix(projectId, attempt)}`)) return true;
  }
  return false;
};

/**
 * Create the root on demand, then the leaf without `recursive` so an existing folder fails
 * loudly instead of being shared. Returns the leaf's realpath.
 */
export async function createChatFolder(
  root: string,
  input: AllocateChatFolderInput,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  for (let attempt = 0; attempt < CHAT_FOLDER_ALLOCATION_ATTEMPTS; attempt += 1) {
    const folder = path.join(realRoot, chatFolderName(input, attempt));
    try {
      await mkdir(folder);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw cause;
    }
    return realpath(folder);
  }
  throw new Error(`No free chat folder name after ${CHAT_FOLDER_ALLOCATION_ATTEMPTS} attempts.`);
}

const isStrictlyInside = async (root: string, candidate: string) => {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalizeWorktreePath(root),
    canonicalizeWorktreePath(candidate),
  ]);
  return (
    containsPath(canonicalRoot, canonicalCandidate) && !samePath(canonicalRoot, canonicalCandidate)
  );
};

interface RunningProbe {
  readonly setting: string;
  readonly generation: number;
  /** Completed once, when the probe answers; a stalled one never does. */
  readonly answer: Deferred.Deferred<ChatsRootProbe>;
}

interface ChatsRootProbe {
  /** The `chatsRoot` setting this probe answered. */
  readonly setting: string;
  /** Canonical chats root, which may not exist yet; null when it could not be resolved. */
  readonly root: string | null;
  readonly capability: ServerChatsCapability;
  /** Failed probes expire; definitive answers last until the setting changes. */
  readonly retryAt: number | null;
}

export interface ChatFoldersDependencies {
  readonly config: Pick<ServerConfigShape, "chatsDir" | "workspaceAccessRoot">;
  readonly settings: Pick<ServerSettingsShape, "getSettings" | "streamChanges">;
  readonly policy: WorkspaceAccessPolicyShape;
  /** `git rev-parse --is-inside-work-tree` semantics, run in an existing directory. */
  readonly isInsideGitWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
  readonly now?: () => number;
  /** Overrides the probe's bound and the config load's wait (tests). */
  readonly waits?: {
    readonly probe?: Duration.Input;
    readonly capability?: Duration.Input;
  };
}

/** A probe that did not answer in time; it is retried like any failed probe. */
const unansweredProbe = (setting: string, now: number): ChatsRootProbe => ({
  setting,
  root: null,
  retryAt: now + FAILED_PROBE_RETRY_MS,
  capability: { available: false, unavailableReason: "root-unavailable" },
});

export const makeChatFolders = Effect.fn("makeChatFolders")(function* (
  deps: ChatFoldersDependencies,
) {
  const now = deps.now ?? Date.now;
  const probeTimeout = deps.waits?.probe ?? PROBE_TIMEOUT;
  const capabilityWait = deps.waits?.capability ?? CAPABILITY_WAIT;
  const scope = yield* Effect.scope;
  const probeRef = yield* SubscriptionRef.make(Option.none<ChatsRootProbe>());
  /** Guards starting probes and publishing their answers. Never held while a probe runs. */
  const probeLock = yield* Semaphore.make(1);
  /** The probe running for a setting, if any; a newer generation's answer always wins. */
  const running = yield* Ref.make(Option.none<RunningProbe>());
  const generation = yield* Ref.make(0);

  const probeChatsRoot = Effect.fn("ChatFolders.probe")(function* (setting: string) {
    const validated = yield* validateWorktreeRoot(
      setting || resolveManagedChatsRoot(deps.config),
      deps.policy,
      "Chats folder",
    ).pipe(Effect.result);
    if (Result.isFailure(validated)) {
      return {
        setting,
        root: null,
        retryAt: now() + FAILED_PROBE_RETRY_MS,
        capability: {
          available: false,
          unavailableReason:
            validated.failure.reason === "restricted" ? "restricted" : "root-unavailable",
        },
      } satisfies ChatsRootProbe;
    }
    const root = validated.success;
    // The root itself is created lazily, so ask Git from its nearest existing ancestor. Only the
    // Git process is cut short; a stalled filesystem call is bounded by the whole probe's wait.
    const insideRepository = yield* Effect.tryPromise(() => resolveExistingAncestor(root)).pipe(
      Effect.flatMap((cwd) =>
        deps.isInsideGitWorkTree(cwd).pipe(
          // Without a runnable git, no repository can surface in a chat either.
          Effect.catchTag("VcsProcessSpawnError", () => Effect.succeed(false)),
          Effect.timeout(GIT_PROBE_TIMEOUT),
        ),
      ),
      Effect.result,
    );
    if (Result.isFailure(insideRepository)) {
      yield* Effect.logWarning("chats root probe failed; chats stay hidden until it succeeds", {
        root,
        cause: String(insideRepository.failure),
      });
      return {
        setting,
        root,
        retryAt: now() + FAILED_PROBE_RETRY_MS,
        capability: { available: false, root, unavailableReason: "root-unavailable" },
      } satisfies ChatsRootProbe;
    }
    return {
      setting,
      root,
      retryAt: null,
      capability: insideRepository.success
        ? { available: false, root, unavailableReason: "inside-git-repository" }
        : { available: true, root },
    } satisfies ChatsRootProbe;
  });

  const isCurrent = (
    probe: Option.Option<ChatsRootProbe>,
    setting: string,
  ): probe is Option.Some<ChatsRootProbe> =>
    Option.isSome(probe) &&
    probe.value.setting === setting &&
    (probe.value.retryAt === null || now() < probe.value.retryAt);

  /** Publish an answer unless a newer probe started; `ifUnanswered` skips an answered probe. */
  const publish = (
    probe: RunningProbe,
    answer: ChatsRootProbe,
    options?: { readonly ifUnanswered?: boolean },
  ) =>
    probeLock.withPermits(1)(
      Effect.gen(function* () {
        if (options?.ifUnanswered && (yield* Deferred.isDone(probe.answer))) return;
        if ((yield* Ref.get(generation)) !== probe.generation) return;
        yield* SubscriptionRef.set(probeRef, Option.some(answer));
      }),
    );

  /**
   * The probe running for `setting`, or a new one. A probe is never interrupted: a stalled
   * filesystem call would keep running anyway, so retries join it instead of stacking new ones.
   */
  const startOrJoinProbe = (setting: string) =>
    probeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(running);
        if (Option.isSome(current) && current.value.setting === setting) return current.value;
        const probe: RunningProbe = {
          setting,
          generation: yield* Ref.updateAndGet(generation, (value) => value + 1),
          answer: yield* Deferred.make<ChatsRootProbe>(),
        };
        yield* Ref.set(running, Option.some(probe));
        yield* probeChatsRoot(setting).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("chats root probe failed", { cause: Cause.pretty(cause) }).pipe(
                  Effect.as(unansweredProbe(setting, now())),
                ),
          ),
          Effect.tap((answer) => publish(probe, answer)),
          Deferred.into(probe.answer),
          Effect.ensuring(
            Ref.update(running, (latest) =>
              Option.isSome(latest) && latest.value === probe ? Option.none() : latest,
            ),
          ),
          Effect.forkIn(scope),
        );
        // A probe that does not answer in time reads as unavailable until it does.
        yield* Deferred.await(probe.answer).pipe(
          Effect.timeoutOption(probeTimeout),
          Effect.flatMap((answered) =>
            Option.isSome(answered)
              ? Effect.void
              : Effect.logWarning("chats root probe did not answer; chats stay hidden meanwhile", {
                  setting,
                }).pipe(
                  Effect.andThen(
                    publish(probe, unansweredProbe(setting, now()), { ifUnanswered: true }),
                  ),
                ),
          ),
          Effect.forkIn(scope),
        );
        return probe;
      }),
    );

  /** The probe's answer, or an unanswered one after `wait`. */
  const awaitProbe = (probe: RunningProbe, wait: Duration.Input) =>
    Deferred.await(probe.answer).pipe(
      Effect.timeoutOption(wait),
      Effect.map(Option.getOrElse(() => unansweredProbe(probe.setting, now()))),
    );

  /** The current answer; `fresh` skips the cache for decisions that create files. */
  const resolve = (options?: { readonly fresh?: boolean }) =>
    Effect.gen(function* () {
      const setting = (yield* deps.settings.getSettings).chatsRoot;
      const cached = yield* SubscriptionRef.get(probeRef);
      if (!options?.fresh && isCurrent(cached, setting)) return cached.value;
      return yield* awaitProbe(yield* startOrJoinProbe(setting), probeTimeout);
    });

  const capability: ChatFoldersShape["capability"] = Effect.gen(function* () {
    const setting = (yield* deps.settings.getSettings).chatsRoot;
    const cached = yield* SubscriptionRef.get(probeRef);
    if (Option.isSome(cached) && cached.value.setting === setting) {
      // A failed answer due for its retry is still the best one now; its retry runs in the
      // background and publishes through `changes`.
      if (!isCurrent(cached, setting)) yield* Effect.forkIn(startOrJoinProbe(setting), scope);
      return cached.value.capability;
    }
    // No answer for this setting yet (startup, a new Chats folder): wait briefly, never long.
    return (yield* awaitProbe(yield* startOrJoinProbe(setting), capabilityWait)).capability;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("chats capability unavailable", { cause: Cause.pretty(cause) }).pipe(
            Effect.as<ServerChatsCapability>({
              available: false,
              unavailableReason: "root-unavailable",
            }),
          ),
    ),
  );

  const changes: ChatFoldersShape["changes"] = SubscriptionRef.changes(probeRef).pipe(
    Stream.filter(Option.isSome),
    Stream.map((probe) => probe.value.capability),
    Stream.changesWith((left, right) => sameChatsCapability(left, right)),
  );

  const availableRoot = resolve({ fresh: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ChatFolderError({
          reason: "chats-unavailable",
          detail: describeChatsUnavailable("root-unavailable"),
          cause,
        }),
    ),
    Effect.flatMap((probe) =>
      probe.capability.available && probe.root !== null
        ? Effect.succeed(probe.root)
        : Effect.fail(
            new ChatFolderError({
              reason: "chats-unavailable",
              detail: describeChatsUnavailable(probe.capability.unavailableReason),
            }),
          ),
    ),
  );

  const allocateChatFolder: ChatFoldersShape["allocateChatFolder"] = Effect.fn(
    "ChatFolders.allocateChatFolder",
  )(function* (input) {
    const root = yield* availableRoot;
    return yield* Effect.tryPromise({
      try: () => createChatFolder(root, input),
      catch: (cause) =>
        new ChatFolderError({
          reason: "allocation-failed",
          detail: "Could not create a folder for this chat in the chats folder.",
          cause,
        }),
    });
  });

  const ensureChatFolder: ChatFoldersShape["ensureChatFolder"] = Effect.fn(
    "ChatFolders.ensureChatFolder",
  )(function* (folder) {
    const root = yield* availableRoot;
    return yield* Effect.tryPromise({
      try: async () => {
        const existing = await stat(folder).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existing?.isDirectory()) return { created: false };
        if (existing || !(await isStrictlyInside(root, folder))) throw new Error("not recreatable");
        await mkdir(root, { recursive: true });
        await mkdir(folder);
        return { created: true };
      },
      catch: (cause) =>
        new ChatFolderError({
          reason: "folder-missing",
          detail: "This chat's folder is missing and cannot be recreated.",
          cause,
        }),
    });
  });

  const insideRoot = (candidate: string) =>
    resolve().pipe(
      Effect.flatMap(({ root }) =>
        root === null
          ? Effect.succeed(false)
          : Effect.tryPromise(() => isStrictlyInside(root, candidate)),
      ),
    );

  const isInsideChatsRoot: ChatFoldersShape["isInsideChatsRoot"] = (candidate) =>
    insideRoot(candidate).pipe(Effect.catch(() => Effect.succeed(false)));

  const removeEmptyChatFolder: ChatFoldersShape["removeEmptyChatFolder"] = (folder) =>
    insideRoot(folder).pipe(
      // `rmdir` refuses a non-empty directory, so nothing a chat wrote can be lost here.
      Effect.flatMap((inside) =>
        inside
          ? Effect.tryPromise(() => rmdir(folder)).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
      Effect.catch(() => Effect.succeed(false)),
    );

  // Warm the cache so the first client config load does not wait for Git.
  yield* Effect.forkScoped(resolve().pipe(Effect.ignoreCause({ log: false })));
  // Retry a failed probe in the background, so subscribed clients learn when chats recover.
  yield* Effect.forkScoped(
    SubscriptionRef.get(probeRef).pipe(
      Effect.flatMap((probe) =>
        Option.isSome(probe) && probe.value.retryAt !== null && now() >= probe.value.retryAt
          ? resolve().pipe(Effect.ignoreCause({ log: true }))
          : Effect.void,
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(FAILED_PROBE_RETRY_MS))),
    ),
  );
  // A new chats root is re-probed as soon as it is saved, so clients see the change.
  yield* Effect.forkScoped(
    deps.settings.streamChanges.pipe(
      Stream.map((settings) => settings.chatsRoot),
      Stream.changes,
      Stream.runForEach(() => resolve().pipe(Effect.ignoreCause({ log: true }))),
    ),
  );

  return {
    capability,
    changes,
    allocateChatFolder,
    ensureChatFolder,
    removeEmptyChatFolder,
    isInsideChatsRoot,
  } satisfies ChatFoldersShape;
});

export const ChatFoldersLive = Layer.effect(
  ChatFolders,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.makeVcsDriverShape();
    return yield* makeChatFolders({
      config: yield* ServerConfig,
      settings: yield* ServerSettingsService,
      policy: yield* WorkspaceAccessPolicy,
      isInsideGitWorkTree: git.isInsideWorkTree,
    });
  }),
);

export interface DeleteChatFolderDependencies {
  /** Deleted project rows still resolve: the chat record usually goes before its files. */
  readonly projects: Pick<ProjectionProjectRepositoryShape, "getById">;
  readonly threads: Pick<ProjectionThreadRepositoryShape, "listByProjectId">;
  readonly chatFolders: Pick<ChatFoldersShape, "isInsideChatsRoot">;
  /** The live projects, workspaces and threads, whose folders must survive the deletion. */
  readonly workspaces: Pick<ProjectionSnapshotQueryShape, "getShellSnapshot">;
  /** Let already-committed deletion cleanup (session stops) finish before sessions are checked. */
  readonly settleThreadCleanup: Effect.Effect<void>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<Pick<ProviderSession, "threadId" | "status" | "cwd">>
  >;
}

const chatError = (reason: ProjectChatError["reason"], message: string) =>
  new ProjectChatError({ reason, message });

/** The live folders other than `projectId`'s own: project roots, workspaces and thread checkouts. */
const otherWorkspaceFolders = (
  snapshot: OrchestrationShellSnapshot,
  projectId: ProjectId,
): ReadonlyArray<string> => [
  ...snapshot.projects.flatMap((project) =>
    project.id === projectId ? [] : [project.workspaceRoot],
  ),
  ...(snapshot.worktrees ?? []).flatMap((worktree) =>
    worktree.projectId === projectId || worktree.worktreePath === null
      ? []
      : [worktree.worktreePath],
  ),
  ...snapshot.threads.flatMap((thread) =>
    thread.projectId === projectId || thread.worktreePath === null ? [] : [thread.worktreePath],
  ),
];

/**
 * "Also delete files" for a chat: remove its folder, recursively, only when the project is a
 * chat, none of its threads is live or in Trash, the folder is the one Ryco allocated for this
 * chat (by name) with its realpath strictly inside the chats root, no other live project,
 * workspace or thread has its folder at or inside it, and no provider session still runs for it.
 */
export const deleteChatFolder = Effect.fn("deleteChatFolder")(function* (
  deps: DeleteChatFolderDependencies,
  projectId: ProjectId,
): Effect.fn.Return<ProjectsDeleteChatFolderResult, ProjectChatError> {
  const unreadable = () => chatError("not-found", "This chat could not be read.");
  const project = yield* deps.projects.getById({ projectId }).pipe(Effect.mapError(unreadable));
  if (Option.isNone(project)) return yield* chatError("not-found", "This chat no longer exists.");
  if (!isChatProject(project.value)) {
    return yield* chatError(
      "not-chat",
      "Only the folder of a chat without a project can be deleted.",
    );
  }
  const threads = yield* deps.threads
    .listByProjectId({ projectId })
    .pipe(Effect.mapError(unreadable));
  // A trashed thread can be restored, and it would need these files back.
  if (threads.some((thread) => thread.deletedAt === null || thread.trashedAt !== null)) {
    return yield* chatError(
      "has-threads",
      "Delete this chat's conversations permanently, including from Trash, before deleting its files.",
    );
  }
  const folder = project.value.workspaceRoot;
  const present = yield* Effect.promise(() =>
    lstat(folder).then(
      () => true,
      () => false,
    ),
  );
  if (!present) return { deleted: false };
  const canonicalFolder = yield* Effect.promise(() =>
    canonicalizeWorktreePath(folder).catch(() => null),
  );
  // Only the folder allocated for this chat: never another chat's, even if the record says so.
  if (
    canonicalFolder === null ||
    !isChatFolderNameOf(folder, projectId) ||
    !isChatFolderNameOf(canonicalFolder, projectId) ||
    !(yield* deps.chatFolders.isInsideChatsRoot(folder))
  ) {
    return yield* chatError(
      "outside-chats-root",
      "This chat's folder is not one Ryco created for it in the chats folder, so Ryco will not delete it.",
    );
  }
  const snapshot = yield* deps.workspaces.getShellSnapshot().pipe(Effect.mapError(unreadable));
  const nested = yield* Effect.promise(async () => {
    for (const other of otherWorkspaceFolders(snapshot, projectId)) {
      const canonical = await canonicalizeWorktreePath(other).catch(() => path.resolve(other));
      if (containsPath(canonicalFolder, canonical)) return other;
    }
    return null;
  });
  if (nested !== null) {
    return yield* chatError(
      "busy",
      `Another project or workspace uses files in this chat's folder (${nested}). Remove it from Ryco first, or delete the folder yourself.`,
    );
  }
  yield* deps.settleThreadCleanup;
  const threadIds = new Set<string>(threads.map((thread) => thread.threadId));
  const sessions = yield* deps.listSessions();
  if (
    sessions.some(
      (session) =>
        session.status !== "closed" &&
        (threadIds.has(session.threadId) ||
          (session.cwd !== undefined && containsPath(folder, session.cwd))),
    )
  ) {
    return yield* chatError(
      "busy",
      "An agent session is still running in this chat's folder. Try again in a moment.",
    );
  }
  yield* Effect.tryPromise({
    try: () => rm(folder, { recursive: true }),
    catch: () =>
      chatError(
        "access-denied",
        "Ryco could not delete every file in this chat's folder. Check its permissions.",
      ),
  });
  return { deleted: true };
});
