import type { ConfirmDialogRequest } from "../../components/ConfirmDialogHost";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${Math.random().toString(16).slice(2)}` }));
const dialogs = vi.hoisted(() => ({ requests: [] as ConfirmDialogRequest[] }));
vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: (request: ConfirmDialogRequest) => dialogs.requests.push(request),
}));

import {
  EnvironmentId,
  EventId,
  ThreadId,
  TurnId,
  type ClientOrchestrationCommand,
  type EnvironmentApi,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import type { CheckpointRevertThreadView } from "@ryco/client-runtime/state/session";

import { chooseUndoFileChangesMode, runUndoFileChanges } from "./undoFileChanges";

describe("chooseUndoFileChangesMode", () => {
  it("undoes only the files, reverts the thread too, or cancels", async () => {
    dialogs.requests.length = 0;
    const keepChat = chooseUndoFileChangesMode({ revertThreadAvailable: true });
    const request = dialogs.requests[0]!;
    expect(request).toMatchObject({
      title: "Undo file changes?",
      confirmText: "Undo file changes",
      destructive: true,
      alternative: { text: "Revert thread too", destructive: true },
    });
    expect(request.message).toContain("The chat stays as it is.");
    expect(request.message).toContain(
      "Uncommitted edits made since then, including your own, are replaced.",
    );
    request.onConfirm();
    await expect(keepChat).resolves.toBe("keep-chat");

    const revertThread = chooseUndoFileChangesMode({ revertThreadAvailable: true });
    dialogs.requests[1]!.alternative!.onPress();
    await expect(revertThread).resolves.toBe("restore-files");

    const cancelled = chooseUndoFileChangesMode({ revertThreadAvailable: true });
    dialogs.requests[2]!.onCancel!();
    await expect(cancelled).resolves.toBeNull();
  });

  it("offers only the files when the agent cannot forget turns", () => {
    dialogs.requests.length = 0;
    void chooseUndoFileChangesMode({ revertThreadAvailable: false, keptChangesTurnCount: 2 });
    const request = dialogs.requests[0]!;
    expect(request.alternative).toBeUndefined();
    expect(request.message).not.toContain("Revert thread too");
    expect(request.message).toContain("reverted to checkpoint 2");
    request.onCancel!();
  });
});

describe("runUndoFileChanges", () => {
  const environmentId = EnvironmentId.make("environment-undo");
  const threadId = ThreadId.make("thread-undo");

  function node() {
    let thread: CheckpointRevertThreadView = {
      latestTurn: { turnId: TurnId.make("turn-2") },
      activities: [],
      messages: [],
      turnDiffSummaries: [],
    };
    const listeners = new Set<() => void>();
    const commands: ClientOrchestrationCommand[] = [];
    const finish = (status: string, detail: string): OrchestrationThreadActivity => ({
      id: EventId.make(`checkpoint-revert:${commands[0]!.commandId}`),
      tone: status === "completed" ? "info" : "error",
      kind: "checkpoint.revert",
      summary:
        status === "completed" ? "Restored files from checkpoint 1" : "Files were not restored",
      payload: {
        schemaVersion: 1,
        revertRequestId: commands[0]!.commandId,
        turnCount: 1,
        status,
        detail,
        rollbackConversation: false,
      },
      turnId: null,
      createdAt: "2026-10-28T00:00:00.000Z",
    });
    let answer: { readonly status: string; readonly detail: string } = {
      status: "completed",
      detail: "The chat was kept as it is.",
    };
    const api = {
      orchestration: {
        dispatchCommand: async (command: ClientOrchestrationCommand) => {
          commands.push(command);
          thread = { ...thread, activities: [finish(answer.status, answer.detail)] };
          for (const listener of listeners) listener();
          return undefined;
        },
      },
    } as unknown as EnvironmentApi;
    return {
      api,
      commands,
      answer: (next: typeof answer) => {
        answer = next;
      },
      readThread: () => thread,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  const run = (
    target: ReturnType<typeof node>,
    overrides: Partial<Parameters<typeof runUndoFileChanges>[0]> = {},
  ) =>
    runUndoFileChanges({
      api: target.api,
      environmentId,
      threadId,
      turnCount: 1,
      environmentUnavailable: false,
      turnInProgress: false,
      providerRefusal: null,
      keptChangesTurnCount: null,
      readThread: target.readThread,
      subscribe: target.subscribe,
      ...overrides,
    });

  it("sends the files-only undo, even for an agent that cannot forget turns", async () => {
    dialogs.requests.length = 0;
    const target = node();
    const result = run(target, { providerRefusal: "Cursor can't remove turns." });
    await vi.waitFor(() => expect(dialogs.requests).toHaveLength(1));
    dialogs.requests[0]!.onConfirm();

    await expect(result).resolves.toEqual({
      error: null,
      notice: {
        tone: "info",
        title: "Restored files from checkpoint 1",
        detail: "The chat was kept as it is.",
      },
    });
    expect(target.commands[0]).toMatchObject({ type: "thread.files.revert", turnCount: 1 });
  });

  it("says why the node did not restore the files", async () => {
    dialogs.requests.length = 0;
    const target = node();
    target.answer({
      status: "failed",
      detail: "Files were not restored: disk full. Nothing was changed.",
    });
    const result = run(target);
    await vi.waitFor(() => expect(dialogs.requests).toHaveLength(1));
    dialogs.requests[0]!.onConfirm();

    await expect(result).resolves.toEqual({
      error: "Files were not restored: disk full. Nothing was changed.",
      notice: null,
    });
  });

  it("refuses before asking while a turn runs", async () => {
    dialogs.requests.length = 0;
    const target = node();
    await expect(run(target, { turnInProgress: true })).resolves.toEqual({
      error: "Interrupt the current turn before reverting checkpoints.",
      notice: null,
    });
    expect(dialogs.requests).toHaveLength(0);
    expect(target.commands).toHaveLength(0);
  });
});
