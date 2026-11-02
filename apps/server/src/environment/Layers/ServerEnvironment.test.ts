import * as nodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { desktopAppAutomaticUpdateMode } from "@ryco/shared/desktopResourceTelemetry";
import { Effect, Exit, FileSystem, Layer, PlatformError } from "effect";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ServerEnvironment } from "../Services/ServerEnvironment.ts";
import { ServerEnvironmentLive } from "./ServerEnvironment.ts";

const makeServerEnvironmentLayer = (baseDir: string) =>
  ServerEnvironmentLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

const makeServerConfig = Effect.fn(function* (baseDir: string) {
  const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

  return {
    ...derivedPaths,
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "ryco-server",
    cwd: process.cwd(),
    baseDir,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
    startupPresentation: "browser",
  } satisfies ServerConfigShape;
});

it.layer(NodeServices.layer)("ServerEnvironmentLive", (it) => {
  it.effect("persists the environment id across service restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));
      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(second.capabilities.environmentIcon).toBe(true);
      expect(second.platform.machine).toBeDefined();
      expect(second.capabilities.repositoryIdentity).toBe(true);
      expect(second.capabilities.crossRepositoryChangeRequests).toBe(true);
      expect(second.capabilities.worktreeSubmoduleSettings).toBe(true);
      expect(second.capabilities.requiredWorktreeBootstrap).toBe(true);
      expect(second.capabilities.nodeAutoSettlement).toBe(true);
      expect(second.capabilities.usageLimitRecovery).toBe(true);
      expect(second.capabilities.responseStreamingModes).toBe(true);
      expect(second.capabilities.worktreeNotes).toBe(true);
      expect(second.capabilities.localTasks).toBe(true);
      expect(second.capabilities.nodeSelfUpdate).toBe(true);
      expect(second.capabilities.automaticUpdates).toBe(true);
      // Not a desktop app's backend.
      expect(second.capabilities.desktopAppUpdates).toBeUndefined();
      expect(second.capabilities.terminalWriteRequireIdle).toBe(true);
      expect(second.capabilities.threadFork).toBe(true);
      expect(second.capabilities.threadBranchAdoption).toBe(true);
      expect(second.capabilities.projectSearchEmptyQuery).toBe(true);
      expect(second.capabilities.projectContentSearch).toBe(true);
      expect(second.capabilities.projectReadFileChunk).toBe(true);
      expect(second.capabilities.projectFileWatch).toBe(true);
      expect(second.capabilities.threadLocalServers).toBe(process.platform !== "win32");
      expect(second.capabilities.threadLocalServerStop).toBe(process.platform !== "win32");
      expect(second.capabilities.cliProxyHubs).toBe(true);
      expect(second.capabilities.cliProxyCloudflareAccess).toBe(true);
      expect(second.capabilities.stagedOnlyCommit).toBe(true);
      expect(second.capabilities.recoverableGitActions).toBe(true);
    }),
  );

  it.effect("says what a packaged desktop app does with its own updates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-server-environment-desktop-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      yield* fileSystem.makeDirectory(nodePath.dirname(serverConfig.environmentIdPath), {
        recursive: true,
      });
      const describe = (config: ServerConfigShape) =>
        Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            ServerEnvironmentLive.pipe(Layer.provide(Layer.succeed(ServerConfig, config))),
          ),
        );

      const desktop = yield* describe({ ...serverConfig, mode: "desktop" });
      // The desktop app's own answer for this platform and AppImage file name.
      expect(desktop.capabilities.desktopAppUpdates).toBe(
        desktopAppAutomaticUpdateMode({
          platform: process.platform,
          appImage: process.env.APPIMAGE,
        }) ?? undefined,
      );
      if (process.platform === "darwin") {
        expect(desktop.capabilities.desktopAppUpdates).toBe("restart");
      }
      // Development builds never update themselves.
      const development = yield* describe({
        ...serverConfig,
        mode: "desktop",
        devUrl: new URL("http://127.0.0.1:5733"),
      });
      expect(development.capabilities.desktopAppUpdates).toBeUndefined();
    }),
  );

  it.effect("fails instead of overwriting a persisted id when reading the file errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-server-environment-read-error-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      const environmentIdPath = serverConfig.environmentIdPath;
      yield* fileSystem.makeDirectory(nodePath.dirname(environmentIdPath), { recursive: true });
      yield* fileSystem.writeFileString(environmentIdPath, "persisted-environment-id\n");
      const writeAttempts: string[] = [];
      const failingFileSystemLayer = FileSystem.layerNoop({
        exists: (path) => Effect.succeed(path === environmentIdPath),
        readFileString: (path) =>
          path === environmentIdPath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "permission denied",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "not found",
                  pathOrDescriptor: path,
                }),
              ),
        writeFileString: (path) => {
          writeAttempts.push(path);
          return Effect.void;
        },
      });

      const exit = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironmentLive.pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(ServerConfig, serverConfig), failingFileSystemLayer),
            ),
          ),
        ),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(writeAttempts).toEqual([]);
      expect(yield* fileSystem.readFileString(environmentIdPath)).toBe(
        "persisted-environment-id\n",
      );
    }),
  );
});
