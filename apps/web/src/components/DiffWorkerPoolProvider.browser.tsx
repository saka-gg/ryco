import { useWorkerPool } from "@pierre/diffs/react";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { resolveDiffThemeName } from "../lib/diffRendering";
import { acquireDiffWorkerPool } from "../lib/diffWorkerPool";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

describe("diff worker pool", () => {
  it("highlights in its workers with the WASM engine", async () => {
    const lease = acquireDiffWorkerPool(resolveDiffThemeName("dark"));
    try {
      expect(lease.pool.getPreferredHighlighter()).toBe("shiki-wasm");
      const file = {
        name: "example.ts",
        contents: "const answer: number = 42;\n",
        cacheKey: "diff-worker-pool-browser-test",
      };
      await lease.pool.primeFileHighlightCache(file);
      expect(lease.pool.getStats().workersFailed).toBe(false);
      expect(lease.pool.getFileResultCache(file)).toBeDefined();
    } finally {
      lease.release();
    }
  });

  it("keeps the same pool when a provider unmounts and another mounts", async () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useWorkerPool());
      return null;
    }

    const first = await render(
      <DiffWorkerPoolProvider>
        <Probe />
      </DiffWorkerPoolProvider>,
    );
    await first.unmount();
    const second = await render(
      <DiffWorkerPoolProvider>
        <Probe />
      </DiffWorkerPoolProvider>,
    );
    try {
      expect(seen[0]).toBeDefined();
      expect(seen.at(-1)).toBe(seen[0]);
    } finally {
      await second.unmount();
    }
  });
});
