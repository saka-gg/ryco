/**
 * compileCache - Node's on-disk V8 module compile cache for the server process.
 *
 * `bin.ts` enables the cache before the server graph is imported, so the whole
 * graph compiles from cached bytecode on later launches. Node writes the cache
 * when the process exits normally; flushing after startup keeps it even when a
 * later shutdown is killed. Both are optimizations only and never throw.
 *
 * @module compileCache
 */
import * as NodeModule from "node:module";

/**
 * Ryco Desktop's per-version, pruned compile cache directory. Desktop hands it
 * to its own children (backend, MCP bridge) through their `--require` hook.
 * {@link enableCompileCacheBestEffort} consumes it and removes it from the
 * environment, so provider CLIs, agents and terminals the process starts never
 * inherit it: a Ryco CLI or dev server an agent runs (under Homebrew Node or
 * Bun) must not fill the packaged app's cache, which only app updates prune.
 */
export const DESKTOP_COMPILE_CACHE_DIR_ENV = "RYCO_COMPILE_CACHE_DIR";

/** The explicit cache directory to use, or `undefined` for Node's default. */
export function resolveCompileCacheDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const directory = env[DESKTOP_COMPILE_CACHE_DIR_ENV]?.trim();
  return directory ? directory : undefined;
}

/**
 * Persists compiled bytecode across launches (keyed by file content and the
 * engine version, so updates invalidate it) in {@link resolveCompileCacheDirectory},
 * else `NODE_COMPILE_CACHE` or the OS temp dir. A process Desktop already
 * started with its compile cache hook keeps that cache. Then drops
 * {@link DESKTOP_COMPILE_CACHE_DIR_ENV} from `env`, so child processes do not
 * inherit it. `NODE_DISABLE_COMPILE_CACHE=1` turns the cache off; runtimes
 * without the API skip it.
 */
export function enableCompileCacheBestEffort(
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    (
      NodeModule as { readonly enableCompileCache?: (directory?: string) => unknown }
    ).enableCompileCache?.(resolveCompileCacheDirectory(env));
  } catch {
    // The cache is an optimization only.
  }
  delete env[DESKTOP_COMPILE_CACHE_DIR_ENV];
}

export function flushCompileCacheBestEffort(): void {
  try {
    // Absent on runtimes and Node releases without the compile cache API.
    (NodeModule as { readonly flushCompileCache?: () => void }).flushCompileCache?.();
  } catch {
    // Cache persistence is an optimization only.
  }
}
