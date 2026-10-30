import { describe, expect, it } from "vite-plus/test";

import {
  GIT_EXECUTABLE_RECHECK_MS,
  type GitExecutableHost,
  makeGitExecutableResolver,
  MACOS_GIT_SHIM,
} from "./gitExecutable.ts";

const XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";
const env = { PATH: "/usr/bin:/bin" };

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
    now: 1_000,
  };
  const resolve = makeGitExecutableResolver({
    platform: options.platform ?? "darwin",
    findGitOnPath: async () => host.gitOnPath,
    locateXcodeGit: async () => {
      host.xcrunCalls += 1;
      return host.xcrunGit;
    },
    isExecutable: async (filePath) => host.files.has(filePath),
    now: () => host.now,
  } satisfies GitExecutableHost);
  return { host, resolve };
}

describe("resolveGitExecutable", () => {
  it("spawns the git behind the xcrun shim and looks it up once", async () => {
    const { host, resolve } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await resolve(env)).toBe(XCODE_GIT);
    expect(await resolve(env)).toBe(XCODE_GIT);
    expect(host.xcrunCalls).toBe(1);
  });

  it("looks up concurrent first spawns once", async () => {
    const { host, resolve } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await Promise.all([resolve(env), resolve(env), resolve(env)])).toEqual([
      XCODE_GIT,
      XCODE_GIT,
      XCODE_GIT,
    ]);
    expect(host.xcrunCalls).toBe(1);
  });

  it("keeps git when PATH has another git first or the host is not macOS", async () => {
    const homebrew = setup({ gitOnPath: "/opt/homebrew/bin/git", xcrunGit: XCODE_GIT });
    expect(await homebrew.resolve(env)).toBe("git");
    expect(homebrew.host.xcrunCalls).toBe(0);

    const linux = setup({ platform: "linux", gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await linux.resolve(env)).toBe("git");
    expect(linux.host.xcrunCalls).toBe(0);
  });

  it("keeps git when xcrun fails or names a missing file", async () => {
    const failed = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: undefined });
    expect(await failed.resolve(env)).toBe("git");

    const missing = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    missing.host.files.delete(XCODE_GIT);
    expect(await missing.resolve(env)).toBe("git");
  });

  it("looks again when the located git disappears", async () => {
    const betaGit = "/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git";
    const { host, resolve } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    expect(await resolve(env)).toBe(XCODE_GIT);

    host.files.delete(XCODE_GIT);
    host.files.add(betaGit);
    host.xcrunGit = betaGit;
    expect(await resolve(env)).toBe(betaGit);
    expect(host.xcrunCalls).toBe(2);
  });

  it("checks a plain-git answer again after the recheck interval", async () => {
    const { host, resolve } = setup({ gitOnPath: "/opt/homebrew/bin/git", xcrunGit: XCODE_GIT });
    expect(await resolve(env)).toBe("git");
    // The Homebrew git is uninstalled: the shim is first on PATH now.
    host.gitOnPath = MACOS_GIT_SHIM;
    host.now += GIT_EXECUTABLE_RECHECK_MS - 1;
    expect(await resolve(env)).toBe("git");
    host.now += 1;
    expect(await resolve(env)).toBe(XCODE_GIT);
  });

  it("caches per PATH and DEVELOPER_DIR", async () => {
    const { host, resolve } = setup({ gitOnPath: MACOS_GIT_SHIM, xcrunGit: XCODE_GIT });
    await resolve(env);
    await resolve({ ...env, DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer" });
    await resolve({ PATH: "/bin:/usr/bin" });
    expect(host.xcrunCalls).toBe(3);
  });
});
