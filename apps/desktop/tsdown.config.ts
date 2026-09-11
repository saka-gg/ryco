import { parseOptInSourcemapEnv, readEnv } from "@ryco/shared/runtimeEnv";
import { defineConfig } from "tsdown";

const buildSourcemap = parseOptInSourcemapEnv(readEnv("RYCO_DESKTOP_SOURCEMAP"));

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: buildSourcemap,
  outExtensions: () => ({ js: ".cjs" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts", "src/shellEnvironmentWorker.ts"],
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
