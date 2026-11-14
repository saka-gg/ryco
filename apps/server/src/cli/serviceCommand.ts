/**
 * `ryco service`: run this node as a background service.
 */
import { spawn as spawnChild } from "node:child_process";
import NodePath from "node:path";
import { Console, Data, Effect, FileSystem, Option, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { resolveBaseDir } from "../os-jank.ts";
import {
  EMPTY_NODE_CONFIG,
  nodeConfigAsServeArgs,
  nodeConfigPath,
  readNodeConfig,
  writeNodeConfig,
} from "../cliSetup/nodeConfig.ts";
import { applyNodeSettings, installServiceForNode } from "../cliSetup/nodeSetup.ts";
import {
  nodeServiceLabel,
  nodeServicePlatform,
  readNodeServiceStatus,
  restartNodeService,
  startNodeService,
  stopNodeService,
  uninstallNodeService,
} from "../service/nodeService.ts";
import {
  isPersistedServerRunning,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  baseDirFlag,
  hostFlag,
  hubAllowFileSecretStoreFlag,
  hubConnectorEnabledFlag,
  hubE2eePolicyFlag,
  hubNodeNameFlag,
  hubOriginFlag,
  jsonFlag,
  keepAwakeWhileWorkingFlag,
  portFlag,
  preventSleepFlag,
  restrictToCwdFlag,
  tailscaleServeFlag,
  tailscaleServePortFlag,
} from "./flags.ts";
import { refuseDesktopOwnedNode, resolveCliAuthConfig } from "./serverConfig.ts";

// ─── ryco service ─────────────────────────────────────────────────────────────

const serviceLocationFlags = { baseDir: baseDirFlag } as const;

const resolveServiceContext = Effect.fn("resolveServiceContext")(function* (
  baseDir: Option.Option<string>,
) {
  const platform = nodeServicePlatform();
  if (platform === null) {
    return yield* Effect.fail(
      new Error(
        "Background services are supported on macOS (launchd) and Linux (systemd). On other systems, run `ryco serve` under your own process manager.",
      ),
    );
  }
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig({ baseDir }, logLevel);
  const defaultBaseDir = yield* resolveBaseDir(undefined);
  return {
    platform,
    config,
    label: nodeServiceLabel(config.baseDir, defaultBaseDir),
    logPath: NodePath.join(config.logsDir, "service.log"),
  };
});

export class ServiceCommandError extends Data.TaggedError("ServiceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const serviceProcess = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ServiceCommandError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const serviceInstallCommand = Command.make("install", {
  ...serviceLocationFlags,
  host: hostFlag,
  port: portFlag,
  hubConnectorEnabled: hubConnectorEnabledFlag,
  hubOrigin: hubOriginFlag,
  hubNodeName: hubNodeNameFlag,
  hubAllowFileSecretStore: hubAllowFileSecretStoreFlag,
  hubE2eePolicy: hubE2eePolicyFlag,
  tailscaleServeEnabled: tailscaleServeFlag,
  tailscaleServePort: tailscaleServePortFlag,
  restrictToCwd: restrictToCwdFlag,
  preventSleep: preventSleepFlag,
  keepAwakeWhileWorking: keepAwakeWhileWorkingFlag,
  cwd: Argument.String("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription(
    "Run `ryco serve` as a background service that starts at login, restarts if it stops, and keeps the machine awake on AC power (disable with --no-prevent-sleep).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { platform, config, label, logPath } = yield* resolveServiceContext(flags.baseDir);
      yield* refuseDesktopOwnedNode(config.baseDir);
      const configPath = nodeConfigPath(config.stateDir);
      const saved = yield* serviceProcess(() => readNodeConfig(configPath));
      const settings = applyNodeSettings(saved ?? EMPTY_NODE_CONFIG, {
        workspace: Option.isSome(flags.cwd)
          ? NodePath.resolve(flags.cwd.value)
          : (saved?.workspace ?? process.cwd()),
        host: Option.getOrUndefined(flags.host),
        port: Option.getOrUndefined(flags.port),
        tailscaleServe: Option.getOrUndefined(flags.tailscaleServeEnabled),
        tailscaleServePort: Option.getOrUndefined(flags.tailscaleServePort),
        hubEnabled: Option.getOrUndefined(flags.hubConnectorEnabled),
        hubOrigin: Option.getOrUndefined(flags.hubOrigin),
        hubNodeName: Option.getOrUndefined(flags.hubNodeName),
        hubAllowFileSecretStore: Option.getOrUndefined(flags.hubAllowFileSecretStore),
        hubE2eePolicy: Option.getOrUndefined(flags.hubE2eePolicy),
        restrictToWorkspace: Option.getOrUndefined(flags.restrictToCwd),
        // A node installed to stay reachable should not idle-sleep; opt out explicitly.
        preventSleep: Option.getOrUndefined(flags.preventSleep) ?? saved?.preventSleep ?? true,
        keepAwakeWhileWorking: Option.getOrUndefined(flags.keepAwakeWhileWorking),
      });
      yield* serviceProcess(() => writeNodeConfig(configPath, settings));
      const { definitionPath } = yield* serviceProcess(() =>
        installServiceForNode({
          platform,
          label,
          baseDir: config.baseDir,
          logPath,
          workspace: settings.workspace,
        }),
      );
      const status = yield* serviceProcess(() => readNodeServiceStatus(platform, label));
      yield* Console.log(
        [
          `Installed Ryco as a background service (${label}).`,
          `  Settings:   ${configPath}  (ryco config)`,
          `  Runs:       ryco serve ${nodeConfigAsServeArgs(settings).join(" ")}`,
          `  Definition: ${definitionPath}`,
          `  Logs:       ${logPath}  (ryco service logs -f)`,
          `  State:      ${status.running ? `running (pid ${status.pid ?? "?"})` : "starting"}`,
          "",
          "It starts at login and restarts if it stops.",
          ...(platform === "systemd" && status.lingering === false
            ? ["Run `sudo loginctl enable-linger $USER` so it also runs at boot without a login."]
            : []),
          "Next:",
          "  ryco auth pairing create --ttl 1h   # pair a desktop, browser, or phone",
          ...(settings.hub?.enabled
            ? ["  ryco hub login                      # link this node to your Ryco account"]
            : []),
          "  ryco setup                          # status, pairing, logs, and settings in one place",
          "",
        ].join("\n"),
      );
    }),
  ),
);

const serviceUninstallCommand = Command.make("uninstall", { ...serviceLocationFlags }).pipe(
  Command.withDescription("Stop the background service and remove its definition."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { platform, label } = yield* resolveServiceContext(flags.baseDir);
      const result = yield* serviceProcess(() => uninstallNodeService(platform, label));
      yield* Console.log(
        result.removed
          ? `Removed the Ryco service (${label}). Node state and pairings are kept.\n`
          : `No Ryco service (${label}) was installed.\n`,
      );
    }),
  ),
);

const serviceStartCommand = Command.make("start", { ...serviceLocationFlags }).pipe(
  Command.withDescription("Start the installed background service."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { platform, label } = yield* resolveServiceContext(flags.baseDir);
      yield* serviceProcess(() => startNodeService(platform, label));
      yield* Console.log(`Started ${label}.\n`);
    }),
  ),
);

const serviceStopCommand = Command.make("stop", { ...serviceLocationFlags }).pipe(
  Command.withDescription("Stop the background service until the next start, login, or boot."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { platform, label } = yield* resolveServiceContext(flags.baseDir);
      yield* serviceProcess(() => stopNodeService(platform, label));
      yield* Console.log(`Stopped ${label}.\n`);
    }),
  ),
);

const serviceRestartCommand = Command.make("restart", { ...serviceLocationFlags }).pipe(
  Command.withDescription("Restart the background service, for example after upgrading ryco-cli."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { platform, label } = yield* resolveServiceContext(flags.baseDir);
      yield* serviceProcess(() => restartNodeService(platform, label));
      yield* Console.log(`Restarted ${label}.\n`);
    }),
  ),
);

/**
 * `ryco service status --ready`: probe the node this home runs (as a service or
 * a foreground `ryco serve`) instead of the service manager, and fail (exit 1)
 * unless it answers as this home's node. For scripts and health checks.
 */
const probeServiceReadiness = Effect.fn("probeServiceReadiness")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly json: boolean;
}) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
  const fileSystem = yield* FileSystem.FileSystem;
  const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  const environmentId = yield* fileSystem
    .readFileString(config.environmentIdPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const { describeServerReadiness, probeServerReadiness } = yield* Effect.promise(
    () => import("../cliStatus/readiness.ts"),
  );
  const readiness = yield* Effect.promise(() =>
    probeServerReadiness({
      runtime,
      environmentId,
      isRunning: (state) => isPersistedServerRunning(state),
    }),
  );
  const description = describeServerReadiness(readiness);
  yield* Console.log(
    flags.json
      ? JSON.stringify({
          ready: readiness.ready,
          reason: readiness.reason,
          origin: readiness.origin,
        })
      : readiness.ready
        ? `Ready:      ${readiness.origin}`
        : `Ready:      no (${description.replace(/^not ready: /u, "")})`,
  );
  if (!readiness.ready) {
    return yield* Effect.fail(new Error(description));
  }
});

const serviceStatusCommand = Command.make("status", {
  ...serviceLocationFlags,
  json: jsonFlag,
  ready: Flag.Boolean("ready").pipe(
    Flag.withDescription(
      "Only check that this home's node answers as itself within 3 seconds; exit 1 when it does not.",
    ),
  ),
}).pipe(
  Command.withDescription("Show whether the background service is installed and running."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.ready) return yield* probeServiceReadiness(flags);
      const { platform, config, label, logPath } = yield* resolveServiceContext(flags.baseDir);
      const status = yield* serviceProcess(() => readNodeServiceStatus(platform, label));
      const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const origin = status.running ? runtime?.origin : undefined;
      if (flags.json) {
        yield* Console.log(JSON.stringify({ ...status, logPath, origin: origin ?? null }));
        return;
      }
      yield* Console.log(
        [
          `Service:    ${label} (${platform})`,
          `Installed:  ${status.installed ? status.definitionPath : "no — run `ryco service install`"}`,
          `State:      ${
            status.running
              ? `running (pid ${status.pid ?? "?"})`
              : status.loaded
                ? "loaded, not running"
                : "not running"
          }`,
          ...(origin ? [`Listening:  ${origin}`] : []),
          ...(status.lingering === false
            ? ["Linger:     off — it stops at logout (`sudo loginctl enable-linger $USER`)"]
            : []),
          `Logs:       ${logPath}`,
          "",
        ].join("\n"),
      );
    }),
  ),
);

const serviceLogsCommand = Command.make("logs", {
  ...serviceLocationFlags,
  lines: Flag.Int("lines").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))),
    Flag.withAlias("n"),
    Flag.withDescription("How many trailing lines to print (default 80)."),
    Flag.optional,
  ),
  follow: Flag.Boolean("follow").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Keep printing new lines as they are written."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Print the background service's log."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { logPath } = yield* resolveServiceContext(flags.baseDir);
      const lines = Option.getOrElse(flags.lines, () => 80);
      const follow = Option.getOrElse(flags.follow, () => false);
      yield* serviceProcess(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawnChild(
              "tail",
              ["-n", String(lines), ...(follow ? ["-F"] : []), logPath],
              { stdio: "inherit" },
            );
            child.on("error", reject);
            child.on("exit", () => resolve());
          }),
      );
    }),
  ),
);

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription(
    "Keep this node running in the background: start at login, restart on failure, stay awake.",
  ),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceUninstallCommand,
    serviceStartCommand,
    serviceStopCommand,
    serviceRestartCommand,
    serviceStatusCommand,
    serviceLogsCommand,
  ]),
);
