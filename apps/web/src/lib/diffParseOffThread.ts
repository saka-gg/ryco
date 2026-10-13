import { getRenderablePatch, type RenderablePatch } from "./diffParsing";

/**
 * Patches at least this long (about 1 MB of text) are parsed in a worker:
 * parsing one takes tens of milliseconds, a dropped frame or more on the main
 * thread. Smaller patches parse inline, where the round trip would cost more.
 */
export const OFF_THREAD_DIFF_PARSE_MIN_CHARS = 1_000_000;
/** An idle parse worker is stopped after this long. */
const DIFF_PARSE_WORKER_IDLE_MS = 60_000;
/**
 * A worker that has not answered a parse in this long is given up on, as if it
 * had crashed: parsing a few megabytes takes well under a second there.
 */
const DIFF_PARSE_WORKER_ANSWER_TIMEOUT_MS = 5_000;

export interface DiffParseWorkerRequest {
  readonly id: number;
  readonly patch: string;
  readonly scope: string;
}

export type DiffParseWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly patch: RenderablePatch | null }
  | { readonly id: number; readonly ok: false };

export interface DiffParseWorkerLike {
  postMessage: (message: DiffParseWorkerRequest) => void;
  terminate: () => void;
  addEventListener: (
    type: "message" | "error",
    listener: (event: MessageEvent<DiffParseWorkerResponse> | Event) => void,
  ) => void;
}

export interface OffThreadDiffParser {
  readonly parse: (patch: string, scope: string) => Promise<RenderablePatch | null>;
  readonly dispose: () => void;
}

/**
 * One lazily started worker that parses patches. Every failure falls back to
 * parsing on the main thread: no worker support, a worker that fails to start
 * or crashes, or a result it could not send back. A crashed worker is not
 * restarted for the page's lifetime.
 */
export function createOffThreadDiffParser(options: {
  readonly createWorker: (() => DiffParseWorkerLike) | null;
  readonly idleMs?: number;
  readonly answerTimeoutMs?: number;
}): OffThreadDiffParser {
  const idleMs = options.idleMs ?? DIFF_PARSE_WORKER_IDLE_MS;
  const answerTimeoutMs = options.answerTimeoutMs ?? DIFF_PARSE_WORKER_ANSWER_TIMEOUT_MS;
  let worker: DiffParseWorkerLike | null = null;
  let broken = options.createWorker === null;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<
    number,
    {
      readonly patch: string;
      readonly scope: string;
      readonly resolve: (patch: RenderablePatch | null) => void;
      readonly watchdog: ReturnType<typeof setTimeout>;
    }
  >();

  const parseInline = (patch: string, scope: string) => getRenderablePatch(patch, scope);
  const stopWorker = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    worker?.terminate();
    worker = null;
  };
  const scheduleIdleStop = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = pending.size === 0 ? setTimeout(stopWorker, idleMs) : null;
  };
  const failAll = () => {
    broken = true;
    stopWorker();
    const waiting = Array.from(pending.values());
    pending.clear();
    for (const request of waiting) {
      clearTimeout(request.watchdog);
      request.resolve(parseInline(request.patch, request.scope));
    }
  };
  const ensureWorker = (): DiffParseWorkerLike | null => {
    if (broken) return null;
    if (worker) return worker;
    try {
      const created = options.createWorker!();
      created.addEventListener("message", (event) => {
        const response = (event as MessageEvent<DiffParseWorkerResponse>).data;
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        clearTimeout(request.watchdog);
        request.resolve(response.ok ? response.patch : parseInline(request.patch, request.scope));
        scheduleIdleStop();
      });
      created.addEventListener("error", failAll);
      worker = created;
      return created;
    } catch {
      broken = true;
      return null;
    }
  };

  return {
    parse: (patch, scope) => {
      const target = ensureWorker();
      if (!target) return Promise.resolve(parseInline(patch, scope));
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
      const id = nextId++;
      return new Promise((resolve) => {
        const watchdog = setTimeout(failAll, answerTimeoutMs);
        pending.set(id, { patch, scope, resolve, watchdog });
        try {
          // A dedicated worker's postMessage takes no target origin.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          target.postMessage({ id, patch, scope });
        } catch {
          failAll();
        }
      });
    },
    dispose: () => {
      const waiting = Array.from(pending.values());
      pending.clear();
      stopWorker();
      for (const request of waiting) {
        clearTimeout(request.watchdog);
        request.resolve(parseInline(request.patch, request.scope));
      }
    },
  };
}

let sharedParser: OffThreadDiffParser | null = null;

/** The page's off-thread patch parser. */
export function getOffThreadDiffParser(): OffThreadDiffParser {
  sharedParser ??= createOffThreadDiffParser({
    createWorker:
      typeof Worker === "undefined"
        ? null
        : () =>
            new Worker(new URL("./diffParse.worker.ts", import.meta.url), {
              type: "module",
            }) as unknown as DiffParseWorkerLike,
  });
  return sharedParser;
}
