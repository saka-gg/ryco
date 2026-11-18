import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const scheduled = vi.hoisted(() => vi.fn());
vi.mock("../lib/chatFolderDelete", () => ({ deleteChatFolderAfterPurge: scheduled }));

import { confirmChatDelete } from "./ChatDeleteDialog";

const folder = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("chat-project"),
  folderPath: "/chats/chat-project",
};

function open() {
  return confirmChatDelete({
    message: 'Delete "Trip"? You can undo for a few seconds.',
    threadId: ThreadId.make("thread-1"),
    folder,
  });
}

describe("confirmChatDelete", () => {
  afterEach(() => {
    scheduled.mockReset();
    document.body.innerHTML = "";
  });

  it("keeps the chat's files unless the reader opts in", async () => {
    const choice = open();
    const checkbox = page.getByRole("checkbox", { name: /Also delete files/ });
    await expect.element(checkbox).not.toBeChecked();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    const result = await choice;
    expect(result).toEqual({});
    expect(scheduled).not.toHaveBeenCalled();
  });

  it("schedules the folder only once the delete was accepted", async () => {
    const choice = open();
    await page.getByRole("checkbox", { name: /Also delete files/ }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    const result = await choice;
    // Choosing it schedules nothing yet: deleteThread runs onDeleted after the node accepts.
    expect(scheduled).not.toHaveBeenCalled();
    result?.onDeleted?.();
    expect(scheduled).toHaveBeenCalledExactlyOnceWith(folder, expect.any(Function));
  });

  it("resolves null when dismissed", async () => {
    const choice = open();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(choice).resolves.toBeNull();
    expect(scheduled).not.toHaveBeenCalled();
  });
});
