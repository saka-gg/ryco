import { EnvironmentId, ProjectChatError, ProjectId, ThreadId } from "@ryco/contracts";
import { THREAD_DELETE_GRACE_MS } from "@ryco/shared/workspaceLifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHAT_FOLDER_DELETE_ATTEMPTS,
  CHAT_FOLDER_DELETE_DELAY_MS,
  CHAT_FOLDER_DELETE_RETRY_MS,
  deleteChatFolderAfterPurge,
  describeChatFolderDeleteOutcome,
  type ChatFolderDeleteOutcome,
} from "./chatFolderDelete.ts";
import {
  chatFolderFreedByDelete,
  isDeletedThreadListed,
  type ChatFolderEnvironment,
} from "./chatFolder.ts";

const environmentId = EnvironmentId.make("env");
const target = {
  environmentId,
  projectId: ProjectId.make("chat-project"),
  folderPath: "/chats/chat-project",
};
const hasThreads = () =>
  new ProjectChatError({ reason: "has-threads", message: "Delete its conversations first." });

describe("chatFolderFreedByDelete", () => {
  const ref = { environmentId, threadId: ThreadId.make("thread-1") };
  const environment = (input: {
    readonly kind: "chat" | "project";
    readonly threads: ReadonlyArray<readonly [string, string]>;
  }): ChatFolderEnvironment => ({
    threadIds: input.threads.map(([threadId]) => ThreadId.make(threadId)),
    threadShellById: Object.fromEntries(
      input.threads.map(([threadId, projectId]) => [
        threadId,
        { projectId: ProjectId.make(projectId) },
      ]),
    ),
    projectById: {
      "project-1": input.kind === "chat" ? { kind: "chat", cwd: "/chats/c1" } : { cwd: "/code/p1" },
    },
  });

  it("frees the folder of a chat whose last conversation is deleted", () => {
    expect(
      chatFolderFreedByDelete(
        environment({ kind: "chat", threads: [["thread-1", "project-1"]] }),
        ref,
      ),
    ).toEqual({ environmentId, projectId: "project-1", folderPath: "/chats/c1" });
  });

  it("frees nothing while another conversation, archived included, belongs to the chat", () => {
    expect(
      chatFolderFreedByDelete(
        environment({
          kind: "chat",
          threads: [
            ["thread-1", "project-1"],
            ["thread-2", "project-1"],
          ],
        }),
        ref,
      ),
    ).toBeNull();
  });

  it("frees nothing for a project's conversation or an unknown one", () => {
    expect(
      chatFolderFreedByDelete(
        environment({ kind: "project", threads: [["thread-1", "project-1"]] }),
        ref,
      ),
    ).toBeNull();
    expect(chatFolderFreedByDelete(environment({ kind: "chat", threads: [] }), ref)).toBeNull();
  });

  it("reads a conversation listed again as restored", () => {
    const listed = environment({ kind: "chat", threads: [["thread-1", "project-1"]] });
    expect(isDeletedThreadListed(listed, ref.threadId)).toBe(true);
    expect(isDeletedThreadListed(environment({ kind: "chat", threads: [] }), ref.threadId)).toBe(
      false,
    );
  });
});

describe("deleteChatFolderAfterPurge", () => {
  const deleteChatFolder = vi.fn();
  const report = vi.fn<(outcome: ChatFolderDeleteOutcome) => void>();
  const schedule = (isRestored: () => boolean, available = true) =>
    deleteChatFolderAfterPurge({
      target,
      isRestored,
      resolveDeleteChatFolder: () => (available ? deleteChatFolder : null),
      report,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    deleteChatFolder.mockReset();
    report.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("asks the node only after the conversation can no longer be restored", async () => {
    deleteChatFolder.mockResolvedValue({ deleted: true });
    schedule(() => false);

    expect(CHAT_FOLDER_DELETE_DELAY_MS).toBeGreaterThan(THREAD_DELETE_GRACE_MS);
    await vi.advanceTimersByTimeAsync(THREAD_DELETE_GRACE_MS);
    expect(deleteChatFolder).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS - THREAD_DELETE_GRACE_MS);
    expect(deleteChatFolder).toHaveBeenCalledExactlyOnceWith({ projectId: target.projectId });
    expect(report).toHaveBeenCalledExactlyOnceWith({ kind: "deleted" });
  });

  it("reports a folder that was already gone", async () => {
    deleteChatFolder.mockResolvedValue({ deleted: false });
    schedule(() => false);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS);
    expect(report).toHaveBeenCalledExactlyOnceWith({ kind: "already-gone" });
  });

  it("never deletes the folder of a conversation that was restored", async () => {
    schedule(() => true);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(deleteChatFolder).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("retries while the node has not purged the conversation yet", async () => {
    deleteChatFolder.mockRejectedValueOnce(hasThreads());
    deleteChatFolder.mockRejectedValueOnce(
      new ProjectChatError({ reason: "busy", message: "A session still runs." }),
    );
    deleteChatFolder.mockResolvedValueOnce({ deleted: true });
    schedule(() => false);

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS);
    expect(deleteChatFolder).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_RETRY_MS);
    expect(deleteChatFolder).toHaveBeenCalledTimes(2);
    expect(report).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_RETRY_MS);
    expect(deleteChatFolder).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledExactlyOnceWith({ kind: "deleted" });
  });

  it("stops quietly when the conversation is restored between attempts", async () => {
    let restored = false;
    deleteChatFolder.mockImplementation(() => {
      restored = true;
      return Promise.reject(hasThreads());
    });
    schedule(() => restored);

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(deleteChatFolder).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports a refusal that outlasts the retries", async () => {
    deleteChatFolder.mockRejectedValue(hasThreads());
    schedule(() => false);

    await vi.advanceTimersByTimeAsync(
      CHAT_FOLDER_DELETE_DELAY_MS + CHAT_FOLDER_DELETE_RETRY_MS * CHAT_FOLDER_DELETE_ATTEMPTS,
    );
    expect(deleteChatFolder).toHaveBeenCalledTimes(CHAT_FOLDER_DELETE_ATTEMPTS);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      kind: "failed",
      reason: "Delete its conversations first.",
    });
  });

  it("does not retry a refusal waiting cannot change", async () => {
    deleteChatFolder.mockRejectedValue(
      new ProjectChatError({ reason: "outside-chats-root", message: "Not a Ryco chat folder." }),
    );
    schedule(() => false);

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(deleteChatFolder).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      kind: "failed",
      reason: "Not a Ryco chat folder.",
    });
  });

  it("reports a device that cannot ask the node", async () => {
    schedule(() => false, false);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      kind: "failed",
      reason: "This device cannot delete chat folders.",
    });
  });
});

describe("describeChatFolderDeleteOutcome", () => {
  it("says where the files remain when it gives up", () => {
    expect(
      describeChatFolderDeleteOutcome(target, { kind: "failed", reason: "The request failed." }),
    ).toEqual({
      tone: "error",
      title: "Could not delete the chat folder",
      description: "The request failed. The files are still in /chats/chat-project.",
    });
    expect(describeChatFolderDeleteOutcome(target, { kind: "deleted" })).toMatchObject({
      tone: "success",
      description: target.folderPath,
    });
  });
});
