import * as path from "node:path";
import { defineConfig } from "vite-plus/test/config";
import { ciTestReporting } from "./scripts/lib/vitestReporting.ts";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "~",
        replacement: path.resolve(import.meta.dirname, "./apps/web/src"),
      },
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
    ],
  },
  test: {
    ...ciTestReporting(),
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
