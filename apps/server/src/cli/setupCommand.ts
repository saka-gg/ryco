/**
 * `ryco setup` and `ryco config`: the setup guide and this node's saved settings.
 */
import NodePath from "node:path";
import { Console, type Context, Duration, Effect, Option } from "effect";
// oxlint-disable-next-line no-unused-vars -- TS needs the symbol in scope to name exported CLI types.
import type { NodeInspectSymbol } from "effect/Inspectable";
import { Argument, Command, GlobalFlag } from "effect/cli";
import type * as Terminal from "effect/Terminal";
import { resolveBaseDir } from "../os-jank.ts";
import {
  EMPTY_NODE_CONFIG,
  nodeConfigPath,
  readNodeConfig,
  writeNodeConfig,
} from "../cliSetup/nodeConfig.ts";
import {
  formatNodeConfig,
  lookupConfigKey,
  NODE_CONFIG_KEYS,
  setConfigKey,
  unsetConfigKey,
} from "../cliSetup/configKeys.ts";
import { SetupError } from "../cliSetup/setupError.ts";
import type { SetupContext, SetupOperations } from "../cliSetup/setupFlow.ts";
import { cliCommandPrefix, dim, isInteractiveTerminal } from "../cliSetup/ui.ts";
import packageJson from "../../package.json" with { type: "json" };
import {
  nodeServiceLabel,
  nodeServicePlatform,
  readNodeServiceStatus,
} from "../service/nodeService.ts";
import { baseDirFlag, jsonFlag } from "./flags.ts";
import {
  requestHubEnrollment,
  requestHubIdentitySummary,
  requestHubPendingEnrollment,
  requestHubStatus,
  runHubLoginFlow,
} from "./hubCommand.ts";
import { probeLocalServerRuntime, runHubCommand, runWithAuthControlPlane } from "./runtime.ts";
import { runServerCommand } from "./serverCommand.ts";
import {
  refuseDesktopOwnedNode,
  resolveCliAuthConfig,
  type CliAuthLocationFlags,
  type CliServerFlags,
} from "./serverConfig.ts";

// ─── ryco setup / ryco config ─────────────────────────────────────────────────

// The setup guide and the node manager load when a command opens them, never on the `serve` path.
export const loadSetupFlow = Effect.promise(() => import("../cliSetup/setupFlow.ts"));

export const resolveSetupContext = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig({ baseDir }, logLevel);
    const defaultBaseDir = yield* resolveBaseDir(undefined);
    const context: SetupContext = {
      version: packageJson.version,
      baseDir: config.baseDir,
      configPath: nodeConfigPath(config.stateDir),
      logPath: NodePath.join(config.logsDir, "service.log"),
      platform: nodeServicePlatform(),
      serviceLabel: nodeServiceLabel(config.baseDir, defaultBaseDir),
      commandPrefix: cliCommandPrefix(),
    };
    return { config, context };
  });

/** The running node's origin, when a server recorded one and actually answers there. */
const probeLocalServer = (serverRuntimeStatePath: string) =>
  probeLocalServerRuntime(serverRuntimeStatePath).pipe(
    Effect.map((state) => state?.origin ?? null),
  );

const emptyServerFlags = (baseDir: Option.Option<string>): CliServerFlags => ({
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  baseDir,
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
});

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

/**
 * The setup flow's view of the running node. Built inside a command handler and
 * bound to that handler's services, so the flow itself needs none.
 */
export const makeSetupOperations = (flags: CliAuthLocationFlags, serverRuntimeStatePath: string) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const bind = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
      effect.pipe(Effect.provideContext(services as Context.Context<R>));
    return bindSetupOperations(flags, serverRuntimeStatePath, bind);
  });

const bindSetupOperations = (
  flags: CliAuthLocationFlags,
  serverRuntimeStatePath: string,
  bind: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>,
): SetupOperations => ({
  serverOrigin: bind(probeLocalServer(serverRuntimeStatePath)),
  hubState: bind(
    runHubCommand(
      flags,
      (origin, token) =>
        Effect.all({
          status: requestHubStatus(origin, token),
          identity: requestHubIdentitySummary(origin, token),
        }),
      { quietLogs: true },
    ).pipe(
      Effect.map(({ status, identity }) => ({
        connector: status.state,
        enrolled: identity.enrolled,
      })),
      Effect.orElseSucceed(() => null),
    ),
  ),
  startHubEnrollment: bind(
    runHubCommand(
      flags,
      (origin, token) =>
        requestHubPendingEnrollment(origin, token).pipe(
          Effect.flatMap((pending) =>
            pending === null ? requestHubEnrollment(origin, token) : Effect.succeed(pending),
          ),
        ),
      { quietLogs: true },
    ).pipe(Effect.mapError(asError)),
  ),
  createOwnerPairingCredential: (ttlMinutes) =>
    bind(
      runWithAuthControlPlane(
        flags,
        (authControlPlane) =>
          authControlPlane
            .createPairingLink({
              role: "owner",
              ttl: Duration.minutes(ttlMinutes),
              label: "ryco setup",
            })
            .pipe(Effect.map((issued) => issued.credential)),
        { quietLogs: true },
      ).pipe(Effect.mapError(asError)),
    ),
  hubLogin: (hubOrigin) =>
    // A cancelled prompt stays a QuitError at runtime; `asError` keeps it as is.
    bind(runHubLoginFlow(flags, { hubOrigin, username: Option.none() })).pipe(
      Effect.mapError(asError),
    ),
  runInForeground: bind(
    runServerCommand(emptyServerFlags(flags.baseDir), {
      startupPresentation: "headless",
      defaultAutoBootstrapProjectFromCwd: false,
    }),
  ).pipe(Effect.asVoid, Effect.mapError(asError)),
});

export const setupClosed = <A, E, R>(effect: Effect.Effect<A, E | Terminal.QuitError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is Terminal.QuitError =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "QuitError",
      () => Console.log(dim("\nClosed.")),
    ),
  );

export const setupCommand = Command.make("setup", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Set this computer up as a Ryco node for your other devices — then come back here for status, pairing, logs, and settings.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (!isInteractiveTerminal()) {
        return yield* new SetupError({
          message:
            "`ryco setup` is interactive. From a script, use `ryco config set <key> <value>` and `ryco service install`.",
        });
      }
      const { config, context } = yield* resolveSetupContext(flags.baseDir);
      yield* refuseDesktopOwnedNode(config.baseDir);
      const operations = yield* makeSetupOperations(flags, config.serverRuntimeStatePath);
      yield* setupClosed(
        Effect.flatMap(loadSetupFlow, (flow) => flow.runSetup(context, operations)),
      );
    }),
  ),
);

const configLocationFlags = { baseDir: baseDirFlag } as const;

const readConfigFor = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const { config, context } = yield* resolveSetupContext(baseDir);
    const saved = yield* Effect.tryPromise({
      try: () => readNodeConfig(context.configPath),
      catch: (cause) => new SetupError({ message: asError(cause).message, cause }),
    });
    return { config, context, saved };
  });

/** After a change: restart a running service, or say how the change takes effect. */
const settingsChangedHint = (context: SetupContext) =>
  Effect.gen(function* () {
    const status =
      context.platform === null
        ? null
        : yield* Effect.tryPromise(() =>
            readNodeServiceStatus(context.platform!, context.serviceLabel),
          ).pipe(Effect.orElseSucceed(() => null));
    yield* Console.log(
      status?.running
        ? `Restart Ryco to use it: ${context.commandPrefix} service restart\n`
        : `Ryco uses it the next time it starts (${context.commandPrefix} serve, or the background service).\n`,
    );
  });

const configShowCommand = Command.make("show", { ...configLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("Show this node's saved settings."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { context, saved } = yield* readConfigFor(flags.baseDir);
      if (flags.json) {
        yield* Console.log(JSON.stringify(saved ?? EMPTY_NODE_CONFIG));
        return;
      }
      yield* Console.log(
        [
          dim(`# ${context.configPath}${saved === null ? " (not created yet)" : ""}`),
          formatNodeConfig(saved ?? EMPTY_NODE_CONFIG),
          "",
          dim(
            `Change one with \`${context.commandPrefix} config set <key> <value>\`, or all of them with \`${context.commandPrefix} setup\`.`,
          ),
          "",
        ].join("\n"),
      );
    }),
  ),
);

const configPathCommand = Command.make("path", { ...configLocationFlags }).pipe(
  Command.withDescription("Print where this node's settings are saved."),
  Command.withHandler((flags) =>
    readConfigFor(flags.baseDir).pipe(
      Effect.flatMap(({ context }) => Console.log(context.configPath)),
    ),
  ),
);

const configSetCommand = Command.make("set", {
  ...configLocationFlags,
  key: Argument.String("key").pipe(
    Argument.withDescription(`One of: ${Object.keys(NODE_CONFIG_KEYS).join(", ")}.`),
  ),
  value: Argument.String("value"),
}).pipe(
  Command.withDescription("Change one saved setting, named like its `ryco serve` flag."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { context, saved } = yield* readConfigFor(flags.baseDir);
      const next = yield* Effect.try({
        try: () => setConfigKey(saved ?? EMPTY_NODE_CONFIG, flags.key, flags.value),
        catch: (cause) => new SetupError({ message: asError(cause).message, cause }),
      });
      yield* Effect.tryPromise({
        try: () => writeNodeConfig(context.configPath, next),
        catch: (cause) => new SetupError({ message: asError(cause).message, cause }),
      });
      yield* Console.log(`${flags.key} = ${lookupConfigKey(flags.key).read(next) ?? "(default)"}`);
      yield* settingsChangedHint(context);
    }),
  ),
);

const configUnsetCommand = Command.make("unset", {
  ...configLocationFlags,
  key: Argument.String("key").pipe(
    Argument.withDescription(`One of: ${Object.keys(NODE_CONFIG_KEYS).join(", ")}.`),
  ),
}).pipe(
  Command.withDescription("Return one setting to its default."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { context, saved } = yield* readConfigFor(flags.baseDir);
      const next = yield* Effect.try({
        try: () => unsetConfigKey(saved ?? EMPTY_NODE_CONFIG, flags.key),
        catch: (cause) => new SetupError({ message: asError(cause).message, cause }),
      });
      yield* Effect.tryPromise({
        try: () => writeNodeConfig(context.configPath, next),
        catch: (cause) => new SetupError({ message: asError(cause).message, cause }),
      });
      yield* Console.log(`${flags.key} = (default)`);
      yield* settingsChangedHint(context);
    }),
  ),
);

const configEditCommand = Command.make("edit", { ...configLocationFlags }).pipe(
  Command.withDescription("Open this node's settings in $EDITOR, checking them when you save."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (!isInteractiveTerminal()) {
        return yield* new SetupError({
          message: "`ryco config edit` needs a terminal. Use `ryco config set` from a script.",
        });
      }
      const { context } = yield* resolveSetupContext(flags.baseDir);
      const changed = yield* Effect.flatMap(loadSetupFlow, (flow) =>
        flow.editNodeConfigFile(context),
      ).pipe(
        Effect.catchIf(
          (error) => error._tag === "QuitError",
          () => Effect.succeed(false),
        ),
      );
      if (changed) yield* settingsChangedHint(context);
    }),
  ),
);

export const configCommand = Command.make("config", {
  ...configLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show or change this node's saved settings (read by `ryco serve` and the background service).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { context, saved } = yield* readConfigFor(flags.baseDir);
      if (flags.json) {
        yield* Console.log(JSON.stringify(saved ?? EMPTY_NODE_CONFIG));
        return;
      }
      yield* Console.log(
        [
          dim(`# ${context.configPath}${saved === null ? " (not created yet)" : ""}`),
          formatNodeConfig(saved ?? EMPTY_NODE_CONFIG),
          "",
          dim(
            `Change one with \`${context.commandPrefix} config set <key> <value>\`, edit them with \`${context.commandPrefix} config edit\`, or rerun \`${context.commandPrefix} setup\`.`,
          ),
          "",
        ].join("\n"),
      );
    }),
  ),
  Command.withSubcommands([
    configShowCommand,
    configPathCommand,
    configSetCommand,
    configUnsetCommand,
    configEditCommand,
  ]),
);
