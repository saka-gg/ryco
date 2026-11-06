import { execFile } from "node:child_process";
import { basename } from "node:path";

/**
 * The user-facing app name for an executable path: the outermost `.app`
 * bundle's name (so a helper inside `Google Chrome.app` reads as Google
 * Chrome), else the executable's file name.
 */
export function appNameFromExecutablePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const bundle = /(?:^|\/)([^/]+)\.app(?:\/|$)/u.exec(trimmed);
  if (bundle?.[1]) return bundle[1];
  return basename(trimmed) || null;
}

const MAX_CACHED = 64;
const cache = new Map<number, Promise<string | null>>();

/**
 * Resolves a process id to its app name for status text. Cached per pid
 * (bounded); a failed lookup resolves to null and is retried next time.
 */
export function appNameForPid(pid: number): Promise<string | null> {
  const cached = cache.get(pid);
  if (cached) return cached;
  const lookup = new Promise<string | null>((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "comm=", "-p", String(pid)],
      { timeout: 2_000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        const name = error ? null : appNameFromExecutablePath(stdout);
        if (name === null) cache.delete(pid);
        resolve(name);
      },
    );
  });
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(pid, lookup);
  return lookup;
}
