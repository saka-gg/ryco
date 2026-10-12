import {
  execFile,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

import type { ProjectFavicon } from "./Services/ProjectFaviconResolver.ts";
import { projectFaviconWorkerMain } from "./projectFaviconWorker.ts";

export const PROJECT_FAVICON_READ_TIMEOUT_MS = 1_500;
/** Extra deadline per additional root in one child (probing a root takes well under this). */
export const PROJECT_FAVICON_READ_TIMEOUT_PER_ROOT_MS = 250;
const MAX_OUTPUT_BYTES_PER_ROOT = 768 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const WORKER_SCRIPT = `(${projectFaviconWorkerMain.toString()})()`;

export type ProjectFaviconExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => ChildProcess;

/**
 * One root's outcome. `absent` is a definite "no icon"; `unavailable` means the
 * read did not finish (deadline, cancellation, a broken child) and says
 * nothing about the project, so callers must not remember it as "no icon".
 */
export type ProjectFaviconReadResult =
  | { readonly status: "found"; readonly icon: ProjectFavicon }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

const UNAVAILABLE: ProjectFaviconReadResult = Object.freeze({ status: "unavailable" });
const ABSENT: ProjectFaviconReadResult = Object.freeze({ status: "absent" });

function parseWorkerLine(line: string): {
  readonly index: number;
  result: ProjectFaviconReadResult;
} {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || !("i" in parsed) || !("icon" in parsed))
    throw new Error("Malformed project icon record.");
  const index = parsed.i;
  if (typeof index !== "number" || !Number.isInteger(index)) throw new Error("Malformed index.");
  const icon = parsed.icon;
  if (icon === null) return { index, result: ABSENT };
  if (
    typeof icon !== "object" ||
    !("path" in icon) ||
    !("base64" in icon) ||
    typeof icon.path !== "string" ||
    typeof icon.base64 !== "string"
  )
    return { index, result: ABSENT };
  const bytes = Buffer.from(icon.base64, "base64");
  return {
    index,
    result:
      bytes.length <= MAX_ICON_BYTES
        ? { status: "found", icon: { path: icon.path, bytes } }
        : ABSENT,
  };
}

/**
 * Resolves the icons of several workspace roots in one isolated child (see
 * `projectFaviconWorker.ts`). Results arrive per root, so roots finished
 * before a deadline or a stalled read keep their answers; the rest are
 * `unavailable`.
 */
export function readProjectFavicons(
  roots: readonly string[],
  options: {
    readonly signal?: AbortSignal;
    readonly execFile?: ProjectFaviconExecFile;
    readonly timeoutMs?: number;
  } = {},
): Promise<ReadonlyArray<ProjectFaviconReadResult>> {
  return new Promise((resolve) => {
    const results: ProjectFaviconReadResult[] = roots.map(() => UNAVAILABLE);
    if (roots.length === 0 || options.signal?.aborted) {
      resolve(results);
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
        ["--eval", WORKER_SCRIPT, "--", ...roots],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: undefined,
            NODE_PATH: undefined,
          },
          encoding: "utf8",
          timeout:
            options.timeoutMs ??
            PROJECT_FAVICON_READ_TIMEOUT_MS +
              PROJECT_FAVICON_READ_TIMEOUT_PER_ROOT_MS * (roots.length - 1),
          killSignal: "SIGKILL",
          maxBuffer: MAX_OUTPUT_BYTES_PER_ROOT * roots.length,
          windowsHide: true,
        },
        // A deadline or kill still hands over what the child wrote until then.
        (_error, stdout) => {
          cleanup();
          for (const line of stdout.split("\n")) {
            if (line.length === 0) continue;
            try {
              const { index, result } = parseWorkerLine(line);
              if (index >= 0 && index < results.length) results[index] = result;
            } catch {
              // A torn last line (killed mid-write) leaves that root unavailable.
            }
          }
          resolve(results);
        },
      );
      if (options.signal?.aborted) abort();
    } catch {
      cleanup();
      resolve(results);
    }
  });
}

/** One root's icon, or null when there is none or it could not be read in time. */
export function readProjectFavicon(
  cwd: string,
  options: {
    readonly signal?: AbortSignal;
    readonly execFile?: ProjectFaviconExecFile;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProjectFavicon | null> {
  return readProjectFavicons([cwd], options).then(([result]) =>
    result?.status === "found" ? result.icon : null,
  );
}
