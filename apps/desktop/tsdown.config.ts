import { parseOptInSourcemapEnv, readEnv } from "@ryco/shared/runtimeEnv";
import { defineConfig } from "tsdown";

const buildSourcemap = parseOptInSourcemapEnv(readEnv("RYCO_DESKTOP_SOURCEMAP"));

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: buildSourcemap,
  outExtensions: () => ({ js: ".cjs" }),
  tsconfig: "tsconfig.build.json",
};

export default defineConfig([
  {
    ...shared,
    entry: {
      main: "src/desktopEntry.ts",
      desktopMain: "src/main.ts",
      shellEnvironmentWorker: "src/shellEnvironmentWorker.ts",
      // Required first by the main process and via `--require` by Node-mode
      // children (backend, MCP bridge); see src/compileCache.ts.
      compileCache: "src/compileCache.ts",
    },
    clean: true,
    deps: {
      alwaysBundle: (id) => id.startsWith("@ryco/") || id.startsWith("effect-acp"),
    },
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
]);
