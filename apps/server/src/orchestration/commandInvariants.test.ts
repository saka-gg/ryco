import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@ryco/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  isThreadPristine,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
  requireThreadHasUserMessage,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires a user message before archiving a thread", async () => {
    await expect(
      Effect.runPromise(
        requireThreadHasUserMessage({
          readModel,
          command: {
            type: "thread.archive",
            commandId: CommandId.make("cmd-archive-empty"),
            threadId: ThreadId.make("thread-1"),
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("before a message has been sent");

    const thread = await Effect.runPromise(
      requireThreadHasUserMessage({
        readModel: {
          ...readModel,
          threads: readModel.threads.map((entry) =>
            entry.id === ThreadId.make("thread-1")
              ? {
                  ...entry,
                  messages: [
                    {
                      id: MessageId.make("message-1"),
                      role: "user",
                      text: "hello",
                      attachments: [],
                      turnId: null,
                      streaming: false,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ],
                }
              : entry,
          ),
        },
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-with-message"),
          threadId: ThreadId.make("thread-1"),
        },
        threadId: ThreadId.make("thread-1"),
      }),
    );

    expect(thread.id).toBe(ThreadId.make("thread-1"));
  });

  it("treats a fork as used before it sends anything, even without an inherited prompt", async () => {
    const lineage = {
      parentThreadId: ThreadId.make("thread-2"),
      rootThreadId: ThreadId.make("thread-2"),
      relationship: "forked",
    };
    const forkReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((entry) =>
        entry.id === ThreadId.make("thread-1") ? { ...entry, lineage } : entry,
      ),
    };
    const fork = findThreadById(forkReadModel, ThreadId.make("thread-1"))!;
    expect(fork.messages.some((message) => message.role === "user")).toBe(false);

    const archived = await Effect.runPromise(
      requireThreadHasUserMessage({
        readModel: forkReadModel,
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-fork"),
          threadId: ThreadId.make("thread-1"),
        },
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(archived.id).toBe(ThreadId.make("thread-1"));
    expect(isThreadPristine(fork)).toBe(false);
    // Other lineage (a delegated child) is not a conversation by itself.
    expect(isThreadPristine({ ...fork, lineage: { ...lineage, relationship: "delegated" } })).toBe(
      true,
    );
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("allows re-creating a thread id after the prior incarnation was deleted", async () => {
    const threadId = ThreadId.make("thread-1");
    const previous = readModel.threads.find((thread) => thread.id === threadId)!;
    const afterDeletion: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === threadId ? { ...thread, deletedAt: now, updatedAt: now } : thread,
      ),
    };
    const retry: OrchestrationCommand = {
      type: "thread.create",
      commandId: CommandId.make("cmd-retry"),
      threadId,
      projectId: previous.projectId,
      title: previous.title,
      modelSelection: previous.modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    };

    await expect(
      Effect.runPromise(
        requireThreadAbsent({ readModel: afterDeletion, command: retry, threadId }),
      ),
    ).resolves.toBeUndefined();
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});
