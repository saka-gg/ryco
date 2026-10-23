import type { ConfirmDialogRequest } from "../../components/ConfirmDialogHost";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${Math.random().toString(16).slice(2)}` }));
const dialogs = vi.hoisted(() => ({ requests: [] as ConfirmDialogRequest[] }));
vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: (request: ConfirmDialogRequest) => dialogs.requests.push(request),
}));

import { readCheckpointRevertPhase } from "@ryco/client-runtime/state/session";

import {
  chooseCheckpointRevertMode,
  holdReturnedSentMessage,
  loadSentMessageDrafts,
  runEditFromHere,
  subscribeReturnedSentMessages,
  takeReturnedSentMessages,
} from "./editFromHere";

const message = {
  text: "Ultrathink:\nSplit the auth module",
  attachments: [
    {
      type: "image" as const,
      id: "image-1",
      name: "sketch.png",
      mimeType: "image/png",
      sizeBytes: 3,
    },
    {
      type: "file" as const,
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    },
  ],
};

describe("chooseCheckpointRevertMode", () => {
  it("offers keeping the files, restoring them, or cancelling", async () => {
    dialogs.requests.length = 0;
    const keep = chooseCheckpointRevertMode({ keepFilesAvailable: true });
    const request = dialogs.requests[0]!;
    expect(request).toMatchObject({
      title: "Edit from here?",
      confirmText: "Revert and keep changes",
      alternative: { text: "Revert files too", destructive: true },
    });
    request.onConfirm();
    await expect(keep).resolves.toBe("keep-files");

    const restore = chooseCheckpointRevertMode({ keepFilesAvailable: true });
    dialogs.requests[1]!.alternative!.onPress();
    await expect(restore).resolves.toBe("restore-files");

    const cancelled = chooseCheckpointRevertMode({ keepFilesAvailable: true });
    dialogs.requests[2]!.onCancel!();
    await expect(cancelled).resolves.toBeNull();
  });

  it("offers only the file restore on a node without conversation-only reverts", async () => {
    dialogs.requests.length = 0;
    const restore = chooseCheckpointRevertMode({ keepFilesAvailable: false });
    const request = dialogs.requests[0]!;
    expect(request).toMatchObject({ confirmText: "Revert files", destructive: true });
    expect(request.alternative).toBeUndefined();
    request.onConfirm();
    await expect(restore).resolves.toBe("restore-files");
  });

  it("says when restoring would also discard changes an earlier revert kept", () => {
    dialogs.requests.length = 0;
    void chooseCheckpointRevertMode({ keepFilesAvailable: true, keptChangesTurnCount: 2 });
    expect(dialogs.requests[0]!.message).toContain(
      "Restoring the files also discards the changes kept when this thread was reverted to checkpoint 2.",
    );
    dialogs.requests[0]!.onCancel!();
  });
});

describe("loadSentMessageDrafts", () => {
  it("turns the sent attachments back into composer drafts", async () => {
    const writeFile = vi.fn(async (name: string) => `file:///cache/${name}`);
    const returned = await loadSentMessageDrafts({
      message: message as never,
      composerAttachments: [],
      fileUploadsSupported: true,
      readBytes: async () => new Uint8Array([97, 98, 99]),
      writeFile,
    });

    // As sent: the prefix is what selects ultrathink again.
    expect(returned.prompt).toBe("Ultrathink:\nSplit the auth module");
    expect(returned.attachments).toMatchObject([
      {
        type: "image",
        name: "sketch.png",
        dataUrl: "data:image/png;base64,YWJj",
        previewUri: "data:image/png;base64,YWJj",
        sizeBytes: 3,
      },
      { type: "file", name: "notes.txt", readUri: "file:///cache/notes.txt", sizeBytes: 3 },
    ]);
    expect(writeFile).toHaveBeenCalledWith("notes.txt", new Uint8Array([97, 98, 99]));
  });

  it("refuses before reverting when the attachments cannot come back", async () => {
    const readBytes = vi.fn(async () => new Uint8Array(3));
    await expect(
      loadSentMessageDrafts({
        message: message as never,
        composerAttachments: [],
        fileUploadsSupported: false,
        readBytes,
      }),
    ).rejects.toThrow("can't attach this message's files");
    await expect(
      loadSentMessageDrafts({
        message: message as never,
        composerAttachments: Array.from({ length: 7 }, () => ({ sizeBytes: 1 })),
        fileUploadsSupported: true,
        readBytes,
      }),
    ).rejects.toThrow("Remove some attachments from the composer first");
    expect(readBytes).not.toHaveBeenCalled();

    await expect(
      loadSentMessageDrafts({
        message: message as never,
        composerAttachments: [],
        fileUploadsSupported: true,
        readBytes: async () => {
          throw new Error("Attachment connection unavailable.");
        },
      }),
    ).rejects.toThrow("Couldn't load this message's attachments, so nothing was reverted.");
  });
});

describe("runEditFromHere", () => {
  const threadKey = "environment-1:thread-1";

  function harness() {
    const commands: Array<{ type: string; commandId: string; turnCount: number }> = [];
    let thread: {
      latestTurn: { turnId: string } | null;
      activities: unknown[];
      messages: Array<{ turnId: string | null }>;
      turnDiffSummaries: Array<{ turnId: string }>;
    } = {
      latestTurn: { turnId: "turn-1" },
      activities: [] as unknown[],
      messages: [{ turnId: null }, { turnId: "turn-1" }],
      turnDiffSummaries: [{ turnId: "turn-1" }],
    };
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    return {
      commands,
      /** The node's journal row for the revert, and the rewind once it completed. */
      settle(status: string, detail?: string) {
        const commandId = commands[0]!.commandId;
        thread = {
          ...thread,
          ...(status === "completed"
            ? { latestTurn: null, messages: [], turnDiffSummaries: [] }
            : {}),
          activities: [
            {
              id: `checkpoint-revert:${commandId}`,
              kind: "checkpoint.revert",
              tone: "info",
              summary: `Revert ${status}`,
              payload: {
                schemaVersion: 1,
                revertRequestId: commandId,
                turnCount: 0,
                status,
                ...(detail ? { detail } : {}),
              },
              turnId: null,
              createdAt: "2026-10-22T10:00:00.000Z",
            },
          ],
        };
        notify();
      },
      input: {
        api: {
          orchestration: {
            dispatchCommand: async (command: never) => {
              commands.push(command);
              return { sequence: 1 };
            },
          },
          attachments: {
            readChunk: async (chunk: { offset: number }) => ({
              dataBase64: "YWJj",
              offset: chunk.offset,
              totalBytes: 3,
            }),
          },
        } as never,
        environmentId: "environment-1" as never,
        threadId: "thread-1" as never,
        threadKey,
        message: { id: "message-1", text: "Split it", attachments: [] } as never,
        turnCount: 0,
        environmentUnavailable: false,
        turnInProgress: false,
        providerRefusal: null,
        keepFilesAvailable: true,
        keptChangesTurnCount: null,
        composerAttachments: [],
        fileUploadsSupported: true,
        readThread: () => thread as never,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
  }

  it("keeps the files and holds the prompt for the composer once the node rewound the thread", async () => {
    dialogs.requests.length = 0;
    takeReturnedSentMessages(threadKey);
    const node = harness();
    const run = runEditFromHere(node.input);
    await vi.waitFor(() => expect(dialogs.requests).toHaveLength(1));
    dialogs.requests[0]!.onConfirm();
    await vi.waitFor(() => expect(node.commands).toHaveLength(1));
    expect(node.commands[0]).toMatchObject({ type: "thread.conversation.revert", turnCount: 0 });
    expect(readCheckpointRevertPhase(threadKey)).toBe("reverting");

    node.settle("completed", "The removed turns' changes stay in src/app.ts.");
    await expect(run).resolves.toEqual({
      kind: "returned",
      notice: {
        tone: "info",
        title: "Revert completed",
        detail: "The removed turns' changes stay in src/app.ts.",
      },
      error: null,
    });
    expect(readCheckpointRevertPhase(threadKey)).toBeNull();
    // Held until the thread's screen takes it, even when that screen closed meanwhile.
    expect(takeReturnedSentMessages(threadKey)).toEqual([{ prompt: "Split it", attachments: [] }]);
    expect(takeReturnedSentMessages(threadKey)).toEqual([]);
  });

  it("says why when the node refuses, and refuses early without asking", async () => {
    dialogs.requests.length = 0;
    const node = harness();
    const run = runEditFromHere(node.input);
    await vi.waitFor(() => expect(dialogs.requests).toHaveLength(1));
    dialogs.requests[0]!.alternative!.onPress();
    await vi.waitFor(() => expect(node.commands).toHaveLength(1));
    expect(node.commands[0]).toMatchObject({ type: "thread.checkpoint.revert" });
    node.settle("failed", 'Nothing was changed. "Neighbour" is working in this checkout.');
    await expect(run).resolves.toEqual({
      kind: "stopped",
      error: 'Nothing was changed. "Neighbour" is working in this checkout.',
    });
    expect(takeReturnedSentMessages(threadKey)).toEqual([]);

    dialogs.requests.length = 0;
    await expect(
      runEditFromHere({ ...harness().input, providerRefusal: "Cursor can't remove turns." }),
    ).resolves.toEqual({ kind: "stopped", error: "Cursor can't remove turns." });
    expect(dialogs.requests).toHaveLength(0);
  });
});

describe("held returned messages", () => {
  it("tells listeners, and hands each one over once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReturnedSentMessages(listener);
    holdReturnedSentMessage("environment-1:thread-held", { prompt: "First", attachments: [] });
    holdReturnedSentMessage("environment-1:thread-held", { prompt: "Second", attachments: [] });
    unsubscribe();
    holdReturnedSentMessage("environment-1:thread-other", { prompt: "Other", attachments: [] });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      takeReturnedSentMessages("environment-1:thread-held").map((entry) => entry.prompt),
    ).toEqual(["First", "Second"]);
    expect(takeReturnedSentMessages("environment-1:thread-held")).toEqual([]);
    expect(takeReturnedSentMessages("environment-1:thread-other")).toHaveLength(1);
  });
});
