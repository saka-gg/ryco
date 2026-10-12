import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadForkError,
  ThreadId,
  WorktreeId,
  type ThreadForkInput,
  type ThreadForkKey,
  type ThreadForkResult,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { selectEnvironmentState, useStore, type AppState, type EnvironmentState } from "./store.ts";
import {
  THREAD_FORK_COPY,
  THREAD_FORK_SHELL_TIMEOUT_MS,
  type ThreadForkApi,
} from "./threadFork.ts";
import {
  restoreThreadForkAttempt,
  threadForkAttemptView,
  type ThreadForkAttemptBoundary,
} from "./threadForkAttempt.ts";
import {
  createThreadForkAttemptController,
  threadForkShellPorts,
  type ThreadForkAttemptController,
  type ThreadForkAttemptControllerPorts,
} from "./threadForkAttemptController.ts";
import type { ThreadShellSource } from "./waitForThreadShell.ts";

// One dialog or sheet opening on the shared fork-attempt state machine and its registry (no mocks
// of either): which key every request goes under, that a reopened dialog continues the same
// attempt (also one that was created while no dialog was open), which connection each send is
// checked against, and that the dialog cannot close while a request or the created fork's
// opening is in flight. Each test forks from its own reply: the registry lives as long as the app.

const result: ThreadForkResult = {
  threadId: ThreadId.make("fork-thread"),
  projectId: ProjectId.make("project-1"),
  replayed: false,
  providerContext: "native",
  checkout: {
    kind: "new-worktree",
    worktreeId: WorktreeId.make("worktree-fork"),
    worktreePath: "/repo/.worktrees/fork",
    branch: "ryco/fork-1a2b3c4d",
    start: "checkpoint",
    baseRef: "0123456789abcdef0123456789abcdef01234567",
  },
  notices: [],
};

const environmentId = EnvironmentId.make("env-fork");

let nextBoundary = 0;
function boundary(): ThreadForkAttemptBoundary {
  nextBoundary += 1;
  return {
    environmentId,
    sourceThreadId: ThreadId.make("source-thread"),
    sourceMessageId: MessageId.make(`controller-reply-${nextBoundary}`),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A node whose answers the test hands out one call at a time. */
function fakeNode() {
  const calls: ThreadForkInput[] = [];
  const answers: Array<ReturnType<typeof deferred<ThreadForkResult>>> = [];
  const api: ThreadForkApi = {
    fork: (input) => {
      calls.push(input);
      const answer = deferred<ThreadForkResult>();
      answers.push(answer);
      return answer.promise;
    },
  };
  return { api, calls, answers };
}

function keys() {
  let next = 0;
  return vi.fn((): ThreadForkKey => {
    next += 1;
    return `fork-${String(next).padStart(16, "0")}`;
  });
}

/**
 * A connection whose generation changes on reconnect; a capture asserts the generation it saw,
 * as `captureReviewedSendReadiness` does.
 */
function connection() {
  let generation = 1;
  const capture = () => {
    const seen = generation;
    return () => {
      if (generation !== seen) throw new Error("generation changed");
    };
  };
  return {
    capture,
    reconnect: () => {
      generation += 1;
    },
  };
}

function dialogPorts(api: ThreadForkApi, shell = deferred<boolean>()) {
  const mintKey = keys();
  const ports = {
    mintKey,
    captureReadiness: vi.fn((): (() => void) => () => undefined),
    resolveApi: vi.fn((): ReturnType<ThreadForkAttemptControllerPorts["resolveApi"]> => api),
    waitForShell: vi.fn((_result: ThreadForkResult, _signal: AbortSignal) => shell.promise),
    readAvailability: vi.fn(
      (
        _result: ThreadForkResult,
      ): ReturnType<ThreadForkAttemptControllerPorts["readAvailability"]> => "unknown",
    ),
  } satisfies ThreadForkAttemptControllerPorts;
  return { ports, shell, mintKey };
}

function open(input: {
  readonly at: ThreadForkAttemptBoundary;
  readonly ports: ThreadForkAttemptControllerPorts;
  readonly onForked?: (result: ThreadForkResult, arrived: boolean) => void;
  readonly start?: boolean;
}): ThreadForkAttemptController {
  const controller = createThreadForkAttemptController({
    boundary: input.at,
    initialSelection: { destination: "current-checkout", worktreeStart: null, baseRef: "main" },
    defaultBaseRef: "main",
    ports: input.ports,
    onForked: input.onForked ?? (() => undefined),
  });
  if (input.start !== false) controller.start();
  return controller;
}

function view(controller: ThreadForkAttemptController) {
  return threadForkAttemptView(controller.getSnapshot().attempt);
}

/** Presses the dialog's primary button with the form as it stands. */
function press(controller: ThreadForkAttemptController) {
  expect(view(controller).canSubmit).toBe(true);
  controller.submit(controller.getSnapshot().attempt.selection);
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs `run` with the clock moved past the time a dialog waits for a new fork's thread. */
async function later<T>(run: () => T | Promise<T>): Promise<T> {
  const now = Date.now() + THREAD_FORK_SHELL_TIMEOUT_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    return await run();
  } finally {
    clock.mockRestore();
  }
}

/**
 * A fork created after its dialog went away: the request was in flight when the dialog was
 * dropped, and the node answered after. The registry keeps it for the next opening.
 */
async function forkCreatedWhileNoDialog(at: ThreadForkAttemptBoundary) {
  const node = fakeNode();
  const first = open({ at, ports: dialogPorts(node.api).ports });
  press(first);
  first.stop();
  node.answers[0]!.resolve(result);
  await flush();
  expect(restoreThreadForkAttempt(at)).toMatchObject({ phase: "succeeded", result });
  return node;
}

/** The threads store with the fork's environment's shell snapshot current, or not yet. */
function shellStore(environment: Partial<EnvironmentState>): ThreadShellSource {
  const base = useStore.getState();
  const state: AppState = {
    ...base,
    environmentStateById: {
      ...base.environmentStateById,
      [environmentId]: { ...selectEnvironmentState(base, environmentId), ...environment },
    },
  };
  return { getState: () => state, subscribe: () => () => undefined };
}

function typed(
  reason: ThreadForkError["reason"],
  attempt: ThreadForkError["attempt"],
  retryable = true,
) {
  return new ThreadForkError({ message: `node: ${reason}`, reason, retryable, attempt });
}

describe("fork attempt controller", () => {
  it("cannot close while the request or the new fork's opening is in flight", async () => {
    const node = fakeNode();
    const { ports, shell } = dialogPorts(node.api);
    const onForked = vi.fn();
    const at = boundary();
    const dialog = open({ at, ports, onForked });
    expect(dialog.requestClose()).toBe(true);

    dialog.select({ destination: "new-worktree", worktreeStart: "checkpoint" });
    press(dialog);
    expect(view(dialog)).toMatchObject({
      canDismiss: false,
      busyLabel: THREAD_FORK_COPY.busy.preparingWorktree,
    });
    expect(dialog.requestClose()).toBe(false);

    node.answers[0]!.resolve(result);
    await flush();
    // Created: waiting for the fork's thread to arrive before opening it, still not closable.
    expect(dialog.getSnapshot().opening).toBe(true);
    expect(dialog.requestClose()).toBe(false);
    expect(ports.waitForShell).toHaveBeenCalledWith(result, expect.any(AbortSignal));
    expect(onForked).not.toHaveBeenCalled();

    shell.resolve(false); // A slow stream still opens the fork.
    await flush();
    expect(onForked).toHaveBeenCalledExactlyOnceWith(result, false);
    // Opened: the next fork from this reply is a new one.
    expect(restoreThreadForkAttempt(at)).toBeNull();
  });

  it("can close again once the node answered", async () => {
    const node = fakeNode();
    const dialog = open({ at: boundary(), ports: dialogPorts(node.api).ports });
    press(dialog);
    expect(dialog.requestClose()).toBe(false);
    node.answers[0]!.reject(new Error("socket closed"));
    await flush();
    expect(dialog.getSnapshot().attempt.phase).toBe("uncertain");
    expect(dialog.requestClose()).toBe(true);
  });

  it("reopening for the same reply after an unknown outcome continues the same attempt", async () => {
    const node = fakeNode();
    const at = boundary();
    const first = open({ at, ports: dialogPorts(node.api).ports });
    first.select({ destination: "new-worktree", worktreeStart: "checkpoint" });
    press(first);
    node.answers[0]!.reject(new Error("socket closed"));
    await flush();
    const sentKey = node.calls[0]!.forkKey;
    first.stop(); // Cancel.

    const reopenedPorts = dialogPorts(node.api).ports;
    const reopened = open({ at, ports: reopenedPorts });
    expect(reopened.getSnapshot().attempt.forkKey).toBe(sentKey);
    expect(view(reopened)).toMatchObject({ canEdit: false, submitLabel: THREAD_FORK_COPY.retry });
    // The selection stays locked: only the request the node may hold can go out again.
    reopened.select({ destination: "current-checkout" });
    expect(reopened.getSnapshot().attempt.selection.destination).toBe("new-worktree");

    reopened.submit(null);
    expect(node.calls).toHaveLength(2);
    expect(node.calls[1]).toEqual(node.calls[0]);
    expect(reopenedPorts.mintKey).not.toHaveBeenCalled();
  });

  it("a dialog that went away mid-request hands the request to the next opening", async () => {
    const node = fakeNode();
    const at = boundary();
    const first = open({ at, ports: dialogPorts(node.api).ports });
    press(first);
    // The dialog was unmounted while the request was in flight.
    first.stop();

    const onForked = vi.fn();
    const { ports, shell } = dialogPorts(node.api);
    const reopened = open({ at, ports, onForked });
    expect(reopened.getSnapshot().attempt.forkKey).toBe(node.calls[0]!.forkKey);
    expect(view(reopened)).toMatchObject({ canDismiss: false, canSubmit: false });
    // Pressing anything sends nothing while the inherited request is in flight.
    reopened.submit(reopened.getSnapshot().attempt.selection);
    expect(node.calls).toHaveLength(1);

    node.answers[0]!.resolve(result);
    await flush();
    expect(reopened.getSnapshot()).toMatchObject({ opening: true });
    shell.resolve(true);
    await flush();
    expect(onForked).toHaveBeenCalledExactlyOnceWith(result, true);
  });

  it("opens a fork created after its dialog went away instead of starting a second one", async () => {
    const node = fakeNode();
    const at = boundary();
    const first = open({ at, ports: dialogPorts(node.api).ports });
    press(first);
    // The screen was retargeted while the request was in flight: the sheet is dropped.
    first.stop();
    node.answers[0]!.resolve(result);
    await flush();
    // Nobody saw the fork yet: the registry keeps it for the next opening.
    expect(restoreThreadForkAttempt(at)).toMatchObject({ phase: "succeeded", result });

    const onForked = vi.fn();
    const { ports, shell, mintKey } = dialogPorts(node.api);
    const reopened = open({ at, ports, onForked });
    expect(reopened.getSnapshot()).toMatchObject({
      attempt: { phase: "succeeded" },
      opening: true,
    });
    // Nothing is in flight while it opens: Cancel would leave it for the next opening.
    expect(reopened.requestClose()).toBe(true);
    shell.resolve(true);
    await flush();
    expect(onForked).toHaveBeenCalledExactlyOnceWith(result, true);
    expect(node.calls).toHaveLength(1);
    expect(mintKey).not.toHaveBeenCalled();
    // Opened now: the next "Fork from here" on this reply is a new fork.
    expect(restoreThreadForkAttempt(at)).toBeNull();
  });

  it("keeps a created fork for the next opening when its dialog went away while opening it", async () => {
    const node = fakeNode();
    const at = boundary();
    const onForked = vi.fn();
    const first = open({ at, ports: dialogPorts(node.api).ports, onForked });
    press(first);
    node.answers[0]!.resolve(result);
    await flush();
    expect(first.getSnapshot().opening).toBe(true);
    first.stop();
    await flush();
    expect(onForked).not.toHaveBeenCalled();
    expect(restoreThreadForkAttempt(at)?.phase).toBe("succeeded");

    const reopenedForked = vi.fn();
    const shell = deferred<boolean>();
    open({ at, ports: dialogPorts(node.api, shell).ports, onForked: reopenedForked });
    shell.resolve(true);
    await flush();
    expect(reopenedForked).toHaveBeenCalledExactlyOnceWith(result, true);
    expect(node.calls).toHaveLength(1);
  });

  it("follows the answer to an inherited request even when it lands before the dialog shows", async () => {
    const node = fakeNode();
    const at = boundary();
    const first = open({ at, ports: dialogPorts(node.api).ports });
    press(first);
    first.stop();

    const onForked = vi.fn();
    const { ports, shell } = dialogPorts(node.api);
    // Created for the reopened sheet, not started yet (its effect runs after the render).
    const second = open({ at, ports, onForked, start: false });
    expect(second.getSnapshot().attempt.phase).toBe("submitting");
    node.answers[0]!.resolve(result);
    await flush();
    second.start();
    expect(second.getSnapshot()).toMatchObject({
      attempt: { phase: "succeeded", result },
      opening: true,
    });
    // The real outcome, never "may have been created".
    expect(restoreThreadForkAttempt(at)?.phase).toBe("succeeded");
    expect(view(second).notice).toBeNull();
    shell.resolve(true);
    await flush();
    expect(onForked).toHaveBeenCalledExactlyOnceWith(result, true);
  });

  it("starts a stopped attempt over under a new key when the selection changed", async () => {
    const node = fakeNode();
    const dialog = open({ at: boundary(), ports: dialogPorts(node.api).ports });
    dialog.select({ destination: "new-worktree", worktreeStart: "base-ref", baseRef: "main" });
    press(dialog);
    node.answers[0]!.reject(typed("preparation-failed", "stopped"));
    await flush();
    expect(view(dialog)).toMatchObject({ canEdit: true, submitLabel: THREAD_FORK_COPY.retry });

    dialog.select({ destination: "current-checkout" });
    expect(view(dialog).submitLabel).toBe(THREAD_FORK_COPY.submit);
    press(dialog);
    expect(node.calls[1]!.forkKey).not.toBe(node.calls[0]!.forkKey);
    expect(node.calls[1]!.destination).toEqual({ kind: "current-checkout" });
  });

  it("keeps the key and the request while the node is still preparing the fork", async () => {
    const node = fakeNode();
    const dialog = open({ at: boundary(), ports: dialogPorts(node.api).ports });
    press(dialog);
    node.answers[0]!.reject(typed("preparation-failed", "running"));
    await flush();
    expect(view(dialog)).toMatchObject({
      canEdit: false,
      submitLabel: THREAD_FORK_COPY.checkAgain,
      canDismiss: true,
    });
    dialog.submit({ destination: "new-worktree", worktreeStart: "checkpoint" });
    expect(node.calls[1]).toEqual(node.calls[0]);
  });

  it("re-reviews the connection after a send that went nowhere", async () => {
    const node = fakeNode();
    const { ports } = dialogPorts(node.api);
    ports.captureReadiness.mockImplementationOnce(() => () => {
      throw new Error("generation changed");
    });
    const dialog = open({ at: boundary(), ports });
    press(dialog);
    await flush();
    expect(node.calls).toHaveLength(0);
    expect(view(dialog).notice?.title).toBe(THREAD_FORK_COPY.titles.notSent);

    press(dialog);
    expect(ports.captureReadiness).toHaveBeenCalledTimes(2);
    expect(node.calls).toHaveLength(1);
  });

  it("sends a retry after a reconnect on the first press", async () => {
    const node = fakeNode();
    const live = connection();
    const { ports } = dialogPorts(node.api);
    ports.captureReadiness.mockImplementation(live.capture);
    const dialog = open({ at: boundary(), ports });
    press(dialog);
    // The socket dropped mid-request, and the client reconnected (a new shell generation).
    node.answers[0]!.reject(new Error("socket closed"));
    await flush();
    expect(dialog.getSnapshot().attempt.phase).toBe("uncertain");
    live.reconnect();

    dialog.submit(null);
    expect(node.calls).toHaveLength(2);
    expect(node.calls[1]).toEqual(node.calls[0]);
    expect(dialog.getSnapshot().attempt.refusal).toBeNull();
  });

  it("checks the first send against the connection the form was reviewed under", async () => {
    const node = fakeNode();
    const live = connection();
    const { ports } = dialogPorts(node.api);
    ports.captureReadiness.mockImplementation(live.capture);
    const dialog = open({ at: boundary(), ports });
    live.reconnect(); // While the user was choosing.
    press(dialog);
    await flush();
    expect(node.calls).toHaveLength(0);
    expect(view(dialog).notice).toMatchObject({
      title: THREAD_FORK_COPY.titles.notSent,
      message: THREAD_FORK_COPY.connectionChanged,
    });
  });

  it("records a send without a live client as a refusal that keeps an unknown outcome", async () => {
    const node = fakeNode();
    const at = boundary();
    const { ports } = dialogPorts(node.api);
    const dialog = open({ at, ports });
    press(dialog);
    node.answers[0]!.reject(new Error("socket closed"));
    await flush();

    ports.resolveApi.mockImplementationOnce(() => ({
      refusal: {
        status: "refused",
        awaiting: true,
        message: THREAD_FORK_COPY.connectionChanged,
        error: null,
      },
    }));
    dialog.submit(null);
    await flush();
    expect(node.calls).toHaveLength(1);
    expect(dialog.getSnapshot().attempt).toMatchObject({
      phase: "uncertain",
      refusal: { awaiting: true },
    });
    expect(view(dialog).notice).toMatchObject({
      title: THREAD_FORK_COPY.titles.uncertain,
      message: THREAD_FORK_COPY.connectionChanged,
    });
    expect(restoreThreadForkAttempt(at)?.phase).toBe("uncertain");
  });

  it("opens a fork created while the dialog was hidden once it shows again, and only once", async () => {
    const node = fakeNode();
    const shell = deferred<boolean>();
    const onForked = vi.fn();
    const dialog = open({ at: boundary(), ports: dialogPorts(node.api, shell).ports, onForked });
    press(dialog);
    node.answers[0]!.resolve(result);
    await flush();
    dialog.stop();
    expect(dialog.getSnapshot().opening).toBe(false);
    shell.resolve(true);
    await flush();
    expect(onForked).not.toHaveBeenCalled();

    dialog.start();
    await flush();
    expect(onForked).toHaveBeenCalledOnce();
    dialog.stop();
    dialog.start();
    await flush();
    expect(onForked).toHaveBeenCalledOnce();
  });

  it("starts over instead of opening a fork created while no dialog was open and deleted since", async () => {
    const at = boundary();
    const node = await forkCreatedWhileNoDialog(at);
    const sentKey = node.calls[0]!.forkKey;

    // The fork was deleted (or moved to Trash): the current shell snapshot no longer has it.
    const onForked = vi.fn();
    const { ports, mintKey } = dialogPorts(node.api);
    mintKey.mockReturnValueOnce("fork-0000000000000099");
    ports.readAvailability.mockReturnValue("missing");
    const reopened = await later(() => open({ at, ports, onForked }));
    // No lock, no wait, no "Fork created", no navigation to the missing thread.
    expect(reopened.getSnapshot()).toMatchObject({
      attempt: { phase: "editing", result: null },
      opening: false,
      restored: false,
    });
    expect(reopened.requestClose()).toBe(true);
    expect(ports.readAvailability).toHaveBeenCalledWith(result);
    expect(ports.waitForShell).not.toHaveBeenCalled();
    await flush();
    expect(onForked).not.toHaveBeenCalled();
    expect(restoreThreadForkAttempt(at)).toBeNull();

    // The next press is a new fork from this reply, under a key of its own.
    expect(mintKey).toHaveBeenCalledOnce();
    press(reopened);
    expect(node.calls).toHaveLength(2);
    expect(node.calls[1]!.forkKey).toBe("fork-0000000000000099");
    expect(sentKey).not.toBe("fork-0000000000000099");
  });

  it("reads a deleted fork through the shared threads store", async () => {
    const at = boundary();
    const node = await forkCreatedWhileNoDialog(at);
    const onForked = vi.fn();
    const { ports } = dialogPorts(node.api);
    const reopened = await later(() =>
      open({
        at,
        // The environment's snapshot is current and the fork's thread is not in it.
        ports: {
          ...ports,
          ...threadForkShellPorts(environmentId, shellStore({ bootstrapComplete: true })),
        },
        onForked,
      }),
    );
    expect(reopened.getSnapshot()).toMatchObject({ attempt: { phase: "editing" }, opening: false });
    await flush();
    expect(onForked).not.toHaveBeenCalled();
    expect(restoreThreadForkAttempt(at)).toBeNull();
  });

  it("opens a fork created while no dialog was open, and lets that opening be cancelled", async () => {
    const at = boundary();
    const node = await forkCreatedWhileNoDialog(at);
    // The snapshot has not arrived yet (a reconnect): nothing says whether the fork is still there.
    const { ports } = dialogPorts(node.api);
    const reopened = await later(() => open({ at, ports }));
    expect(reopened.getSnapshot()).toMatchObject({
      attempt: { phase: "succeeded" },
      opening: true,
      restored: true,
    });
    // Nothing is in flight: Cancel closes, and the fork stays for the next opening.
    expect(reopened.requestClose()).toBe(true);
    reopened.stop();
    expect(restoreThreadForkAttempt(at)).toMatchObject({ phase: "succeeded", result });

    // Its thread is there: it opens.
    const onForked = vi.fn();
    const shell = deferred<boolean>();
    const again = dialogPorts(node.api, shell).ports;
    again.readAvailability.mockReturnValue("available");
    await later(() => open({ at, ports: again, onForked }));
    shell.resolve(true);
    await flush();
    expect(onForked).toHaveBeenCalledExactlyOnceWith(result, true);
    expect(restoreThreadForkAttempt(at)).toBeNull();
  });

  it("starts over once a remembered fork's thread never arrives and it is missing", async () => {
    const at = boundary();
    const node = await forkCreatedWhileNoDialog(at);
    const onForked = vi.fn();
    const shell = deferred<boolean>();
    const { ports } = dialogPorts(node.api, shell);
    ports.readAvailability.mockReturnValue("missing");
    // Created moments ago: its thread may still be on its way, so this opening waits for it.
    const reopened = open({ at, ports, onForked });
    expect(reopened.getSnapshot()).toMatchObject({ opening: true, restored: true });
    expect(ports.waitForShell).toHaveBeenCalledOnce();

    // The wait ran out and the current snapshot still lacks it: it was deleted meanwhile.
    await later(async () => {
      shell.resolve(false);
      await flush();
    });
    expect(onForked).not.toHaveBeenCalled();
    expect(reopened.getSnapshot()).toMatchObject({
      attempt: { phase: "editing" },
      opening: false,
      restored: false,
    });
    expect(restoreThreadForkAttempt(at)).toBeNull();
  });

  it("still announces a fork it created itself when its thread is slow to arrive", async () => {
    const node = fakeNode();
    const shell = deferred<boolean>();
    const { ports } = dialogPorts(node.api, shell);
    ports.readAvailability.mockReturnValue("missing");
    const onForked = vi.fn();
    const dialog = open({ at: boundary(), ports, onForked });
    press(dialog);
    node.answers[0]!.resolve(result);
    await flush();
    expect(dialog.getSnapshot()).toMatchObject({ opening: true, restored: false });
    expect(dialog.requestClose()).toBe(false);
    // The user watched it being created: a slow stream is announced, never taken for a delete.
    await later(async () => {
      shell.resolve(false);
      await flush();
    });
    expect(onForked).toHaveBeenCalledExactlyOnceWith(result, false);
  });
});
