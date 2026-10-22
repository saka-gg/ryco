import { defineConfig, mergeConfig } from "vite-plus/test/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Schema-only package: the files share immutable schemas and no mocks,
      // globals, or module state, so they can share one module graph per worker
      // instead of re-evaluating the contracts index for every file.
      isolate: false,
    },
  }),
);
