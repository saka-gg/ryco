import {
  CommandId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import type { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ChatFolderError } from "../../project/chatFolders.ts";
import {
  type ChatBootstrapDependencies,
  classifyChatBootstrapFailure,
  prepareChatProject,
  releasePreparedChatFolder,
} from "./chatBootstrap.ts";

const projectId = ProjectId.make("project-chat");
const createdAt = "2026-10-08T12:00:00.000Z";
const folder = "/chats/2026-10-08-fix-the-build-0123abcd";

const createThread = {
  projectId,
  title: "Fix the build",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt,
};

const shell = (overrides: Partial<OrchestrationProjectShell> = {}): OrchestrationProjectShell => ({
  id: projectId,
  kind: "chat",
  title: "Fix the build",
  workspaceRoot: folder,
  projectMetadataDir: ".ryco",
  defaultModelSelection: null,
  scripts: [],
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

/** Recording fakes: projects by id/root, live threads by project, and a scripted dispatcher. */
const harness = (input?: {
  readonly existing?: OrchestrationProjectShell;
  /** Active project id by workspace root. */
  readonly owners?: Record<string, ProjectId>;
  readonly liveThread?: boolean;
  readonly failCreate?: boolean;
  readonly ensuredCreated?: boolean;
  readonly withoutChatFolders?: boolean;
  readonly unavailable?: boolean;
  /** The project record of `projectId`, including a deleted one; absent when never created. */
  readonly record?: { readonly deletedAt: string | null };
  readonly withoutProjectRecords?: boolean;
}) => {
  const calls = {
    allocated: [] as unknown[],
    ensured: [] as string[],
    removed: [] as string[],
    dispatched: [] as OrchestrationCommand[],
  };
  const deps: ChatBootstrapDependencies = {
    chatFolders: input?.withoutChatFolders
      ? undefined
      : {
          allocateChatFolder: (allocation) =>
            input?.unavailable
              ? Effect.fail(
                  new ChatFolderError({
                    reason: "chats-unavailable",
                    detail: "Chats are off: the chats folder is inside a Git repository.",
                  }),
                )
              : Effect.sync(() => {
                  calls.allocated.push(allocation);
                  return folder;
                }),
          ensureChatFolder: (path) =>
            Effect.sync(() => {
              calls.ensured.push(path);
              return { created: input?.ensuredCreated ?? false };
            }),
          removeEmptyChatFolder: (path) =>
            Effect.sync(() => {
              calls.removed.push(path);
              return true;
            }),
        },
    projects: {
      getProjectShellById: () => Effect.succeed(Option.fromNullishOr(input?.existing)),
      getActiveProjectByWorkspaceRoot: (root) => {
        const owner = input?.owners?.[root];
        return Effect.succeed(
          owner === undefined ? Option.none() : Option.some({ id: owner } as OrchestrationProject),
        );
      },
      getFirstActiveThreadIdByProjectId: () =>
        Effect.succeed(
          input?.liveThread ? Option.some(ThreadId.make("thread-live")) : Option.none(),
        ),
    },
    projectRecords: input?.withoutProjectRecords
      ? undefined
      : {
          getById: () =>
            Effect.succeed(
              input?.record === undefined
                ? Option.none()
                : Option.some({ projectId, kind: "chat", ...input.record } as ProjectionProject),
            ),
        },
    dispatch: (command) =>
      input?.failCreate
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Project already exists and cannot be created twice.",
            }),
          )
        : Effect.sync(() => {
            calls.dispatched.push(command);
            return { sequence: calls.dispatched.length };
          }),
    serverCommandId: (tag) => CommandId.make(`server:${tag}`),
  };
  return { deps, calls };
};

const prepare = (
  deps: ChatBootstrapDependencies,
  overrides: { readonly titleSeed?: string; readonly worktreePath?: string | null } = {},
) =>
  Effect.runPromise(
    prepareChatProject(deps, {
      chat: { projectId, titleSeed: overrides.titleSeed ?? "Fix the build" },
      createThread: { ...createThread, worktreePath: overrides.worktreePath ?? null },
    }).pipe(Effect.result),
  );

describe("prepareChatProject", () => {
  it("allocates a folder and creates a chat project there through internal dispatch", async () => {
    const { deps, calls } = harness();
    const result = await prepare(deps, { titleSeed: "Fix the\nbuild   please" });

    expect(result).toMatchObject({
      _tag: "Success",
      success: { projectId, folder, createdFolder: true },
    });
    expect(calls.allocated).toEqual([
      { createdAt, titleSeed: "Fix the\nbuild   please", projectId },
    ]);
    expect(calls.dispatched).toEqual([
      {
        type: "project.create",
        commandId: CommandId.make("server:bootstrap-chat-project-create"),
        projectId,
        kind: "chat",
        title: "Fix the build please",
        workspaceRoot: folder,
        createdAt,
      },
    ]);
  });

  it("reuses an earlier attempt's chat without allocating a second folder", async () => {
    const { deps, calls } = harness({ existing: shell(), ensuredCreated: true });
    const result = await prepare(deps);

    expect(result).toMatchObject({
      _tag: "Success",
      success: { projectId, folder, createdFolder: true },
    });
    expect(calls.allocated).toEqual([]);
    expect(calls.dispatched).toEqual([]);
    expect(calls.ensured).toEqual([folder]);
  });

  it("leaves a chat that is already in use exactly as it is", async () => {
    const { deps, calls } = harness({ existing: shell(), liveThread: true });
    const result = await prepare(deps);

    expect(result).toMatchObject({
      _tag: "Success",
      success: { projectId, folder, createdFolder: false },
    });
    expect(calls.ensured).toEqual([]);
    expect(calls.allocated).toEqual([]);
    expect(calls.dispatched).toEqual([]);
  });

  it("removes the new folder when the chat project cannot be created", async () => {
    const { deps, calls } = harness({ failCreate: true });
    const result = await prepare(deps);

    expect(result._tag).toBe("Failure");
    expect(calls.removed).toEqual([folder]);
  });

  it("refuses with a clear reason instead of creating anything", async () => {
    const cases = [
      { deps: harness({ withoutChatFolders: true }).deps, message: "not available" },
      { deps: harness({ unavailable: true }).deps, message: "inside a Git repository" },
      {
        deps: harness({ existing: shell({ kind: "project" }) }).deps,
        message: "is not a chat",
      },
    ];
    for (const { deps, message } of cases) {
      const result = await prepare(deps);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain(message);
    }

    const { deps, calls } = harness();
    const worktree = await prepare(deps, { worktreePath: "/repo/.ryco/worktrees/x" });
    expect(worktree._tag).toBe("Failure");
    if (worktree._tag === "Failure") expect(worktree.failure.message).toContain("worktree");
    expect(calls.allocated).toEqual([]);
  });
});

describe("retired chat ids", () => {
  const retired = { deletedAt: "2026-10-08T13:00:00.000Z" };

  it("refuses a deleted chat's id with a recognizable reason before creating anything", async () => {
    const { deps, calls } = harness({ record: retired });
    const result = await prepare(deps);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(OrchestrationDispatchCommandError);
      expect(result.failure.reason).toBe("chat-project-retired");
      expect(result.failure.message).toContain("Start a new chat");
    }
    expect(calls.allocated).toEqual([]);
    expect(calls.ensured).toEqual([]);
    expect(calls.dispatched).toEqual([]);
  });

  it("treats an unknown id as new and a live chat as reusable", async () => {
    const fresh = harness();
    expect((await prepare(fresh.deps))._tag).toBe("Success");

    const live = harness({ existing: shell(), record: { deletedAt: null } });
    expect((await prepare(live.deps))._tag).toBe("Success");
  });

  const classify = (deps: ChatBootstrapDependencies, error: OrchestrationDispatchCommandError) =>
    Effect.runPromise(classifyChatBootstrapFailure(deps, projectId, error));

  it("reports a later failure as retired once the chat was deleted meanwhile", async () => {
    const original = new OrchestrationDispatchCommandError({
      message: "Project 'project-chat' does not exist.",
    });
    const classified = await classify(harness({ record: retired }).deps, original);
    expect(classified.reason).toBe("chat-project-retired");
    expect(classified.cause).toBe(original);
  });

  it("keeps every other failure exactly as it was", async () => {
    const original = new OrchestrationDispatchCommandError({ message: "Provider unavailable." });
    expect(await classify(harness({ record: { deletedAt: null } }).deps, original)).toBe(original);
    expect(await classify(harness().deps, original)).toBe(original);
    expect(await classify(harness({ withoutProjectRecords: true }).deps, original)).toBe(original);
  });
});

describe("releasePreparedChatFolder", () => {
  const release = (
    deps: ChatBootstrapDependencies,
    prepared: { readonly createdFolder: boolean } = { createdFolder: true },
  ) => Effect.runPromise(releasePreparedChatFolder(deps, { projectId, folder, ...prepared }));

  it("removes a folder this attempt created once nothing depends on it", async () => {
    const unowned = harness();
    await release(unowned.deps);
    expect(unowned.calls.removed).toEqual([folder]);

    const ownChatWithoutThreads = harness({ owners: { [folder]: projectId } });
    await release(ownChatWithoutThreads.deps);
    expect(ownChatWithoutThreads.calls.removed).toEqual([folder]);
  });

  it("keeps folders another project owns, a concurrent send uses, or it did not create", async () => {
    const otherOwner = harness({
      owners: { [folder]: ProjectId.make("project-other") },
    });
    await release(otherOwner.deps);
    expect(otherOwner.calls.removed).toEqual([]);

    const concurrentSend = harness({ owners: { [folder]: projectId }, liveThread: true });
    await release(concurrentSend.deps);
    expect(concurrentSend.calls.removed).toEqual([]);

    const reused = harness();
    await release(reused.deps, { createdFolder: false });
    expect(reused.calls.removed).toEqual([]);
  });
});
