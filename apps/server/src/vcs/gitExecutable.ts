// @effect-diagnostics nodeBuiltinImport:off - one `xcrun` child and `access` checks, outside any Effect service.
/**
 * gitExecutable - which binary Ryco spawns for `git`.
 *
 * Without a git of its own (Homebrew, Nix), macOS resolves `git` to /usr/bin/git: an xcrun shim
 * that finds the active developer directory on every run, about 8 ms per spawn against under
 * 3 ms for the git behind it (T3 Code #22759). When the first `git` on PATH is that shim, the git
 * behind it is spawned instead, located once with `xcrun --find git`, which honors
 * `DEVELOPER_DIR` and the `xcode-select` choice as the shim does. Only the shim is replaced, so a
 * git earlier on PATH still wins, and git's own children keep the same PATH. Any lookup failure
 * keeps plain `git`. Other platforms always spawn `git`.
 *
 * Answers are cached per PATH and `DEVELOPER_DIR`. A located binary is checked before each reuse,
 * so an Xcode update or removal looks again instead of failing the spawn; a "keep `git`" answer
 * expires after {@link GIT_EXECUTABLE_RECHECK_MS}, so a git installed later is picked up.
 *
 * @module gitExecutable
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { resolveCommandPathAsync } from "@ryco/shared/shell";

export const MACOS_GIT_SHIM = "/usr/bin/git";
export const GIT_EXECUTABLE_RECHECK_MS = 5 * 60_000;
const XCRUN_TIMEOUT_MS = 5_000;

export interface GitExecutableHost {
  readonly platform: NodeJS.Platform;
  /** The first executable `git` on `env.PATH`, or null. */
  readonly findGitOnPath: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** What `xcrun --find git` prints for `env`, or undefined when it fails. */
  readonly locateXcodeGit: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  readonly isExecutable: (filePath: string) => Promise<boolean>;
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

const defaultHost: GitExecutableHost = {
  platform: process.platform,
  findGitOnPath: (env) => resolveCommandPathAsync("git", { env, platform: "darwin" }),
  locateXcodeGit: locateXcodeGitWithXcrun,
  isExecutable: isExecutableFile,
  now: () => Date.now(),
};

interface CachedGitExecutable {
  /** The git behind the shim, or null to spawn plain `git`. */
  readonly command: string | null;
  readonly checkedAt: number;
}

/** A resolver of the command to spawn for `git` with `env`; never rejects. */
export function makeGitExecutableResolver(
  host: GitExecutableHost = defaultHost,
): (env: NodeJS.ProcessEnv) => Promise<string> {
  const cache = new Map<string, CachedGitExecutable>();
  const inFlight = new Map<string, Promise<string | null>>();

  const locate = async (env: NodeJS.ProcessEnv): Promise<string | null> => {
    if ((await host.findGitOnPath(env)) !== MACOS_GIT_SHIM) return null;
    const located = await host.locateXcodeGit(env);
    return located !== undefined && (await host.isExecutable(located)) ? located : null;
  };

  return async (env) => {
    if (host.platform !== "darwin") return "git";
    const key = `${env.PATH ?? ""}\u0000${env.DEVELOPER_DIR ?? ""}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      if (cached.command === null) {
        if (host.now() - cached.checkedAt < GIT_EXECUTABLE_RECHECK_MS) return "git";
      } else if (await host.isExecutable(cached.command)) {
        return cached.command;
      }
    }
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = locate(env)
        .catch(() => null)
        .then((command) => {
          cache.set(key, { command, checkedAt: host.now() });
          return command;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return (await pending) ?? "git";
  };
}

/** The command to spawn for `git` with the child environment `env`. */
export const resolveGitExecutable: (env: NodeJS.ProcessEnv) => Promise<string> =
  makeGitExecutableResolver();
