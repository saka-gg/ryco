import { defineConfig, mergeConfig } from "vite-plus/test/config";

import baseConfig from "../../../vitest.config.ts";

/**
 * The cross-node E2E alone. `*.e2e.ts` is outside Vitest's default include, so
 * the scripts package's own run never collects it; this config is the only
 * way in, and the tests still skip unless RYCO_TEST_CROSS_NODE_E2E=1.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    root: import.meta.dirname,
    test: {
      include: ["*.e2e.ts"],
      // One harness (a container and a node process) per file, files one at a time.
      fileParallelism: false,
      testTimeout: 10 * 60_000,
      // beforeAll builds node B's image.
      hookTimeout: 25 * 60_000,
    },
  }),
);
