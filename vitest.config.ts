import * as path from "node:path";
import { defineConfig } from "vite-plus/test/config";
import { ciTestReporting } from "./vitest.reporting.ts";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "~",
        replacement: path.resolve(import.meta.dirname, "./apps/web/src"),
      },
    ],
  },
  test: {
    ...ciTestReporting(),
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
