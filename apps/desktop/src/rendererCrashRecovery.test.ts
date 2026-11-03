import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  attachRendererCrashRecovery,
  buildRendererCrashDialog,
  createRendererCrashPolicy,
  createRendererCrashRecovery,
  type RendererCrashDialogOptions,
  type RendererCrashRecoveryOptions,
  RENDERER_CRASH_STREAK_GAP_MS,
} from "./rendererCrashRecovery.ts";

describe("createRendererCrashPolicy", () => {
  it("reloads three times per streak with a doubling delay, then prompts on every crash", () => {
    const policy = createRendererCrashPolicy();
    expect(policy.decide({ reason: "oom", quitting: false, nowMs: 0 })).toEqual({
      kind: "reload",
      attempt: 1,
      delayMs: 500,
    });
    expect(policy.decide({ reason: "crashed", quitting: false, nowMs: 1_000 })).toEqual({
      kind: "reload",
      attempt: 2,
      delayMs: 1_000,
    });
    expect(policy.decide({ reason: "crashed", quitting: false, nowMs: 2_000 })).toEqual({
      kind: "reload",
      attempt: 3,
      delayMs: 2_000,
    });
    for (let crash = 4; crash <= 9; crash += 1) {
      expect(policy.decide({ reason: "crashed", quitting: false, nowMs: crash * 1_000 })).toEqual({
        kind: "prompt",
        cause: "reload-budget-exhausted",
        crashes: crash,
      });
    }
  });

  it("starts a new streak only after more than 60 s without a crash", () => {
    const policy = createRendererCrashPolicy();
    policy.decide({ reason: "crashed", quitting: false, nowMs: 0 });
    expect(
      policy.decide({ reason: "crashed", quitting: false, nowMs: RENDERER_CRASH_STREAK_GAP_MS }),
    ).toMatchObject({ kind: "reload", attempt: 2 });
    expect(
      policy.decide({
        reason: "crashed",
        quitting: false,
        nowMs: 2 * RENDERER_CRASH_STREAK_GAP_MS + 1,
      }),
    ).toEqual({ kind: "reload", attempt: 1, delayMs: 500 });
  });

  it("ignores a clean exit and any exit while quitting", () => {
    const policy = createRendererCrashPolicy();
    expect(policy.decide({ reason: "clean-exit", quitting: false, nowMs: 0 })).toEqual({
      kind: "ignore",
    });
    expect(policy.decide({ reason: "crashed", quitting: true, nowMs: 1 })).toEqual({
      kind: "ignore",
    });
    expect(policy.streak).toBe(0);
  });

  it("prompts at once for exits that repeat on reload", () => {
    for (const reason of ["launch-failed", "integrity-failure"]) {
      expect(createRendererCrashPolicy().decide({ reason, quitting: false, nowMs: 0 })).toEqual({
        kind: "prompt",
        cause: "unrecoverable",
        crashes: 1,
      });
    }
  });

  it("reloads every other exit, including ones a later Chromium adds", () => {
    for (const reason of ["killed", "abnormal-exit", "memory-eviction", "some-future-reason"]) {
      expect(createRendererCrashPolicy().decide({ reason, quitting: false, nowMs: 0 })).toEqual({
        kind: "reload",
        attempt: 1,
        delayMs: 500,
      });
    }
  });

  it("gives a full budget again after reset", () => {
    const policy = createRendererCrashPolicy();
    for (let crash = 0; crash < 5; crash += 1) {
      policy.decide({ reason: "crashed", quitting: false, nowMs: crash });
    }
    policy.reset();
    expect(policy.decide({ reason: "crashed", quitting: false, nowMs: 10 })).toEqual({
      kind: "reload",
      attempt: 1,
      delayMs: 500,
    });
  });
});

describe("buildRendererCrashDialog", () => {
  it("offers Reload, Open Logs and Quit, with Esc reloading", () => {
    const budget = buildRendererCrashDialog({
      appName: "Ryco",
      cause: "reload-budget-exhausted",
      crashes: 4,
      reason: "oom",
    });
    expect(budget).toMatchObject({
      type: "error",
      title: "Ryco window stopped",
      message: "The Ryco window crashed 4 times in a row.",
      buttons: ["Reload", "Open Logs", "Quit"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(budget.detail).toContain("(oom)");
    expect(budget.detail).toContain("Your chats and agents keep running.");

    const unrecoverable = buildRendererCrashDialog({
      appName: "Ryco",
      cause: "unrecoverable",
      crashes: 1,
      reason: "launch-failed",
    });
    expect(unrecoverable.message).toBe("The Ryco window stopped unexpectedly.");
    expect(unrecoverable.message).not.toBe(budget.message);
    expect(unrecoverable.detail).toContain("(launch-failed)");
  });
});

describe("createRendererCrashRecovery", () => {
  let clock: number;
  let lines: string[];
  let quitting: boolean;
  let windowClosed: boolean;
  let loadPending: boolean;
  let dialogAnswers: Array<(answer: { response: number }) => void>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    clock = 0;
    lines = [];
    quitting = false;
    windowClosed = false;
    loadPending = false;
    dialogAnswers = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    clock += ms;
    vi.advanceTimersByTime(ms);
  }

  function options() {
    return {
      appName: "Ryco",
      now: () => clock,
      isQuitting: () => quitting,
      isWindowClosed: () => windowClosed,
      isLoadPending: () => loadPending,
      describeUrl: () => "app",
      recover: vi.fn<RendererCrashRecoveryOptions["recover"]>(),
      reveal: vi.fn(),
      showMessageBox: vi.fn(
        (_options: RendererCrashDialogOptions) =>
          new Promise<{ response: number }>((resolve) => dialogAnswers.push(resolve)),
      ),
      openLogs: vi.fn(async () => undefined),
      quit: vi.fn(),
      log: (line: string) => lines.push(line),
    } satisfies RendererCrashRecoveryOptions;
  }

  async function answerDialog(response: number): Promise<void> {
    const answer = dialogAnswers.shift();
    if (answer === undefined) throw new Error("no dialog is open");
    answer({ response });
    // Let the dialog loop act on the answer.
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  }

  it("reloads a crashed window after the backoff delay and logs why", () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);

    recovery.handleRenderProcessGone({ reason: "oom", exitCode: 9 });

    expect(lines).toEqual([
      "renderer process gone reason=oom exitCode=9 url=app",
      "renderer reload scheduled attempt=1/3 delayMs=500",
    ]);
    advance(499);
    expect(deps.recover).not.toHaveBeenCalled();
    advance(1);
    expect(deps.recover).toHaveBeenCalledTimes(1);
    expect(deps.recover).toHaveBeenCalledWith(1);
  });

  it("reloads an exit isCrashed() does not report (memory-eviction)", () => {
    const deps = options();
    createRendererCrashRecovery(deps).handleRenderProcessGone({
      reason: "memory-eviction",
      exitCode: 0,
    });
    advance(500);
    expect(deps.recover).toHaveBeenCalledWith(1);
  });

  it("skips the reload when something else already loaded the window", () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);

    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    recovery.noteNavigationStarted();
    advance(500);

    expect(deps.recover).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe("renderer already reloaded; automatic reload skipped attempt=1");
  });

  it("skips the reload while another load of the window is pending", () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);

    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    loadPending = true;
    advance(500);

    expect(deps.recover).not.toHaveBeenCalled();
  });

  it("never reloads once quitting started, the window closed or it was disposed", () => {
    for (const stop of [
      () => {
        quitting = true;
      },
      () => {
        windowClosed = true;
      },
      (recovery: ReturnType<typeof createRendererCrashRecovery>) => recovery.dispose(),
    ]) {
      quitting = false;
      windowClosed = false;
      const deps = options();
      const recovery = createRendererCrashRecovery(deps);
      recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
      stop(recovery);
      advance(5_000);
      expect(deps.recover).not.toHaveBeenCalled();
    }
  });

  it("ignores a crash while quitting", () => {
    const deps = options();
    quitting = true;
    createRendererCrashRecovery(deps).handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    advance(5_000);
    expect(deps.recover).not.toHaveBeenCalled();
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });

  it("fails requests waiting on the renderer only when it died unexpectedly", () => {
    const onRendererGone = vi.fn();
    const recovery = createRendererCrashRecovery({ ...options(), onRendererGone });

    recovery.handleRenderProcessGone({ reason: "clean-exit", exitCode: 0 });
    quitting = true;
    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    expect(onRendererGone).not.toHaveBeenCalled();

    quitting = false;
    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    expect(onRendererGone).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending reload when the window crashes again", () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);

    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    advance(200);
    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    advance(999);
    expect(deps.recover).not.toHaveBeenCalled();
    advance(1);

    expect(deps.recover).toHaveBeenCalledTimes(1);
    expect(deps.recover).toHaveBeenCalledWith(2);
  });

  it("reloads three times, then asks on the fourth crash in a streak", () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);

    for (const delayMs of [500, 1_000, 2_000]) {
      recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
      advance(delayMs);
    }
    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });

    expect(deps.recover.mock.calls).toEqual([[1], [2], [3]]);
    expect(deps.reveal).toHaveBeenCalledTimes(1);
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
    expect(deps.showMessageBox).toHaveBeenCalledWith(
      buildRendererCrashDialog({
        appName: "Ryco",
        cause: "reload-budget-exhausted",
        crashes: 4,
        reason: "crashed",
      }),
    );
    expect(lines).toContain("renderer recovery prompt cause=reload-budget-exhausted crashes=4");
  });

  function exhaustBudget(recovery: ReturnType<typeof createRendererCrashRecovery>): void {
    for (const delayMs of [500, 1_000, 2_000]) {
      recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
      advance(delayMs);
    }
    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
  }

  it("reloads from the dialog and gives the window a fresh streak", async () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);
    exhaustBudget(recovery);

    await answerDialog(0);
    expect(deps.recover).toHaveBeenLastCalledWith("manual");

    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    expect(lines.at(-1)).toBe("renderer reload scheduled attempt=1/3 delayMs=500");
  });

  it("opens the logs and asks again, then quits", async () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);
    exhaustBudget(recovery);

    await answerDialog(1);
    expect(deps.openLogs).toHaveBeenCalledTimes(1);
    expect(deps.showMessageBox).toHaveBeenCalledTimes(2);

    await answerDialog(2);
    expect(deps.quit).toHaveBeenCalledTimes(1);
    expect(deps.recover).toHaveBeenCalledTimes(3);
  });

  it("ignores a dialog answer that arrives after dispose", async () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);
    exhaustBudget(recovery);

    recovery.dispose();
    await answerDialog(0);

    expect(deps.recover).toHaveBeenCalledTimes(3);
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it("opens one dialog at a time", () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);
    exhaustBudget(recovery);

    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });

    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe("renderer recovery prompt already open");
  });

  it("asks at once for an exit that would repeat on reload", () => {
    const deps = options();
    createRendererCrashRecovery(deps).handleRenderProcessGone({
      reason: "launch-failed",
      exitCode: 1,
    });

    expect(deps.recover).not.toHaveBeenCalled();
    expect(deps.showMessageBox).toHaveBeenCalledWith(
      buildRendererCrashDialog({
        appName: "Ryco",
        cause: "unrecoverable",
        crashes: 1,
        reason: "launch-failed",
      }),
    );
  });

  it("logs the time to a usable window once, and keeps the streak", () => {
    const deps = options();
    const recovery = createRendererCrashRecovery(deps);

    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    advance(500);
    recovery.noteNavigationStarted();
    advance(734);
    recovery.noteShellUsable();
    recovery.noteShellUsable();

    expect(lines.filter((line) => line.startsWith("renderer recovered"))).toEqual([
      "renderer recovered attempt=1 elapsedMs=1234",
    ]);
    advance(10_000);
    recovery.handleRenderProcessGone({ reason: "crashed", exitCode: 11 });
    expect(lines.at(-1)).toBe("renderer reload scheduled attempt=2/3 delayMs=1000");
  });
});

class FakeWebContents extends EventEmitter {}
class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
}

describe("attachRendererCrashRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function attach() {
    const window = new FakeWindow();
    const lines: string[] = [];
    let clock = 0;
    const deps = {
      appName: "Ryco",
      now: () => clock,
      isQuitting: () => false,
      isWindowClosed: () => false,
      isLoadPending: () => false,
      describeUrl: () => "app",
      recover: vi.fn<RendererCrashRecoveryOptions["recover"]>(),
      reveal: vi.fn(),
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      openLogs: vi.fn(async () => undefined),
      quit: vi.fn(),
      log: (line: string) => lines.push(line),
      onRendererGone: vi.fn(),
    };
    const recovery = attachRendererCrashRecovery(window, deps);
    return { window, lines, deps, recovery, tick: (ms: number) => (clock += ms) };
  }

  it("reloads a window whose renderer died and fails requests waiting on it", () => {
    const { window, deps } = attach();

    window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    expect(deps.onRendererGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);

    expect(deps.recover).toHaveBeenCalledWith(1);
  });

  it("treats a main-frame document navigation as revived, and nothing else", () => {
    const { window, deps } = attach();

    window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    vi.advanceTimersByTime(500);
    expect(deps.recover).toHaveBeenCalledTimes(1);

    window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    vi.advanceTimersByTime(1_000);
    expect(deps.recover).toHaveBeenCalledTimes(1);
  });

  it("logs hangs with their length", () => {
    const { window, lines, tick } = attach();

    window.emit("unresponsive");
    tick(4_321);
    window.emit("responsive");

    expect(lines).toEqual(["renderer unresponsive", "renderer responsive afterMs=4321"]);
  });

  it("stops recovering once the window is closed", () => {
    const { window, deps } = attach();

    window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    window.emit("closed");
    vi.advanceTimersByTime(5_000);

    expect(deps.recover).not.toHaveBeenCalled();
  });
});
