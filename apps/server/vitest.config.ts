import { defaultExclude, defineConfig, mergeConfig } from "vite-plus/test/config";

import baseConfig from "../../vitest.config.ts";
import { SERVER_PURE_TEST_FILES } from "./test/pureTests.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide parallel runs they regularly exceed the default 15s budget.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      projects: [
        {
          extends: true,
          test: {
            name: "pure",
            include: [...SERVER_PURE_TEST_FILES],
            isolate: false,
            testTimeout: 5_000,
            hookTimeout: 5_000,
          },
        },
        {
          extends: true,
          test: {
            name: "isolated",
            exclude: [...defaultExclude, ...SERVER_PURE_TEST_FILES],
          },
        },
      ],
    },
  }),
);
