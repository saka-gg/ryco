/**
 * Fail an app update download that stops making progress.
 *
 * electron-updater downloads through Electron's `net` module. Its 60 s idle
 * timeout listens for a request `socket` event that Electron's requests never
 * emit, and Chromium has no idle timeout on a response body. A server that
 * stalls mid-download therefore leaves the download pending, with the app in
 * "Downloading…" and a remote install waiting on it, until the app restarts.
 */
export const UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 90_000;

export class UpdateDownloadStalledError extends Error {
  constructor(stallTimeoutMs: number) {
    super(
      `The update download stopped: no data arrived for ${Math.round(stallTimeoutMs / 1_000)} seconds.`,
    );
    this.name = "UpdateDownloadStalledError";
  }
}

export interface WatchedUpdateDownload<T> {
  /**
   * Settles like the download, or rejects with an UpdateDownloadStalledError
   * once no progress arrived for the stall timeout. A cancelled download that
   * never settles (a stalled differential download only notices cancellation
   * on its next chunk) cannot keep its caller waiting.
   */
  readonly result: Promise<T>;
  /** Data arrived (a `download-progress` event): the stall timer starts over. */
  noteProgress(): void;
}

export function watchUpdateDownload<T>(input: {
  readonly download: Promise<T>;
  /**
   * Cancels the download. It must also end a stalled request: electron-updater's
   * differential download checks its CancellationToken only when the next chunk
   * arrives, and until the download settles every later downloadUpdate() call
   * gets this same download back.
   */
  readonly cancel: () => void;
  readonly stallTimeoutMs?: number;
}): WatchedUpdateDownload<T> {
  const stallTimeoutMs = input.stallTimeoutMs ?? UPDATE_DOWNLOAD_STALL_TIMEOUT_MS;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let arm: () => void = () => undefined;

  const result = new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      finish();
    };
    arm = () => {
      if (settled) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        settle(() => {
          try {
            input.cancel();
          } catch {
            // The stall is reported either way.
          }
          reject(new UpdateDownloadStalledError(stallTimeoutMs));
        });
      }, stallTimeoutMs);
      timer.unref?.();
    };
    arm();
    // Also handles the download's own rejection after a stall (its cancellation).
    input.download.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });

  return {
    result,
    noteProgress: () => arm(),
  };
}
