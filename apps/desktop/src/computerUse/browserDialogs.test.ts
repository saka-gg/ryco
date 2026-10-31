import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { beginPageDialogScope, DIALOG_SHIM_CLEANUP_TIMEOUT_MS } from "./browserDialogs.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("beginPageDialogScope", () => {
  it("gives up on a slow finish without aborting the paired browser's request", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    // The install answers; the finish never does (a page busy past the cleanup bound).
    const evaluate = vi.fn((params: Record<string, unknown>, signal: AbortSignal) => {
      signals.push(signal);
      return String(params.expression).includes("delete window[")
        ? new Promise<unknown>(() => undefined)
        : Promise.resolve({ result: { value: true } });
    });
    const scope = await beginPageDialogScope(
      evaluate,
      { dialog: "dismiss" },
      15_000,
      new AbortController().signal,
    );
    const ended = scope.end();
    await vi.advanceTimersByTimeAsync(DIALOG_SHIM_CLEANUP_TIMEOUT_MS);
    await expect(ended).resolves.toEqual({ dialogs: [] });
    expect(evaluate).toHaveBeenCalledTimes(2);
    // The paired transport ends its whole connection on an abort: the finish is never aborted.
    expect(signals[1]!.aborted).toBe(false);
  });

  it("finishes even when the install's answer was lost, and only once", async () => {
    const evaluate = vi.fn(async (params: Record<string, unknown>) => {
      if (!String(params.expression).includes("delete window[")) throw new Error("lost");
      return { result: { value: [{ kind: "alert", message: "hi" }] } };
    });
    const scope = await beginPageDialogScope(
      evaluate,
      { dialog: "dismiss" },
      15_000,
      new AbortController().signal,
    );
    const ended = await scope.end();
    expect(ended.dialogs).toEqual([expect.objectContaining({ kind: "alert", action: "accepted" })]);
    expect(await scope.end()).toEqual({ dialogs: [] });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
