import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * The V8 compile cache directory, handed to `compileCache.cjs` in the Electron
 * main process and in every Node-mode child started with `--require`. Unlike
 * `NODE_COMPILE_CACHE`, Node ignores it, so third-party Node programs the
 * backend spawns (provider CLIs, terminals) never write into Ryco's cache.
 */
export const DESKTOP_COMPILE_CACHE_DIR_ENV = "RYCO_COMPILE_CACHE_DIR";

const COMPILE_CACHE_ROOT_NAME = "compile-cache";

/** One directory per app version: an update starts a fresh cache and the old one is pruned. */
export function resolveDesktopCompileCacheDir(userDataPath: string, appVersion: string): string {
  return Path.join(userDataPath, COMPILE_CACHE_ROOT_NAME, sanitizeVersion(appVersion));
}

function sanitizeVersion(version: string): string {
  const sanitized = version.replace(/[^0-9A-Za-z._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

/**
 * Whether this launch should use a compile cache at all. AppImage mounts the
 * app at a new random path on every launch, so cache entries would never be
 * hit again and would only accumulate.
 */
export function shouldUseDesktopCompileCache(input: {
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
}): boolean {
  return input.isPackaged && !input.env.APPIMAGE;
}

/** Remove caches left by earlier app versions. Never throws. */
export async function pruneStaleDesktopCompileCaches(currentDir: string): Promise<number> {
  const root = Path.dirname(currentDir);
  const current = Path.basename(currentDir);
  let removed = 0;
  try {
    for (const entry of await FS.promises.readdir(root)) {
      if (entry === current) continue;
      await FS.promises.rm(Path.join(root, entry), { recursive: true, force: true });
      removed += 1;
    }
  } catch {
    // Nothing to prune, or the directory is gone; the next launch tries again.
  }
  return removed;
}
