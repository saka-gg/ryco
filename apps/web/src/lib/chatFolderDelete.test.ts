import { EnvironmentId, ProjectChatError, ProjectId } from "@ryco/contracts";
import { THREAD_DELETE_GRACE_MS } from "@ryco/shared/workspaceLifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteChatFolder: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ projects: { deleteChatFolder: mocks.deleteChatFolder } }),
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.addToast },
  stackedThreadToast: <T>(toast: T) => toast,
}));

import {
  CHAT_FOLDER_DELETE_ATTEMPTS,
  CHAT_FOLDER_DELETE_DELAY_MS,
  CHAT_FOLDER_DELETE_RETRY_MS,
  deleteChatFolderAfterPurge,
} from "./chatFolderDelete";

const target = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("chat-project"),
  folderPath: "/chats/chat-project",
};
const hasThreads = () =>
  new ProjectChatError({ reason: "has-threads", message: "Delete its conversations first." });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.deleteChatFolder.mockReset();
  mocks.addToast.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("deleteChatFolderAfterPurge", () => {
  it("asks the node only after the conversation can no longer be restored", async () => {
    mocks.deleteChatFolder.mockResolvedValue({ deleted: true });
    deleteChatFolderAfterPurge(target, () => false);

    expect(CHAT_FOLDER_DELETE_DELAY_MS).toBeGreaterThan(THREAD_DELETE_GRACE_MS);
    await vi.advanceTimersByTimeAsync(THREAD_DELETE_GRACE_MS);
    expect(mocks.deleteChatFolder).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS - THREAD_DELETE_GRACE_MS);
    expect(mocks.deleteChatFolder).toHaveBeenCalledExactlyOnceWith({
      projectId: target.projectId,
    });
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "success", title: "Chat folder deleted" }),
    );
  });

  it("never deletes the folder of a conversation Undo restored", async () => {
    deleteChatFolderAfterPurge(target, () => true);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(mocks.deleteChatFolder).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("retries while the node has not purged the conversation yet", async () => {
    mocks.deleteChatFolder.mockRejectedValueOnce(hasThreads());
    mocks.deleteChatFolder.mockResolvedValueOnce({ deleted: true });
    deleteChatFolderAfterPurge(target, () => false);

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS);
    expect(mocks.deleteChatFolder).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_RETRY_MS);
    expect(mocks.deleteChatFolder).toHaveBeenCalledTimes(2);
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("stops quietly when the conversation is restored between attempts", async () => {
    let restored = false;
    mocks.deleteChatFolder.mockImplementation(() => {
      restored = true;
      return Promise.reject(hasThreads());
    });
    deleteChatFolderAfterPurge(target, () => restored);

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(mocks.deleteChatFolder).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("reports a refusal that outlasts the retries, keeping the files", async () => {
    mocks.deleteChatFolder.mockRejectedValue(hasThreads());
    deleteChatFolderAfterPurge(target, () => false);

    await vi.advanceTimersByTimeAsync(
      CHAT_FOLDER_DELETE_DELAY_MS + CHAT_FOLDER_DELETE_RETRY_MS * CHAT_FOLDER_DELETE_ATTEMPTS,
    );
    expect(mocks.deleteChatFolder).toHaveBeenCalledTimes(CHAT_FOLDER_DELETE_ATTEMPTS);
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "error",
        description: expect.stringContaining(target.folderPath),
      }),
    );
  });

  it("does not retry a refusal waiting cannot change", async () => {
    mocks.deleteChatFolder.mockRejectedValue(
      new ProjectChatError({ reason: "outside-chats-root", message: "Not a Ryco chat folder." }),
    );
    deleteChatFolderAfterPurge(target, () => false);

    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(mocks.deleteChatFolder).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "error" }),
    );
  });
});
