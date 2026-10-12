import { type OrchestrationCommand, ProjectId, ThreadId } from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionProject } from "../persistence/Services/ProjectionProjects.ts";
import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ThreadForkLedgerRow } from "../threadFork/forkLedger.ts";
import {
  type OrphanChatProjectDependencies,
  removeOrphanChatProjects,
} from "./orphanChatProjects.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const TWO_HOURS_AGO = "2026-10-08T10:00:00.000Z";

const project = (id: string, overrides: Partial<ProjectionProject> = {}): ProjectionProject => ({
  projectId: ProjectId.make(id),
  kind: "chat",
  title: id,
  workspaceRoot: `/chats/${id}`,
  projectMetadataDir: ".ryco",
  defaultModelSelection: null,
  customAvatarContentHash: null,
  preferredRemoteName: null,
  scripts: [],
  createdAt: TWO_HOURS_AGO,
  updatedAt: TWO_HOURS_AGO,
  deletedAt: null,
  ...overrides,
});

const thread = (projectId: string, overrides: Partial<ProjectionThread> = {}) =>
  ({
    threadId: ThreadId.make(`thread-${projectId}`),
    projectId: ProjectId.make(projectId),
    deletedAt: null,
    trashedAt: null,
    archivedAt: null,
    latestTurnId: null,
    latestUserMessageAt: TWO_HOURS_AGO,
    ...overrides,
  }) as ProjectionThread;

/** A `new-chat` fork's ledger row; the sweep reads only where its chat is. */
const newChatFork = (
  chatProjectId: string,
  checkout: "planned" | "prepared" = "planned",
): ThreadForkLedgerRow =>
  ({
    destinationKind: "new-chat",
    plan: {
      projectId: ProjectId.make(chatProjectId),
      checkout: { kind: "new-chat", projectId: ProjectId.make(chatProjectId), titleSeed: "Fork" },
    },
    checkout:
      checkout === "prepared"
        ? {
            kind: "new-chat",
            projectId: ProjectId.make(chatProjectId),
            folder: `/chats/${chatProjectId}`,
            createdFolder: true,
          }
        : null,
  }) as unknown as ThreadForkLedgerRow;

const sweep = (input: {
  readonly projects: ReadonlyArray<ProjectionProject>;
  readonly threads?: ReadonlyArray<ProjectionThread>;
  readonly refuse?: ReadonlyArray<string>;
  readonly keepFolders?: ReadonlyArray<string>;
  readonly unfinishedForks?: ReadonlyArray<ThreadForkLedgerRow>;
  readonly retryableFailedForks?: ReadonlyArray<ThreadForkLedgerRow>;
  readonly ledgerUnavailable?: boolean;
  /** Receives every dispatched command, also when the sweep fails. */
  readonly commands?: OrchestrationCommand[];
}) => {
  const commands: OrchestrationCommand[] = input.commands ?? [];
  const removedFolders: string[] = [];
  const ledgerError = new PersistenceSqlError({
    operation: "ThreadForkRepository.listUnfinished:query",
    detail: "database is locked",
  });
  const deps: OrphanChatProjectDependencies = {
    projects: { listAll: () => Effect.succeed(input.projects) },
    threads: {
      listByProjectId: ({ projectId }) =>
        Effect.succeed((input.threads ?? []).filter((entry) => entry.projectId === projectId)),
    },
    threadForks: {
      listUnfinished: () =>
        input.ledgerUnavailable
          ? Effect.fail(ledgerError)
          : Effect.succeed(input.unfinishedForks ?? []),
      listRetryableFailed: () => Effect.succeed(input.retryableFailedForks ?? []),
    },
    chatFolders: {
      removeEmptyChatFolder: (folder) =>
        Effect.sync(() => {
          if (input.keepFolders?.includes(folder)) return false;
          removedFolders.push(folder);
          return true;
        }),
    },
    dispatch: (command) =>
      Effect.suspend(() => {
        commands.push(command);
        return command.type === "project.delete" && input.refuse?.includes(command.projectId)
          ? Effect.fail({ message: "thread set changed after the command was authorized" })
          : Effect.succeed({ sequence: commands.length });
      }),
    now: () => NOW,
  };
  return Effect.runPromise(removeOrphanChatProjects(deps)).then((result) => ({
    result,
    commands,
    removedFolders,
  }));
};

describe("removeOrphanChatProjects", () => {
  it("deletes an old chat without any thread, then its empty folder", async () => {
    const { result, commands, removedFolders } = await sweep({ projects: [project("chat-a")] });

    expect(commands).toEqual([
      expect.objectContaining({
        type: "project.delete",
        projectId: "chat-a",
        expectedUpdatedAt: TWO_HOURS_AGO,
        expectedThreadIds: [],
      }),
    ]);
    expect(removedFolders).toEqual(["/chats/chat-a"]);
    expect(result).toEqual({ orphans: 1, deleted: 1, foldersRemoved: 1, skipped: 0 });
  });

  it.each([
    ["a live thread", thread("chat-a")],
    ["an archived thread", thread("chat-a", { archivedAt: TWO_HOURS_AGO })],
    ["a thread in Trash", thread("chat-a", { trashedAt: TWO_HOURS_AGO })],
    ["a deleted but retained thread", thread("chat-a", { deletedAt: TWO_HOURS_AGO })],
    [
      "an unused thread in Trash",
      thread("chat-a", {
        deletedAt: TWO_HOURS_AGO,
        trashedAt: TWO_HOURS_AGO,
        latestUserMessageAt: null,
      }),
    ],
  ] as const)("keeps a chat with %s", async (_label, entry) => {
    const { result, commands } = await sweep({ projects: [project("chat-a")], threads: [entry] });
    expect(commands).toEqual([]);
    expect(result.orphans).toBe(0);
  });

  it("deletes a chat whose only thread is a rolled-back creation", async () => {
    // A first send failed after creating its thread: the thread was deleted unused.
    const rolledBack = thread("chat-a", { deletedAt: TWO_HOURS_AGO, latestUserMessageAt: null });
    const { result, commands } = await sweep({
      projects: [project("chat-a")],
      threads: [rolledBack],
    });
    expect(commands).toEqual([
      expect.objectContaining({
        type: "project.delete",
        projectId: "chat-a",
        expectedThreadIds: [],
      }),
    ]);
    expect(result).toEqual({ orphans: 1, deleted: 1, foldersRemoved: 1, skipped: 0 });
  });

  it.each([
    ["younger than an hour", project("chat-a", { createdAt: "2026-10-08T11:30:00.000Z" })],
    ["a regular project", project("chat-a", { kind: "project" })],
    ["already deleted", project("chat-a", { deletedAt: TWO_HOURS_AGO })],
  ] as const)("keeps a project %s", async (_label, entry) => {
    const { commands, removedFolders } = await sweep({ projects: [entry] });
    expect(commands).toEqual([]);
    expect(removedFolders).toEqual([]);
  });

  it("keeps the folder of a chat whose deletion was refused", async () => {
    const { result, removedFolders } = await sweep({
      projects: [project("chat-a"), project("chat-b")],
      refuse: ["chat-a"],
    });
    expect(removedFolders).toEqual(["/chats/chat-b"]);
    expect(result).toEqual({ orphans: 2, deleted: 1, foldersRemoved: 1, skipped: 1 });
  });

  it.each([
    [
      "an unfinished fork that has not prepared it yet",
      { unfinishedForks: [newChatFork("chat-a")] },
    ],
    [
      "an unfinished fork that already prepared it",
      { unfinishedForks: [newChatFork("chat-a", "prepared")] },
    ],
    [
      "a failed fork a retry would resume",
      { retryableFailedForks: [newChatFork("chat-a", "prepared")] },
    ],
  ] as const)("keeps an old chat without threads held by %s", async (_label, forks) => {
    // A new-chat fork creates its chat before it publishes the fork's thread.
    const { result, commands, removedFolders } = await sweep({
      projects: [project("chat-a"), project("chat-b")],
      ...forks,
    });
    expect(commands).toEqual([
      expect.objectContaining({ type: "project.delete", projectId: "chat-b" }),
    ]);
    expect(removedFolders).toEqual(["/chats/chat-b"]);
    expect(result).toEqual({ orphans: 1, deleted: 1, foldersRemoved: 1, skipped: 0 });
  });

  it("deletes nothing when the fork ledger cannot be read", async () => {
    const commands: OrchestrationCommand[] = [];
    await expect(
      sweep({ projects: [project("chat-a")], ledgerUnavailable: true, commands }),
    ).rejects.toThrow("database is locked");
    expect(commands).toEqual([]);
  });

  it("counts a deleted chat whose folder is kept (not empty, or outside the chats root)", async () => {
    const { result } = await sweep({
      projects: [project("chat-a")],
      keepFolders: ["/chats/chat-a"],
    });
    expect(result).toEqual({ orphans: 1, deleted: 1, foldersRemoved: 0, skipped: 0 });
  });
});
