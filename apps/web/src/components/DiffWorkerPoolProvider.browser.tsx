import { useWorkerPool } from "@pierre/diffs/react";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { resolveDiffThemeName } from "../lib/diffRendering";
import { acquireDiffWorkerPool } from "../lib/diffWorkerPool";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

describe("diff worker pool", () => {
  it("highlights in its workers with Highlights' WASM lexers", async () => {
    const lease = acquireDiffWorkerPool(resolveDiffThemeName("dark"));
    try {
      expect(lease.pool.getPreferredHighlighter()).toBe("highlights");
      const file = {
        name: "example.ts",
        contents: "const answer: number = 42;\n",
        cacheKey: "diff-worker-pool-browser-test",
      };
      await lease.pool.primeFileHighlightCache(file);
      expect(lease.pool.getStats().workersFailed).toBe(false);
      const highlighted = lease.pool.getFileResultCache(file)?.result.code;
      expect(highlighted).toBeDefined();
      // Tokens of several colors, not a plain-text rendering.
      const colors = new Set(JSON.stringify(highlighted).match(/color:#[0-9a-f]{6}/giu));
      expect(colors.size).toBeGreaterThan(2);
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
