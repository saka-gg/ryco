import { defineConfig, mergeConfig } from "vite-plus/test/config";

import baseConfig from "../../vitest.config.ts";
import { pureAndIsolatedProjects } from "../../vitest.pure-projects.ts";
import { SHARED_PURE_TEST_FILES } from "./test/pureTests.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { projects: pureAndIsolatedProjects(import.meta.dirname, SHARED_PURE_TEST_FILES) },
  }),
);
