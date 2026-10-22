import { availableParallelism } from "node:os";

import { defineConfig, mergeConfig } from "vite-plus/test/config";

import baseConfig from "../../vitest.config.ts";
import { pureAndIsolatedProjects } from "../../vitest.pure-projects.ts";
import { DESKTOP_PURE_TEST_FILES } from "./test/pureTests.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // The cuaDriverHost suites spend most of their time waiting on fake driver
      // processes and real timers, so they overlap even on a 2-vCPU runner, where
      // the default (available parallelism - 1) would run every file serially.
      maxWorkers: Math.max(2, availableParallelism() - 1),
      projects: pureAndIsolatedProjects(import.meta.dirname, DESKTOP_PURE_TEST_FILES),
    },
  }),
);
