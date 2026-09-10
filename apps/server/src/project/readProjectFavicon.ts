import {
  execFile,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

import type { ProjectFavicon } from "./Services/ProjectFaviconResolver.ts";
import { projectFaviconWorkerMain } from "./projectFaviconWorker.ts";

export const PROJECT_FAVICON_READ_TIMEOUT_MS = 1_500;
const MAX_OUTPUT_BYTES = 768 * 1024;
const WORKER_SCRIPT = `(${projectFaviconWorkerMain.toString()})()`;

export type ProjectFaviconExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => ChildProcess;

export function readProjectFavicon(
  cwd: string,
  options: {
    readonly signal?: AbortSignal;
    readonly execFile?: ProjectFaviconExecFile;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProjectFavicon | null> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve(null);
      return;
    }
    let child: ChildProcess | undefined;
    const abort = () => {
      child?.kill("SIGKILL");
    };
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      child = (options.execFile ?? execFile)(
        process.execPath,
        ["--eval", WORKER_SCRIPT, "--", cwd],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: undefined,
            NODE_PATH: undefined,
          },
          encoding: "utf8",
          timeout: options.timeoutMs ?? PROJECT_FAVICON_READ_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout) => {
          cleanup();
          if (error) {
            resolve(null);
            return;
          }
          try {
            const result: unknown = JSON.parse(stdout);
            if (
              typeof result !== "object" ||
              result === null ||
              !("path" in result) ||
              !("base64" in result) ||
              typeof result.path !== "string" ||
              typeof result.base64 !== "string"
            ) {
              resolve(null);
              return;
            }
            const bytes = Buffer.from(result.base64, "base64");
            resolve(bytes.length <= 512 * 1024 ? { path: result.path, bytes } : null);
          } catch {
            resolve(null);
          }
        },
      );
      if (options.signal?.aborted) abort();
    } catch {
      cleanup();
      resolve(null);
    }
  });
}
