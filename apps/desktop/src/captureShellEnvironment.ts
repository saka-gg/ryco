import { Worker } from "node:worker_threads";
import { pickShellEnvironment } from "./shellEnvironmentCache.ts";

export interface CapturedShellEnvironment {
  readonly environment: ReturnType<typeof pickShellEnvironment>;
  readonly warnings: readonly string[];
}

/** A single bounded attempt; a broken profile must not freeze or hold up startup. */
export function captureShellEnvironment(options: {
  readonly workerPath: string | URL;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<CapturedShellEnvironment | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerPath, { workerData: { env: { ...options.env } } });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: CapturedShellEnvironment | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Do not await termination: an OS filesystem call may itself be stuck.
      worker.unref();
      void worker.terminate().catch(() => undefined);
      resolve(value);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, options.timeoutMs ?? 2_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: CapturedShellEnvironment) => finish(value));
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}
