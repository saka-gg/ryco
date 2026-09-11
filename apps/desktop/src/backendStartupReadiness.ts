import { BackendReadinessTimeoutError, isBackendReadinessAborted } from "./backendReadiness.ts";

export interface WaitForBackendStartupReadyOptions {
  readonly listeningPromise?: Promise<void> | null;
  readonly waitForHttpReady: () => Promise<void>;
  readonly cancelHttpWait: () => void;
}

export async function waitForBackendStartupReady(
  options: WaitForBackendStartupReadyOptions,
): Promise<"listening" | "http"> {
  const httpReadyPromise = options.waitForHttpReady();
  const listeningPromise = options.listeningPromise;

  if (!listeningPromise) {
    await httpReadyPromise;
    return "http";
  }

  return await new Promise<"listening" | "http">((resolve, reject) => {
    let settled = false;

    const settleResolve = (source: "listening" | "http") => {
      if (settled) {
        return;
      }
      settled = true;
      if (source === "listening") {
        options.cancelHttpWait();
      }
      resolve(source);
    };

    const settleReject = (
      error: unknown,
      settleOptions?: { readonly cancelHttpWait?: boolean },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      if (settleOptions?.cancelHttpWait) {
        options.cancelHttpWait();
      }
      reject(error);
    };

    listeningPromise.then(
      () => settleResolve("listening"),
      (error) => settleReject(error, { cancelHttpWait: true }),
    );
    httpReadyPromise.then(
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
  });
}
