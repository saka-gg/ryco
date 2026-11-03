import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
  UpdateDownloadStalledError,
  watchUpdateDownload,
} from "./updateDownloadWatchdog.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function settledState(promise: Promise<unknown>): Promise<string> {
  const marker = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => (error instanceof UpdateDownloadStalledError ? "stalled" : "rejected"),
    ),
    Promise.resolve().then(() => Promise.resolve(marker)),
  ]);
  return outcome === marker ? "pending" : (outcome as string);
}

describe("watchUpdateDownload", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels and fails a download that makes no progress", async () => {
    const download = deferred<string[]>();
    const cancel = vi.fn();
    const watched = watchUpdateDownload({ download: download.promise, cancel });

    vi.advanceTimersByTime(UPDATE_DOWNLOAD_STALL_TIMEOUT_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(watched.result).rejects.toThrow(
      "The update download stopped: no data arrived for 90 seconds.",
    );
    // The cancelled download's own rejection changes nothing.
    download.reject(new Error("cancelled"));
    await expect(watched.result).rejects.toBeInstanceOf(UpdateDownloadStalledError);
  });

  it("keeps a download that makes progress", async () => {
    const download = deferred<string[]>();
    const cancel = vi.fn();
    const watched = watchUpdateDownload({
      download: download.promise,
      cancel,
      stallTimeoutMs: 1_000,
    });

    for (let step = 0; step < 10; step += 1) {
      vi.advanceTimersByTime(900);
      watched.noteProgress();
    }
    expect(await settledState(watched.result)).toBe("pending");

    download.resolve(["/tmp/update.zip"]);
    await expect(watched.result).resolves.toEqual(["/tmp/update.zip"]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("disarms once the download settles", async () => {
    const download = deferred<string[]>();
    const cancel = vi.fn();
    const watched = watchUpdateDownload({
      download: download.promise,
      cancel,
      stallTimeoutMs: 1_000,
    });

    download.reject(new Error("HttpError: 404"));
    await expect(watched.result).rejects.toThrow("HttpError: 404");
    watched.noteProgress();
    vi.advanceTimersByTime(5_000);

    expect(cancel).not.toHaveBeenCalled();
  });

  it("still fails a stalled download when cancelling throws", async () => {
    const watched = watchUpdateDownload({
      download: new Promise<string[]>(() => undefined),
      cancel: () => {
        throw new Error("already disposed");
      },
      stallTimeoutMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);

    await expect(watched.result).rejects.toBeInstanceOf(UpdateDownloadStalledError);
  });
});
