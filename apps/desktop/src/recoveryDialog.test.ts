import { describe, expect, it, vi } from "vite-plus/test";

import { runRecoveryDialogLoop } from "./recoveryDialog.ts";

function answers(...responses: number[]) {
  const queue = [...responses];
  return vi.fn(async () => ({ response: queue.shift() ?? 2 }));
}

function loopOptions(show: ReturnType<typeof answers>, isCancelled = () => false) {
  return {
    show,
    isCancelled,
    openLogs: vi.fn(async () => undefined),
    primary: vi.fn(),
    quit: vi.fn(),
  };
}

describe("runRecoveryDialogLoop", () => {
  it("runs the primary action for the first button", async () => {
    const options = loopOptions(answers(0));
    await runRecoveryDialogLoop(options);
    expect(options.primary).toHaveBeenCalledTimes(1);
    expect(options.quit).not.toHaveBeenCalled();
  });

  it("opens the logs and shows the dialog again", async () => {
    const options = loopOptions(answers(1, 1, 0));
    await runRecoveryDialogLoop(options);
    expect(options.openLogs).toHaveBeenCalledTimes(2);
    expect(options.show).toHaveBeenCalledTimes(3);
    expect(options.primary).toHaveBeenCalledTimes(1);
  });

  it("shows the dialog again when opening the logs fails", async () => {
    const options = {
      ...loopOptions(answers(1, 2)),
      openLogs: vi.fn(async () => Promise.reject(new Error("no"))),
    };
    await runRecoveryDialogLoop(options);
    expect(options.show).toHaveBeenCalledTimes(2);
    expect(options.quit).toHaveBeenCalledTimes(1);
  });

  it("quits for the last button or any other answer", async () => {
    for (const response of [2, 7]) {
      const options = loopOptions(answers(response));
      await runRecoveryDialogLoop(options);
      expect(options.quit).toHaveBeenCalledTimes(1);
      expect(options.primary).not.toHaveBeenCalled();
    }
  });

  it("ignores an answer that arrives once it no longer matters", async () => {
    const options = loopOptions(answers(0), () => true);
    await runRecoveryDialogLoop(options);
    expect(options.primary).not.toHaveBeenCalled();
    expect(options.quit).not.toHaveBeenCalled();
    expect(options.openLogs).not.toHaveBeenCalled();
  });
});

describe("runRecoveryDialogLoop with an extra action", () => {
  it("ends when the extra action takes over, and shows the dialog again when it does not", async () => {
    const extra = vi
      .fn(async () => false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const options = { ...loopOptions(answers(2, 2)), extra };
    await runRecoveryDialogLoop(options);
    expect(extra).toHaveBeenCalledTimes(2);
    expect(options.show).toHaveBeenCalledTimes(2);
    expect(options.primary).not.toHaveBeenCalled();
    expect(options.quit).not.toHaveBeenCalled();
  });

  it("treats a failing extra action as not taking over", async () => {
    const extra = vi.fn(async () => Promise.reject(new Error("restore failed")));
    const options = { ...loopOptions(answers(2, 3)), extra };
    await runRecoveryDialogLoop(options);
    expect(options.show).toHaveBeenCalledTimes(2);
    expect(options.quit).toHaveBeenCalledTimes(1);
  });

  it("quits for the button after the extra action", async () => {
    const extra = vi.fn(async () => true);
    const options = { ...loopOptions(answers(3)), extra };
    await runRecoveryDialogLoop(options);
    expect(extra).not.toHaveBeenCalled();
    expect(options.quit).toHaveBeenCalledTimes(1);
  });
});
