import { CHAT_FOLDER_DELETE_DELAY_MS } from "@ryco/client-runtime/state/chats";
import { EnvironmentId, ProjectChatError, ProjectId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteChatFolder: vi.fn(),
  addToast: vi.fn(),
  listed: new Set<string>(),
}));
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ projects: { deleteChatFolder: mocks.deleteChatFolder } }),
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.addToast },
  stackedThreadToast: <T>(toast: T) => ({ ...toast, stacked: true }),
}));
vi.mock("../store", () => ({
  useStore: { getState: () => ({}) },
  selectEnvironmentState: () => ({
    threadShellById: Object.fromEntries([...mocks.listed].map((id) => [id, {}])),
  }),
}));

import { scheduleChatFolderDelete } from "./chatFolderDelete";

const target = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("chat-project"),
  folderPath: "/chats/chat-project",
};
const threadId = ThreadId.make("thread-1");

beforeEach(() => {
  vi.useFakeTimers();
  mocks.deleteChatFolder.mockReset();
  mocks.addToast.mockReset();
  mocks.listed.clear();
});
afterEach(() => vi.useRealTimers());

// The schedule itself is the shared `deleteChatFolderAfterPurge`
// (client-runtime/state/chats/chatFolderDelete.test.ts); this covers the web's
// side of it: the store read behind "restored" and the toasts.
describe("scheduleChatFolderDelete", () => {
  it("reports the deleted folder as a toast", async () => {
    mocks.deleteChatFolder.mockResolvedValue({ deleted: true });
    scheduleChatFolderDelete(target, threadId);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS);
    expect(mocks.deleteChatFolder).toHaveBeenCalledExactlyOnceWith({
      projectId: target.projectId,
    });
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: "Chat folder deleted",
      description: target.folderPath,
    });
  });

  it("never deletes the folder of a conversation Undo listed again", async () => {
    mocks.listed.add(threadId);
    scheduleChatFolderDelete(target, threadId);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS * 10);
    expect(mocks.deleteChatFolder).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("says where the files remain when it gives up", async () => {
    mocks.deleteChatFolder.mockRejectedValue(
      new ProjectChatError({ reason: "outside-chats-root", message: "Not a Ryco chat folder." }),
    );
    scheduleChatFolderDelete(target, threadId);
    await vi.advanceTimersByTimeAsync(CHAT_FOLDER_DELETE_DELAY_MS);
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not delete the chat folder",
      description: "Not a Ryco chat folder. The files are still in /chats/chat-project.",
      stacked: true,
    });
  });
});
