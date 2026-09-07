import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
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
      include: ["src/components/**/*.browser.tsx", "src/browser/**/*.browser.tsx"],
      // Browser files share a constrained Chromium process in CI. Serializing
      // them avoids scheduler-driven timing failures in interaction tests.
      fileParallelism: false,
      maxWorkers: 1,
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
        api: {
          strictPort: false,
        },
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
