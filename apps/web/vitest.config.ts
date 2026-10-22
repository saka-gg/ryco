import { defineConfig, mergeConfig } from "vite-plus/test/config";

import { pureAndIsolatedProjects } from "../../vitest.pure-projects.ts";
import { WEB_PURE_TEST_FILES } from "./test/pureTests.ts";
import viteConfig from "./vite.config.ts";

// Unit tests only. The projects stay out of vite.config.ts because
// vitest.browser.config.ts extends that file: inherited there, they would run
// the unit files in Chromium instead of the browser suite's own include.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { projects: pureAndIsolatedProjects(import.meta.dirname, WEB_PURE_TEST_FILES) },
  }),
);
