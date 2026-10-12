import { BackendReadinessTimeoutError, isBackendReadinessAborted } from "./backendReadiness.ts";

export interface WaitForBackendStartupReadyOptions<Source extends string> {
  /** The child's own readiness signal; rejects when the child fails. */
  readonly readyPromise?: Promise<Source> | null;
  readonly waitForHttpReady: () => Promise<void>;
  readonly cancelHttpWait: () => void;
  /**
   * Start the HTTP probe only this long after a readiness signal exists. The
   * probe is a last resort: early probes land in the server's bind window.
   */
  readonly httpFallbackDelayMs?: number;
}

export async function waitForBackendStartupReady<Source extends string>(
  options: WaitForBackendStartupReadyOptions<Source>,
): Promise<Source | "http"> {
  const readyPromise = options.readyPromise;

  if (!readyPromise) {
    await options.waitForHttpReady();
    return "http";
  }

  return await new Promise<Source | "http">((resolve, reject) => {
    let settled = false;
    let httpStarted = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const stopHttpWait = () => {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (httpStarted) options.cancelHttpWait();
    };

    const settleResolve = (source: Source | "http") => {
      if (settled) {
        return;
      }
      settled = true;
      if (source !== "http") stopHttpWait();
      resolve(source);
    };

    const settleReject = (error: unknown, settleOptions?: { readonly stopHttpWait?: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (settleOptions?.stopHttpWait) stopHttpWait();
      reject(error);
    };

    const startHttpWait = () => {
      fallbackTimer = null;
      if (settled) return;
      httpStarted = true;
      options.waitForHttpReady().then(
        () => settleResolve("http"),
        (error) => {
          // A slow but living child can still announce readiness after the HTTP
          // probe budget expires. Its exit/error signal remains authoritative.
          if (error instanceof BackendReadinessTimeoutError) return;
          if (settled && isBackendReadinessAborted(error)) {
            return;
          }
          settleReject(error);
        },
      );
    };

    readyPromise.then(
      (source) => settleResolve(source),
      (error) => settleReject(error, { stopHttpWait: true }),
    );
    const delayMs = options.httpFallbackDelayMs ?? 0;
    if (delayMs <= 0) {
      startHttpWait();
    } else {
      fallbackTimer = setTimeout(startHttpWait, delayMs);
      fallbackTimer.unref?.();
    }
  });
}
