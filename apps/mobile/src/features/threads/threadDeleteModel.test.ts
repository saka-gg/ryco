import {
  CHAT_FOLDER_DELETE_ATTEMPTS,
  CHAT_FOLDER_DELETE_DELAY_MS,
  CHAT_FOLDER_DELETE_RETRY_MS,
  type ChatFolderEnvironment,
} from "@ryco/client-runtime/state/chats";
import { EnvironmentId, ProjectChatError, ProjectId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  chatFolderForThreadDelete,
  scheduleChatFolderDelete,
  threadDeleteConfirmation,
} from "./threadDeleteModel";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

function environment(input: {
  readonly kind: "chat" | "project";
  readonly threadIds: ReadonlyArray<string>;
}): ChatFolderEnvironment {
  return {
    threadIds: input.threadIds.map((id) => ThreadId.make(id)),
    threadShellById: Object.fromEntries(input.threadIds.map((id) => [id, { projectId }])),
    projectById: {
      [projectId]: input.kind === "chat" ? { kind: "chat", cwd: "/chats/c1" } : { cwd: "/code/p1" },
    },
  };
}

describe("the thread screen's Delete confirmation", () => {
  it("offers the chat's folder only for the last conversation of a chat", () => {
    const folder = chatFolderForThreadDelete(
      environment({ kind: "chat", threadIds: ["thread-1"] }),
      environmentId,
      threadId,
    );
    expect(folder).toEqual({ environmentId, projectId, folderPath: "/chats/c1" });

    const confirmation = threadDeleteConfirmation("Trip", folder);
    expect(confirmation.title).toBe('Delete "Trip"?');
    expect(confirmation.deleteWithFiles).toEqual({ label: "Delete with files" });
    // Plain Delete is the default and keeps the files; the message says where.
    expect(confirmation.message).toContain("Delete keeps the chat's files in /chats/c1.");

    for (const other of [
      environment({ kind: "chat", threadIds: ["thread-1", "thread-2"] }),
      environment({ kind: "project", threadIds: ["thread-1"] }),
    ]) {
      const none = chatFolderForThreadDelete(other, environmentId, threadId);
      expect(none).toBeNull();
      expect(threadDeleteConfirmation("Trip", none)).toEqual({
        title: 'Delete "Trip"?',
        message: "The chat, its attachments and its terminal history are removed for good.",
        deleteWithFiles: null,
      });
    }
  });
});

describe("Delete with files", () => {
  const target = { environmentId, projectId, folderPath: "/chats/c1" };
  const deleteChatFolder = vi.fn();
  const alert = vi.fn<(title: string, message: string) => void>();
  let listed = false;
  const schedule = () =>
    scheduleChatFolderDelete({
      target,
      threadId,
      readEnvironment: () => environment({ kind: "chat", threadIds: listed ? ["thread-1"] : [] }),
      resolveDeleteChatFolder: () => deleteChatFolder,
      alert,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    deleteChatFolder.mockReset();
    alert.mockReset();
    listed = false;
  });
  afterEach(() => vi.useRealTimers());

  it("deletes the folder after the purge without interrupting anyone", async () => {
    deleteChatFolder.mockResolvedValue({ deleted: true });
    schedule();
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS - 1);
    expect(deleteChatFolder).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteChatFolder).toHaveBeenCalledExactlyOnceWith({ projectId });
    expect(alert).not.toHaveBeenCalled();
  });

  it("leaves the folder of a conversation that was restored", async () => {
    listed = true;
    schedule();
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(deleteChatFolder).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("retries an unsettled purge, then says where the files remain", async () => {
    deleteChatFolder.mockRejectedValue(
      new ProjectChatError({ reason: "has-threads", message: "Delete its conversations first." }),
    );
    schedule();
    await vi.advanceTimersByTimeAsync(
      CHAT_FOLDER_DELETE_DELAY_MS + CHAT_FOLDER_DELETE_RETRY_MS * CHAT_FOLDER_DELETE_ATTEMPTS,
    );
    expect(deleteChatFolder).toHaveBeenCalledTimes(CHAT_FOLDER_DELETE_ATTEMPTS);
    expect(alert).toHaveBeenCalledExactlyOnceWith(
      "Could not delete the chat folder",
      "Delete its conversations first. The files are still in /chats/c1.",
    );
  });
});
