import { afterEach, describe, expect, it } from "@effect/vitest";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import os from "node:os";
import path from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@ryco/contracts";
import { Effect, Layer, Sink, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  clearLatestProviderVersionCacheForTests,
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  homebrewOwnershipFromCommandPath,
  installerLatestVersionCacheKey,
  makeLazyProviderMaintenanceCapabilities,
  makeMaintenanceChildProcess,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  parseHomebrewLatestVersion,
  resolveLatestProviderUpdateAction,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type HomebrewInstall,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceResolutionContext,
} from "./providerMaintenance.ts";
import {
  codexHomeFromStandaloneCommandPath,
  makeCodexMaintenanceResolver,
} from "./Drivers/CodexDriver.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
// These write `#!/bin/sh` stubs and resolve them with POSIX path semantics.
const windowsHost = process.platform === "win32";
const makeTempDir = Effect.fn("makeTempDir")(function* (name: string) {
  const id = yield* Effect.sync(() => crypto.randomUUID());
  // The real tmpdir, so expectations match realpath'd results (`/var` → `/private/var`).
  return path.join(realpathSync(os.tmpdir()), `${name}-${id}`);
});
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolDefinition: PackageManagedProviderMaintenanceDefinition = {
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  nativeUpdate: null,
};
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver(packageToolDefinition);
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
const claudeLikeDefinition: PackageManagedProviderMaintenanceDefinition = {
  provider: driver("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: (commandPath) => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/.local/bin/claude") || normalized.endsWith("/.local/bin/claude.exe")
      );
    },
  },
};
const staticToolUpdate = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: driver("staticTool"),
    packageName: null,
    updateExecutable: "static-tool",
    updateArgs: ["update"],
    updateLockKey: "static-tool",
  }),
);
const manualPackageTool: ProviderMaintenanceCapabilities = {
  provider: driver("packageTool"),
  packageName: "@example/package-tool",
  update: null,
};
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("packageTool"),
  driver: driver("packageTool"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

function writeExecutable(filePath: string, contents = "#!/bin/sh\n") {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

/** `<tempDir>/bin/<name>` → `<tempDir>/<packageSegments>/bin/<name>.js`, as package managers link. */
function linkIntoPackage(tempDir: string, name: string, packageSegments: ReadonlyArray<string>) {
  const target = path.join(tempDir, ...packageSegments, "bin", `${name}.js`);
  writeExecutable(target);
  const link = path.join(tempDir, "bin", name);
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link);
  return link;
}

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("maintenance resolution should not spawn a process here"),
);

function stdoutSpawner(
  onSpawn: (command: string, args: ReadonlyArray<string>) => string,
  exitCodeOf: (args: ReadonlyArray<string>) => number = () => 0,
) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCodeOf(args))),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

const dyingHttpClient = (reason: string) => HttpClient.make(() => Effect.die(reason));
const npmRegistryHttpClient = (version: string) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version }))),
  );

/** Resolve `binaryPath` like a driver does, with the given spawner standing in for installers. */
const resolveWith = (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] = noSpawn,
) =>
  resolveProviderMaintenanceCapabilitiesEffect(resolver, options).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(NodeServices.layer),
  );

/** Resolve a fixed context (paths need not exist), for path-shape rules. */
const resolveContext = (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: Omit<ProviderMaintenanceResolutionContext, "binaryPath" | "env"> &
    Partial<Pick<ProviderMaintenanceResolutionContext, "binaryPath" | "env">>,
) =>
  resolvePackageManagedProviderMaintenance(definition, {
    binaryPath: "tool",
    env: {},
    ...context,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
    Effect.provide(NodeServices.layer),
  );

afterEach(() => {
  clearLatestProviderVersionCacheForTests();
});

describe("providerMaintenance", () => {
  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it.effect("skips latest-version resolution when provider update checks are disabled", () => {
    let httpRequested = false;
    const trackingHttpClient = HttpClient.make((request) => {
      httpRequested = true;
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response('{"version":"9.9.9"}', { status: 200 })),
      );
    });

    return Effect.gen(function* () {
      const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
        installedPackageToolProvider,
        manualPackageTool,
      );
      // The registry is never contacted, and latest stays unknown even though a
      // newer version would have been reported had the checker run.
      expect(httpRequested).toBe(false);
      expect(enriched.versionAdvisory).toMatchObject({
        status: "unknown",
        currentVersion: "1.0.0",
        latestVersion: null,
      });
    }).pipe(
      Effect.provide(ServerSettingsService.layerTest({ enableProviderUpdateChecks: false })),
      Effect.provideService(HttpClient.HttpClient, trackingHttpClient),
    );
  });

  it("offers the update when an owned install is behind", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@example/package-tool@latest"],
          updateLockKey: "npm-global:/usr/local",
        }),
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.110",
      latestVersion: "2.1.117",
      updateCommand: "npm install -g @example/package-tool@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("names the install to update when it is behind but Ryco cannot update it", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: {
          ...manualPackageTool,
          installPath: "/Applications/Tool.app/Contents/Resources/bin/package-tool",
        },
      }),
    ).toMatchObject({
      status: "behind_latest",
      latestVersion: "2.1.117",
      updateCommand: null,
      canUpdate: false,
      message:
        "Version 2.1.117 is out. Ryco runs /Applications/Tool.app/Contents/Resources/bin/package-tool; update it with the app or tool that installed it.",
    });
  });

  it("pins the advertised stable version in a pnpm-global update command", () => {
    const pnpmTool = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateExecutable: "pnpm",
      updateArgs: [
        "add",
        "-g",
        "--allow-build=@example/package-tool",
        "@example/package-tool@latest",
      ],
      updateLockKey: "pnpm-global",
    });
    const advisoryCommand = (
      capabilities: ProviderMaintenanceCapabilities,
      latestVersion: string,
    ) =>
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion,
        maintenanceCapabilities: capabilities,
      }).updateCommand;

    expect(advisoryCommand(pnpmTool, "1.1.0")).toBe(
      "pnpm add -g --allow-build=@example/package-tool @example/package-tool@1.1.0",
    );
    expect(resolveLatestProviderUpdateAction(pnpmTool, "1.1.0")?.args).toEqual([
      "add",
      "-g",
      "--allow-build=@example/package-tool",
      "@example/package-tool@1.1.0",
    ]);
    // A prerelease cannot be pinned safely, so pnpm keeps @latest.
    expect(advisoryCommand(pnpmTool, "1.1.0-beta.1")).toBe(
      "pnpm add -g --allow-build=@example/package-tool @example/package-tool@latest",
    );
    // Only pnpm's minimumReleaseAge skips fresh releases; npm keeps @latest.
    expect(
      advisoryCommand(
        makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@example/package-tool@latest"],
          updateLockKey: "npm-global:/opt/node",
        }),
        "1.1.0",
      ),
    ).toBe("npm install -g @example/package-tool@latest");
  });

  it.effect("keeps update commands owned by static provider maintenance capabilities", () =>
    Effect.gen(function* () {
      expect(yield* staticToolUpdate.resolve(null)).toEqual({
        provider: driver("staticTool"),
        packageName: null,
        update: {
          command: "static-tool update",
          executable: "static-tool",
          args: ["update"],
          lockKey: "static-tool",
        },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("quotes copyable command words the shell would split", () => {
    const posix = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        "/Users/Jane Doe/.npm-global",
        "@example/package-tool@latest",
      ],
      updateLockKey: "npm-global",
      platform: "darwin",
    });
    expect(posix.update?.command).toBe(
      "npm install -g --prefix '/Users/Jane Doe/.npm-global' @example/package-tool@latest",
    );
    const windows = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: null,
      updateExecutable: "C:\\Program Files\\Tool\\tool.exe",
      updateArgs: ["update"],
      updateLockKey: "tool",
      platform: "win32",
    });
    expect(windows.update?.command).toBe("& 'C:\\Program Files\\Tool\\tool.exe' update");
  });

  describe("Windows spawning", () => {
    it("runs package-manager shims through cmd.exe as one quoted command line", () => {
      const npm = makeMaintenanceChildProcess({
        command: "npm",
        args: ["install", "-g", "--prefix", "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm", "x@1"],
        platform: "win32",
      });
      expect(npm).toMatchObject({
        command: 'npm install -g --prefix "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm" x@1',
        args: [],
        options: { shell: true },
      });
      const shim = makeMaintenanceChildProcess({
        command: "C:\\Program Files\\nodejs\\pnpm.CMD",
        args: ["--version"],
        platform: "win32",
      });
      expect(shim).toMatchObject({
        command: '"C:\\Program Files\\nodejs\\pnpm.CMD" --version',
        args: [],
        options: { shell: true },
      });
    });

    it("spawns real executables and every POSIX command directly", () => {
      const exe = makeMaintenanceChildProcess({
        command: "C:\\Users\\me\\.local\\bin\\claude.exe",
        args: ["update"],
        platform: "win32",
      });
      expect(exe).toMatchObject({
        command: "C:\\Users\\me\\.local\\bin\\claude.exe",
        args: ["update"],
      });
      expect(exe.options.shell).toBeUndefined();
      expect(
        makeMaintenanceChildProcess({
          command: "npm",
          args: ["install", "-g", "x@latest"],
          env: { CODEX_HOME: "/home/me/.codex" },
          platform: "linux",
        }),
      ).toMatchObject({
        command: "npm",
        args: ["install", "-g", "x@latest"],
        options: { env: { CODEX_HOME: "/home/me/.codex" }, extendEnv: true },
      });
    });
  });

  describe("install ownership", () => {
    it.effect("stays manual-only when the binary cannot be located", () =>
      Effect.gen(function* () {
        // A bare name that resolves nowhere is not evidence of npm.
        expect(
          yield* resolveWith(packageToolUpdate, { binaryPath: "package-tool", env: { PATH: "" } }),
        ).toEqual(manualPackageTool);
        expect(yield* resolveWith(packageToolUpdate, { binaryPath: null })).toEqual(
          manualPackageTool,
        );
      }),
    );

    it.effect.skipIf(windowsHost)(
      "pins npm updates to the global prefix that owns the package",
      () =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-npm-capabilities");
          const link = linkIntoPackage(tempDir, "package-tool", [
            "lib",
            "node_modules",
            "@example",
            "package-tool",
          ]);

          const capabilities = yield* resolveWith(packageToolUpdate, {
            binaryPath: link,
            env: { PATH: "" },
          });

          expect(capabilities).toEqual({
            provider: driver("packageTool"),
            packageName: "@example/package-tool",
            update: {
              command: `npm install -g --prefix ${tempDir} --allow-scripts=@example/package-tool @example/package-tool@latest`,
              executable: "npm",
              args: [
                "install",
                "-g",
                "--prefix",
                tempDir,
                "--allow-scripts=@example/package-tool",
                "@example/package-tool@latest",
              ],
              lockKey: `npm-global:${normalizeCommandPath(tempDir)}`,
            },
          });
        }),
    );

    it("derives the npm prefix only from the global lib/node_modules layout", () => {
      expect(
        npmGlobalPrefixFromCommandPath(
          "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
          "@openai/codex",
        ),
      ).toBe("/usr/local");
      expect(
        npmGlobalPrefixFromCommandPath(
          "/usr/local/lib/node_modules/other/node_modules/@openai/codex/bin/codex.js",
          "@openai/codex",
        ),
      ).toBeNull();
      expect(
        npmGlobalPrefixFromCommandPath(
          "/lib/node_modules/@openai/codex/bin/codex.js",
          "@openai/codex",
        ),
      ).toBe("/");
      // A project-local install (`node_modules/.bin`) is not a global prefix.
      expect(
        npmGlobalPrefixFromCommandPath(
          "/work/app/node_modules/@openai/codex/bin/codex.js",
          "@openai/codex",
        ),
      ).toBeNull();
      // Mise's npm backend uses a global-looking layout inside a tool version.
      expect(
        npmGlobalPrefixFromCommandPath(
          "/home/me/.local/share/mise/installs/npm-openai-codex/0.1.0/lib/node_modules/@openai/codex/bin/codex.js",
          "@openai/codex",
        ),
      ).toBeNull();
      expect(
        npmGlobalPrefixFromCommandPath(
          "/home/me/.local/share/mise/installs/node/22.1.0/lib/node_modules/@openai/codex/bin/codex.js",
          "@openai/codex",
        ),
      ).toBe("/home/me/.local/share/mise/installs/node/22.1.0");
    });

    it.effect("keeps a project-local node_modules/.bin install manual-only", () =>
      Effect.gen(function* () {
        const capabilities = yield* resolveContext(packageToolDefinition, {
          resolvedCommandPath: "/work/app/node_modules/.bin/package-tool",
          realCommandPath: "/work/app/node_modules/@example/package-tool/bin/package-tool.js",
          platform: "linux",
        });
        expect(capabilities.update).toBeNull();
      }),
    );

    it.effect("proves Windows npm ownership from the package manifest beside the shim", () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("ryco-npm-windows-capabilities");
        const shim = path.join(tempDir, "package-tool.cmd");
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(shim, "@echo off\r\n");
        const manifestDir = path.join(tempDir, "node_modules", "@example", "package-tool");
        mkdirSync(manifestDir, { recursive: true });
        writeFileSync(path.join(manifestDir, "package.json"), "{}");

        const capabilities = yield* resolveWith(packageToolUpdate, {
          binaryPath: shim,
          platform: "win32",
          env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        });
        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: [
            "install",
            "-g",
            "--prefix",
            tempDir,
            "--allow-scripts=@example/package-tool",
            "@example/package-tool@latest",
          ],
          lockKey: `npm-global:${normalizeCommandPath(tempDir)}`,
        });

        // A POSIX project checkout has the same shape and stays manual.
        if (windowsHost) return;
        const script = path.join(tempDir, "package-tool");
        writeExecutable(script);
        const posix = yield* resolveWith(packageToolUpdate, {
          binaryPath: script,
          platform: "linux",
          env: { PATH: "" },
        });
        expect(posix.update).toBeNull();
      }),
    );

    it.effect.skipIf(windowsHost)(
      "prefers npm ownership over the Node keg the package lives under",
      () =>
        Effect.gen(function* () {
          // `brew install node` keeps npm globals inside the node keg.
          const tempDir = yield* makeTempDir("ryco-homebrew-node-capabilities");
          const keg = path.join(tempDir, "Cellar", "node", "22.1.0");
          const link = linkIntoPackage(keg, "package-tool", [
            "lib",
            "node_modules",
            "@example",
            "package-tool",
          ]);

          const capabilities = yield* resolveWith(packageToolUpdate, {
            binaryPath: link,
            env: { PATH: "" },
          });
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining(["--prefix", keg]),
            lockKey: `npm-global:${normalizeCommandPath(keg)}`,
          });
        }),
    );

    it.effect.skipIf(windowsHost)(
      "switches to pnpm updates and approves install scripts on pnpm 10.4+",
      () =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-pnpm-capabilities");
          const link = linkIntoPackage(tempDir, "package-tool", [
            ".local",
            "share",
            "pnpm",
            "global",
            "5",
            "node_modules",
            "@example",
            "package-tool",
          ]);
          const updateFor = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
            resolveWith(packageToolUpdate, { binaryPath: link, env: { PATH: "" } }, spawner).pipe(
              Effect.map((capabilities) => capabilities.update),
            );
          const pnpmVersion = (version: string) =>
            stdoutSpawner((command, args) => {
              expect([command, ...args].join(" ")).toBe("pnpm --version");
              return `${version}\n`;
            });

          expect(yield* updateFor(pnpmVersion("11.1.3"))).toMatchObject({
            command: "pnpm add -g --allow-build=@example/package-tool @example/package-tool@latest",
            lockKey: "pnpm-global",
          });
          // Older pnpm rejects the unknown flag, and runs install scripts before 10.
          expect((yield* updateFor(pnpmVersion("10.3.0")))?.command).toBe(
            "pnpm add -g @example/package-tool@latest",
          );
          expect((yield* updateFor(noSpawn))?.command).toBe(
            "pnpm add -g @example/package-tool@latest",
          );
        }),
    );

    it.effect.each([
      {
        case: "the eligible release",
        outdated: { "@example/package-tool": { current: "1.0.0", latest: "1.1.0" } },
        exitCode: 1,
        expected: "1.1.0",
      },
      { case: "no update during cooldown", outdated: {}, exitCode: 0, expected: "1.0.0" },
      {
        case: "the npm fallback when the pnpm probe fails",
        outdated: { "@example/package-tool": { current: "1.0.0", latest: "1.1.0" } },
        exitCode: 2,
        expected: "9.9.9",
      },
    ])(
      "advertises $case for pnpm-global installs",
      (fixture) =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-pnpm-latest");
          const link = linkIntoPackage(tempDir, "package-tool", [
            ".local",
            "share",
            "pnpm",
            "global",
            "5",
            "node_modules",
            "@example",
            "package-tool",
          ]);
          const capabilities = yield* resolveWith(
            packageToolUpdate,
            { binaryPath: link, env: { PATH: "" } },
            stdoutSpawner(
              (_command, args) =>
                args[0] === "outdated"
                  ? JSON.stringify(fixture.outdated)
                  : args[0] === "ls"
                    ? JSON.stringify([
                        { dependencies: { "@example/package-tool": { version: "1.0.0" } } },
                      ])
                    : "11.1.3\n",
              (args) => (args[0] === "outdated" ? fixture.exitCode : 0),
            ),
          );

          const provider = yield* enrichProviderSnapshotWithVersionAdvisory(
            installedPackageToolProvider,
            capabilities,
          ).pipe(
            Effect.provide(ServerSettingsService.layerTest()),
            Effect.provideService(HttpClient.HttpClient, npmRegistryHttpClient("9.9.9")),
          );
          expect(provider.versionAdvisory).toMatchObject({
            status: fixture.expected === "1.0.0" ? "current" : "behind_latest",
            currentVersion: "1.0.0",
            latestVersion: fixture.expected,
          });
        }),
      { skip: windowsHost },
    );

    it.effect.skipIf(windowsHost)(
      "switches to bun updates when the resolved binary lives in bun's global bin",
      () =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-bun-capabilities");
          const bunBinDir = path.join(tempDir, ".bun", "bin");
          writeExecutable(path.join(bunBinDir, "package-tool"));

          const capabilities = yield* resolveWith(packageToolUpdate, {
            binaryPath: "package-tool",
            platform: "darwin",
            env: { PATH: bunBinDir },
          });
          expect(capabilities.update).toMatchObject({
            command: "bun i -g @example/package-tool@latest",
            lockKey: "bun-global",
          });
        }),
    );

    it.effect.each([
      {
        name: "the default home",
        resolved: "/Users/me/.vite-plus/bin/claude",
        real: "/Users/me/.vite-plus/current/bin/vp",
        platform: "darwin",
      },
      {
        name: "the XDG home",
        resolved: "/home/me/.local/share/vite-plus/bin/claude",
        real: "/home/me/.local/share/vite-plus/current/bin/vp",
        platform: "linux",
      },
      {
        name: "the Windows home",
        resolved: "C:\\Users\\Me\\AppData\\Local\\vite-plus\\bin\\claude.cmd",
        real: "C:\\Users\\Me\\AppData\\Local\\vite-plus\\packages\\@anthropic-ai\\claude-code\\lib\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        platform: "win32",
      },
    ] as const)("updates a Vite+ global install in $name with vp", (fixture) =>
      Effect.gen(function* () {
        const capabilities = yield* resolveContext(claudeLikeDefinition, {
          resolvedCommandPath: fixture.resolved,
          realCommandPath: fixture.real,
          platform: fixture.platform,
        });
        expect(capabilities.update).toMatchObject({
          command: "vp i -g @anthropic-ai/claude-code",
          lockKey: "vite-plus-global",
        });
      }),
    );

    it.effect("keeps a project folder named vite-plus manual-only", () =>
      Effect.gen(function* () {
        const capabilities = yield* resolveContext(claudeLikeDefinition, {
          resolvedCommandPath: "/work/vite-plus/bin/claude",
          realCommandPath: "/work/vite-plus/node_modules/@anthropic-ai/claude-code/cli.js",
          platform: "linux",
        });
        expect(capabilities.update).toBeNull();
      }),
    );

    it.effect("updates a Yarn global install with yarn global add", () =>
      Effect.gen(function* () {
        const capabilities = yield* resolveContext(claudeLikeDefinition, {
          resolvedCommandPath: "/home/me/.yarn/bin/claude",
          realCommandPath:
            "/home/me/.config/yarn/global/node_modules/@anthropic-ai/claude-code/cli.js",
          platform: "linux",
        });
        expect(capabilities.update).toMatchObject({
          command: "yarn global add @anthropic-ai/claude-code@latest",
          lockKey: "yarn-global",
        });
      }),
    );

    it.effect("updates a package Volta holds with volta install", () =>
      Effect.gen(function* () {
        const voltaHome = yield* makeTempDir("ryco-volta-home");
        mkdirSync(
          path.join(voltaHome, "tools", "image", "packages", "@anthropic-ai", "claude-code"),
          {
            recursive: true,
          },
        );
        const capabilities = yield* resolveContext(claudeLikeDefinition, {
          resolvedCommandPath: path.join(voltaHome, "bin", "claude"),
          realCommandPath: path.join(voltaHome, "bin", "volta-shim"),
          platform: "linux",
        });
        expect(capabilities.update).toMatchObject({
          command: "volta install @anthropic-ai/claude-code@latest",
          lockKey: "volta",
        });
      }),
    );

    it.effect.each([
      {
        name: "a Volta shim without the package's image",
        resolved: "/home/me/.volta/bin/claude",
        real: "/home/me/.volta/bin/volta-shim",
      },
      {
        name: "a mise install",
        resolved: "/home/me/.local/share/mise/installs/claude/2.1.0/bin/claude",
        real: "/home/me/.local/share/mise/installs/claude/2.1.0/bin/claude",
      },
      {
        name: "a mise shim",
        resolved: "/home/me/.local/share/mise/shims/claude",
        real: "/opt/homebrew/Cellar/mise/2025.1.0/bin/mise",
      },
      {
        name: "a system package",
        resolved: "/usr/bin/claude",
        real: "/usr/lib/claude-code/bin/claude",
      },
    ] as const)("keeps $name manual-only", (fixture) =>
      Effect.gen(function* () {
        const capabilities = yield* resolveContext(claudeLikeDefinition, {
          resolvedCommandPath: fixture.resolved,
          realCommandPath: fixture.real,
          platform: "linux",
        });
        expect(capabilities).toEqual({
          provider: driver("claudeAgent"),
          packageName: "@anthropic-ai/claude-code",
          update: null,
          installPath: fixture.real,
        });
      }),
    );

    it.effect.skipIf(windowsHost)(
      "switches to native updates and runs the resolved executable",
      () =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-native-capabilities");
          const nativeBinDir = path.join(tempDir, ".local", "bin");
          const nativePath = path.join(nativeBinDir, "native-package-tool");
          writeExecutable(nativePath);

          const capabilities = yield* resolveWith(nativePackageToolUpdate, {
            binaryPath: "native-package-tool",
            platform: "darwin",
            env: { PATH: nativeBinDir },
          });
          expect(capabilities).toEqual({
            provider: driver("nativePackageTool"),
            packageName: "@example/native-package-tool",
            update: {
              command: `${nativePath} update`,
              executable: nativePath,
              args: ["update"],
              lockKey: "nativePackageTool-native",
            },
          });
        }),
    );

    it.effect.each(["wrapper", "symlink"])(
      "keeps a mise-owned %s in a native install location manual-only",
      (launcher) =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-native-mise");
          const nativePath = path.join(tempDir, ".local", "bin", "native-package-tool");
          if (launcher === "wrapper") {
            writeExecutable(
              nativePath,
              '#!/bin/sh\nexec mise x native-package-tool -- native-package-tool "$@"\n',
            );
          } else {
            const target = path.join(
              tempDir,
              "mise",
              "installs",
              "native-package-tool",
              "1.0.0",
              "native-package-tool",
            );
            writeExecutable(target);
            mkdirSync(path.dirname(nativePath), { recursive: true });
            symlinkSync(target, nativePath);
          }

          const capabilities = yield* resolveWith(nativePackageToolUpdate, {
            binaryPath: nativePath,
            env: { PATH: "" },
          });
          expect(capabilities.update).toBeNull();
        }),
      { skip: windowsHost },
    );

    it.effect.skipIf(windowsHost)(
      "falls back to the provider's own updater when no installer is proven",
      () =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-self-update-fallback");
          const customPath = path.join(tempDir, "tools", "package-tool");
          writeExecutable(customPath);
          const selfUpdating = makePackageManagedProviderMaintenanceResolver({
            ...packageToolDefinition,
            nativeUpdate: { args: ["update", "--self"] },
          });

          const capabilities = yield* resolveWith(selfUpdating, {
            binaryPath: customPath,
            env: { PATH: "" },
          });
          expect(capabilities.update).toMatchObject({
            executable: customPath,
            args: ["update", "--self"],
            lockKey: "packageTool-native",
          });

          // Without a native updater the same unmapped path stays manual, never npm.
          expect(
            yield* resolveWith(packageToolUpdate, { binaryPath: customPath, env: { PATH: "" } }),
          ).toEqual({ ...manualPackageTool, installPath: customPath });
        }),
    );

    it.effect.skipIf(windowsHost)("carries the native updater's environment into the action", () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("ryco-native-env");
        const nativePath = path.join(tempDir, ".local", "bin", "native-package-tool");
        writeExecutable(nativePath);
        const resolver = makePackageManagedProviderMaintenanceResolver({
          provider: driver("nativePackageTool"),
          npmPackageName: "@example/native-package-tool",
          nativeUpdate: {
            args: ["update"],
            isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
            env: () => ({ TOOL_HOME: tempDir }),
          },
        });

        const capabilities = yield* resolveWith(resolver, {
          binaryPath: nativePath,
          env: { PATH: "" },
        });
        expect(capabilities.update?.env).toEqual({ TOOL_HOME: tempDir });
      }),
    );
  });

  describe("WinGet", () => {
    const userWinGetLink = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe";
    const userWinGetPackage =
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
    const machineWinGetLink = "C:\\Program Files\\WinGet\\Links\\claude.exe";
    const machineWinGetPackage =
      "C:\\Program Files\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
    const nativeClaude = "C:\\Users\\me\\.local\\bin\\claude.exe";

    it.effect.each([
      { name: "a user-scope link", resolved: userWinGetLink, real: userWinGetPackage },
      { name: "a user-scope package", resolved: userWinGetPackage, real: userWinGetPackage },
      {
        name: "a machine-scope package",
        resolved: machineWinGetPackage,
        real: machineWinGetPackage,
      },
      { name: "a machine-scope link alone", resolved: machineWinGetLink, real: machineWinGetLink },
      {
        name: "a mixed-case link",
        resolved: "c:\\USERS\\me\\appdata\\local\\MICROSOFT\\winget\\links\\Claude.EXE",
        real: userWinGetPackage.toUpperCase(),
      },
      { name: "a native-looking alias", resolved: nativeClaude, real: userWinGetPackage },
      {
        name: "another provider's package",
        resolved: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe",
        real: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe\\copilot.exe",
      },
    ] as const)("keeps a WinGet install manual-only through $name", (fixture) =>
      Effect.gen(function* () {
        const capabilities = yield* resolveContext(claudeLikeDefinition, {
          resolvedCommandPath: fixture.resolved,
          realCommandPath: fixture.real,
          platform: "win32",
        });
        expect(capabilities.update).toBeNull();
      }),
    );

    it.effect.each([
      { name: "a native install", resolved: nativeClaude, platform: "win32" },
      {
        name: "a WinGet-shaped path off Windows",
        resolved: "/home/me/winget/links/claude.exe",
        platform: "linux",
      },
      {
        name: "a WinGet-named folder outside the WinGet roots",
        resolved: "C:\\Work\\WinGet\\Links\\claude.exe",
        platform: "win32",
      },
      {
        name: "a WinGet-named folder inside another directory",
        resolved: "C:\\Work\\Microsoft\\WinGet\\Links\\claude.exe",
        platform: "win32",
      },
    ] as const)("keeps the native updater for $name", (fixture) =>
      Effect.gen(function* () {
        const capabilities = yield* resolveContext(claudeLikeDefinition, {
          resolvedCommandPath: fixture.resolved,
          realCommandPath: fixture.resolved,
          platform: fixture.platform,
        });
        expect(capabilities.update).toMatchObject({
          executable: fixture.resolved,
          args: ["update"],
          lockKey: "claudeAgent-native",
        });
      }),
    );
  });

  describe("Codex standalone", () => {
    // The Windows installer exposes `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` as a junction into
    // `%CODEX_HOME%\packages\standalone\…`; realpath follows it, so the real path has the marker.
    it.effect("updates a Windows standalone install through its junctioned bin dir", () =>
      Effect.gen(function* () {
        const visiblePath =
          "C:\\Users\\Me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
        const realPath =
          "C:\\Users\\Me\\.codex\\packages\\standalone\\releases\\0.120.0-x86_64\\bin\\codex.exe";
        const capabilities = yield* makeCodexMaintenanceResolver(undefined)
          .resolve({
            binaryPath: "codex",
            resolvedCommandPath: visiblePath,
            realCommandPath: realPath,
            env: {},
            platform: "win32",
          })
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
            Effect.provide(NodeServices.layer),
          );

        expect(capabilities.update).toEqual({
          command: `${visiblePath} update`,
          executable: visiblePath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: "C:\\Users\\Me\\.codex" },
        });
      }),
    );

    it.effect("runs `codex update` against the home the standalone tree lives in", () =>
      Effect.gen(function* () {
        const resolve = (sharedHome: string | undefined, realPath: string) =>
          makeCodexMaintenanceResolver(sharedHome)
            .resolve({
              binaryPath: "codex",
              resolvedCommandPath: "/home/me/.local/bin/codex",
              realCommandPath: realPath,
              env: {},
              platform: "linux",
            })
            .pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
              Effect.provide(NodeServices.layer),
            );

        const standalone = yield* resolve(
          "/srv/codex-shared",
          "/home/me/.codex/packages/standalone/current/bin/codex",
        );
        expect(standalone.update).toMatchObject({
          executable: "/home/me/.local/bin/codex",
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: "/home/me/.codex" },
        });
        // Not a standalone path: the instance's own selected home, else Codex's default.
        const custom = yield* resolve("/srv/codex-shared", "/opt/codex/bin/codex");
        expect(custom.update?.env).toEqual({ CODEX_HOME: "/srv/codex-shared" });
        const defaultHome = yield* resolve(undefined, "/opt/codex/bin/codex");
        expect(defaultHome.update).toMatchObject({ lockKey: "codex-native" });
        expect(defaultHome.update?.env).toBeUndefined();
      }),
    );

    it("reads CODEX_HOME from the standalone real path", () => {
      expect(
        codexHomeFromStandaloneCommandPath("/Users/me/.codex/packages/standalone/current/codex"),
      ).toBe("/Users/me/.codex");
      expect(
        codexHomeFromStandaloneCommandPath(
          "C:\\Users\\Me\\.codex\\Packages\\Standalone\\releases\\0.1\\codex.exe",
        ),
      ).toBe("C:\\Users\\Me\\.codex");
      expect(codexHomeFromStandaloneCommandPath("/usr/local/bin/codex")).toBeNull();
    });
  });

  describe("Homebrew", () => {
    it("recognizes Homebrew kegs and casks from the real executable path", () => {
      expect(
        homebrewOwnershipFromCommandPath(
          "/opt/homebrew/Cellar/claude-code@latest/2.1.0/bin/claude",
        ),
      ).toEqual({
        kind: "formula",
        name: "claude-code@latest",
        prefix: "/opt/homebrew",
        version: "2.1.0",
      });
      expect(homebrewOwnershipFromCommandPath("/usr/local/Caskroom/codex/0.148.0/codex")).toEqual({
        kind: "cask",
        name: "codex",
        prefix: "/usr/local",
        version: "0.148.0",
      });
      // Linuxbrew matches the same pattern.
      expect(
        homebrewOwnershipFromCommandPath(
          "/home/linuxbrew/.linuxbrew/Cellar/opencode/1.2.3/bin/opencode",
        ),
      ).toMatchObject({ kind: "formula", name: "opencode", prefix: "/home/linuxbrew/.linuxbrew" });
      // A plain /opt/homebrew/bin or /usr/local/bin binary is not evidence of Homebrew.
      expect(homebrewOwnershipFromCommandPath("/opt/homebrew/bin/codex")).toBeNull();
      expect(homebrewOwnershipFromCommandPath("/usr/local/bin/codex")).toBeNull();
    });

    it("reads the version an upgrade installs from brew info", () => {
      const formulaInfo = JSON.stringify({ formulae: [{ versions: { stable: "2.1.5" } }] });
      expect(parseHomebrewLatestVersion(formulaInfo, "formula")).toBe("2.1.5");
      expect(parseHomebrewLatestVersion("not json", "formula")).toBeNull();
      const caskInfo = JSON.stringify({ casks: [{ version: "1.2.3,456" }] });
      expect(parseHomebrewLatestVersion(caskInfo, "cask")).toBe("1.2.3");
      // Homebrew's `latest` cask version is not a version.
      expect(
        parseHomebrewLatestVersion(JSON.stringify({ casks: [{ version: "latest" }] }), "cask"),
      ).toBeNull();
    });

    /** A keg under `<tempDir>` whose own `bin/brew` reports `<tempDir>` as its prefix. */
    const makeKeg = Effect.fn("makeKeg")(function* (input: {
      readonly kind: "Cellar" | "Caskroom";
      readonly name: string;
      readonly version: string;
      readonly binary: ReadonlyArray<string>;
      readonly tap?: string;
    }) {
      const tempDir = yield* makeTempDir("ryco-homebrew-keg");
      const brewPath = path.join(tempDir, "bin", "brew");
      writeExecutable(brewPath);
      const keg = path.join(tempDir, input.kind, input.name, input.version);
      const binary = path.join(keg, ...input.binary);
      writeExecutable(binary);
      if (input.tap) {
        writeFileSync(
          path.join(keg, "INSTALL_RECEIPT.json"),
          JSON.stringify({ source: { tap: input.tap, spec: "stable" } }),
        );
      }
      const calls: Array<string> = [];
      const spawner = stdoutSpawner((command, args) => {
        calls.push([command, ...args].join(" "));
        if (args[0] === "--prefix") return `${tempDir}\n`;
        if (args[0] === "info") {
          return JSON.stringify(
            input.kind === "Cellar"
              ? { formulae: [{ versions: { stable: "9.0.0" } }] }
              : { casks: [{ version: "9.1.0,77" }] },
          );
        }
        return "";
      });
      return { tempDir, brewPath, binary, calls, spawner };
    });

    it.effect.skipIf(windowsHost)(
      "upgrades a formula with the keg's own brew when brew is not on PATH",
      () =>
        Effect.gen(function* () {
          const keg = yield* makeKeg({
            kind: "Cellar",
            name: "package-tool",
            version: "1.0.0",
            binary: ["bin", "tool"],
          });

          const capabilities = yield* resolveWith(
            packageToolUpdate,
            { binaryPath: keg.binary, platform: "darwin", env: { PATH: "" } },
            keg.spawner,
          );
          expect(capabilities.update).toEqual({
            command: "brew upgrade package-tool",
            executable: keg.brewPath,
            args: ["upgrade", "package-tool"],
            lockKey: "homebrew",
          });
          expect(capabilities.latestVersion).toBeNull();
          expect(keg.calls).toEqual([`${keg.brewPath} --prefix`]);

          // The latest version comes from brew, never from npm.
          const latest = yield* resolveLatestProviderVersion(capabilities).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              dyingHttpClient("Homebrew's latest should not come from npm"),
            ),
          );
          expect(latest).toBe("9.0.0");
          expect(keg.calls).toEqual([
            `${keg.brewPath} --prefix`,
            `${keg.brewPath} info --json=v2 --formula package-tool`,
          ]);
        }),
    );

    it.effect.skipIf(windowsHost)("upgrades a cask with `brew upgrade --cask <name>`", () =>
      Effect.gen(function* () {
        const keg = yield* makeKeg({
          kind: "Caskroom",
          name: "claude-code@latest",
          version: "2.1.0",
          binary: ["claude"],
        });

        const capabilities = yield* resolveWith(
          makePackageManagedProviderMaintenanceResolver(claudeLikeDefinition),
          { binaryPath: keg.binary, platform: "darwin", env: { PATH: "" } },
          keg.spawner,
        );
        expect(capabilities.update).toEqual({
          command: "brew upgrade --cask claude-code@latest",
          executable: keg.brewPath,
          args: ["upgrade", "--cask", "claude-code@latest"],
          lockKey: "homebrew",
        });
        const latest = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideService(HttpClient.HttpClient, dyingHttpClient("not npm")),
        );
        expect(latest).toBe("9.1.0");
      }),
    );

    it.effect.skipIf(windowsHost)(
      "stays manual, without an npm latest version, when the keg is not under the resolved brew's prefix",
      () =>
        Effect.gen(function* () {
          const tempDir = yield* makeTempDir("ryco-homebrew-foreign-prefix");
          const brewBinDir = path.join(tempDir, "brew-bin");
          writeExecutable(path.join(brewBinDir, "brew"));
          const kegBinary = path.join(
            tempDir,
            "elsewhere",
            "Cellar",
            "package-tool",
            "1.0.0",
            "bin",
            "package-tool",
          );
          writeExecutable(kegBinary);

          const capabilities = yield* resolveWith(
            packageToolUpdate,
            { binaryPath: kegBinary, platform: "darwin", env: { PATH: brewBinDir } },
            stdoutSpawner(() => `${path.join(tempDir, "other-prefix")}\n`),
          );
          expect(capabilities).toEqual({
            ...manualPackageTool,
            installPath: kegBinary,
            latestVersion: null,
          });
          expect(
            yield* resolveLatestProviderVersion(capabilities).pipe(
              Effect.provideService(HttpClient.HttpClient, dyingHttpClient("not npm")),
            ),
          ).toBeNull();
        }),
    );

    // OpenCode's 1.x formula lives in its own tap; homebrew-core's `opencode` is 2.x.
    const openCodeLikeDefinition: PackageManagedProviderMaintenanceDefinition = {
      provider: driver("opencode"),
      npmPackageName: "opencode-ai",
      nativeUpdate: {
        args: ["upgrade"],
        isCommandPath: isNativeTestCommandPath("/.opencode/bin/opencode"),
      },
      supportsHomebrewInstall: (install: HomebrewInstall) =>
        install.kind === "formula" && install.tap !== null && install.tap !== "homebrew/core",
    };

    it.effect.skipIf(windowsHost)(
      "addresses a third-party tap formula by its full name and lets a definition refuse core",
      () =>
        Effect.gen(function* () {
          const tapKeg = yield* makeKeg({
            kind: "Cellar",
            name: "opencode",
            version: "1.18.0",
            binary: ["bin", "opencode"],
            tap: "anomalyco/tap",
          });
          const tapped = yield* resolveWith(
            makePackageManagedProviderMaintenanceResolver(openCodeLikeDefinition),
            { binaryPath: tapKeg.binary, platform: "darwin", env: { PATH: "" } },
            tapKeg.spawner,
          );
          expect(tapped.update).toMatchObject({
            command: "brew upgrade anomalyco/tap/opencode",
            args: ["upgrade", "anomalyco/tap/opencode"],
            lockKey: "homebrew",
          });

          for (const tap of ["homebrew/core", undefined]) {
            const coreKeg = yield* makeKeg({
              kind: "Cellar",
              name: "opencode",
              version: "2.0.1",
              binary: ["bin", "opencode"],
              ...(tap ? { tap } : {}),
            });
            const core = yield* resolveWith(
              makePackageManagedProviderMaintenanceResolver(openCodeLikeDefinition),
              { binaryPath: coreKeg.binary, platform: "darwin", env: { PATH: "" } },
              coreKeg.spawner,
            );
            expect(core).toEqual({
              provider: driver("opencode"),
              packageName: "opencode-ai",
              update: null,
              installPath: coreKeg.binary,
              latestVersion: null,
            });
            expect(coreKeg.calls).toEqual([]);
          }
        }),
    );
  });

  describe("latest versions", () => {
    it.effect("caches installer lookups per executable and update target, apart from npm", () =>
      Effect.gen(function* () {
        let lookups = 0;
        const capabilities = (executable: string, args: ReadonlyArray<string>, version: string) =>
          makeProviderMaintenanceCapabilities({
            provider: driver("packageTool"),
            packageName: "@example/package-tool",
            updateExecutable: executable,
            updateArgs: args,
            updateLockKey: "homebrew",
            latestVersion: null,
            lookupLatestVersion: Effect.sync(() => {
              lookups += 1;
              return version;
            }),
          });

        const formula = capabilities(
          "/opt/homebrew/bin/brew",
          ["upgrade", "package-tool"],
          "2.0.0",
        );
        const cask = capabilities(
          "/opt/homebrew/bin/brew",
          ["upgrade", "--cask", "package-tool"],
          "3.0.0",
        );
        const otherBrew = capabilities("/usr/local/bin/brew", ["upgrade", "package-tool"], "4.0.0");
        expect(installerLatestVersionCacheKey(formula)).not.toBe(
          installerLatestVersionCacheKey(cask),
        );

        expect(yield* resolveLatestProviderVersion(formula)).toBe("2.0.0");
        expect(yield* resolveLatestProviderVersion(cask)).toBe("3.0.0");
        expect(yield* resolveLatestProviderVersion(otherBrew)).toBe("4.0.0");
        const refreshed = capabilities(
          "/opt/homebrew/bin/brew",
          ["upgrade", "package-tool"],
          "5.0.0",
        );
        expect(yield* resolveLatestProviderVersion(refreshed)).toBe("2.0.0");
        expect(lookups).toBe(3);
        // A click-time check asks the installer again and refreshes the cache.
        expect(yield* resolveLatestProviderVersion(refreshed, { fresh: true })).toBe("5.0.0");
        expect(yield* resolveLatestProviderVersion(formula)).toBe("5.0.0");
        expect(lookups).toBe(4);
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          dyingHttpClient("Homebrew's latest should not come from npm"),
        ),
      ),
    );

    it.effect(
      "re-fetches a fresh latest version despite a warm cache and refreshes the cache",
      () =>
        Effect.gen(function* () {
          const capabilities = makeProviderMaintenanceCapabilities({
            provider: driver("packageTool"),
            packageName: "@example/fresh-latest-tool",
            updateExecutable: "npm",
            updateArgs: ["install", "-g", "@example/fresh-latest-tool@latest"],
            updateLockKey: "npm-global",
          });
          let registryVersion = "1.0.0";
          let requests = 0;
          const httpClient = HttpClient.make((request) => {
            requests += 1;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ version: registryVersion })),
            );
          });
          const resolve = (options?: { readonly fresh?: boolean }) =>
            resolveLatestProviderVersion(capabilities, options).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );

          expect(yield* resolve()).toBe("1.0.0");
          registryVersion = "1.1.0";
          expect(yield* resolve()).toBe("1.0.0");
          expect(requests).toBe(1);

          expect(yield* resolve({ fresh: true })).toBe("1.1.0");
          expect(requests).toBe(2);

          expect(yield* resolve()).toBe("1.1.0");
          expect(requests).toBe(2);
        }),
    );

    it.effect("persists latest versions with their TTL so a restart skips the registry", () =>
      Effect.gen(function* () {
        let installerLookups = 0;
        const npmCapabilities = makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/persisted-latest-tool",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@example/persisted-latest-tool@latest"],
          updateLockKey: "npm-global",
        });
        const brewCapabilities = makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/persisted-latest-tool",
          updateExecutable: "/opt/homebrew/bin/brew",
          updateArgs: ["upgrade", "persisted-latest-tool"],
          updateLockKey: "homebrew",
          latestVersion: null,
          lookupLatestVersion: Effect.sync(() => {
            installerLookups += 1;
            return "1.5.0";
          }),
        });
        let requests = 0;
        const httpClient = HttpClient.make((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ version: "2.0.0" })),
          );
        });
        const resolve = (capabilities: ProviderMaintenanceCapabilities) =>
          resolveLatestProviderVersion(capabilities).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );

        yield* Effect.gen(function* () {
          expect(yield* resolve(npmCapabilities)).toBe("2.0.0");
          expect(yield* resolve(brewCapabilities)).toBe("1.5.0");
          expect([requests, installerLookups]).toEqual([1, 1]);
          // A new process starts with an empty memory cache but reads the persisted entries.
          clearLatestProviderVersionCacheForTests();
          expect(yield* resolve(npmCapabilities)).toBe("2.0.0");
          expect(yield* resolve(brewCapabilities)).toBe("1.5.0");
          expect([requests, installerLookups]).toEqual([1, 1]);
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "ryco-latest-version-cache-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      }),
    );

    it.effect("concurrent lookups after a restart all wait for the one persisted-cache read", () =>
      Effect.gen(function* () {
        const makeCapabilities = (packageName: string) =>
          makeProviderMaintenanceCapabilities({
            provider: driver("packageTool"),
            packageName,
            updateExecutable: "npm",
            updateArgs: ["install", "-g", `${packageName}@latest`],
            updateLockKey: "npm-global",
          });
        let requests = 0;
        const httpClient = HttpClient.make((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ version: "3.0.0" })),
          );
        });
        const resolveBoth = Effect.all(
          [
            resolveLatestProviderVersion(makeCapabilities("@example/concurrent-a")),
            resolveLatestProviderVersion(makeCapabilities("@example/concurrent-b")),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

        yield* Effect.gen(function* () {
          yield* resolveBoth;
          expect(requests).toBe(2);
          clearLatestProviderVersionCacheForTests();
          expect(yield* resolveBoth).toEqual(["3.0.0", "3.0.0"]);
          expect(requests).toBe(2);
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "ryco-latest-version-concurrent-",
            }).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );
      }),
    );
  });

  it.effect.skipIf(windowsHost)(
    "resolves maintenance capabilities lazily, once, without blocking construction",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("ryco-lazy-maintenance");
        const binDir = path.join(tempDir, ".bun", "bin");
        writeExecutable(path.join(binDir, "package-tool"));
        let resolutions = 0;
        const countingResolver: ProviderMaintenanceCapabilitiesResolver = {
          resolve: (context) => {
            if (context !== null) resolutions += 1;
            return packageToolUpdate.resolve(context);
          },
        };

        const capabilities = yield* makeLazyProviderMaintenanceCapabilities(countingResolver, {
          binaryPath: "package-tool",
          env: { PATH: binDir },
        });
        expect(resolutions).toBe(0);
        expect((yield* capabilities).update?.lockKey).toBe("bun-global");
        expect((yield* capabilities).update?.lockKey).toBe("bun-global");
        expect(resolutions).toBe(1);
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.provide(NodeServices.layer),
      ),
  );
});
