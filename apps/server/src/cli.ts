import { NetService } from "@ryco/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@ryco/shared/serverSettings";
import {
  AuthSessionId,
  CommandId,
  ComputerUseBridgeConfig,
  HubConnectorStatus,
  HubEnrollmentCeremonyDetail,
  HubEnrollmentStartResult,
  HubIdentitySummary,
  NodeE2eeAdmissionPolicy,
  OrchestrationReadModel,
  ProjectId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import {
  Config,
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  LogLevel,
  Option,
  Path,
  References,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
// oxlint-disable-next-line no-unused-vars -- TS needs the symbol in scope to name exported CLI types.
import type { NodeInspectSymbol } from "effect/Inspectable";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  DEFAULT_PORT,
  resolveHubConnectorConfig,
  resolveNodeE2eePolicyConfig,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  RuntimeMode,
  type ServerConfigShape,
  type StartupPresentation,
} from "./config.ts";
import { readBootstrapEnvelope } from "./bootstrap.ts";
import {
  E2eeAuthorizationChangeView,
  E2eeClientListingView,
  E2eeClientRecordView,
  E2eeContinuityChangeView,
  E2eeCrossDeviceApprovalView,
  E2eeContinuityView,
  E2eeFallbackView,
  E2eePolicyChangeView,
  E2eePolicyPreviewView,
  E2eePolicyView,
  E2eePrekeyView,
  E2eeSessionListView,
} from "./hubConnector/e2eeOperatorContract.ts";
import { expandHomePath, resolveBaseDir } from "./os-jank.ts";
import { runServer } from "./server.ts";
import { renderTerminalQrCode } from "./startupAccess.ts";
import { AuthControlPlaneRuntimeLive } from "./auth/Layers/AuthControlPlane.ts";
import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "./cliAuthFormat.ts";
import { AuthControlPlane } from "./auth/Services/AuthControlPlane.ts";
import type { AuthControlPlaneShape } from "./auth/Services/AuthControlPlane.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ProjectAvatarStoreLive } from "./project/Layers/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { getAutoBootstrapDefaultModelSelection } from "./serverRuntimeStartup.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";
import { WorkspacePaths } from "./workspace/Services/WorkspacePaths.ts";
import { WorkspaceAccessPolicyLive } from "./workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";

import { initializeDesktopResourceTelemetry } from "./diagnostics/DesktopResourceTelemetry.ts";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

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
  hubOrigin: Schema.optional(Schema.String),
  hubNodeName: Schema.optional(Schema.String),
  hubAllowFileSecretStore: Schema.optional(Schema.Boolean),
  hubRequireE2EE: Schema.optional(Schema.Boolean),
  hubRequireApprovedClientE2EE: Schema.optional(Schema.Boolean),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to RYCO_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const restrictToCwdFlag = Flag.boolean("restrict-to-cwd").pipe(
  Flag.withDescription(
    "Restrict Ryco-managed workspace paths to the startup working directory (not a process sandbox).",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to RYCO_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
const hubConnectorEnabledFlag = Flag.boolean("hub-connector-enabled").pipe(
  Flag.withDescription("Enable the outbound Hub connector (overrides RYCO_HUB_CONNECTOR_ENABLED)."),
  Flag.optional,
);
const hubOriginFlag = Flag.string("hub-origin").pipe(
  Flag.withDescription("Canonical Hub HTTPS origin (overrides RYCO_HUB_ORIGIN)."),
  Flag.optional,
);
const hubNodeNameFlag = Flag.string("hub-node-name").pipe(
  Flag.withDescription("Name proposed when this node enrolls (overrides RYCO_HUB_NODE_NAME)."),
  Flag.optional,
);
const hubAllowFileSecretStoreFlag = Flag.boolean("hub-allow-file-secret-store").pipe(
  Flag.withDescription(
    "Allow the permissioned-file Hub secret-store fallback (overrides RYCO_HUB_ALLOW_FILE_SECRET_STORE).",
  ),
  Flag.optional,
);
const hubRequireE2EEFlag = Flag.boolean("hub-require-e2ee").pipe(
  Flag.withDescription(
    "Accept only end-to-end encrypted relay channels; open plaintext channels are closed (overrides RYCO_HUB_REQUIRE_E2EE).",
  ),
  Flag.optional,
);
const hubRequireApprovedClientE2EEFlag = Flag.boolean("hub-require-approved-client-e2ee").pipe(
  Flag.withDescription(
    "Accept only approved native clients over the relay. Disables web and legacy access entirely, closes the live channels it no longer admits, and can strand remote access if every approved client key is lost (overrides RYCO_HUB_REQUIRE_APPROVED_CLIENT_E2EE).",
  ),
  Flag.optional,
);
const tailscaleServeFlag = Flag.boolean("tailscale-serve").pipe(
  Flag.withDescription(
    "Configure Tailscale Serve to expose this backend over HTTPS on the Tailnet.",
  ),
  Flag.optional,
);
const tailscaleServePortFlag = Flag.integer("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale-serve is enabled."),
  Flag.optional,
);

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("RYCO_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.logLevel("RYCO_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.boolean("RYCO_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: Config.string("RYCO_TRACE_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxBytes: Config.int("RYCO_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: Config.int("RYCO_TRACE_MAX_FILES").pipe(Config.withDefault(10)),
  traceBatchWindowMs: Config.int("RYCO_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(200)),
  otlpTracesUrl: Config.string("RYCO_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.string("RYCO_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.int("RYCO_OTLP_EXPORT_INTERVAL_MS").pipe(Config.withDefault(10_000)),
  otlpServiceName: Config.string("RYCO_OTLP_SERVICE_NAME").pipe(Config.withDefault("ryco-server")),
  mode: Config.schema(RuntimeMode, "RYCO_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("RYCO_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("RYCO_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  rycoHome: Config.string("RYCO_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("RYCO_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.int("RYCO_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("RYCO_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServeEnabled: Config.boolean("RYCO_TAILSCALE_SERVE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServePort: Config.port("RYCO_TAILSCALE_SERVE_PORT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubConnectorEnabled: Config.string("RYCO_HUB_CONNECTOR_ENABLED").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubOrigin: Config.string("RYCO_HUB_ORIGIN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubNodeName: Config.string("RYCO_HUB_NODE_NAME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectBaseMs: Config.string("RYCO_HUB_RECONNECT_BASE_MS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectMaxMs: Config.string("RYCO_HUB_RECONNECT_MAX_MS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectStableMs: Config.string("RYCO_HUB_RECONNECT_STABLE_MS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubReconnectJitterRatio: Config.string("RYCO_HUB_RECONNECT_JITTER_RATIO").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubAllowFileSecretStore: Config.string("RYCO_HUB_ALLOW_FILE_SECRET_STORE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  // Strings, like the other Hub policy inputs, so an unparseable value reaches
  // `resolveNodeE2eePolicyConfig` and is reported as `configuration_invalid`
  // rather than being coerced by the config layer into a policy the operator did
  // not ask for.
  hubRequireE2EE: Config.string("RYCO_HUB_REQUIRE_E2EE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  hubRequireApprovedClientE2EE: Config.string("RYCO_HUB_REQUIRE_APPROVED_CLIENT_E2EE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

interface CliServerFlags {
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
  readonly tailscaleServeEnabled: Option.Option<boolean>;
  readonly tailscaleServePort: Option.Option<number>;
}

interface CliAuthLocationFlags {
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
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
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
      tailscaleServeEnabled: flags.tailscaleServeEnabled ?? Option.none(),
      tailscaleServePort: flags.tailscaleServePort ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);
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

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    yield* Effect.logDebug("startup config phase resolved port", {
      durationMs: Date.now() - startedAt,
      mode,
      port,
    });
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
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const workspaceAccessRoot = Option.getOrElse(normalizedFlags.restrictToCwd, () => false)
      ? yield* fs.realPath(cwd)
      : undefined;
    yield* Effect.logDebug("startup config phase prepared cwd", {
      durationMs: Date.now() - startedAt,
      cwd,
    });
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    yield* Effect.logDebug("startup config phase ensured directories", {
      durationMs: Date.now() - startedAt,
      baseDir,
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
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
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
        Option.fromUndefinedOr(bootstrap?.tailscaleServeEnabled),
      ),
      () => false,
    );
    const tailscaleServePort = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServePort,
        Option.fromUndefinedOr(env.tailscaleServePort),
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
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);
    // Explicit flags win over env, and env wins over the bootstrap envelope,
    // matching every other option here. In the desktop that contest never
    // happens: `backendChildEnv()` strips the Hub variables, so the envelope is
    // the only source. A headless `ryco serve` sends no envelope.
    const hubConnector = resolveHubConnectorConfig({
      enabled: Option.getOrUndefined(
        resolveOptionPrecedence(
          Option.map(normalizedFlags.hubConnectorEnabled, String),
          Option.fromUndefinedOr(env.hubConnectorEnabled),
          Option.map(Option.fromUndefinedOr(bootstrap?.hubConnectorEnabled), String),
        ),
      ),
      origin: Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.hubOrigin,
          Option.fromUndefinedOr(env.hubOrigin),
          Option.fromUndefinedOr(bootstrap?.hubOrigin),
        ),
      ),
      nodeName: Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.hubNodeName,
          Option.fromUndefinedOr(env.hubNodeName),
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
          Option.map(Option.fromUndefinedOr(bootstrap?.hubAllowFileSecretStore), String),
        ),
      ),
    });
    // Same flag > env > envelope precedence as everything above. An option left
    // unset by all three stays unset all the way through to
    // `NodeE2eePolicyStore`, where it means "leave the committed policy alone" —
    // never "false" (§12.4).
    const hubE2eePolicy = resolveNodeE2eePolicyConfig({
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

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        bootstrap?.otlpTracesUrl ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        bootstrap?.otlpMetricsUrl ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
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
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      tailscaleServeEnabled,
      tailscaleServePort,
      hubConnector,
      hubE2eePolicy,
    };

    return config;
  });

const resolveCliAuthConfig = (
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

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(
            { message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes." },
            value,
          ),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);

/**
 * `--json` OWNS STDOUT, so silence covers the WHOLE command and not part of it.
 *
 * Two leaks were shipped by suppressing logs one layer at a time, and both are
 * closed here rather than at the call sites, because both are structural:
 *
 *  1. `resolveServerConfig` logs its startup phases at Debug, and it is what
 *     COMPUTES the configured level — so no level derived from its result can
 *     ever cover it. Under `--log-level debug` a `--json` command emitted four
 *     log lines before printing its document.
 *  2. `Layer.provide(MinimumLogLevel)` hands the reference to the LAYER's
 *     construction and not to the effect that runs under it, so anything the
 *     command body itself logs — the request, the handler, a future addition —
 *     was outside the suppression by construction.
 *
 * `quietly` applies the level to the whole effect, so both are covered by one
 * rule: under `--json`, nothing this process writes below Error reaches the
 * console, whatever part of the command produced it.
 */
const quietly = <A, E, R>(
  quiet: boolean,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  quiet ? Effect.provideService(effect, References.MinimumLogLevel, "Error") : effect;

const runWithAuthControlPlane = <A, E>(
  flags: CliAuthLocationFlags,
  run: (authControlPlane: AuthControlPlaneShape) => Effect.Effect<A, E>,
  options?: {
    readonly quietLogs?: boolean;
  },
) => {
  const quiet = options?.quietLogs === true;
  return quietly(
    quiet,
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const minimumLogLevel = quiet ? "Error" : config.logLevel;
      return yield* Effect.gen(function* () {
        const authControlPlane = yield* AuthControlPlane;
        return yield* run(authControlPlane);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(AuthControlPlaneRuntimeLive).pipe(
            Layer.provide(Layer.succeed(ServerConfig, config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );
    }),
  );
};

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCommandExecutionMode = "live" | "offline";
type ProjectCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "project.create" | "project.meta.update" | "project.delete" }
>;

const ProjectAvatarStoreFromConfigLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return ProjectAvatarStoreLive({ dataDir: config.stateDir });
  }),
);

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspaceAccessPolicyLive,
  WorkspacePathsLive,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(ProjectAvatarStoreFromConfigLayer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);
const HUB_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(15);
const OrchestrationHttpErrorResponse = Schema.Struct({
  error: Schema.String,
});

const withCliSessionToken = <A, E, R>(
  authControlPlane: AuthControlPlaneShape,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    authControlPlane.issueSession({
      role: "owner",
      label: "ryco project cli",
    }),
    (issued) => run(issued.token),
    (issued) => authControlPlane.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const runLiveServerRequest = <A, E extends Error, R>(
  request: HttpClientRequest.HttpClientRequest,
  handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
  timeout = PROJECT_CLI_LIVE_SERVER_TIMEOUT,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    return yield* handle(response);
  }).pipe(Effect.timeout(timeout));

const decodeOrchestrationReadModelResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(OrchestrationReadModel)(response);

const readErrorMessageFromResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(OrchestrationHttpErrorResponse)(response).pipe(
    Effect.map((body) => body.error),
    Effect.catch(() => Effect.succeed(null)),
    Effect.map((body) => {
      if (typeof body === "string" && body.trim().length > 0) {
        return body;
      }
      return `Server request failed with status ${response.status}.`;
    }),
  );

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* Effect.fail(new Error("Project title cannot be empty."));
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* Effect.fail(new Error("Project identifier cannot be empty."));
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.exit(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  const normalizedWorkspaceRoot = Exit.isSuccess(normalizedWorkspaceRootResult)
    ? normalizedWorkspaceRootResult.value
    : null;

  const exactWorkspaceMatch =
    normalizedWorkspaceRoot === null
      ? undefined
      : activeProjects.find((project) => project.workspaceRoot === normalizedWorkspaceRoot);

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* Effect.fail(new Error(`No active project found for '${trimmedIdentifier}'.`));
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/orchestration/snapshot`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": decodeOrchestrationReadModelResponse,
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
  );

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ProjectCliDispatchCommand,
) =>
  HttpClientRequest.post(`${origin}/api/orchestration/dispatch`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(bearerToken),
    HttpClientRequest.bodyJson(command),
    Effect.flatMap((request) =>
      runLiveServerRequest(
        request,
        HttpClientResponse.matchStatus({
          "2xx": () => Effect.void,
          orElse: (response) =>
            readErrorMessageFromResponse(response).pipe(
              Effect.flatMap((message) => Effect.fail(new Error(message))),
            ),
        }),
      ),
    ),
  );

export const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getCommandReadModel();
});

const tryResolveLiveProjectExecutionMode = Effect.fn("tryResolveLiveProjectExecutionMode")(
  function* (authControlPlane: AuthControlPlaneShape, config: ServerConfigShape) {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return Option.none<{ readonly origin: string }>();
    }

    const attempt = withCliSessionToken(authControlPlane, (token) =>
      fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
        Effect.as({
          origin: runtimeState.value.origin,
        }),
      ),
    );

    const attempted = yield* Effect.exit(attempt);
    if (Exit.isSuccess(attempted)) {
      return Option.some(attempted.value);
    }

    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return Option.none<{ readonly origin: string }>();
  },
);

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const authControlPlane = yield* AuthControlPlane;
    const liveMode = yield* tryResolveLiveProjectExecutionMode(authControlPlane, config);

    if (Option.isSome(liveMode)) {
      return yield* withCliSessionToken(authControlPlane, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    const offlineRuntimeLayer = ProjectCliRuntimeLive.pipe(
      Layer.provide(Layer.succeed(ServerConfig, config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const orchestrationEngine = yield* OrchestrationEngineService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => orchestrationEngine.dispatch(command),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(offlineRuntimeLayer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AuthControlPlaneRuntimeLive,
        WorkspaceAccessPolicyLive,
        WorkspacePathsLive,
      ).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

/**
 * Run one command against the running server, as an ephemeral owner session.
 *
 * `quietLogs` mirrors `runWithAuthControlPlane`, through the same `quietly`
 * rule: under `--json` the only thing on stdout must be the document, and this
 * command opens the auth control plane, its SQLite persistence, and an HTTP
 * client — all of which log, and the configuration resolution logs BEFORE any of
 * them. Without it a machine consumer reads log lines interleaved with the value
 * it asked for. It is passed from every command that can emit JSON rather than
 * being defaulted here, so a human run still gets the operator's configured
 * level.
 */
const runHubCommandQuiet = Effect.fn("runHubCommand")(function* <A>(
  flags: CliAuthLocationFlags,
  run: (origin: string, bearerToken: string) => Effect.Effect<A, Error, HttpClient.HttpClient>,
  quiet: boolean,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = quiet ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* Effect.fail(new Error("The Ryco server is not running."));
    }
    const authControlPlane = yield* AuthControlPlane;
    return yield* withCliSessionToken(authControlPlane, (token) =>
      run(runtimeState.value.origin, token),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(AuthControlPlaneRuntimeLive, FetchHttpClient.layer).pipe(
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const runHubCommand = <A>(
  flags: CliAuthLocationFlags,
  run: (origin: string, bearerToken: string) => Effect.Effect<A, Error, HttpClient.HttpClient>,
  options?: {
    readonly quietLogs?: boolean;
  },
) => {
  const quiet = options?.quietLogs === true;
  return quietly(quiet, runHubCommandQuiet(flags, run, quiet));
};

const requestHubStatus = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/hub/status`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const requestHubIdentitySummary = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/hub/identity`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubIdentitySummary)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const requestHubEnrollment = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/enrollment`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubEnrollmentStartResult)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const requestHubEnrollmentCancellation = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/enrollment/cancel`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const requestHubPendingEnrollment = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/hub/enrollment`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) =>
        HttpClientResponse.schemaBodyJson(HubEnrollmentCeremonyDetail)(response).pipe(
          Effect.map((detail): typeof HubEnrollmentCeremonyDetail.Type | null => detail),
        ),
      "404": () => Effect.succeed(null),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const requestHubResume = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/resume`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const formatHubStatus = (
  status: typeof HubConnectorStatus.Type,
  json: boolean,
  identity?: typeof HubIdentitySummary.Type,
): string => {
  if (json) {
    return emitJson({
      ...status,
      ...(identity?.fingerprint === undefined ? {} : { fingerprint: identity.fingerprint }),
    });
  }
  const details = [
    `Hub connector: ${status.state}`,
    identity?.fingerprint === undefined ? undefined : `Fingerprint: ${identity.fingerprint}`,
    status.failure === undefined ? undefined : `Failure: ${status.failure}`,
    status.nextRetryAt === undefined ? undefined : `Next retry: ${status.nextRetryAt}`,
    status.state === "online" ? `Active channels: ${status.activeChannels}` : undefined,
    status.state === "online" ? `Queued bytes: ${status.queuedBytes}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return details.join("\n");
};

const sharedServerLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  restrictToCwd: restrictToCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
  hubConnectorEnabled: hubConnectorEnabledFlag,
  hubOrigin: hubOriginFlag,
  hubNodeName: hubNodeNameFlag,
  hubAllowFileSecretStore: hubAllowFileSecretStoreFlag,
  hubRequireE2EE: hubRequireE2EEFlag,
  hubRequireApprovedClientE2EE: hubRequireApprovedClientE2EEFlag,
  tailscaleServeEnabled: tailscaleServeFlag,
  tailscaleServePort: tailscaleServePortFlag,
} as const;

const authLocationFlags = sharedServerLocationFlags;

const ttlFlag = Flag.string("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

/**
 * The `--json` document, in ONE dialect for every command that emits one.
 *
 * Two dialects grew here: the `hub` family emits compact JSON with no trailing
 * newline, and the `auth` family emits two-space-indented JSON with one. Nothing
 * chose between them, and `--json` is a compatibility surface, so a rule is
 * stated once here and every new command uses it.
 *
 * THE RULE IS THE COMPACT FORM. Three reasons, in order of weight:
 *
 *  1. It is what a consumer of `--json` wants. These documents are read by
 *     `jq`, by shell pipelines, and by scripts that read one line per
 *     invocation; one line per document is the shape all three handle without
 *     buffering, and indentation is display formatting for an audience that is
 *     by definition not reading it.
 *  2. It matches the family this surface belongs to. Every command below reaches
 *     the running server through `runHubCommand`, exactly as `ryco hub status`
 *     does, and an operator piping both into one tool should not have to know
 *     which subcommand tree a value came from.
 *  3. A single emission is what the output is. `Console.log` is called ONCE per
 *     command with the whole document, which is also what keeps the human form's
 *     multi-line output atomic against a concurrent writer.
 *
 * The `auth` family is deliberately left as it is: its documents are printed for
 * a person setting up a headless node, its formatters are a module of their own,
 * and changing an established output format is a break with no benefit to the
 * consumer that already parses it.
 */
const emitJson = (value: unknown): string => JSON.stringify(value);

const sessionRoleFlag = Flag.choice("role", ["owner", "client"]).pipe(
  Flag.withDescription("Role for the issued bearer session."),
  Flag.withDefault("owner"),
);

const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.string("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.string("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.createPairingLink({
            role: "client",
            subject: "one-time-token",
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          const output = formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
          });
          yield* Console.log(output);
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const pairingLinks = yield* authControlPlane.listPairingLinks({ role: "client" });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.string("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokePairingLink(flags.id);
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  ttl: ttlFlag,
  role: sessionRoleFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a bearer session token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.issueSession({
            role: flags.role,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const sessions = yield* authControlPlane.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.string("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokeSession(flags.sessionId);
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);

const hubStatusCommand = Command.make("status", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show bounded local Hub connector status."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        Effect.all({
          status: requestHubStatus(origin, token),
          identity: requestHubIdentitySummary(origin, token),
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap(({ status, identity }) =>
        Console.log(formatHubStatus(status, flags.json, identity)),
      ),
    ),
  ),
);

const hubEnrollCommand = Command.make("enroll", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start device-code enrollment with the configured Hub."),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubEnrollment(origin, token), {
      quietLogs: flags.json,
    }).pipe(
      Effect.flatMap((result) =>
        Console.log(
          flags.json
            ? emitJson(result)
            : [
                `Device code: ${result.deviceCode}`,
                `Fingerprint: ${result.fingerprint}`,
                `Expires: ${result.expiresAt}`,
                "Compare this fingerprint in Hub before approving. Ryco will continue polling in the background.",
              ].join("\n"),
        ),
      ),
    ),
  ),
);

const hubCancelCommand = Command.make("cancel", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Cancel pending Hub enrollment and erase its local polling material."),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubEnrollmentCancellation(origin, token), {
      quietLogs: flags.json,
    }).pipe(Effect.flatMap((status) => Console.log(formatHubStatus(status, flags.json)))),
  ),
);

const requestHubLeave = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/leave`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const formatHubCeremony = (
  detail: typeof HubEnrollmentCeremonyDetail.Type,
  json: boolean,
): string =>
  json
    ? emitJson(detail)
    : [
        `Label: ${detail.label}`,
        `Platform: ${detail.platformOs} · ${detail.platformArch}`,
        `Version: ${detail.clientVersion}`,
        `Algorithm: ${detail.algorithm}`,
        `Fingerprint: ${detail.fingerprint}`,
        `Expires: ${detail.expiresAt}`,
        `Device code: ${detail.deviceCode}`,
        "Compare every field, especially the fingerprint, in Hub before approving.",
      ].join("\n");

const hubPendingCommand = Command.make("pending", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the pending enrollment ceremony again so its fields can be compared in Hub.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubPendingEnrollment(origin, token), {
      quietLogs: flags.json,
    }).pipe(
      Effect.flatMap((detail) =>
        Console.log(
          detail === null
            ? // "Nothing is pending" is an ANSWER, so under `--json` it is a
              // document — `null` — and not prose. Emitting the sentence here
              // made the one reachable outcome of this command unparseable for
              // the consumer the flag exists for, which is the same defect as a
              // log line on stdout and was reached without any logging at all.
              flags.json
              ? emitJson(null)
              : "No Hub enrollment is pending."
            : formatHubCeremony(detail, flags.json),
        ),
      ),
    ),
  ),
);

const hubLeaveCommand = Command.make("leave", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Erase this node's local Hub identity. Destructive: reconnecting needs a new approval, and this does not revoke the node in Hub.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubLeave(origin, token), {
      quietLogs: flags.json,
    }).pipe(Effect.flatMap((status) => Console.log(formatHubStatus(status, flags.json)))),
  ),
);

const hubResumeCommand = Command.make("resume", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Retry a Hub connector that stopped without scheduling its own retry. Prints the resulting status.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubResume(origin, token), {
      quietLogs: flags.json,
    }).pipe(Effect.flatMap((status) => Console.log(formatHubStatus(status, flags.json)))),
  ),
);

const hubCommand = Command.make("hub").pipe(
  Command.withDescription("Manage the outbound Hub connector through the local Ryco server."),
  Command.withSubcommands([
    hubStatusCommand,
    hubEnrollCommand,
    hubPendingCommand,
    hubCancelCommand,
    hubResumeCommand,
    hubLeaveCommand,
  ]),
);

// ─── the relay E2EE operator surface (§6.4, §7.5, §12.3–§12.6, §13.4–§13.6) ──
//
// A sibling family of `hub` rather than a subtree of it. `hub`'s six subcommands
// are connector-lifecycle verbs — enroll, cancel, resume, leave — and every one
// of them is about this node's relationship with a Hub. These are about the
// node's own security state: the Branch A record set outlives any connector
// state, the admission policy is the operator's and not the Hub's (§12.4), and
// the §7.5 lineage survives a `leave` on purpose.
//
// EVERY COMMAND HERE REQUIRES THE RUNNING SERVER, and that is not a limitation
// to be worked around. §13.6 forbids acknowledging a withdrawal before every
// affected channel is closed, §12.6 forbids it before the sweep completes, and
// only the live connector holds those channels. An offline mode would answer
// exactly the questions whose answers would then be false.

const e2eeHubOriginFlag = Flag.string("hub-origin").pipe(
  Flag.withDescription("Hub origin of the client authorization record (§13.6 record key)."),
);

const e2eeAccountIdFlag = Flag.string("account-id").pipe(
  Flag.withDescription("Account id of the client authorization record (§13.6 record key)."),
);

/**
 * The third element of the §13.6 key, in the §7.1 display form.
 *
 * An argument rather than a flag: it is the thing the command is about, and it
 * is the value the owner reads off the device they are pairing — the same
 * `SHA256:`-prefixed string `ryco hub enroll` already prints for this node.
 */
const e2eeFingerprintArgument = Argument.string("fingerprint").pipe(
  Argument.withDescription("Client key fingerprint in SHA256: display form (§7.1)."),
);

const e2eeMaxRoleFlag = Flag.choice("max-role", ["viewer", "operator", "owner"]).pipe(
  Flag.withDescription("Maximum role this client key may exercise (§8.3 role ordering)."),
);

const e2eeCapabilityFlag = Flag.string("capability").pipe(
  Flag.withDescription("Relay capability to grant. Repeat the flag to grant more than one."),
  Flag.atLeast(1),
);

const e2eeLabelFlag = Flag.string("label").pipe(
  Flag.withDescription("Optional owner-assigned label for this record."),
  Flag.optional,
);

const e2eeClientKeyFlags = {
  hubOrigin: e2eeHubOriginFlag,
  accountId: e2eeAccountIdFlag,
} as const;

const e2eeRequireE2eeFlag = Flag.boolean("require-e2ee").pipe(
  Flag.withDescription(
    "Reject plaintext relay payloads (§12.3). Enabling it closes every open legacy channel.",
  ),
  Flag.optional,
);

const e2eePolicyModeFlag = Flag.choice("mode", NodeE2eeAdmissionPolicy.literals).pipe(
  Flag.withDescription(
    "Admission mode: compatibility, require-e2ee, require-native-e2ee, or require-locally-approved-native-e2ee.",
  ),
  Flag.optional,
);

const e2eeRequireApprovedClientFlag = Flag.boolean("require-approved-client-e2ee").pipe(
  Flag.withDescription(
    "Admit only approved native client keys (§12.4). Disables web access entirely.",
  ),
  Flag.optional,
);

/**
 * §7.6 element 9, as an owner states it: the REPLACEMENT registry, repeated.
 *
 * §12.6 makes "a suite leaving the advertised registry" one of its three
 * withdrawal classes, with its own `suiteWithdrawn` count in step (c). Without
 * an input path the node could report that count and no operator command could
 * ever produce it, which leaves part of §12.6's withdrawal surface unreachable
 * — the sweep exists, the policy field exists, and nothing can set it.
 *
 * The whole set travels, not a member to add or drop, for the same reason
 * `client narrow` takes the replacement capability set: §12.6's test is over the
 * resulting registry, so the owner states what is kept and the node decides
 * whether that is a reduction.
 */
const e2eeSuiteFlag = Flag.integer("suite").pipe(
  Flag.withDescription(
    "Suite id to advertise (§3.4 registry). Repeat the flag for each suite kept; the set replaces the current registry.",
  ),
  Flag.atLeast(1),
  Flag.optional,
);

const e2eeAdoptFlag = Flag.string("adopt").pipe(
  Flag.withDescription("Re-adopt this continuity id, keeping every existing client verification."),
  Flag.optional,
);

const e2eeBreakFlag = Flag.boolean("break").pipe(
  Flag.withDescription(
    "Break continuity and mint a fresh id. Every paired client must verify this node again.",
  ),
  Flag.withDefault(false),
);

const e2eeRequest = <A, I, RD>(
  origin: string,
  bearerToken: string,
  path: string,
  schema: Schema.Codec<A, I, RD>,
  body?: unknown,
) => {
  const request =
    body === undefined
      ? Effect.succeed(
          HttpClientRequest.get(`${origin}${path}`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(bearerToken),
          ),
        )
      : HttpClientRequest.post(`${origin}${path}`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(bearerToken),
          HttpClientRequest.bodyJson(body),
        );
  return request.pipe(
    Effect.flatMap((prepared) =>
      runLiveServerRequest(
        prepared,
        HttpClientResponse.matchStatus({
          "2xx": (response) => HttpClientResponse.schemaBodyJson(schema)(response),
          orElse: (response) =>
            readErrorMessageFromResponse(response).pipe(
              Effect.flatMap((message) => Effect.fail(new Error(message))),
            ),
        }),
        HUB_CLI_LIVE_SERVER_TIMEOUT,
      ),
    ),
  );
};

const formatEpoch = (value: number | undefined): string =>
  value === undefined ? "never" : new Date(value).toISOString();

/**
 * One record, in the presentation convention `ryco hub enroll` established:
 * `Label: value` lines, one `Console.log`, and the fingerprint rendered as the
 * `SHA256:` display form under the label `Fingerprint`.
 */
const formatE2eeClientRecord = (record: E2eeClientRecordView): readonly string[] => [
  `Fingerprint: ${record.fingerprint}`,
  `Status: ${record.status}`,
  `Hub origin: ${record.hubOrigin}`,
  `Account: ${record.accountId}`,
  `Max role: ${record.maxRole}`,
  `Capabilities: ${record.capabilitySet.length === 0 ? "none" : record.capabilitySet.join(", ")}`,
  ...(record.displayLabel === undefined ? [] : [`Label: ${record.displayLabel}`]),
  // §13.6's display duty enumerates the safety number among the fields the
  // LISTING carries, not only the fields one record's own command does — and
  // §13.4 makes it the value an owner compares before trusting a record at all.
  // Printing it here is what makes `list` usable for the comparison; leaving it
  // to `show` alone made the listing's own duty unmet and forced an owner to run
  // one command per record to do the thing the records exist for.
  `Safety number: ${record.safetyNumber}`,
  `Created: ${formatEpoch(record.createdAt)}`,
  ...(record.approvedAt === undefined ? [] : [`Approved: ${formatEpoch(record.approvedAt)}`]),
  ...(record.revokedAt === undefined ? [] : [`Revoked: ${formatEpoch(record.revokedAt)}`]),
  `Last seen: ${formatEpoch(record.lastSeenAt)}`,
  ...(record.pairingReserved ? ["Pairing reservation: held"] : []),
];

const formatE2eeClientListing = (listing: E2eeClientListingView, json: boolean): string => {
  if (json) return emitJson(listing);
  const lines: string[] = [];
  if (listing.records.length === 0) {
    lines.push("No client authorization records.");
  }
  for (const record of listing.records) {
    lines.push(...formatE2eeClientRecord(record), "");
  }
  // §13.6's instrumentation duties, stated as their own lines rather than left
  // for the owner to infer from record counts — which is the exact inference the
  // spec says the display must remove.
  lines.push(
    `Pending global cap: ${listing.pendingGlobalSaturated ? "SATURATED" : "not saturated"}`,
  );
  lines.push(
    `Saturated accounts: ${
      listing.saturatedAccounts.length === 0
        ? "none"
        : listing.saturatedAccounts
            .map((account) => `${account.hubOrigin} ${account.accountId}`)
            .join(", ")
    }`,
  );
  // §13.6 makes this count "bounded, owner-clearable", so the display names the
  // action that clears it: a counter an owner can read and cannot reset stops
  // being instrumentation after the first flood, because every later reading is
  // dominated by history the owner has already dealt with.
  lines.push(
    `Pairing attempts refused for pending cap: ${listing.refusedPairingAttempts}${
      listing.refusedPairingAttempts === 0 ? "" : " (clear with: ryco e2ee client clear-refusals)"
    }`,
  );
  if (listing.pairingWindow === undefined) {
    lines.push("Pairing window: closed");
  } else {
    // All three facts §13.6 names, so the owner can tell "my device has not
    // reached the node" from "some other attempt consumed the window".
    lines.push("Pairing window: open");
    lines.push(`Pairing window fingerprint: ${listing.pairingWindow.fingerprint}`);
    lines.push(`Pairing window expires: ${formatEpoch(listing.pairingWindow.expiresAt)}`);
    lines.push(`Pairing window reservation: ${listing.pairingWindow.spent ? "spent" : "unspent"}`);
  }
  if (listing.pendingGlobalSaturated || listing.saturatedAccounts.length > 0) {
    lines.push(
      "Pending pairing is saturated. Purge a pending record, or read the fingerprint off the device and open a pairing window naming it.",
    );
  }
  return lines.join("\n");
};

/**
 * §13.6: a command that performs a withdrawal MUST report how many channels it
 * closed, and MUST NOT return before the ordering has completed.
 *
 * The counts are printed for every authorization command, not only the
 * narrowing ones, because a widening command reporting nothing is one an owner
 * cannot distinguish from a narrowing command that swept nothing.
 */
const formatE2eeAuthorizationChange = (
  change: E2eeAuthorizationChangeView,
  verb: string,
  json: boolean,
): string => {
  if (json) return emitJson(change);
  return [
    ...(change.record === undefined ? [] : formatE2eeClientRecord(change.record)),
    `${verb}. Closed ${change.closedChannels} active E2EE channel(s) and aborted ${change.abortedHandshakes} in-flight handshake(s).`,
  ].join("\n");
};

const formatE2eeSessions = (view: E2eeSessionListView, json: boolean): string => {
  if (json) return emitJson(view);
  if (view.sessions.length === 0) return "No established E2EE sessions.";
  const lines: string[] = [];
  for (const session of view.sessions) {
    lines.push(`Session: ${session.sessionIndex}`);
    lines.push(`Tier: ${session.tier}`);
    lines.push(`Suite: ${session.suite}`);
    lines.push(`Established: ${formatEpoch(session.establishedAt)}`);
    if (session.verificationCode === undefined) {
      // §13.5 has no native meaning: the long-term §13.4 value is the one to
      // compare for a signed client, and it is on the record, not on the session.
      lines.push("Verification code: not applicable (compare the safety number instead)");
    } else {
      lines.push(`Verification code: ${session.verificationCode}`);
    }
    lines.push("");
  }
  // §13.5's advisory-only disclosure duty, in the words the spec constrains it
  // to: what the comparison catches, and what it cannot protect against.
  lines.push(
    "Compare this code with the one shown in the web session. A match catches accidental wrong-node routing and some network interposition while the loaded code is honest; it cannot protect against the Hub operator, who serves that code, and a match is not proof that no interposer is present.",
  );
  return lines.join("\n");
};

const formatE2eePolicy = (policy: E2eePolicyView, json: boolean): string => {
  if (json) return emitJson(policy);
  return [
    `Mode: ${policy.mode}`,
    `requireE2EE: ${policy.requireE2EE}`,
    `requireApprovedClientE2EE: ${policy.requireApprovedClientE2EE}`,
    `Effective requireE2EE: ${policy.effectiveRequireE2EE}`,
    `Admitted patterns: ${policy.admittedPatterns.join(", ")}`,
    `Suite registry: ${policy.suiteRegistry.join(", ")}`,
    `Policy generation: ${policy.generation}`,
  ].join("\n");
};

/**
 * §12.4's operator lockout warning, and §12.6's "roughly how many currently
 * match", printed BEFORE the change runs.
 *
 * §12.4 requires the warning at enable time and requires it to say three things:
 * that the policy disables web and legacy access entirely, that it can strand
 * remote access if every approved native client key is lost, and that enabling
 * it closes the live channels the policy no longer admits.
 */
const formatE2eePolicyWarning = (preview: E2eePolicyPreviewView, requestingStrict: boolean) => {
  const lines: string[] = [];
  if (requestingStrict) {
    lines.push(
      "WARNING: requireApprovedClientE2EE disables web and legacy access entirely. Only approved native client keys reach application payload, and losing every approved key strands remote access to this node until it is recovered locally, which never relaxes admission policy.",
    );
  }
  if (preview.withdrawal) {
    lines.push(
      `This is a policy withdrawal: it will close live channels. Currently matching, approximately — legacy ${preview.counts.legacy}, NX E2EE ${preview.counts.nxE2ee}, suite-withdrawn E2EE ${preview.counts.suiteWithdrawn}, in-flight handshakes ${preview.counts.abortedHandshakes}.`,
    );
  }
  return lines;
};

const formatE2eePolicyChange = (change: E2eePolicyChangeView, json: boolean): string => {
  if (json) return emitJson(change);
  return [
    formatE2eePolicy(change.policy, false),
    change.changed ? "Policy committed." : "Policy unchanged.",
    // §12.6(c): the counts, broken out by class, and the in-flight aborts. They
    // describe what step (b) actually terminated, which is why they are printed
    // even when this transition changed nothing — a retry after a failed sweep
    // arrives with `changed` false and still closes what the first attempt could
    // not.
    `Closed ${change.counts.legacy} legacy channel(s), ${change.counts.nxE2ee} NX E2EE channel(s), ${change.counts.suiteWithdrawn} suite-withdrawn E2EE channel(s); aborted ${change.counts.abortedHandshakes} in-flight handshake(s).`,
  ].join("\n");
};

/**
 * One agreement prekey, in the §6.4 vocabulary.
 *
 * `trailer` is what the command that produced this view has to add — "rotated",
 * or nothing for a read — and the §6.4 REMEDY is appended after it whenever the
 * certificate is expired. The remedy travels on the view from the module that
 * defines the diagnostic, so this surface prints §6.4's words rather than its
 * own, and an operator who reads `Validity: expired` is told in the same breath
 * what to run.
 */
const formatE2eePrekey = (view: E2eePrekeyView, json: boolean, trailer?: string): string => {
  if (json) return emitJson(view);
  if (!view.present) {
    return [
      "Prekey: none",
      "This node holds no agreement prekey for its configured Hub origin. It re-signs one at startup; run `ryco e2ee prekey rotate` to issue one now.",
    ].join("\n");
  }
  return [
    `Prekey: ${view.prekeyId ?? "unset"}`,
    `Fingerprint: ${view.fingerprint ?? "unset"}`,
    `Created: ${formatEpoch(view.createdAt)}`,
    `Expires: ${formatEpoch(view.expiresAt)}`,
    `Validity: ${view.validity ?? "unknown"}`,
    ...(trailer === undefined ? [] : [trailer]),
    ...(view.remedy === undefined ? [] : [view.remedy]),
  ].join("\n");
};

const formatE2eeContinuity = (view: E2eeContinuityView, json: boolean): string => {
  if (json) return emitJson(view);
  if (view.status === "unavailable") {
    return [
      "Continuity: UNRESOLVABLE",
      `Reason: ${view.reason ?? "unknown"}`,
      // §7.5's own remedy sentence, carried from the store that raised the
      // condition rather than restated here.
      view.remedy ?? "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  return [
    "Continuity: advertisable",
    `Continuity id: ${view.continuityId ?? "unset"}`,
    `Rotation generation: ${view.generation ?? 0}`,
    `Retained chain length: ${view.chainLength ?? 0}`,
    ...(view.repair === undefined ? [] : [`Startup repair: ${view.repair}`]),
    ...(view.chainBreak === undefined ? [] : [`Chain break: ${view.chainBreak}`]),
    ...(view.lastBreakReason === undefined
      ? []
      : [`Last break: ${view.lastBreakReason} at ${formatEpoch(view.lastBreakAt)}`]),
  ].join("\n");
};

const formatE2eeContinuityChange = (view: E2eeContinuityChangeView, json: boolean): string => {
  if (json) return emitJson(view);
  switch (view.outcome) {
    case "adopted":
      return [
        `Continuity id: ${view.continuityId ?? "unset"}`,
        "Re-adopted. Every existing client verification is kept.",
      ].join("\n");
    case "reminted":
      return [
        `Continuity id: ${view.continuityId ?? "unset"}`,
        "Continuity broken and a fresh id minted. Every paired client takes the re-verification path and needs a fresh pairing ceremony.",
      ].join("\n");
    case "chain_broken":
      return "Continuity chain broken deliberately. The lineage id is kept; every pinned client takes the re-verification path and needs a fresh pairing ceremony.";
  }
};

const formatE2eeFallback = (view: E2eeFallbackView, json: boolean): string => {
  if (json) return emitJson(view);
  const lines: string[] = [
    `Observation window started: ${formatEpoch(view.windowStartedAt)}`,
    // §12.5: both counters, SEPARATELY and never as a single total.
    `peer-legacy occurrences: ${view.peerLegacy.occurrences}`,
    `peer-legacy last occurrence: ${formatEpoch(view.peerLegacy.lastOccurrenceAt)}`,
    `advertisement-unavailable occurrences: ${view.advertisementUnavailable.occurrences}`,
    `advertisement-unavailable last occurrence: ${formatEpoch(
      view.advertisementUnavailable.lastOccurrenceAt,
    )}`,
  ];
  lines.push(`Retained occurrences: ${view.ring.length}`);
  for (const entry of view.ring) {
    lines.push(`  ${formatEpoch(entry.occurredAt)} ${entry.reason}`);
  }
  // §12.5: a nonzero ring-overflow count MUST be displayed ADJACENT to the ring
  // and labelled as what it means, so a reader cannot take a truncated ring for
  // the whole picture.
  lines.push(`peer-legacy ring overflows: ${view.peerLegacy.ringOverflows}`);
  lines.push(
    `advertisement-unavailable ring overflows: ${view.advertisementUnavailable.ringOverflows}`,
  );
  if (view.peerLegacy.ringOverflows > 0 || view.advertisementUnavailable.ringOverflows > 0) {
    lines.push(
      "The ring overflowed: it is an incomplete account of this window, and the shape of the retained occurrences is not evidence in either direction.",
    );
  }
  // §12.5: "For a live `undersized-connection` condition it MUST also display
  // the asserted `maxDataChunkBytes` and `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`."
  // Both numbers, because the condition is the COMPARISON between them and one
  // of them alone tells an operator nothing about whether it holds. Absent when
  // the condition is not live: §12.5 scopes the pair to the current connection
  // and forbids retaining it in the ring, so there is nothing to show.
  if (view.undersizedConnection !== undefined) {
    lines.push(
      `Undersized connection: asserted maxDataChunkBytes ${view.undersizedConnection.assertedMaxDataChunkBytes} is below E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES ${view.undersizedConnection.advertisementMinChunkBytes}; no conforming capability carrier fits, so this node advertises nothing on this connection.`,
    );
  }
  return lines.join("\n");
};

const e2eeClientListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List client authorization records with their status, authority, and fingerprint (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/clients", E2eeClientListingView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

const e2eeClientShowCommand = Command.make("show", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show one client authorization record and its long-term safety number (§13.4).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/read", E2eeClientRecordView, {
          hubOrigin: flags.hubOrigin,
          accountId: flags.accountId,
          fingerprint: flags.fingerprint,
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((record) =>
        Console.log(
          flags.json
            ? emitJson(record)
            : [
                ...formatE2eeClientRecord(record),
                "Compare this safety number with the one displayed on the client device before trusting this record.",
              ].join("\n"),
        ),
      ),
    ),
  ),
);

const e2eeClientApproveCommand = Command.make("approve", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  maxRole: e2eeMaxRoleFlag,
  capability: e2eeCapabilityFlag,
  label: e2eeLabelFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Approve a client key with an explicit maximum role and capability set (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "approve",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
            maxRole: flags.maxRole,
            capabilitySet: flags.capability,
            ...(Option.isSome(flags.label) ? { displayLabel: flags.label.value } : {}),
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(
          formatE2eeAuthorizationChange(
            change,
            "Approved. Widened authority takes effect on a fresh ticket, channel, and handshake, never on an open one",
            flags.json,
          ),
        ),
      ),
    ),
  ),
);

const e2eeClientApprovalQrCommand = Command.make("approval-qr", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show a short-lived node-signed QR that verifies one already approved phone.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/approval-qr",
          E2eeCrossDeviceApprovalView,
          {
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((approval) =>
        Console.log(
          flags.json
            ? emitJson(approval)
            : [
                "Scan this code in Ryco on the approved phone. It expires after five minutes.",
                renderTerminalQrCode(approval.payload),
                "The code grants no access by itself; the phone still reconnects with a fresh ticket, channel, and IK handshake.",
              ].join("\n"),
        ),
      ),
    ),
  ),
);

const e2eeClientNarrowCommand = Command.make("narrow", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  maxRole: Flag.choice("max-role", ["viewer", "operator", "owner"]).pipe(
    Flag.withDescription("Reduced maximum role (§8.3 role ordering). Never widens."),
    Flag.optional,
  ),
  // The REPLACEMENT set, not a member to drop: §13.6 defines the narrowing test
  // as "any change whose new set is not a superset of the old one", so the owner
  // states what is kept and the client checks that it is a reduction. Repeated
  // and optional together, because narrowing the role alone must leave the
  // capability set untouched rather than emptying it.
  capability: Flag.string("capability").pipe(
    Flag.withDescription("The reduced capability set. Repeat the flag for each member kept."),
    Flag.atLeast(1),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Narrow a client key's authority. Effective before this command acknowledges (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "narrow",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
            ...(Option.isSome(flags.maxRole) ? { maxRole: flags.maxRole.value } : {}),
            ...(Option.isSome(flags.capability) ? { capabilitySet: flags.capability.value } : {}),
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(formatE2eeAuthorizationChange(change, "Narrowed", flags.json)),
      ),
    ),
  ),
);

const e2eeClientRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Revoke a client key. Effective before this command acknowledges (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "revoke",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(formatE2eeAuthorizationChange(change, "Revoked", flags.json)),
      ),
    ),
  ),
);

const e2eeClientPurgeCommand = Command.make("purge", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Purge a record, freeing its slot against both pending caps (§13.6)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "purge",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(formatE2eeAuthorizationChange(change, "Purged", flags.json)),
      ),
    ),
  ),
);

const e2eeWindowOpenCommand = Command.make("open", {
  ...authLocationFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Open a pairing window for one named client key. The discriminator is required (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/pairing-window", E2eeClientListingView, {
          action: "open",
          fingerprint: flags.fingerprint,
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

const e2eeWindowCloseCommand = Command.make("close", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Close the owner-opened pairing window."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/pairing-window", E2eeClientListingView, {
          action: "close",
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

/**
 * §13.6: the count the listing shows is owner-CLEARABLE, and this is what clears
 * it.
 *
 * A command rather than an automatic decay, for the same reason §12.5's counters
 * have one: the count exists so an owner can see a denial they did not cause,
 * and anything that zeroed it without the owner asking would erase the evidence
 * before they read it.
 */
const e2eeClientClearRefusalsCommand = Command.make("clear-refusals", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Clear the count of pairing attempts refused for a pending cap (§13.6). Frees no slot.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/refusals/clear",
          E2eeClientListingView,
          {},
        ),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

const e2eeWindowCommand = Command.make("window").pipe(
  Command.withDescription("Manage the owner-opened pairing window (§13.6)."),
  Command.withSubcommands([e2eeWindowOpenCommand, e2eeWindowCloseCommand]),
);

const e2eeClientCommand = Command.make("client").pipe(
  Command.withDescription("Manage client authorization records (§13.6 Branch A record set)."),
  Command.withSubcommands([
    e2eeClientListCommand,
    e2eeClientShowCommand,
    e2eeClientApproveCommand,
    e2eeClientApprovalQrCommand,
    e2eeClientNarrowCommand,
    e2eeClientRevokeCommand,
    e2eeClientPurgeCommand,
    e2eeClientClearRefusalsCommand,
    e2eeWindowCommand,
  ]),
);

const e2eeSessionsCommand = Command.make("sessions", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the advisory per-session verification code for each established session (§13.5).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/sessions", E2eeSessionListView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeSessions(view, flags.json)))),
  ),
);

const e2eePolicyShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show the effective node admission policy (§12.3, §12.4)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/policy", E2eePolicyView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((policy) => Console.log(formatE2eePolicy(policy, flags.json)))),
  ),
);

const e2eePolicySetCommand = Command.make("set", {
  ...authLocationFlags,
  mode: e2eePolicyModeFlag,
  requireE2EE: e2eeRequireE2eeFlag,
  requireApprovedClientE2EE: e2eeRequireApprovedClientFlag,
  suite: e2eeSuiteFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Change the node admission policy. A narrowing change closes the live channels it no longer admits (§12.6).",
  ),
  Command.withHandler((flags) => {
    const proposal = {
      ...(Option.isSome(flags.mode) ? { mode: flags.mode.value } : {}),
      ...(Option.isSome(flags.requireE2EE) ? { requireE2EE: flags.requireE2EE.value } : {}),
      ...(Option.isSome(flags.requireApprovedClientE2EE)
        ? { requireApprovedClientE2EE: flags.requireApprovedClientE2EE.value }
        : {}),
      ...(Option.isSome(flags.suite) ? { suiteRegistry: flags.suite.value } : {}),
    };
    const requestingStrict =
      (Option.isSome(flags.mode) && flags.mode.value === "require-locally-approved-native-e2ee") ||
      (Option.isSome(flags.requireApprovedClientE2EE) && flags.requireApprovedClientE2EE.value);
    return runHubCommand(
      flags,
      (origin, token) =>
        Effect.gen(function* () {
          // §12.6's display duty: warn AT THE POINT the withdrawal is requested,
          // and say roughly how many channels currently match. The preview is a
          // separate request that mutates nothing, so the warning is printed
          // before anything has been committed or swept.
          const preview = yield* e2eeRequest(
            origin,
            token,
            "/api/hub/e2ee/policy/preview",
            E2eePolicyPreviewView,
            proposal,
          );
          const warnings = formatE2eePolicyWarning(preview, requestingStrict);
          // §12.4's lockout warning and §12.6's pre-change warning are DUTIES,
          // not decoration, so `--json` moves them rather than dropping them.
          // They go to stderr, which is not the document's channel, and the same
          // sentences travel inside the document as `warnings` — so a consumer
          // that only reads stdout still receives them, and one that pipes
          // stderr to a terminal sees them where a human would. Dropping them
          // was the shape that made `--json` the quiet way to skip a warning.
          if (warnings.length > 0) {
            yield* flags.json
              ? Console.error(warnings.join("\n"))
              : Console.log(warnings.join("\n"));
          }
          const change = yield* e2eeRequest(
            origin,
            token,
            "/api/hub/e2ee/policy",
            E2eePolicyChangeView,
            proposal,
          );
          // The preview is carried into the answer rather than discarded: it is
          // what the warning was computed from, and a machine consumer that
          // cannot see the warning needs the numbers behind it to make the same
          // decision an operator makes reading the sentence.
          return { change, preview, warnings };
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap(({ change, preview, warnings }) =>
        Console.log(
          flags.json
            ? emitJson({ ...change, warnings, preview })
            : formatE2eePolicyChange(change, false),
        ),
      ),
    );
  }),
);

/**
 * §5.7's recovery command.
 *
 * The condition is a node whose advertised policy generation is BELOW its
 * durable high-water mark — a restore rolled the record back — and §5.7 says the
 * node must then not advertise, must not reuse the lower value, and must surface
 * exactly one explicit command that durably advances the generation to a value
 * strictly greater than any it may previously have advertised.
 *
 * The warning §5.7 mandates is printed BEFORE the jump and says both things it
 * requires: that clients accept only a strictly higher value, and that the jump
 * is deliberate. The recovery may also NARROW: the store refuses to re-adopt the
 * values of a record the mark says was rolled back and commits §12.4's
 * fail-closed policy instead, so this reports the §12.6 counts like any other
 * withdrawal, and widening back is a separate explicit `policy set`.
 */
const e2eePolicyRecoverCommand = Command.make("recover", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Recover a rolled-back policy generation: advance it past this node's durable high-water mark (§5.7).",
  ),
  Command.withHandler((flags) => {
    const warning =
      "WARNING: this advances the policy generation past every value this node may previously have advertised, and the jump is deliberate. Clients accept only a strictly higher generation than the one they remember, so nothing below the new value can be advertised again. If the durable record was rolled back, recovery commits the fail-closed policy rather than re-adopting the restored values; widen it back with an explicit `ryco e2ee policy set`.";
    return runHubCommand(
      flags,
      (origin, token) =>
        Effect.gen(function* () {
          yield* flags.json ? Console.error(warning) : Console.log(warning);
          return yield* e2eeRequest(
            origin,
            token,
            "/api/hub/e2ee/policy/recover",
            E2eePolicyChangeView,
            {},
          );
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(
          flags.json
            ? emitJson({ ...change, warnings: [warning] })
            : [
                formatE2eePolicyChange(change, false),
                `Policy generation recovered. The next advertisement carries generation ${String(change.policy.generation)}.`,
              ].join("\n"),
        ),
      ),
    );
  }),
);

const e2eePolicyCommand = Command.make("policy").pipe(
  Command.withDescription("Inspect and change the node admission policy (§12.3–§12.6)."),
  Command.withSubcommands([e2eePolicyShowCommand, e2eePolicySetCommand, e2eePolicyRecoverCommand]),
);

/**
 * §6.4's expiry condition, on the one surface an operator can meet it.
 *
 * A READ of the stored certificate, deliberately not of the advertised one: the
 * advertise path re-signs anything unusable, so a display built on it could
 * never show `expired` and §6.4's remedy would be a sentence no operator ever
 * sees. This is where that sentence is reachable.
 */
const e2eePrekeyShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the agreement prekey this node holds, its validity window, and the §6.4 remedy when it has expired.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/prekey", E2eePrekeyView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eePrekey(view, flags.json)))),
  ),
);

const e2eePrekeyRotateCommand = Command.make("rotate", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Force an immediate agreement-prekey rotation: a new keypair and a new certificate (§6.4).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/prekey/rotate", E2eePrekeyView, {}),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((view) =>
        Console.log(
          formatE2eePrekey(
            view,
            flags.json,
            "Rotated. Established channels are unaffected; the outgoing key is retained for the rotation overlap and then destroyed.",
          ),
        ),
      ),
    ),
  ),
);

const e2eePrekeyCommand = Command.make("prekey").pipe(
  Command.withDescription("Manage this node's agreement prekey (§6.4)."),
  Command.withSubcommands([e2eePrekeyShowCommand, e2eePrekeyRotateCommand]),
);

const e2eeContinuityShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show this node's identity-continuity lineage and chain (§7.5)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuity(view, flags.json)))),
  ),
);

/**
 * §7.5's recovery command, with exactly two outcomes the operator must choose
 * between, and no default.
 *
 * Naming neither is an error rather than a default, and naming both is an error
 * too: §7.5 requires the choice to be deliberate, and the second outcome is
 * equivalent to a deliberate chain break — every pinned client takes the
 * re-verification path and needs a fresh pairing ceremony. The command says
 * exactly that at the point of use, which is what §7.5 asks for.
 */
const e2eeContinuityRecoverCommand = Command.make("recover", {
  ...authLocationFlags,
  adopt: e2eeAdoptFlag,
  break: e2eeBreakFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Recover an unresolvable continuity id: re-adopt a confirmed id, or deliberately break continuity (§7.5).",
  ),
  Command.withHandler((flags) => {
    const adopting = Option.isSome(flags.adopt);
    if (adopting === flags.break) {
      return Effect.fail(
        new Error(
          "Choose exactly one outcome: --adopt <continuity-id> keeps every existing client verification; --break mints a fresh id and requires every paired client to verify this node again.",
        ),
      );
    }
    return runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityChangeView, {
          action: adopting ? "adopt" : "remint",
          ...(Option.isSome(flags.adopt) ? { continuityId: flags.adopt.value } : {}),
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuityChange(view, flags.json))));
  }),
);

const e2eeContinuityBreakCommand = Command.make("break", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Deliberately break the continuity chain. Every pinned client needs a fresh pairing ceremony (§7.5).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityChangeView, {
          action: "break",
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuityChange(view, flags.json)))),
  ),
);

const e2eeContinuityCommand = Command.make("continuity").pipe(
  Command.withDescription("Inspect and repair this node's identity lineage (§7.5)."),
  Command.withSubcommands([
    e2eeContinuityShowCommand,
    e2eeContinuityRecoverCommand,
    e2eeContinuityBreakCommand,
  ]),
);

const e2eeFallbackShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show the fallback-occurrence counters and retained ring (§12.5)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/fallback", E2eeFallbackView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeFallback(view, flags.json)))),
  ),
);

const e2eeFallbackResetCommand = Command.make("reset", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Reset both occurrence counters, both ring-overflow counters, and the ring (§12.5).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/fallback/reset", E2eeFallbackView, {}),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeFallback(view, flags.json)))),
  ),
);

const e2eeFallbackCommand = Command.make("fallback").pipe(
  Command.withDescription("Inspect and reset the fallback-occurrence instrumentation (§12.5)."),
  Command.withSubcommands([e2eeFallbackShowCommand, e2eeFallbackResetCommand]),
);

const e2eeCommand = Command.make("e2ee").pipe(
  Command.withDescription(
    "Manage relay payload encryption: client authorization, admission policy, keys, and diagnostics.",
  ),
  Command.withSubcommands([
    e2eeClientCommand,
    e2eeSessionsCommand,
    e2eePolicyCommand,
    e2eePrekeyCommand,
    e2eeContinuityCommand,
    e2eeFallbackCommand,
  ]),
);

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.string("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        if (existingProject) {
          return yield* Effect.fail(
            new Error(`An active project already exists for '${workspaceRoot}'.`),
          );
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        const projectId = ProjectId.make(crypto.randomUUID());
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId,
          title,
          workspaceRoot,
          defaultModelSelection: getAutoBootstrapDefaultModelSelection(),
          createdAt: new Date().toISOString(),
        });
        return `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
      }),
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.string("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([projectAddCommand, projectRemoveCommand, projectRenameCommand]),
);

const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Ryco server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the Ryco server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);

export const cli = Command.make("ryco", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Ryco server."),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    authCommand,
    hubCommand,
    e2eeCommand,
    projectCommand,
  ]),
);
