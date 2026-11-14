/**
 * How a server command finds its configuration: flags, environment, the desktop bootstrap
 * envelope, `node.json` and defaults, in that order.
 */
import { realpathSync } from "node:fs";
import NodePath from "node:path";
import { DEFAULT_HOSTED_APP_ORIGIN } from "@ryco/shared/hostedApp";
import { NetService } from "@ryco/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@ryco/shared/serverSettings";
import { ComputerUseBridgeConfig } from "@ryco/contracts";
import { Config, Data, Effect, FileSystem, LogLevel, Option, Path, Schema } from "effect";
import {
  DEFAULT_KEEP_AWAKE_WHILE_WORKING,
  DEFAULT_PORT,
  resolveHubConnectorConfig,
  resolveNodeE2eePolicyConfig,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  RuntimeMode,
  type ServerConfigShape,
  type StartupPresentation,
} from "../config.ts";
import {
  applyBootstrapShellEnvironment,
  BootstrapEnvelopeUnavailableError,
  readBootstrapEnvelope,
} from "../bootstrap.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { nodeConfigPath, readNodeConfig } from "../cliSetup/nodeConfig.ts";
import type { TraceLocation, TraceLocationFlags } from "../cliTrace/traceCommand.ts";
import {
  OtelEnvironmentConfig,
  resolveServerOtlpExports,
} from "../observability/OtelEnvironment.ts";
import { resolveStandbyHubConnectorConfig } from "../hubConnector/HubConnectorStandby.ts";
import { initializeDesktopResourceTelemetry } from "../diagnostics/DesktopResourceTelemetry.ts";

export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(RuntimeMode),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  rycoHome: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  desktopBootstrapToken: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optional(Schema.Literal(4)),
  computerUseBridge: Schema.optional(ComputerUseBridgeConfig),
  desktopControlToken: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(43),
      Schema.isMaxLength(43),
      Schema.isPattern(/^[A-Za-z0-9_-]{43}$/),
    ),
  ),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
  tailscaleServeEnabled: Schema.optional(Schema.Boolean),
  tailscaleServePort: Schema.optional(PortSchema),
  hubConnectorEnabled: Schema.optional(Schema.Boolean),
  /**
   * Desktop only: run the connector only while this node holds no Hub
   * identity (`resolveStandbyHubConnectorConfig`). Honoured only when the
   * envelope is what enabled the connector.
   */
  hubConnectorStandby: Schema.optional(Schema.Boolean),
  hubOrigin: Schema.optional(Schema.String),
  hubNodeName: Schema.optional(Schema.String),
  hubAllowFileSecretStore: Schema.optional(Schema.Boolean),
  hubRequireE2EE: Schema.optional(Schema.Boolean),
  hubRequireApprovedClientE2EE: Schema.optional(Schema.Boolean),
  hubE2eePolicy: Schema.optional(Schema.String),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  /**
   * Desktop only: the login-shell environment (PATH, SSH_AUTH_SOCK,
   * HOMEBREW_*, XDG_*, FNM_*), so a backend spawned before the desktop had a
   * shell-environment cache still finds the user's tools. Merged into
   * `process.env` before any layer is built; unknown names are ignored.
   */
  shellEnvironment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * Ryco Nightly only: the one Ryco data home this backend may copy from when Ryco left a copy
   * request in its home (flavorImportStartup.ts), and the token of the launch Ryco opened it
   * with (only that launch's request is taken). Honoured only in desktop mode.
   */
  flavorImport: Schema.optional(
    Schema.Struct({ allowedSourceHome: Schema.String, requestToken: Schema.String }),
  ),
});

/** Where the data directory and the trace file are; `ryco trace` reads only these variables. */
const traceLocationEnvFields = {
  rycoHome: Config.String("RYCO_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  traceFile: Config.String("RYCO_TRACE_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxFiles: Config.Int("RYCO_TRACE_MAX_FILES").pipe(Config.withDefault(10)),
};

const EnvServerConfig = Config.all({
  ...traceLocationEnvFields,
  logLevel: Config.LogLevel("RYCO_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.LogLevel("RYCO_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.Boolean("RYCO_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceMaxBytes: Config.Int("RYCO_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceBatchWindowMs: Config.Int("RYCO_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(200)),
  otlpTracesUrl: Config.String("RYCO_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.String("RYCO_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpLogsUrl: Config.String("RYCO_OTLP_LOGS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otel: OtelEnvironmentConfig,
  otlpExportIntervalMs: Config.Int("RYCO_OTLP_EXPORT_INTERVAL_MS").pipe(Config.withDefault(10_000)),
  browserTracesEnabled: Config.Boolean("RYCO_BROWSER_TRACES").pipe(Config.withDefault(false)),
  otlpServiceName: Config.String("RYCO_OTLP_SERVICE_NAME").pipe(Config.withDefault("ryco-server")),
  mode: Config.schema(RuntimeMode, "RYCO_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.Port("RYCO_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.String("RYCO_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.Boolean("RYCO_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.Int("RYCO_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.Boolean("RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.Boolean("RYCO_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  preventSleep: Config.Boolean("RYCO_PREVENT_SLEEP").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  keepAwakeWhileWorking: Config.Boolean("RYCO_KEEP_AWAKE_WHILE_WORKING").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServeEnabled: Config.Boolean("RYCO_TAILSCALE_SERVE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServePort: Config.Port("RYCO_TAILSCALE_SERVE_PORT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubConnectorEnabled: Config.String("RYCO_HUB_CONNECTOR_ENABLED").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubOrigin: Config.String("RYCO_HUB_ORIGIN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubNodeName: Config.String("RYCO_HUB_NODE_NAME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectBaseMs: Config.String("RYCO_HUB_RECONNECT_BASE_MS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectMaxMs: Config.String("RYCO_HUB_RECONNECT_MAX_MS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectStableMs: Config.String("RYCO_HUB_RECONNECT_STABLE_MS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectJitterRatio: Config.String("RYCO_HUB_RECONNECT_JITTER_RATIO").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubAllowFileSecretStore: Config.String("RYCO_HUB_ALLOW_FILE_SECRET_STORE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  // Strings, like the other Hub policy inputs, so an unparseable value reaches
  // `resolveNodeE2eePolicyConfig` and is reported as `configuration_invalid`
  // rather than being coerced by the config layer into a policy the operator did
  // not ask for.
  hubRequireE2EE: Config.String("RYCO_HUB_REQUIRE_E2EE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubRequireApprovedClientE2EE: Config.String("RYCO_HUB_REQUIRE_APPROVED_CLIENT_E2EE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubE2eePolicy: Config.String("RYCO_HUB_E2EE_POLICY").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

export interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly restrictToCwd?: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
  readonly hubConnectorEnabled?: Option.Option<boolean>;
  readonly hubOrigin?: Option.Option<string>;
  readonly hubNodeName?: Option.Option<string>;
  readonly hubAllowFileSecretStore?: Option.Option<boolean>;
  readonly hubRequireE2EE?: Option.Option<boolean>;
  readonly hubRequireApprovedClientE2EE?: Option.Option<boolean>;
  readonly hubE2eePolicy?: Option.Option<string>;
  readonly preventSleep?: Option.Option<boolean>;
  readonly keepAwakeWhileWorking?: Option.Option<boolean>;
  readonly tailscaleServeEnabled: Option.Option<boolean>;
  readonly tailscaleServePort: Option.Option<number>;
}

export interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly defaultAutoBootstrapProjectFromCwd?: boolean;
    /**
     * Read `<state dir>/node.json` as the layer between environment variables
     * and defaults. Server commands only; never for a Desktop-spawned backend.
     */
    readonly useNodeConfig?: boolean;
  },
) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const { findAvailablePort } = yield* NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      restrictToCwd: flags.restrictToCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
      hubConnectorEnabled: flags.hubConnectorEnabled ?? Option.none(),
      hubOrigin: flags.hubOrigin ?? Option.none(),
      hubNodeName: flags.hubNodeName ?? Option.none(),
      hubAllowFileSecretStore: flags.hubAllowFileSecretStore ?? Option.none(),
      hubRequireE2EE: flags.hubRequireE2EE ?? Option.none(),
      hubRequireApprovedClientE2EE: flags.hubRequireApprovedClientE2EE ?? Option.none(),
      hubE2eePolicy: flags.hubE2eePolicy ?? Option.none(),
      preventSleep: flags.preventSleep ?? Option.none(),
      keepAwakeWhileWorking: flags.keepAwakeWhileWorking ?? Option.none(),
      tailscaleServeEnabled: flags.tailscaleServeEnabled ?? Option.none(),
      tailscaleServePort: flags.tailscaleServePort ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();
    if (bootstrapFd !== undefined && Option.isNone(bootstrapEnvelope)) {
      return yield* new BootstrapEnvelopeUnavailableError({
        fd: bootstrapFd,
        message: `No bootstrap envelope arrived on fd ${bootstrapFd}; the process that started this server is gone or stalled.`,
      });
    }
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);
    applyBootstrapShellEnvironment(bootstrap?.shellEnvironment);
    if (bootstrap?.mode === "desktop" && bootstrap.desktopTelemetryFd === 4) {
      initializeDesktopResourceTelemetry(bootstrap.desktopTelemetryFd);
    }

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      () => "web",
    );

    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.fromUndefinedOr(bootstrap?.devUrl),
      ),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.baseDir,
          Option.fromUndefinedOr(env.rycoHome),
          Option.fromUndefinedOr(bootstrap?.rycoHome),
        ),
      ),
    );
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    yield* Effect.logDebug("startup config phase ensured directories", {
      durationMs: Date.now() - startedAt,
      baseDir,
    });
    const nodeConfig =
      options?.useNodeConfig === true && bootstrap === undefined && mode !== "desktop"
        ? yield* Effect.tryPromise({
            try: () => readNodeConfig(nodeConfigPath(derivedPaths.stateDir)),
            catch: (cause) =>
              new NodeConfigLoadError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          })
        : null;
    const fromNodeConfig = <A>(value: A | undefined) => Option.fromUndefinedOr(value);
    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        fromNodeConfig(nodeConfig?.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          // Check the interface the server will actually bind.
          const bindHost = Option.getOrUndefined(
            resolveOptionPrecedence(
              normalizedFlags.host,
              Option.fromUndefinedOr(env.host),
              fromNodeConfig(nodeConfig?.host),
              Option.fromUndefinedOr(bootstrap?.host),
            ),
          );
          return findAvailablePort(DEFAULT_PORT, bindHost);
        },
      },
    );
    yield* Effect.logDebug("startup config phase resolved port", {
      durationMs: Date.now() - startedAt,
      mode,
      port,
    });
    const rawCwd = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.cwd, fromNodeConfig(nodeConfig?.workspace)),
      () => process.cwd(),
    );
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    if (Option.isSome(normalizedFlags.cwd) && !(yield* fs.exists(cwd))) {
      // A bare word that is not an existing folder is almost always a command
      // this CLI does not have — an older `ryco` given `setup`, or a typo —
      // not a request to create a folder by that name and serve from it.
      const requested = normalizedFlags.cwd.value.trim();
      if (isBareCommandWord(requested)) {
        return yield* new UnknownCommandError({
          message: `Unknown command "${requested}". Run \`ryco --help\` to see the commands${
            process.argv[1]?.includes("_npx") ? " (npx runs the version published on npm)" : ""
          }; to start in a new folder by that name, pass ./${requested}.`,
        });
      }
    }
    yield* fs.makeDirectory(cwd, { recursive: true });
    const workspaceAccessRoot = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.restrictToCwd,
        fromNodeConfig(nodeConfig?.restrictToWorkspace),
      ),
      () => false,
    )
      ? yield* fs.realPath(cwd)
      : undefined;
    yield* Effect.logDebug("startup config phase prepared cwd", {
      durationMs: Date.now() - startedAt,
      cwd,
    });
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      () => mode === "desktop",
    );
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const desktopControlToken = bootstrap?.desktopControlToken;
    // An explicit flag wins; otherwise `serve`/`setup` and headless startups never register the
    // directory they happen to run in, whatever the environment says.
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(options?.defaultAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
        Option.fromUndefinedOr(bootstrap?.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
        Option.fromUndefinedOr(bootstrap?.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const tailscaleServeEnabled = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServeEnabled,
        Option.fromUndefinedOr(env.tailscaleServeEnabled),
        fromNodeConfig(nodeConfig?.tailscaleServe),
        Option.fromUndefinedOr(bootstrap?.tailscaleServeEnabled),
      ),
      () => false,
    );
    const tailscaleServePort = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServePort,
        Option.fromUndefinedOr(env.tailscaleServePort),
        fromNodeConfig(nodeConfig?.tailscaleServePort),
        Option.fromUndefinedOr(bootstrap?.tailscaleServePort),
      ),
      () => 443,
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    yield* Effect.logDebug("startup config phase resolved static dir", {
      durationMs: Date.now() - startedAt,
      staticDir: staticDir ?? "none",
      devUrl: devUrl?.toString() ?? "none",
    });
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        fromNodeConfig(nodeConfig?.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);
    // Explicit flags win over env, and env wins over the bootstrap envelope,
    // matching every other option here. In the desktop that contest never
    // happens: `backendChildEnv()` strips the Hub variables, so the envelope is
    // the only source. A headless `ryco serve` sends no envelope.
    const configuredHubConnector = resolveHubConnectorConfig({
      enabled: Option.getOrUndefined(
        resolveOptionPrecedence(
          Option.map(normalizedFlags.hubConnectorEnabled, String),
          Option.fromUndefinedOr(env.hubConnectorEnabled),
          Option.map(fromNodeConfig(nodeConfig?.hub?.enabled), String),
          Option.map(Option.fromUndefinedOr(bootstrap?.hubConnectorEnabled), String),
        ),
      ),
      // The hosted Hub is the default, so `ryco serve --hub` is enough on its
      // own. Enrollment still needs an owner's explicit approval at that Hub.
      origin: Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.hubOrigin,
          Option.fromUndefinedOr(env.hubOrigin),
          fromNodeConfig(nodeConfig?.hub?.origin),
          Option.fromUndefinedOr(bootstrap?.hubOrigin),
          Option.some(DEFAULT_HOSTED_APP_ORIGIN),
        ),
      ),
      nodeName: Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.hubNodeName,
          Option.fromUndefinedOr(env.hubNodeName),
          fromNodeConfig(nodeConfig?.hub?.nodeName),
          Option.fromUndefinedOr(bootstrap?.hubNodeName),
        ),
      ),
      reconnectBaseMs: env.hubReconnectBaseMs,
      reconnectMaxMs: env.hubReconnectMaxMs,
      reconnectStableMs: env.hubReconnectStableMs,
      reconnectJitterRatio: env.hubReconnectJitterRatio,
      allowFileSecretStore: Option.getOrUndefined(
        resolveOptionPrecedence(
          Option.map(normalizedFlags.hubAllowFileSecretStore, String),
          Option.fromUndefinedOr(env.hubAllowFileSecretStore),
          Option.map(fromNodeConfig(nodeConfig?.hub?.allowFileSecretStore), String),
          Option.map(Option.fromUndefinedOr(bootstrap?.hubAllowFileSecretStore), String),
        ),
      ),
    });
    // An explicit flag or environment value is the operator's statement for
    // this run, so standby only refines an envelope-enabled Desktop connector.
    const hubConnector =
      mode === "desktop" &&
      bootstrap?.hubConnectorStandby === true &&
      Option.isNone(normalizedFlags.hubConnectorEnabled) &&
      env.hubConnectorEnabled === undefined
        ? yield* Effect.promise(() =>
            resolveStandbyHubConnectorConfig({
              config: configuredHubConnector,
              statePath: derivedPaths.hubIdentityStatePath,
            }),
          )
        : configuredHubConnector;
    // Same flag > env > envelope precedence as everything above. An option left
    // unset by all three stays unset all the way through to
    // `NodeE2eePolicyStore`, where it means "leave the committed policy alone" —
    // never "false" (§12.4).
    const hubE2eePolicy = resolveNodeE2eePolicyConfig({
      mode: Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.hubE2eePolicy,
          Option.fromUndefinedOr(env.hubE2eePolicy),
          fromNodeConfig(nodeConfig?.hub?.e2eePolicy),
          Option.fromUndefinedOr(bootstrap?.hubE2eePolicy),
        ),
      ),
      requireE2EE: Option.getOrUndefined(
        resolveOptionPrecedence(
          Option.map(normalizedFlags.hubRequireE2EE, String),
          Option.fromUndefinedOr(env.hubRequireE2EE),
          Option.map(Option.fromUndefinedOr(bootstrap?.hubRequireE2EE), String),
        ),
      ),
      requireApprovedClientE2EE: Option.getOrUndefined(
        resolveOptionPrecedence(
          Option.map(normalizedFlags.hubRequireApprovedClientE2EE, String),
          Option.fromUndefinedOr(env.hubRequireApprovedClientE2EE),
          Option.map(Option.fromUndefinedOr(bootstrap?.hubRequireApprovedClientE2EE), String),
        ),
      ),
    });

    const otlp = yield* resolveServerOtlpExports(env.otel, {
      traces: {
        rycoEnvUrl: env.otlpTracesUrl,
        bootstrapUrl: bootstrap?.otlpTracesUrl,
        settingsUrl: persistedObservabilitySettings.otlpTracesUrl,
      },
      metrics: {
        rycoEnvUrl: env.otlpMetricsUrl,
        bootstrapUrl: bootstrap?.otlpMetricsUrl,
        settingsUrl: persistedObservabilitySettings.otlpMetricsUrl,
      },
      logs: { rycoEnvUrl: env.otlpLogsUrl },
    });

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl: otlp.traces.url,
      otlpMetricsUrl: otlp.metrics.url,
      ...(otlp.logs.url !== undefined ? { otlpLogsUrl: otlp.logs.url } : {}),
      ...(otlp.exports !== undefined ? { otlpExports: otlp.exports } : {}),
      ...(otlp.resourceAttributes !== undefined
        ? { otlpResourceAttributes: otlp.resourceAttributes }
        : {}),
      ...(otlp.warnings.length > 0 ? { observabilityWarnings: otlp.warnings } : {}),
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      ...(env.browserTracesEnabled ? { browserTracesEnabled: true } : {}),
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      cwd,
      ...(workspaceAccessRoot !== undefined ? { workspaceAccessRoot } : {}),
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      ...(desktopControlToken === undefined ? {} : { desktopControlToken }),
      ...(mode === "desktop" && bootstrap?.computerUseBridge
        ? { computerUseBridge: bootstrap.computerUseBridge }
        : {}),
      ...(mode === "desktop" && bootstrap?.flavorImport
        ? { flavorImport: bootstrap.flavorImport }
        : {}),
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      tailscaleServeEnabled,
      tailscaleServePort,
      preventSleep:
        Option.getOrUndefined(normalizedFlags.preventSleep) ??
        env.preventSleep ??
        nodeConfig?.preventSleep ??
        false,
      // Desktop main holds the machine awake for a desktop backend, so it stays unset there.
      ...(mode === "desktop"
        ? {}
        : {
            keepAwakeWhileWorking:
              Option.getOrUndefined(normalizedFlags.keepAwakeWhileWorking) ??
              env.keepAwakeWhileWorking ??
              nodeConfig?.keepAwakeWhileWorking ??
              DEFAULT_KEEP_AWAKE_WHILE_WORKING,
          }),
      hubConnector,
      hubE2eePolicy,
    };

    return config;
  });

/**
 * Admin commands open the node's state directly, which logs routine startup
 * (migrations) at Info; that is noise next to their one line of output. They
 * log warnings and errors unless a level was asked for explicitly.
 */
export const adminCommandLogLevel = (
  requested: Option.Option<LogLevel.LogLevel>,
  configured: LogLevel.LogLevel,
): LogLevel.LogLevel => (Option.isSome(requested) ? configured : "Warn");

export class UnknownCommandError extends Data.TaggedError("UnknownCommandError")<{
  readonly message: string;
}> {}

/** A single word — no path separator, no `.` or `~` prefix — as a command would be. */
export const isBareCommandWord = (value: string) =>
  /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value) && !value.includes("/");

export class NodeConfigLoadError extends Data.TaggedError("NodeConfigLoadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Set by Ryco Desktop's `ryco` command launcher to the home of the app's own
 * node (apps/desktop/src/desktopCliCommand.ts).
 */
const DESKTOP_CLI_HOME_ENV = "RYCO_DESKTOP_CLI";

export class DesktopOwnedNodeError extends Data.TaggedError("DesktopOwnedNodeError")<{
  readonly message: string;
}> {}

/**
 * The desktop's command runs admin commands against the app's node; starting a
 * second node, or a service, for that home would fight the app over its data.
 * Returns the refusal, or `null` when `baseDir` is not the desktop app's home.
 */
/** The folder's real path, so another spelling of it (a link, letter case on APFS) is the same. */
const canonicalPath = (path: string) => {
  const resolved = NodePath.resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

export const desktopOwnedNodeRefusal = (
  env: Readonly<Record<string, string | undefined>>,
  baseDir: string,
): string | null => {
  const desktopHome = env[DESKTOP_CLI_HOME_ENV]?.trim();
  if (!desktopHome || canonicalPath(desktopHome) !== canonicalPath(baseDir)) return null;
  return `Ryco Desktop runs the node for ${baseDir}. Open Ryco to start it; \`ryco --help\` lists the commands that work with it.`;
};

export const refuseDesktopOwnedNode = (baseDir: string) => {
  const message = desktopOwnedNodeRefusal(process.env, baseDir);
  return message === null ? Effect.void : Effect.fail(new DesktopOwnedNodeError({ message }));
};

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      restrictToCwd: Option.none(),
      logWebSocketEvents: Option.none(),
      tailscaleServeEnabled: Option.none(),
      tailscaleServePort: Option.none(),
    },
    cliLogLevel,
  );

/**
 * The trace file the server writes, found the way `resolveServerConfig` finds it, but without
 * creating the data directory's folders: `ryco trace` only reads.
 */
export const resolveTraceLocation = (flags: TraceLocationFlags) =>
  Effect.gen(function* () {
    const env = yield* Config.all(traceLocationEnvFields);
    const devUrl = Option.getOrUndefined(
      resolveOptionPrecedence(flags.devUrl, Option.fromUndefinedOr(env.devUrl)),
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(flags.baseDir, Option.fromUndefinedOr(env.rycoHome)),
      ),
    );
    const { stateDir, serverTracePath } = yield* deriveServerPaths(baseDir, devUrl);
    return {
      baseDir,
      stateDir,
      traceFilePath: env.traceFile ?? serverTracePath,
      traceFileFromEnv: env.traceFile !== undefined,
      maxBackups: env.traceMaxFiles,
    } satisfies TraceLocation;
  });
