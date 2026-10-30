// @effect-diagnostics nodeBuiltinImport:off - one `xcrun` child and `access` checks, outside any Effect service.
/**
 * gitExecutable - which binary Ryco spawns for `git`.
 *
 * Without a git of its own (Homebrew, Nix), macOS resolves `git` to /usr/bin/git: an xcrun shim
 * that finds the active developer directory on every run, about 8 ms per spawn against under
 * 3 ms for the git behind it (T3 Code #22759). When the first `git` on PATH is that shim, the git
 * behind it is spawned instead, located once with `xcrun --find git`, which honors
 * `DEVELOPER_DIR` and the `xcode-select` choice as the shim does. Only the shim is replaced, so a
 * git earlier on PATH still wins. Any lookup failure keeps plain `git`. Other platforms always
 * spawn `git`.
 *
 * The shim also gives git the developer environment (`SDKROOT`, `CPATH`, `LIBRARY_PATH`,
 * `MANPATH`), which git passes on to hooks, aliases, filters and credential helpers: a hook that
 * builds native code may rely on it. So the lookup also runs the shim once with an alias that
 * prints its environment, and those variables (where the shim changed them) are added to every
 * spawn of the located git. Git's own children otherwise see what they saw through the shim.
 *
 * Answers are cached per PATH and `DEVELOPER_DIR` and looked up again after
 * {@link GIT_EXECUTABLE_RECHECK_MS} either way, so installing another git or switching Xcode is
 * picked up. A located binary is also checked before each reuse (synchronously: it is a local
 * file, and the check must never wait behind the thread pool), so an Xcode update or removal
 * looks again at once instead of failing the spawn.
 *
 * @module gitExecutable
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

import { resolveCommandPathAsync } from "@ryco/shared/shell";

export const MACOS_GIT_SHIM = "/usr/bin/git";
export const GIT_EXECUTABLE_RECHECK_MS = 5 * 60_000;
const XCRUN_TIMEOUT_MS = 5_000;
/** The variables the shim sets for git (observed: xcrun's developer environment). */
export const SHIM_ENVIRONMENT_VARIABLES = ["SDKROOT", "CPATH", "LIBRARY_PATH", "MANPATH"] as const;

/** What to spawn for `git`, and the variables to add to its environment. */
export interface GitExecutable {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

const PLAIN_GIT: GitExecutable = { command: "git", env: {} };

export interface GitExecutableHost {
  readonly platform: NodeJS.Platform;
  /** The first executable `git` on `env.PATH`, or null. */
  readonly findGitOnPath: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** What `xcrun --find git` prints for `env`, or undefined when it fails. */
  readonly locateXcodeGit: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  /** The environment the shim gives git's children (`KEY=value` lines), or undefined. */
  readonly readShimEnvironment: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  readonly isExecutable: (filePath: string) => Promise<boolean>;
  /** The same check, synchronous, for a located binary before each reuse. */
  readonly isExecutableNow: (filePath: string) => boolean;
  readonly now: () => number;
}

const isExecutableFile = (filePath: string) =>
  access(filePath, constants.X_OK).then(
    () => true,
    () => false,
  );

const locateXcodeGitWithXcrun = (env: NodeJS.ProcessEnv) =>
  new Promise<string | undefined>((resolve) => {
    execFile(
      "/usr/bin/xcrun",
      ["--find", "git"],
      { env, timeout: XCRUN_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        const located = error ? "" : stdout.trim();
        resolve(isAbsolute(located) ? located : undefined);
      },
    );
  });

// An alias runs through a shell, after the shim and git set up its environment.
const readShimEnvironmentWithAlias = (env: NodeJS.ProcessEnv) =>
  new Promise<string | undefined>((resolve) => {
    execFile(
      MACOS_GIT_SHIM,
      ["-c", "alias.ryco-shim-env=!env", "ryco-shim-env"],
      { env, cwd: tmpdir(), timeout: XCRUN_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });

const isExecutableFileNow = (filePath: string) => {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultHost: GitExecutableHost = {
  platform: process.platform,
  findGitOnPath: (env) => resolveCommandPathAsync("git", { env, platform: "darwin" }),
  locateXcodeGit: locateXcodeGitWithXcrun,
  readShimEnvironment: readShimEnvironmentWithAlias,
  isExecutable: isExecutableFile,
  isExecutableNow: isExecutableFileNow,
  now: () => Date.now(),
};

/** The {@link SHIM_ENVIRONMENT_VARIABLES} the shim set to something other than `env` had. */
export function shimEnvironmentChanges(
  output: string | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const line of (output ?? "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      (SHIM_ENVIRONMENT_VARIABLES as ReadonlyArray<string>).includes(name) &&
      env[name] !== value
    ) {
      changes[name] = value;
    }
  }
  return changes;
}

interface CachedGitExecutable {
  /** The git behind the shim with its environment, or null to spawn plain `git`. */
  readonly executable: GitExecutable | null;
  readonly checkedAt: number;
}

/** A resolver of what to spawn for `git` with `env`; never rejects. */
export function makeGitExecutableResolver(
  host: GitExecutableHost = defaultHost,
): (env: NodeJS.ProcessEnv) => Promise<GitExecutable> {
  const cache = new Map<string, CachedGitExecutable>();
  const inFlight = new Map<string, Promise<GitExecutable | null>>();

  const locate = async (env: NodeJS.ProcessEnv): Promise<GitExecutable | null> => {
    if ((await host.findGitOnPath(env)) !== MACOS_GIT_SHIM) return null;
    const located = await host.locateXcodeGit(env);
    if (located === undefined || !(await host.isExecutable(located))) return null;
    return {
      command: located,
      env: shimEnvironmentChanges(await host.readShimEnvironment(env), env),
    };
  };

  return async (env) => {
    if (host.platform !== "darwin") return PLAIN_GIT;
    const key = `${env.PATH ?? ""}\u0000${env.DEVELOPER_DIR ?? ""}`;
    const cached = cache.get(key);
    if (cached !== undefined && host.now() - cached.checkedAt < GIT_EXECUTABLE_RECHECK_MS) {
      if (cached.executable === null) return PLAIN_GIT;
      if (host.isExecutableNow(cached.executable.command)) return cached.executable;
    }
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = locate(env)
        .catch(() => null)
        .then((executable) => {
          cache.set(key, { executable, checkedAt: host.now() });
          return executable;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return (await pending) ?? PLAIN_GIT;
  };
}

/** What to spawn for `git` with the child environment `env`. */
export const resolveGitExecutable: (env: NodeJS.ProcessEnv) => Promise<GitExecutable> =
  makeGitExecutableResolver();
