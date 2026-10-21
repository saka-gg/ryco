import { defineConfig, mergeConfig } from "vite-plus/test/config";

import baseConfig from "../../vitest.config.ts";
import { pureAndIsolatedProjects } from "../../vitest.pure-projects.ts";
import { vitestMaxWorkers } from "../../vitest.workers.ts";
import { SERVER_PURE_TEST_FILES } from "./test/pureTests.ts";
import { SERVER_TIMING_TEST_FILES } from "./test/timingTests.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Files run in parallel, each isolated one in its own forked process, so
      // module state, process.env and timers never cross files; the suite's
      // sqlite databases, git repositories, temp worktrees and listeners are
      // per test (in memory, mkdtemp, port 0). What parallel files do share is
      // CPU, so the files that bound wall-clock time run afterwards, one at a
      // time (test/timingTests.ts). CI's server legs are 4-vCPU runners.
      maxWorkers: vitestMaxWorkers({ ci: 4, localMax: 4 }),
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide parallel runs they regularly exceed the default 15s budget.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      projects: pureAndIsolatedProjects(import.meta.dirname, SERVER_PURE_TEST_FILES, {
        pureOverrides: { testTimeout: 5_000, hookTimeout: 5_000 },
        timingTestFiles: SERVER_TIMING_TEST_FILES,
      }),
    },
  }),
);
