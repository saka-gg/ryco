import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { parseOptInSourcemapEnv, readEnv } from "@ryco/shared/runtimeEnv";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite-plus";
import pkg from "./package.json" with { type: "json" };
import { ciTestReporting } from "../../vitest.reporting.ts";
import { createHostedPwaBuildPlugin } from "./src/pwa/buildArtifacts";
import { createClientModeSeamPlugin } from "./src/clientModeSeams";
import { createBootFontPreloadPlugin } from "./src/viteBuild/bootFontPreload";
import {
  createWebCodeSplittingOptions,
  BOOT_ROOT_MODULES,
  HOSTED_ROUTE_GROUP_MODULES,
  webChunkFileName,
} from "./src/viteBuild/codeSplitting";
import {
  createBootPreloadPlugin,
  resolveWebModulePreloadDependencies,
} from "./src/viteBuild/modulePreload";
import { createPrecompressedAssetsPlugin } from "./src/viteBuild/precompressAssets";
import { REACT_COMPILER_EXCLUDE, REACT_COMPILER_INCLUDE } from "./src/viteBuild/reactCompilerScope";

const resolveWebModule = (module: string) => fileURLToPath(new URL(`./${module}`, import.meta.url));
const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredHttpUrl = process.env.VITE_HTTP_URL?.trim();
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const clientMode = process.env.VITE_RYCO_CLIENT_MODE === "hosted-hub" ? "hosted-hub" : "standard";
const phoneAppInterstitial =
  process.env.VITE_RYCO_PHONE_APP_INTERSTITIAL === "enabled" ? "enabled" : "disabled";
const mobileAppUrl = process.env.VITE_RYCO_MOBILE_APP_URL ?? "";
const configuredHostedAppUrl = (() => {
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return process.env.VITE_HOSTED_APP_URL?.trim();
})();
const buildSourcemap = parseOptInSourcemapEnv(readEnv("RYCO_WEB_SOURCEMAP"), {
  allowHidden: true,
});

/**
 * Packages that must resolve to exactly one copy in every web bundle. React keeps its
 * hook dispatcher in module-level state, so a second runtime pulled in through a
 * workspace dependency renders every hook call it owns unusable.
 */
export const REACT_DEDUPE_PACKAGES = ["react", "react-dom"] as const;
export function shouldEnableHostedPwaBuild(input: {
  readonly clientMode: "hosted-hub" | "standard";
  readonly command: string;
}): boolean {
  return input.clientMode === "hosted-hub" && input.command === "build";
}

function resolveDevProxyTarget(wsUrl: string | undefined): string | undefined {
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(configuredWsUrl);

export function createWebViteConfig(
  resolvedClientMode: "hosted-hub" | "standard" = clientMode,
  resolvedPhoneAppInterstitial: string = phoneAppInterstitial,
  resolvedMobileAppUrl: string = mobileAppUrl,
): UserConfig {
  const normalizedPhoneAppInterstitial =
    resolvedPhoneAppInterstitial === "enabled" ? "enabled" : "disabled";

  return {
    plugins: [
      createClientModeSeamPlugin({
        clientMode: resolvedClientMode,
        srcRoot: fileURLToPath(new URL("./src", import.meta.url)),
      }),
      tanstackRouter(),
      // The React Compiler runs through Oxc (oxc-transform-react) in dev,
      // build and the browser tests alike, so they never memoize differently.
      // It compiles the modules `reactCompilerScope.ts` selects; with
      // `compiler` on, Fast Refresh is limited to the same modules. Build
      // logs stay quiet about recoverable bailouts:
      // `src/perf/reactCompilerCoverage.test.ts` tracks them instead.
      react({
        compiler: true,
        include: REACT_COMPILER_INCLUDE,
        exclude: [...REACT_COMPILER_EXCLUDE],
      }),
      tailwindcss(),
      createBootPreloadPlugin(),
      ...(resolvedClientMode === "hosted-hub" ? [createHostedPwaBuildPlugin()] : []),
      // The Ryco server serves these siblings by Accept-Encoding, and the node
      // app paints in DM Sans. Hosted builds deploy to a CDN that compresses on
      // its own and the Hub surface has its own typography.
      ...(resolvedClientMode === "standard"
        ? [createBootFontPreloadPlugin(), createPrecompressedAssetsPlugin()]
        : []),
    ],
    optimizeDeps: {
      include: [
        "@pierre/diffs",
        "@pierre/diffs/react",
        "@pierre/diffs/worker/worker.js",
        "effect/Array",
        "effect/Order",
        "@tanstack/react-router",
        "react-dom/client",
      ],
    },
    define: {
      "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
      // In dev mode, tell the web app where the WebSocket server lives
      "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
      "import.meta.env.VITE_RYCO_CLIENT_MODE": JSON.stringify(resolvedClientMode),
      "import.meta.env.VITE_RYCO_PHONE_APP_INTERSTITIAL": JSON.stringify(
        normalizedPhoneAppInterstitial,
      ),
      "import.meta.env.VITE_RYCO_MOBILE_APP_URL": JSON.stringify(resolvedMobileAppUrl),
      "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
    },
    resolve: {
      // Workspace packages (e.g. `@ryco/client-runtime`) resolve their own peer
      // dependencies, so Zustand can pick up a second React copy from the isolated
      // install tree while `apps/web` renders with its own. Two runtimes means the
      // second copy's hook dispatcher is always null — `useCallback` of null at
      // startup. Force every `react`/`react-dom` specifier onto this package's
      // single runtime for both dev and build.
      dedupe: [...REACT_DEDUPE_PACKAGES],
      tsconfigPaths: true,
    },
    server: {
      host,
      port,
      strictPort: true,
      ...(devProxyTarget
        ? {
            proxy: {
              "/.well-known": {
                target: devProxyTarget,
                changeOrigin: clientMode !== "hosted-hub",
              },
              "/api": {
                target: devProxyTarget,
                changeOrigin: clientMode !== "hosted-hub",
              },
              "/attachments": {
                target: devProxyTarget,
                changeOrigin: true,
              },
              ...(clientMode === "hosted-hub"
                ? {
                    "/v1/relay": {
                      target: devProxyTarget,
                      changeOrigin: false,
                      ws: true,
                    },
                  }
                : {}),
            },
          }
        : {}),
      hmr: {
        // Explicit config so Vite's HMR WebSocket connects reliably
        // inside Electron's BrowserWindow. Vite 8 uses console.debug for
        // connection logs — enable "Verbose" in DevTools to see them.
        protocol: "ws",
        host,
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // Each dynamic import preloads its own static closure in one round;
      // index.html preloads only the boot chain (see the resolver and
      // `createBootPreloadPlugin`).
      modulePreload: {
        polyfill: false,
        resolveDependencies: resolveWebModulePreloadDependencies,
      },
      rolldownOptions: {
        output: {
          codeSplitting: createWebCodeSplittingOptions({
            bootEntry: fileURLToPath(new URL("./src/main.tsx", import.meta.url)),
            bootRoots: BOOT_ROOT_MODULES.map(resolveWebModule),
            // Standard builds keep their chunk layout; their routes load from
            // the local server, not across a Hub round trip.
            ...(resolvedClientMode === "hosted-hub"
              ? {
                  routeGroups: {
                    roots: HOSTED_ROUTE_GROUP_MODULES.roots.map(resolveWebModule),
                    excludedRoots: HOSTED_ROUTE_GROUP_MODULES.excludedRoots.map(resolveWebModule),
                  },
                }
              : {}),
          }),
          chunkFileNames: webChunkFileName,
        },
      },
      sourcemap: buildSourcemap,
    },
    // ES workers code-split instead of inlining every dynamic import: the diff
    // worker no longer embeds Shiki's unused 608 KiB Oniguruma WASM.
    worker: {
      format: "es",
    },
    test: {
      ...ciTestReporting(),
      // A full web run has several module-heavy suites. Capping workers avoids
      // multiplying their module graph until the host starts swapping. Below
      // the cap, one worker per core: Vitest's default leaves a core to its
      // main process, which idles here, and 4 workers finished the suite about
      // 15% sooner than 3 on 4 vCPU.
      maxWorkers: Math.min(4, availableParallelism()),
      // Under CI load, CPU-heavy tests that take about 1 s locally have run past
      // 5 s, so they get 15 s there. Locally, Vitest's 5 s default stays the
      // budget that makes a hang obvious.
      testTimeout: process.env.CI ? 15_000 : 5_000,
    },
  };
}

export default defineConfig(createWebViteConfig());
