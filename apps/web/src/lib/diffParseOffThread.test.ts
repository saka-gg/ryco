import { describe, expect, it, vi } from "vite-plus/test";

import {
  createOffThreadDiffParser,
  type DiffParseWorkerLike,
  type DiffParseWorkerRequest,
  type DiffParseWorkerResponse,
} from "./diffParseOffThread";
import { getRenderablePatch } from "./diffParsing";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

/** A worker that runs the real parser, as `diffParse.worker.ts` does, asynchronously. */
function fakeWorker(options?: {
  readonly crash?: boolean;
  readonly failParse?: boolean;
  readonly silent?: boolean;
}) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const posted: DiffParseWorkerRequest[] = [];
  const worker: DiffParseWorkerLike & { readonly posted: DiffParseWorkerRequest[] } = {
    posted,
    postMessage: (message) => {
      posted.push(message);
      queueMicrotask(() => {
        if (options?.silent) return;
        if (options?.crash) {
          for (const listener of listeners.get("error") ?? []) listener(new Event("error"));
          return;
        }
        const data: DiffParseWorkerResponse = options?.failParse
          ? { id: message.id, ok: false }
          : { id: message.id, ok: true, patch: getRenderablePatch(message.patch, message.scope) };
        for (const listener of listeners.get("message") ?? []) listener({ data });
      });
    },
    terminate: vi.fn(),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (event: unknown) => void]);
    },
  };
  return worker;
}

describe("createOffThreadDiffParser", () => {
  it("parses in the worker and matches the inline parse", async () => {
    const worker = fakeWorker();
    const parser = createOffThreadDiffParser({ createWorker: () => worker });
    const parsed = await parser.parse(PATCH, "diff-panel");
    expect(worker.posted).toHaveLength(1);
    expect(parsed).toEqual(getRenderablePatch(PATCH, "diff-panel"));
    parser.dispose();
  });

  it("parses inline without worker support", async () => {
    const parser = createOffThreadDiffParser({ createWorker: null });
    expect(await parser.parse(PATCH, "diff-panel")).toEqual(
      getRenderablePatch(PATCH, "diff-panel"),
    );
  });

  it("falls back to an inline parse when the worker cannot answer or crashes", async () => {
    const unanswered = createOffThreadDiffParser({
      createWorker: () => fakeWorker({ failParse: true }),
    });
    expect(await unanswered.parse(PATCH, "diff-panel")).toEqual(
      getRenderablePatch(PATCH, "diff-panel"),
    );

    const crashing = fakeWorker({ crash: true });
    const createWorker = vi.fn(() => crashing);
    const parser = createOffThreadDiffParser({ createWorker });
    expect(await parser.parse(PATCH, "diff-panel")).toEqual(
      getRenderablePatch(PATCH, "diff-panel"),
    );
    // A crashed worker is not started again.
    await parser.parse(PATCH, "diff-panel");
    expect(createWorker).toHaveBeenCalledOnce();
    expect(crashing.terminate).toHaveBeenCalled();
  });

  it("gives up on a worker that never answers", async () => {
    vi.useFakeTimers();
    try {
      const parser = createOffThreadDiffParser({
        createWorker: () => fakeWorker({ silent: true }),
        answerTimeoutMs: 50,
      });
      const parsed = parser.parse(PATCH, "diff-panel");
      await vi.advanceTimersByTimeAsync(50);
      expect(await parsed).toEqual(getRenderablePatch(PATCH, "diff-panel"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an idle worker", async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker();
      const parser = createOffThreadDiffParser({ createWorker: () => worker, idleMs: 100 });
      const parsed = parser.parse(PATCH, "diff-panel");
      await vi.advanceTimersByTimeAsync(0);
      await parsed;
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
