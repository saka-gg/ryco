import { parseOptInSourcemapEnv, readEnv } from "@ryco/shared/runtimeEnv";
import { defineConfig } from "tsdown";

import { latin1OutputPlugin } from "./scripts/latin1Output.ts";

const buildSourcemap = parseOptInSourcemapEnv(readEnv("RYCO_SERVER_SOURCEMAP"));

/**
 * Pure-JS runtime dependencies compiled into the server's own chunks. As
 * externals Node resolved, stat'ed and compiled them file by file at every boot
 * (effect alone is several hundred modules); bundled, only the code the server
 * reaches ships, in a few chunks, and the `patchedDependencies` this repository
 * applies to them travel with the build. Native addons and provider SDKs stay
 * external (sharp, node-pty, @github/keytar, the agent SDKs), and nothing that
 * stays external may depend on these packages, or it would load a second copy.
 */
const BUNDLED_RUNTIME_PACKAGES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",
  "mime",
];

const isBundledRuntimePackage = (id: string) =>
  BUNDLED_RUNTIME_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`));

export default defineConfig({
  entry: ["src/bin.ts"],
  tsconfig: "tsconfig.build.json",
  // ESM only: the `ryco` bin and the desktop backend both launch dist/bin.mjs.
  format: ["esm"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: buildSourcemap,
  clean: true,
  deps: {
    alwaysBundle: (id) =>
      id.startsWith("@ryco/") || id.startsWith("effect-acp") || isBundledRuntimePackage(id),
    // Bun's own modules (the Bun-runtime SQLite client) exist only under Bun.
    neverBundle: [/^bun:/],
    onlyBundle: false,
  },
  outputOptions: {
    // JSDoc is a large share of the bundled source and only costs parse time
    // and heap at boot. Legal and pure/side-effect annotations stay.
    comments: { legal: true, annotation: true, jsdoc: false },
  },
  // Keeps chunk sources Latin-1 so V8 stores them as one-byte strings. Skipped
  // for source-mapped (diagnostic) builds, whose columns it would shift.
  plugins: buildSourcemap ? [] : [latin1OutputPlugin()],
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
