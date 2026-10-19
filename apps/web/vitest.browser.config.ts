import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig, type Plugin } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const mswWorkerPath = fileURLToPath(new URL("./test/public/mockServiceWorker.js", import.meta.url));
const MSW_WORKER_URL = "/mockServiceWorker.js";

/**
 * Serves the MSW service worker at the site root. The generated worker lives
 * under `test/public` instead of `public` so production builds never copy it
 * into `dist`, while the regular `public` assets stay available to the tests.
 */
function serveMswWorker(): Plugin {
  return {
    name: "ryco:serve-msw-worker",
    configureServer(server) {
      server.middlewares.use(MSW_WORKER_URL, (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.setHeader("Cache-Control", "no-cache");
        response.end(readFileSync(mswWorkerPath));
      });
    },
  };
}

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [serveMswWorker()],
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    server: {
      // The app dev server uses a fixed port, but browser tests need to allow
      // concurrent runs to claim the next available port.
      strictPort: false,
    },
    test: {
      include: [
        "src/components/**/*.browser.tsx",
        "src/browser/**/*.browser.tsx",
        "src/themes/**/*.browser.tsx",
      ],
      // Browser files share a constrained Chromium process in CI. Serializing
      // them avoids scheduler-driven timing failures in interaction tests.
      fileParallelism: false,
      maxWorkers: 1,
      // Vitest 5 serves browser mode from the single top-level API server.
      api: {
        strictPort: false,
      },
      browser: {
        enabled: true,
        provider: playwright({
          launchOptions: {
            args: [
              // Linux headless CI has no input devices, so it reports
              // `pointer: none` / `hover: none` while Tailwind v4 gates hover
              // variants behind `@media (hover: hover)`. Declare a
              // hover-capable fine pointer as the launch default so pristine
              // pages match a real desktop. Note: a CDP touch-emulation
              // disable recomputes from the platform and drops these values
              // again, so hover-media-dependent assertions must still gate on
              // `(hover: hover)`.
              "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
            ],
          },
        }),
        instances: [{ browser: "chromium" }],
        headless: true,
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
