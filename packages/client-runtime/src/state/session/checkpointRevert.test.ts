import {
  CommandId,
  EnvironmentId,
  EventId,
  ThreadId,
  TurnId,
  type ClientOrchestrationCommand,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RpcRequestRefusedError } from "../../rpc/protocol.ts";
import {
  checkpointRevertCommand,
  readCheckpointRevertPhase,
  revertCheckpointGuardFailureMessage,
  revertKeptChangesDiscardedBy,
  runCheckpointRevert,
  subscribeCheckpointReverts,
  waitForCheckpointRevertOutcome,
  type CheckpointRevertThreadView,
} from "./checkpointRevert.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_KEY = `${ENVIRONMENT_ID}:${THREAD_ID}`;
const COMMAND_ID = CommandId.make("cmd-revert");
const TURN_1 = TurnId.make("turn-1");
const TURN_2 = TurnId.make("turn-2");

function revertRow(
  status: string,
  options: {
    readonly detail?: string;
    readonly commandId?: string;
    readonly turnCount?: number;
    readonly restoreFiles?: false;
    readonly createdAt?: string;
  } = {},
): OrchestrationThreadActivity {
  const commandId = options.commandId ?? COMMAND_ID;
  return {
    id: EventId.make(`checkpoint-revert:${commandId}`),
    tone: status === "failed" ? "error" : "info",
    kind: "checkpoint.revert",
    summary: `Revert ${status}`,
    payload: {
      schemaVersion: 1,
      revertRequestId: commandId,
      turnCount: options.turnCount ?? 1,
      status,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.restoreFiles === false ? { restoreFiles: false } : {}),
    },
    turnId: null,
    createdAt: options.createdAt ?? "2026-10-22T00:00:00.000Z",
  };
}

/** What nodes before the revert journal appended on failure. */
function legacyFailureRow(id: string, turnCount: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "error",
    kind: "checkpoint.revert.failed",
    summary: "Checkpoint revert failed",
    payload: { turnCount, detail: "No active provider session is bound to this thread." },
    turnId: null,
    createdAt: "2026-10-22T00:00:01.000Z",
  };
}

/** Two turns; the thread's latest turn is the second. */
function threadStore() {
  let thread: CheckpointRevertThreadView = {
    latestTurn: { turnId: TURN_2 },
    activities: [],
    messages: [{ turnId: null }, { turnId: TURN_1 }, { turnId: null }, { turnId: TURN_2 }],
    turnDiffSummaries: [{ turnId: TURN_1 }, { turnId: TURN_2 }],
  };
  const listeners = new Set<() => void>();
  return {
    readThread: () => thread,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(next: Partial<CheckpointRevertThreadView>) {
      thread = { ...thread, ...next };
      for (const listener of listeners) listener();
    },
    /** What `thread.reverted` to checkpoint 1 leaves. */
    rewind(activities: ReadonlyArray<OrchestrationThreadActivity> = thread.activities) {
      this.update({
        latestTurn: { turnId: TURN_1 },
        messages: thread.messages.slice(0, 2),
        turnDiffSummaries: thread.turnDiffSummaries.slice(0, 1),
        activities,
      });
    },
    listenerCount: () => listeners.size,
  };
}

function revertInput(
  store: ReturnType<typeof threadStore>,
  overrides: Partial<Parameters<typeof runCheckpointRevert<string>>[0]> = {},
) {
  const dispatchCommand = vi.fn(async (_command: ClientOrchestrationCommand) => undefined);
  return {
    dispatchCommand,
    input: {
      environmentId: ENVIRONMENT_ID,
      dispatchCommand,
      threadId: THREAD_ID,
      turnCount: 1,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: false,
      providerRefusal: null,
      choose: async () => "keep-files" as const,
      prepare: async () => "prepared",
      newCommandId: () => COMMAND_ID,
      now: () => "2026-10-22T00:00:00.000Z",
      readThread: store.readThread,
      subscribe: store.subscribe,
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkpointRevertCommand", () => {
  it("sends a command of its own when the files are kept", () => {
    const base = {
      commandId: COMMAND_ID,
      threadId: THREAD_ID,
      turnCount: 1,
      createdAt: "2026-10-22T00:00:00.000Z",
    };
    expect(checkpointRevertCommand({ ...base, mode: "keep-files" })).toEqual({
      ...base,
      type: "thread.conversation.revert",
    });
    expect(checkpointRevertCommand({ ...base, mode: "restore-files" })).toEqual({
      ...base,
      type: "thread.checkpoint.revert",
    });
  });
});

describe("revertCheckpointGuardFailureMessage", () => {
  it("maps guard failures to user-facing errors", () => {
    expect(revertCheckpointGuardFailureMessage({ type: "user-cancelled" })).toBeNull();
    expect(revertCheckpointGuardFailureMessage({ type: "missing-api" })).toBeNull();
    expect(revertCheckpointGuardFailureMessage({ type: "already-reverting" })).toBeNull();
    expect(revertCheckpointGuardFailureMessage({ type: "turn-in-progress" })).toBe(
      "Interrupt the current turn before reverting checkpoints.",
    );
    expect(
      revertCheckpointGuardFailureMessage({ type: "environment-unavailable", label: "Office Mac" }),
    ).toBe("Reconnect Office Mac before reverting checkpoints.");
    expect(
      revertCheckpointGuardFailureMessage({
        type: "provider-unsupported",
        message: "Cursor can't remove turns.",
      }),
    ).toBe("Cursor can't remove turns.");
  });
});

describe("runCheckpointRevert", () => {
  const phase = () => readCheckpointRevertPhase(THREAD_KEY);

  it("asks, prepares, sends, and returns what was prepared once the node rewound", async () => {
    const store = threadStore();
    const order: string[] = [];
    const { input, dispatchCommand } = revertInput(store, {
      choose: async () => {
        order.push(`choose:${phase()}`);
        return "keep-files";
      },
      prepare: async (mode) => {
        order.push(`prepare:${mode}:${phase()}`);
        return "prepared";
      },
    });
    dispatchCommand.mockImplementation(async () => {
      order.push("dispatch");
      store.update({ activities: [revertRow("requested", { restoreFiles: false })] });
      return undefined;
    });

    const phaseChanges = vi.fn();
    const unsubscribe = subscribeCheckpointReverts(phaseChanges);
    const run = runCheckpointRevert(input);
    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalled());
    expect(phase()).toBe("reverting");
    // The rewind lands before the journal's last phase, which names the kept files.
    store.rewind([revertRow("restoring-files", { restoreFiles: false })]);
    expect(phase()).toBe("reverting");
    store.update({
      activities: [
        revertRow("completed", {
          restoreFiles: false,
          detail: "The removed turns' changes stay in src/app.ts.",
        }),
      ],
    });

    await expect(run).resolves.toEqual({
      kind: "reverted",
      mode: "keep-files",
      prepared: "prepared",
      notice: {
        tone: "info",
        title: "Revert completed",
        detail: "The removed turns' changes stay in src/app.ts.",
      },
    });
    expect(order).toEqual(["choose:choosing", "prepare:keep-files:reverting", "dispatch"]);
    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.conversation.revert",
      commandId: COMMAND_ID,
      threadId: THREAD_ID,
      turnCount: 1,
      createdAt: "2026-10-22T00:00:00.000Z",
    });
    expect(phase()).toBeNull();
    // Choosing, reverting, done.
    expect(phaseChanges).toHaveBeenCalledTimes(3);
    unsubscribe();
    expect(store.listenerCount()).toBe(0);
  });

  it("reverts nothing when the user cancels or preparing fails", async () => {
    const cancelled = revertInput(threadStore(), { choose: async () => null });
    await expect(runCheckpointRevert(cancelled.input)).resolves.toEqual({
      kind: "refused",
      reason: { type: "user-cancelled" },
    });
    expect(cancelled.dispatchCommand).not.toHaveBeenCalled();
    expect(phase()).toBeNull();

    const failing = revertInput(threadStore(), {
      prepare: async () => {
        throw new Error("Couldn't load the attachments.");
      },
    });
    await expect(runCheckpointRevert(failing.input)).resolves.toEqual({
      kind: "not-reverted",
      error: "Couldn't load the attachments.",
    });
    expect(failing.dispatchCommand).not.toHaveBeenCalled();
    expect(phase()).toBeNull();
  });

  it("refuses before asking when a turn runs, the machine is away, or the provider cannot forget turns", async () => {
    const choose = vi.fn(async () => "keep-files" as const);
    const run = (overrides: Parameters<typeof revertInput>[1]) =>
      runCheckpointRevert(revertInput(threadStore(), { choose, ...overrides }).input);
    await expect(run({ turnInProgress: true })).resolves.toEqual({
      kind: "refused",
      reason: { type: "turn-in-progress" },
    });
    await expect(
      run({ environmentUnavailable: true, environmentUnavailableLabel: "Office Mac" }),
    ).resolves.toEqual({
      kind: "refused",
      reason: { type: "environment-unavailable", label: "Office Mac" },
    });
    await expect(run({ providerRefusal: "Cursor can't remove turns." })).resolves.toEqual({
      kind: "refused",
      reason: { type: "provider-unsupported", message: "Cursor can't remove turns." },
    });
    await expect(run({ threadId: null })).resolves.toEqual({
      kind: "refused",
      reason: { type: "missing-api" },
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it("runs one revert per thread at a time, and leaves other threads alone", async () => {
    const store = threadStore();
    let answer: (mode: "keep-files" | null) => void = () => {};
    const first = runCheckpointRevert(
      revertInput(store, {
        choose: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      }).input,
    );
    await vi.waitFor(() => expect(phase()).toBe("choosing"));

    const second = revertInput(store);
    await expect(runCheckpointRevert(second.input)).resolves.toEqual({
      kind: "refused",
      reason: { type: "already-reverting" },
    });
    const otherThread = revertInput(threadStore(), {
      threadId: ThreadId.make("thread-2"),
      choose: async () => null,
    });
    await expect(runCheckpointRevert(otherThread.input)).resolves.toMatchObject({
      kind: "refused",
      reason: { type: "user-cancelled" },
    });
    expect(phase()).toBe("choosing");

    answer(null);
    await first;
    expect(phase()).toBeNull();
  });

  it("reports the node's refusal from the journal row", async () => {
    const store = threadStore();
    const { input, dispatchCommand } = revertInput(store);
    dispatchCommand.mockImplementation(async () => {
      store.update({
        activities: [
          revertRow("failed", { detail: 'Nothing was changed. "Neighbour" is working.' }),
        ],
      });
      return undefined;
    });

    await expect(runCheckpointRevert(input)).resolves.toEqual({
      kind: "not-reverted",
      error: 'Nothing was changed. "Neighbour" is working.',
    });
  });

  it("reports what the node answered at once, without waiting", async () => {
    const store = threadStore();
    const { input, dispatchCommand } = revertInput(store);
    dispatchCommand.mockRejectedValueOnce(
      Object.assign(new Error("A checkpoint revert is in progress for this thread."), {
        _tag: "OrchestrationDispatchCommandError",
      }),
    );
    await expect(runCheckpointRevert(input)).resolves.toEqual({
      kind: "not-reverted",
      error: "A checkpoint revert is in progress for this thread.",
    });

    dispatchCommand.mockRejectedValueOnce(new RpcRequestRefusedError("forbidden"));
    await expect(runCheckpointRevert(input)).resolves.toMatchObject({ kind: "not-reverted" });
    expect(store.listenerCount()).toBe(0);
  });

  it("returns what was prepared when the send was cut off but the node rewound anyway", async () => {
    const store = threadStore();
    const { input, dispatchCommand } = revertInput(store);
    dispatchCommand.mockImplementation(async () => {
      throw Object.assign(new Error("socket closed"), { _tag: "RpcClientError" });
    });

    const run = runCheckpointRevert(input);
    await vi.waitFor(() => expect(store.listenerCount()).toBe(1));
    // Reconnected: the shell shows the thread rewound and the journal finished.
    store.rewind([revertRow("completed")]);

    await expect(run).resolves.toEqual({
      kind: "reverted",
      mode: "keep-files",
      prepared: "prepared",
      notice: null,
    });
  });

  it("still returns what was prepared when no verdict comes", async () => {
    vi.useFakeTimers();
    const cutOff = revertInput(threadStore(), { unconfirmedTimeoutMs: 1_000, timeoutMs: 60_000 });
    cutOff.dispatchCommand.mockRejectedValueOnce(new Error("socket closed"));
    const unconfirmed = runCheckpointRevert(cutOff.input);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(unconfirmed).resolves.toEqual({
      kind: "unconfirmed",
      mode: "keep-files",
      prepared: "prepared",
      error:
        "Ryco couldn't confirm that the revert finished. Check the thread before you continue.",
    });

    const silent = revertInput(threadStore(), { timeoutMs: 5_000 });
    const timedOut = runCheckpointRevert(silent.input);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timedOut).resolves.toMatchObject({ kind: "unconfirmed", prepared: "prepared" });
    expect(phase()).toBeNull();
  });

  it("waits the full time for a cut-off revert once the node shows it took it", async () => {
    vi.useFakeTimers();
    const store = threadStore();
    const { input, dispatchCommand } = revertInput(store, {
      unconfirmedTimeoutMs: 1_000,
      timeoutMs: 60_000,
    });
    dispatchCommand.mockRejectedValueOnce(
      Object.assign(new Error("socket closed"), { _tag: "RpcClientError" }),
    );
    const run = runCheckpointRevert(input);
    await vi.advanceTimersByTimeAsync(500);
    // Reconnected: the node journaled the revert and is still restoring.
    store.update({ activities: [revertRow("restoring-files")] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(phase()).toBe("reverting");

    store.update({
      activities: [revertRow("failed", { detail: "Nothing was changed. The files are busy." })],
    });
    await expect(run).resolves.toEqual({
      kind: "not-reverted",
      error: "Nothing was changed. The files are busy.",
    });
    expect(phase()).toBeNull();
  });
});

describe("waitForCheckpointRevertOutcome", () => {
  function wait(store: ReturnType<typeof threadStore>, timeoutMs?: number) {
    return waitForCheckpointRevertOutcome({
      commandId: COMMAND_ID,
      turnCount: 1,
      before: store.readThread(),
      readThread: store.readThread,
      subscribe: store.subscribe,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  it("resolves at once when the verdict is already there", async () => {
    const store = threadStore();
    const before = store.readThread();
    store.update({ activities: [revertRow("failed", { detail: "Nothing was changed." })] });
    await expect(
      waitForCheckpointRevertOutcome({
        commandId: COMMAND_ID,
        turnCount: 1,
        before,
        readThread: store.readThread,
        subscribe: store.subscribe,
      }),
    ).resolves.toEqual({ kind: "not-reverted", detail: "Nothing was changed." });
    expect(store.listenerCount()).toBe(0);
  });

  it("ignores other reverts' rows and phases it does not know", async () => {
    vi.useFakeTimers();
    const store = threadStore();
    const outcome = wait(store, 1_000);
    store.update({
      activities: [revertRow("completed", { commandId: "cmd-other" }), revertRow("some-new-phase")],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toEqual({ kind: "unknown" });
  });

  it("warns, rather than refuses, when a restart cut off the journal after the rewind", async () => {
    const store = threadStore();
    const outcome = wait(store);
    store.rewind([
      revertRow("interrupted", {
        detail: "The conversation was reverted to checkpoint 1, but Ryco stopped.",
      }),
    ]);
    await expect(outcome).resolves.toEqual({
      kind: "reverted",
      notice: {
        tone: "warning",
        title: "Revert interrupted",
        detail: "The conversation was reverted to checkpoint 1, but Ryco stopped.",
      },
    });
  });

  it("counts a revert whose journal row went missing as done once the thread was rewound", async () => {
    vi.useFakeTimers();
    const store = threadStore();
    const outcome = wait(store, 1_000);
    store.rewind([revertRow("restoring-files")]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toEqual({ kind: "reverted", notice: null });
  });

  describe("on a node without the revert journal", () => {
    it("resolves when the thread is rewound", async () => {
      const store = threadStore();
      const outcome = wait(store);
      store.rewind();
      await expect(outcome).resolves.toEqual({ kind: "reverted", notice: null });
      expect(store.listenerCount()).toBe(0);
    });

    it("resolves when the thread is rewound to before its first turn", async () => {
      const store = threadStore();
      const outcome = wait(store);
      store.update({ latestTurn: null, messages: [], turnDiffSummaries: [] });
      await expect(outcome).resolves.toEqual({ kind: "reverted", notice: null });
    });

    it("reads that node's failure row", async () => {
      const store = threadStore();
      store.update({ activities: [legacyFailureRow("old-failure", 1)] });
      const outcome = wait(store);
      // A failure of another revert, or one that was already there, is not this one's.
      store.update({
        activities: [legacyFailureRow("old-failure", 1), legacyFailureRow("other-target", 0)],
      });
      store.update({
        activities: [
          legacyFailureRow("old-failure", 1),
          legacyFailureRow("other-target", 0),
          legacyFailureRow("this-failure", 1),
        ],
      });
      await expect(outcome).resolves.toEqual({
        kind: "not-reverted",
        detail: "No active provider session is bound to this thread.",
      });
    });

    it("does not take a new turn for a rewind", async () => {
      vi.useFakeTimers();
      const store = threadStore();
      const outcome = wait(store, 1_000);
      store.update({ latestTurn: { turnId: TurnId.make("turn-3") } });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toEqual({ kind: "unknown" });
    });
  });
});

describe("revertKeptChangesDiscardedBy", () => {
  it("names the checkpoint whose kept changes restoring would discard", () => {
    const kept = revertRow("completed", { turnCount: 2, restoreFiles: false });
    expect(revertKeptChangesDiscardedBy([kept], 2)).toBe(2);
    expect(revertKeptChangesDiscardedBy([kept], 1)).toBe(2);
    // A checkpoint taken after that revert already holds the kept changes.
    expect(revertKeptChangesDiscardedBy([kept], 3)).toBeNull();
    expect(
      revertKeptChangesDiscardedBy([revertRow("files-not-restored", { turnCount: 2 })], 2),
    ).toBe(2);
  });

  it("still names kept changes after a later revert failed", () => {
    expect(
      revertKeptChangesDiscardedBy(
        [
          revertRow("completed", {
            commandId: "cmd-kept",
            turnCount: 2,
            restoreFiles: false,
            createdAt: "2026-10-22T00:00:00.000Z",
          }),
          revertRow("failed", {
            commandId: "cmd-refused",
            turnCount: 1,
            createdAt: "2026-10-22T00:01:00.000Z",
          }),
        ],
        1,
      ),
    ).toBe(2);
  });

  it("ignores reverts that restored the files, or that are not the newest", () => {
    expect(revertKeptChangesDiscardedBy([], 1)).toBeNull();
    expect(revertKeptChangesDiscardedBy([revertRow("completed", { turnCount: 2 })], 1)).toBeNull();
    expect(
      revertKeptChangesDiscardedBy(
        [
          revertRow("completed", {
            commandId: "cmd-kept",
            turnCount: 2,
            restoreFiles: false,
            createdAt: "2026-10-22T00:00:00.000Z",
          }),
          revertRow("completed", {
            commandId: "cmd-restored",
            turnCount: 1,
            createdAt: "2026-10-22T00:01:00.000Z",
          }),
        ],
        1,
      ),
    ).toBeNull();
  });
});
