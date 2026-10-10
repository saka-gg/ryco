import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationShellSnapshot,
  ProjectId,
  ProviderInstanceId,
  type ServerChatsCapability,
  type ServerSettings,
  ThreadId,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@ryco/contracts";
import { Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { ProjectionProject } from "../persistence/Services/ProjectionProjects.ts";
import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeWorkspaceAccessPolicy } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import {
  type ChatFoldersDependencies,
  chatFolderDate,
  chatFolderName,
  chatFolderSuffix,
  chatProjectTitle,
  createChatFolder,
  deleteChatFolder,
  type DeleteChatFolderDependencies,
  makeChatFolders,
} from "./chatFolders.ts";

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-chat-folders-")));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const projectId = ProjectId.make("project-chat-1");
/** A local-noon timestamp, so the folder date is the same calendar day in every time zone. */
const createdAt = new Date(2026, 9, 8, 12, 0, 0).toISOString();

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** ChatFolders over real Git, a mutable settings stub and an optional access root. */
const withChatFolders = <A, E>(
  input: {
    readonly chatsRoot?: string;
    readonly chatsDir?: string;
    readonly accessRoot?: string;
    readonly isInsideGitWorkTree?: ChatFoldersDependencies["isInsideGitWorkTree"];
    readonly now?: () => number;
    readonly waits?: ChatFoldersDependencies["waits"];
  },
  use: (harness: {
    readonly folders: Effect.Success<ReturnType<typeof makeChatFolders>>;
    readonly setChatsRoot: (chatsRoot: string) => Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* Ref.make<ServerSettings>({
          ...DEFAULT_SERVER_SETTINGS,
          chatsRoot: input.chatsRoot ?? "",
        });
        const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
        const isInsideGitWorkTree =
          input.isInsideGitWorkTree ?? (yield* GitVcsDriver.makeVcsDriverShape()).isInsideWorkTree;
        const folders = yield* makeChatFolders({
          config: {
            chatsDir: input.chatsDir ?? path.join(scratch, "home", "chats"),
            workspaceAccessRoot: input.accessRoot,
          },
          settings: {
            getSettings: Ref.get(settings),
            streamChanges: Stream.fromPubSub(settingsChanges),
          },
          policy: yield* makeWorkspaceAccessPolicy(input.accessRoot),
          isInsideGitWorkTree,
          ...(input.now ? { now: input.now } : {}),
          ...(input.waits ? { waits: input.waits } : {}),
        });
        const setChatsRoot = (chatsRoot: string) =>
          Ref.updateAndGet(settings, (current) => ({ ...current, chatsRoot })).pipe(
            Effect.flatMap((next) => PubSub.publish(settingsChanges, next)),
            Effect.asVoid,
          );
        return yield* use({ folders, setChatsRoot });
      }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
    ),
  );

describe("chat folder names", () => {
  it("uses the local date, a traversal-free slug and a stable 8-hex suffix", () => {
    expect(chatFolderDate(createdAt)).toBe("2026-10-08");
    const name = chatFolderName({ createdAt, titleSeed: "Plan the Q4 offsite!", projectId });
    expect(name).toMatch(/^2026-10-08-plan-the-q4-offsite-[0-9a-f]{8}$/);
    expect(name).toBe(chatFolderName({ createdAt, titleSeed: "Plan the Q4 offsite!", projectId }));
    expect(chatFolderSuffix(projectId, 0)).not.toBe(chatFolderSuffix(projectId, 1));

    for (const titleSeed of ["../../etc/passwd", "a/b\\c", "..", "   ", "🙂"]) {
      const unsafe = chatFolderName({ createdAt, titleSeed, projectId });
      expect(unsafe).not.toMatch(/[/\\]|\.\./);
      expect(path.basename(unsafe)).toBe(unsafe);
    }
    expect(chatFolderName({ createdAt, titleSeed: "🙂", projectId })).toMatch(
      /^2026-10-08-chat-[0-9a-f]{8}$/,
    );
  });

  it("derives a single-line, bounded project title", () => {
    expect(chatProjectTitle("  Fix the\n\tbuild  ")).toBe("Fix the build");
    expect(chatProjectTitle("x".repeat(500))).toHaveLength(200);
    // Never splits a surrogate pair at the bound.
    expect(chatProjectTitle(`${"x".repeat(199)}🙂`)).toBe("x".repeat(199));
  });
});

describe("createChatFolder", () => {
  it("creates the root lazily and retries a colliding name with a fresh suffix", async () => {
    const root = path.join(scratch, "chats");
    const input = { createdAt, titleSeed: "Notes", projectId };
    await mkdir(path.join(root, chatFolderName(input, 0)), { recursive: true });
    await writeFile(path.join(root, chatFolderName(input, 0), "keep.txt"), "owned elsewhere");

    const folder = await createChatFolder(root, input);
    expect(folder).toBe(path.join(root, chatFolderName(input, 1)));
    expect((await lstat(folder)).isDirectory()).toBe(true);
    expect(await readdir(path.join(root, chatFolderName(input, 0)))).toEqual(["keep.txt"]);
  });
});

describe.skipIf(!gitAvailable)("ChatFolders availability", () => {
  it("offers chats for a root outside Git and allocates under its realpath", async () => {
    const result = await withChatFolders({}, ({ folders }) =>
      Effect.gen(function* () {
        const capability = yield* folders.capability;
        const folder = yield* folders.allocateChatFolder({
          createdAt,
          titleSeed: "First chat",
          projectId,
        });
        return { capability, folder };
      }),
    );
    const root = path.join(scratch, "home", "chats");
    expect(result.capability).toEqual({ available: true, root });
    expect(path.dirname(result.folder)).toBe(root);
    expect(path.basename(result.folder)).toMatch(/^2026-10-08-first-chat-[0-9a-f]{8}$/);
  });

  it("turns chats off when the root lies inside a Git working tree", async () => {
    const repository = path.join(scratch, "repo");
    await mkdir(repository);
    execFileSync("git", ["init", "-q"], { cwd: repository });
    const chatsRoot = path.join(repository, "nested", "chats");

    const result = await withChatFolders({ chatsRoot }, ({ folders }) =>
      Effect.gen(function* () {
        const capability = yield* folders.capability;
        const allocation = yield* Effect.flip(
          folders.allocateChatFolder({ createdAt, titleSeed: "x", projectId }),
        );
        return { capability, allocation };
      }),
    );
    expect(result.capability).toEqual({
      available: false,
      root: chatsRoot,
      unavailableReason: "inside-git-repository",
    });
    expect(result.allocation.reason).toBe("chats-unavailable");
    expect(result.allocation.detail).toContain("inside a Git repository");
    await expect(lstat(chatsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a symlinked root and reports and uses its resolved target", async () => {
    const target = path.join(scratch, "synced", "chats");
    await mkdir(target, { recursive: true });
    const alias = path.join(scratch, "alias");
    await symlink(path.join(scratch, "synced"), alias);

    const result = await withChatFolders({ chatsRoot: path.join(alias, "chats") }, ({ folders }) =>
      Effect.gen(function* () {
        const capability = yield* folders.capability;
        const folder = yield* folders.allocateChatFolder({
          createdAt,
          titleSeed: "Linked",
          projectId,
        });
        const inside = yield* folders.isInsideChatsRoot(
          path.join(alias, "chats", path.basename(folder)),
        );
        return { capability, folder, inside };
      }),
    );
    expect(result.capability).toEqual({ available: true, root: target });
    expect(path.dirname(result.folder)).toBe(target);
    expect(result.inside).toBe(true);
  });

  it("reports a root outside the workspace access root as restricted", async () => {
    const accessRoot = path.join(scratch, "allowed");
    await mkdir(accessRoot);
    const capability = await withChatFolders(
      { accessRoot, chatsRoot: path.join(scratch, "elsewhere") },
      ({ folders }) => folders.capability,
    );
    expect(capability).toEqual({ available: false, unavailableReason: "restricted" });

    // The managed default lives inside the access root and stays usable.
    const managed = await withChatFolders({ accessRoot }, ({ folders }) => folders.capability);
    expect(managed).toEqual({ available: true, root: path.join(accessRoot, ".ryco", "chats") });
  });

  it("re-probes and publishes a change when the chats root setting changes", async () => {
    const repository = path.join(scratch, "repo");
    await mkdir(repository);
    execFileSync("git", ["init", "-q"], { cwd: repository });

    const seen = await withChatFolders({}, ({ folders, setChatsRoot }) =>
      Effect.gen(function* () {
        const initial = yield* folders.capability;
        const collected = yield* folders.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* setChatsRoot(path.join(repository, "chats"));
        const changes = yield* Fiber.join(collected).pipe(Effect.timeout("5 seconds"));
        return { initial, changes: Array.from(changes), latest: yield* folders.capability };
      }),
    );
    expect(seen.initial.available).toBe(true);
    expect(seen.changes.map((capability: ServerChatsCapability) => capability.available)).toEqual([
      true,
      false,
    ]);
    expect(seen.latest.unavailableReason).toBe("inside-git-repository");
  });
});

describe("ChatFolders probe failures", () => {
  it("hides chats while the Git probe fails and retries after the backoff", async () => {
    let clock = 0;
    let failing = true;
    const result = await withChatFolders(
      {
        now: () => clock,
        isInsideGitWorkTree: (cwd) =>
          failing
            ? Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "test",
                  command: "git rev-parse",
                  cwd,
                  timeoutMs: 1,
                }),
              )
            : Effect.succeed(false),
      },
      ({ folders }) =>
        Effect.gen(function* () {
          const failed = yield* folders.capability;
          failing = false;
          const cached = yield* folders.capability;
          clock = 60_000;
          // Due for its retry: still answered at once, while the retry runs in the background.
          const due = yield* folders.capability;
          const retried = yield* folders.changes.pipe(
            Stream.filter((capability) => capability.available),
            Stream.runHead,
            Effect.timeout("5 seconds"),
          );
          return { failed, cached, due, retried, latest: yield* folders.capability };
        }),
    );
    expect(result.failed).toMatchObject({
      available: false,
      unavailableReason: "root-unavailable",
    });
    expect(result.cached).toEqual(result.failed);
    expect(result.due).toEqual(result.failed);
    expect(Option.getOrUndefined(result.retried)?.available).toBe(true);
    expect(result.latest.available).toBe(true);
  });

  it("never holds a config load on a root that stops answering, and never stacks its probes", async () => {
    let probes = 0;
    const result = await withChatFolders(
      {
        waits: { probe: "80 millis", capability: "20 millis" },
        isInsideGitWorkTree: () =>
          Effect.suspend(() => {
            probes += 1;
            // A mount that stopped answering: the call never returns.
            return Effect.never;
          }),
      },
      ({ folders }) =>
        Effect.gen(function* () {
          const startedAt = Date.now();
          const first = yield* folders.capability;
          const second = yield* folders.capability;
          const waitedMs = Date.now() - startedAt;
          // Past the probe's bound: the answer is "unavailable" until the probe answers.
          const published = yield* folders.changes.pipe(Stream.runHead);
          const allocation = yield* Effect.flip(
            folders.allocateChatFolder({ createdAt, titleSeed: "x", projectId }),
          );
          const cached = yield* folders.capability;
          return { first, second, waitedMs, published, allocation, cached };
        }),
    );
    const unavailable = { available: false, unavailableReason: "root-unavailable" };
    expect(result.first).toEqual(unavailable);
    expect(result.second).toEqual(unavailable);
    expect(result.waitedMs).toBeLessThan(1_000);
    expect(Option.getOrUndefined(result.published)).toEqual(unavailable);
    expect(result.allocation.reason).toBe("chats-unavailable");
    expect(result.cached).toEqual(unavailable);
    // Every caller joined the one stalled probe instead of starting another.
    expect(probes).toBe(1);
  });

  it("offers chats when git cannot run at all", async () => {
    const capability = await withChatFolders(
      {
        isInsideGitWorkTree: (cwd) =>
          Effect.fail(
            new VcsProcessSpawnError({
              operation: "test",
              command: "git rev-parse",
              cwd,
              cause: new Error("spawn git ENOENT"),
            }),
          ),
      },
      ({ folders }) => folders.capability,
    );
    expect(capability.available).toBe(true);
  });
});

describe("ChatFolders containment and cleanup", () => {
  const notInsideGit = () => Effect.succeed(false);

  it("treats only paths strictly below the root's realpath as inside", async () => {
    const root = path.join(scratch, "chats");
    const outside = path.join(scratch, "outside");
    await mkdir(path.join(root, "chat-a"), { recursive: true });
    await mkdir(`${root}-sibling`);
    await mkdir(outside);
    await symlink(outside, path.join(root, "escape"));

    const results = await withChatFolders(
      { chatsRoot: root, isInsideGitWorkTree: notInsideGit },
      ({ folders }) =>
        Effect.all([
          folders.isInsideChatsRoot(path.join(root, "chat-a")),
          folders.isInsideChatsRoot(root),
          folders.isInsideChatsRoot(`${root}-sibling`),
          folders.isInsideChatsRoot(path.join(root, "escape")),
          folders.isInsideChatsRoot(path.join(root, "chat-a", "..", "..", "outside")),
        ]),
    );
    expect(results).toEqual([true, false, false, false, false]);
  });

  it("removes only empty folders inside the root and recreates a missing chat folder", async () => {
    const root = path.join(scratch, "chats");
    const empty = path.join(root, "empty");
    const used = path.join(root, "used");
    const outside = path.join(scratch, "outside-empty");
    await mkdir(empty, { recursive: true });
    await mkdir(used);
    await writeFile(path.join(used, "notes.md"), "keep");
    await mkdir(outside);

    const result = await withChatFolders(
      { chatsRoot: root, isInsideGitWorkTree: notInsideGit },
      ({ folders }) =>
        Effect.gen(function* () {
          const removed = yield* Effect.all([
            folders.removeEmptyChatFolder(empty),
            folders.removeEmptyChatFolder(used),
            folders.removeEmptyChatFolder(outside),
          ]);
          const recreated = yield* folders.ensureChatFolder(empty);
          const existing = yield* folders.ensureChatFolder(used);
          const refused = yield* Effect.flip(folders.ensureChatFolder(path.join(scratch, "gone")));
          return { removed, recreated, existing, refused };
        }),
    );
    expect(result.removed).toEqual([true, false, false]);
    expect(result.recreated).toEqual({ created: true });
    expect(result.existing).toEqual({ created: false });
    expect(result.refused.reason).toBe("folder-missing");
    expect((await lstat(empty)).isDirectory()).toBe(true);
    expect((await lstat(outside)).isDirectory()).toBe(true);
  });
});

describe("deleteChatFolder", () => {
  const now = "2026-10-08T12:00:00.000Z";
  const projectRow = (overrides: Partial<ProjectionProject> = {}): ProjectionProject => ({
    projectId,
    kind: "chat",
    title: "Chat",
    workspaceRoot: path.join(
      scratch,
      "chats",
      chatFolderName({ createdAt, titleSeed: "Chat", projectId }),
    ),
    projectMetadataDir: ".ryco",
    defaultModelSelection: null,
    customSystemPrompt: null,
    customAvatarContentHash: null,
    preferredRemoteName: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
    ...overrides,
  });
  const threadRow = (overrides: Partial<ProjectionThread> = {}): ProjectionThread => ({
    threadId: ThreadId.make("thread-chat"),
    projectId,
    title: "Chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: now,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: now,
    trashedAt: null,
    lineageParentThreadId: null,
    lineageRootThreadId: null,
    lineageRelationship: null,
    ...overrides,
  });

  const run = (input: {
    readonly project?: ProjectionProject | null;
    readonly threads?: ReadonlyArray<ProjectionThread>;
    readonly inside?: boolean;
    readonly sessions?: Effect.Success<ReturnType<DeleteChatFolderDependencies["listSessions"]>>;
    /** What the shell snapshot lists besides the chat. */
    readonly workspaces?: Partial<OrchestrationShellSnapshot>;
  }) => {
    const project = input.project === undefined ? projectRow() : input.project;
    let settled = 0;
    return Effect.runPromise(
      deleteChatFolder(
        {
          projects: { getById: () => Effect.succeed(Option.fromNullishOr(project)) },
          threads: { listByProjectId: () => Effect.succeed(input.threads ?? [threadRow()]) },
          chatFolders: { isInsideChatsRoot: () => Effect.succeed(input.inside ?? true) },
          workspaces: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [],
                worktrees: [],
                threads: [],
                updatedAt: now,
                ...input.workspaces,
              } as OrchestrationShellSnapshot),
          },
          settleThreadCleanup: Effect.sync(() => void (settled += 1)),
          listSessions: () => Effect.succeed(input.sessions ?? []),
        },
        projectId,
      ).pipe(
        Effect.map((result) => ({ ok: true as const, result, settled })),
        Effect.catch((error) =>
          Effect.succeed({ ok: false as const, reason: error.reason, settled }),
        ),
      ),
    );
  };

  const makeFolder = async () => {
    const folder = projectRow().workspaceRoot;
    await mkdir(path.join(folder, "outputs"), { recursive: true });
    await writeFile(path.join(folder, "outputs", "report.md"), "draft");
    return folder;
  };

  it("deletes a deleted chat's folder recursively once every thread is gone", async () => {
    const folder = await makeFolder();
    expect(await run({})).toEqual({ ok: true, result: { deleted: true }, settled: 1 });
    await expect(lstat(folder)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run({})).toMatchObject({ ok: true, result: { deleted: false } });
  });

  it("refuses unknown projects, regular projects and chats with live or trashed threads", async () => {
    const folder = await makeFolder();
    expect(await run({ project: null })).toMatchObject({ reason: "not-found" });
    expect(await run({ project: projectRow({ kind: "project" }) })).toMatchObject({
      reason: "not-chat",
    });
    expect(await run({ threads: [threadRow({ deletedAt: null })] })).toMatchObject({
      reason: "has-threads",
    });
    expect(await run({ threads: [threadRow({ trashedAt: now })] })).toMatchObject({
      reason: "has-threads",
    });
    expect((await lstat(folder)).isDirectory()).toBe(true);
  });

  it("refuses a folder Ryco did not allocate for this chat, such as another chat's", async () => {
    // The record points at another chat's folder (or a folder inside it): never delete it.
    const otherChat = path.join(
      scratch,
      "chats",
      chatFolderName({
        createdAt,
        titleSeed: "Other",
        projectId: ProjectId.make("project-chat-2"),
      }),
    );
    await mkdir(path.join(otherChat, "src"), { recursive: true });
    for (const workspaceRoot of [otherChat, path.join(otherChat, "src")]) {
      expect(await run({ project: projectRow({ workspaceRoot }) })).toMatchObject({
        reason: "outside-chats-root",
        settled: 0,
      });
    }
    expect((await lstat(path.join(otherChat, "src"))).isDirectory()).toBe(true);
  });

  it("refuses while a live project, workspace or thread has its folder inside the chat's", async () => {
    const folder = await makeFolder();
    const web = path.join(folder, "web");
    await mkdir(web);
    const otherProject = ProjectId.make("project-web");
    const shells = {
      project: { projects: [{ id: otherProject, workspaceRoot: web }] },
      worktree: { worktrees: [{ projectId: otherProject, worktreePath: folder }] },
      thread: { threads: [{ projectId: otherProject, worktreePath: path.join(web, "..") }] },
    } as const;
    for (const workspaces of Object.values(shells)) {
      expect(
        await run({ workspaces: workspaces as unknown as Partial<OrchestrationShellSnapshot> }),
      ).toMatchObject({ reason: "busy", settled: 0 });
    }
    expect((await lstat(web)).isDirectory()).toBe(true);

    // A project around the chats folder, and the chat's own records, do not block it.
    expect(
      await run({
        workspaces: {
          projects: [
            { id: otherProject, workspaceRoot: scratch },
            { id: projectId, workspaceRoot: folder },
          ],
          worktrees: [{ projectId, worktreePath: folder }],
        } as unknown as Partial<OrchestrationShellSnapshot>,
      }),
    ).toMatchObject({ ok: true, result: { deleted: true } });
  });

  it("refuses folders outside the chats root and folders a session still uses", async () => {
    const folder = await makeFolder();
    expect(await run({ inside: false })).toMatchObject({ reason: "outside-chats-root" });
    const session = {
      threadId: ThreadId.make("thread-chat"),
      status: "ready" as const,
      cwd: folder,
    };
    expect(await run({ sessions: [session] })).toMatchObject({ reason: "busy", settled: 1 });
    expect(
      await run({
        sessions: [
          { ...session, threadId: ThreadId.make("other"), cwd: path.join(folder, "outputs") },
        ],
      }),
    ).toMatchObject({ reason: "busy" });
    expect(await run({ sessions: [{ ...session, status: "closed" }] })).toMatchObject({
      ok: true,
      result: { deleted: true },
    });
  });
});
