/**
 * Enable Node's on-disk V8 compile cache for the current process.
 *
 * Built as its own `compileCache.cjs` entry: the Electron main process requires
 * it before the main bundle, and the backend and MCP bridge children load it
 * with `--require`, ahead of their (ESM) module graph. The directory comes from
 * the environment because Node-mode children cannot ask Electron for paths.
 */
import { enableCompileCache } from "node:module";

import { DESKTOP_COMPILE_CACHE_DIR_ENV } from "./compileCacheDirectory.ts";

const directory = process.env[DESKTOP_COMPILE_CACHE_DIR_ENV]?.trim();
if (directory) {
  try {
    enableCompileCache(directory);
  } catch {
    // An unwritable cache only costs the speedup.
  }
}
