import { describe, expect, it } from "vite-plus/test";

import {
  GIT_EXECUTABLE_RECHECK_MS,
  type GitExecutableHost,
  makeGitExecutableResolver,
  MACOS_GIT_SHIM,
  shimEnvironmentChanges,
} from "./gitExecutable.ts";

const XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";
const SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
const env = { PATH: "/usr/bin:/bin" };
/** What the shim's environment alias prints on a Mac with the Command Line Tools. */
const SHIM_ENV_OUTPUT = [
  "PATH=/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core:/usr/bin:/bin",
  `SDKROOT=${SDK}`,
  "CPATH=/usr/local/include",
  "LIBRARY_PATH=/usr/local/lib",
  `MANPATH=${SDK}/usr/share/man`,
  "GIT_EXEC_PATH=/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core",
  "",
].join("\n");

/** Files that exist, the git first on PATH, and what `xcrun --find git` prints. */
function setup(options: {
  readonly platform?: NodeJS.Platform;
  readonly gitOnPath: string | null;
  readonly xcrunGit: string | undefined;
}) {
  const host = {
    files: new Set([options.gitOnPath, options.xcrunGit].filter((file) => file != null)),
    gitOnPath: options.gitOnPath,
    xcrunGit: options.xcrunGit,
    xcrunCalls: 0,
    asyncChecks: 0,
    now: 1_000,
  };
  const resolve = makeGitExecutableResolver({
    platform: options.platform ?? "darwin",
    findGitOnPath: async () => host.gitOnPath,
    locateXcodeGit: async () => {
      host.xcrunCalls += 1;
      return host.xcrunGit;
    },
    readShimEnvironment: async () => SHIM_ENV_OUTPUT,
    isExecutable: async (filePath) => {
      host.asyncChecks += 1;
      return host.files.has(filePath);
    },
    isExecutableNow: (filePath) => host.files.has(filePath),
    now: () => host.now,
  } satisfies GitExecutableHost);
  const command = async (input: NodeJS.ProcessEnv = env) => (await resolve(input)).command;
  return { host, resolve, command };
}

describe("resolveGitExecutable", () => {
  it("spawns the git behind the xcrun shim and looks it up once", async () => {
    const { host, command } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await command()).toBe(XCODE_GIT);
    expect(await command()).toBe(XCODE_GIT);
    expect(host.xcrunCalls).toBe(1);
  });

  it("gives the located git the developer environment the shim sets", async () => {
    const { resolve } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect((await resolve(env)).env).toEqual({
      SDKROOT: SDK,
      CPATH: "/usr/local/include",
      LIBRARY_PATH: "/usr/local/lib",
      MANPATH: `${SDK}/usr/share/man`,
    });
  });

  it("looks up concurrent first spawns once", async () => {
    const { host, command } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await Promise.all([command(), command(), command()])).toEqual([
      XCODE_GIT,
      XCODE_GIT,
      XCODE_GIT,
    ]);
    expect(host.xcrunCalls).toBe(1);
  });

  it("keeps git when PATH has another git first or the host is not macOS", async () => {
    const homebrew = setup({ gitOnPath: "/opt/homebrew/bin/git", xcrunGit: XCODE_GIT });
    expect(await homebrew.resolve(env)).toEqual({ command: "git", env: {} });
    expect(homebrew.host.xcrunCalls).toBe(0);

    const linux = setup({ platform: "linux", gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await linux.command()).toBe("git");
    expect(linux.host.xcrunCalls).toBe(0);
  });

  it("keeps git when xcrun fails or names a missing file", async () => {
    const failed = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: undefined });
    expect(await failed.command()).toBe("git");

    const missing = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    missing.host.files.delete(XCODE_GIT);
    expect(await missing.command()).toBe("git");
  });

  it("looks again at once when the located git disappears", async () => {
    const betaGit = "/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git";
    const { host, command } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await command()).toBe(XCODE_GIT);

    host.files.delete(XCODE_GIT);
    host.files.add(betaGit);
    host.xcrunGit = betaGit;
    expect(await command()).toBe(betaGit);
    expect(host.xcrunCalls).toBe(2);
  });

  it("reuses a located git with a synchronous check only", async () => {
    const { host, command } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    await command();
    const checks = host.asyncChecks;
    await command();
    await command();
    // No thread-pool work per spawn: only the lookup itself used the async check.
    expect(host.asyncChecks).toBe(checks);
  });

  it("checks a plain-git answer again after the recheck interval", async () => {
    const { host, command } = setup({ gitOnPath: "/opt/homebrew/bin/git", xcrunGit: XCODE_GIT });
    expect(await command()).toBe("git");
    // The Homebrew git is uninstalled: the shim is first on PATH now.
    host.gitOnPath = MACOS_GIT_SHIM;
    host.now += GIT_EXECUTABLE_RECHECK_MS - 1;
    expect(await command()).toBe("git");
    host.now += 1;
    expect(await command()).toBe(XCODE_GIT);
  });

  it("checks a located git again after the recheck interval", async () => {
    const { host, command } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await command()).toBe(XCODE_GIT);
    // Homebrew git installed while Ryco runs: it is first on PATH now.
    host.gitOnPath = "/opt/homebrew/bin/git";
    host.now += GIT_EXECUTABLE_RECHECK_MS - 1;
    expect(await command()).toBe(XCODE_GIT);
    host.now += 1;
    expect(await command()).toBe("git");
  });

  it("caches per PATH and DEVELOPER_DIR", async () => {
    const { host, command } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    await command(env);
    await command({ ...env, DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer" });
    await command({ PATH: "/bin:/usr/bin" });
    expect(host.xcrunCalls).toBe(3);
  });
});

describe("shimEnvironmentChanges", () => {
  it("keeps only the developer variables the shim changed", () => {
    expect(
      shimEnvironmentChanges(SHIM_ENV_OUTPUT, { SDKROOT: SDK, CPATH: "/opt/include" }),
    ).toEqual({
      CPATH: "/usr/local/include",
      LIBRARY_PATH: "/usr/local/lib",
      MANPATH: `${SDK}/usr/share/man`,
    });
    expect(shimEnvironmentChanges(undefined, {})).toEqual({});
  });
});
