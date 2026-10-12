import { parseOptInSourcemapEnv, readEnv } from "@ryco/shared/runtimeEnv";
import { defineConfig } from "tsdown";

import { latin1OutputPlugin } from "./scripts/latin1Output.ts";
import { isBundledPatchedPackageImport } from "./scripts/patchedPackages.ts";

const buildSourcemap = parseOptInSourcemapEnv(readEnv("RYCO_SERVER_SOURCEMAP"));

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
      id.startsWith("@ryco/") || id.startsWith("effect-acp") || isBundledPatchedPackageImport(id),
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
