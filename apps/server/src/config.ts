/**
 * ServerConfig - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import path from "node:path";
import type { ComputerUseBridgeConfig } from "@ryco/contracts";

import { Effect, FileSystem, Layer, LogLevel, Path, Schema, Context } from "effect";
import { canonicalizeHubOrigin, normalizeHubNodeName } from "@ryco/shared/nodeIdentity";

export const DEFAULT_PORT = 3773;

export const RuntimeMode = Schema.Literals(["web", "desktop"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const StartupPresentation = Schema.Literals(["browser", "headless"]);
export type StartupPresentation = typeof StartupPresentation.Type;

/**
 * ServerDerivedPaths - Derived paths from the base directory.
 */
export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly settingsPath: string;
  readonly providerStatusCacheDir: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly serverLogPath: string;
  readonly serverTracePath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly terminalLogsDir: string;
  readonly anonymousIdPath: string;
  readonly environmentIdPath: string;
  readonly serverRuntimeStatePath: string;
  readonly hubIdentityStatePath: string;
  readonly secretsDir: string;
}

export interface HubConnectorConfig {
  readonly enabled: boolean;
  readonly origin: string | undefined;
  readonly nodeName: string | undefined;
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly reconnectStableMs: number;
  readonly reconnectJitterRatio: number;
  readonly allowFileSecretStore: boolean;
  readonly configurationIssue: "configuration_invalid" | undefined;
}

export const DEFAULT_HUB_CONNECTOR_CONFIG: HubConnectorConfig = {
  enabled: false,
  origin: undefined,
  nodeName: undefined,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 60_000,
  reconnectStableMs: 60_000,
  reconnectJitterRatio: 0.2,
  allowFileSecretStore: false,
  configurationIssue: undefined,
};

interface RawHubConnectorConfig {
  readonly enabled?: string | undefined;
  readonly origin?: string | undefined;
  readonly nodeName?: string | undefined;
  readonly reconnectBaseMs?: string | undefined;
  readonly reconnectMaxMs?: string | undefined;
  readonly reconnectStableMs?: string | undefined;
  readonly reconnectJitterRatio?: string | undefined;
  readonly allowFileSecretStore?: string | undefined;
}

const parseBoolean = (value: string | undefined, fallback: boolean): boolean | undefined => {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

const parseInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined => {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
};

const parseRatio = (value: string | undefined, fallback: number): number | undefined => {
  if (value === undefined) return fallback;
  if (value.trim() !== value || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0.5 ? parsed : undefined;
};

export function resolveHubConnectorConfig(raw: RawHubConnectorConfig): HubConnectorConfig {
  const enabled = parseBoolean(raw.enabled, false);
  if (enabled === false) return DEFAULT_HUB_CONNECTOR_CONFIG;

  const reconnectBaseMs = parseInteger(raw.reconnectBaseMs, 1_000, 250, 60_000);
  const reconnectMaxMs = parseInteger(raw.reconnectMaxMs, 60_000, 250, 300_000);
  const reconnectStableMs = parseInteger(raw.reconnectStableMs, 60_000, 5_000, 600_000);
  const reconnectJitterRatio = parseRatio(raw.reconnectJitterRatio, 0.2);
  const allowFileSecretStore = parseBoolean(raw.allowFileSecretStore, false);
  let origin: string | undefined;
  let nodeName: string | undefined;
  try {
    origin = raw.origin === undefined ? undefined : canonicalizeHubOrigin(raw.origin);
  } catch {
    origin = undefined;
  }
  try {
    nodeName = raw.nodeName === undefined ? undefined : normalizeHubNodeName(raw.nodeName);
  } catch {
    nodeName = undefined;
  }

  const invalid =
    enabled !== true ||
    origin === undefined ||
    (raw.nodeName !== undefined && nodeName === undefined) ||
    reconnectBaseMs === undefined ||
    reconnectMaxMs === undefined ||
    reconnectMaxMs < reconnectBaseMs ||
    reconnectStableMs === undefined ||
    reconnectJitterRatio === undefined ||
    allowFileSecretStore === undefined;

  return {
    enabled: true,
    origin,
    nodeName,
    reconnectBaseMs: reconnectBaseMs ?? DEFAULT_HUB_CONNECTOR_CONFIG.reconnectBaseMs,
    reconnectMaxMs: reconnectMaxMs ?? DEFAULT_HUB_CONNECTOR_CONFIG.reconnectMaxMs,
    reconnectStableMs: reconnectStableMs ?? DEFAULT_HUB_CONNECTOR_CONFIG.reconnectStableMs,
    reconnectJitterRatio: reconnectJitterRatio ?? DEFAULT_HUB_CONNECTOR_CONFIG.reconnectJitterRatio,
    allowFileSecretStore: allowFileSecretStore ?? DEFAULT_HUB_CONNECTOR_CONFIG.allowFileSecretStore,
    configurationIssue: invalid ? "configuration_invalid" : undefined,
  };
}

/**
 * NodeE2eePolicyConfig - the operator's E2EE admission policy for this run.
 *
 * TRI-STATE ON PURPOSE. `undefined` means "not configured on this start", which
 * is NOT the same as `false`. The durable record
 * (`hubIdentity/NodeE2eePolicyStore`) is what the node actually admits under;
 * this carries only what the operator stated, and an absent value leaves the
 * committed value untouched.
 *
 * That distinction is the whole point. A boolean defaulted to `false` here would
 * mean an operator who enabled `requireE2EE` by exporting an environment
 * variable in one shell gets it silently withdrawn by the next start from a
 * launcher or service manager — precisely the silent weakening §12.4 forbids.
 * The effective policy is never computed here; §12.4's rule lives in exactly one
 * function, `effectiveNodeE2eePolicy`.
 */
export interface NodeE2eePolicyConfig {
  /** §12.3, raw. `undefined` when this start configured nothing. */
  readonly requireE2EE: boolean | undefined;
  /** §12.4, raw. Implies effective `requireE2EE`; the implication is applied downstream. */
  readonly requireApprovedClientE2EE: boolean | undefined;
  readonly configurationIssue: "configuration_invalid" | undefined;
}

export const DEFAULT_NODE_E2EE_POLICY_CONFIG: NodeE2eePolicyConfig = {
  requireE2EE: undefined,
  requireApprovedClientE2EE: undefined,
  configurationIssue: undefined,
};

interface RawNodeE2eePolicyConfig {
  readonly requireE2EE?: string | undefined;
  readonly requireApprovedClientE2EE?: string | undefined;
}

/**
 * `"unset"` for absent, the boolean for `"true"`/`"false"`, `undefined` for
 * anything else.
 *
 * Deliberately as strict as `parseBoolean`: `1`, `yes` and `TRUE` are refused
 * rather than guessed at, because a guess here changes what the node admits.
 */
const parseTriStateBoolean = (value: string | undefined): boolean | "unset" | undefined => {
  if (value === undefined) return "unset";
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

/**
 * Resolve the configured policy, reporting invalid input rather than guessing.
 *
 * An invalid value resolves to "not configured", so it can only ever leave the
 * durable policy as it was — it can never widen it. `configurationIssue` is what
 * makes that loud instead of silent.
 */
export function resolveNodeE2eePolicyConfig(raw: RawNodeE2eePolicyConfig): NodeE2eePolicyConfig {
  const requireE2EE = parseTriStateBoolean(raw.requireE2EE);
  const requireApprovedClientE2EE = parseTriStateBoolean(raw.requireApprovedClientE2EE);
  const invalid = requireE2EE === undefined || requireApprovedClientE2EE === undefined;
  return {
    requireE2EE: typeof requireE2EE === "boolean" ? requireE2EE : undefined,
    requireApprovedClientE2EE:
      typeof requireApprovedClientE2EE === "boolean" ? requireApprovedClientE2EE : undefined,
    configurationIssue: invalid ? "configuration_invalid" : undefined,
  };
}

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape extends ServerDerivedPaths {
  readonly logLevel: LogLevel.LogLevel;
  readonly traceMinLevel: LogLevel.LogLevel;
  readonly traceTimingEnabled: boolean;
  readonly traceBatchWindowMs: number;
  readonly traceMaxBytes: number;
  readonly traceMaxFiles: number;
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpExportIntervalMs: number;
  readonly otlpServiceName: string;
  readonly mode: RuntimeMode;
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  /**
   * Canonical root for Ryco-managed workspace paths.
   *
   * This is an application path boundary, not a child-process sandbox.
   */
  readonly workspaceAccessRoot?: string | undefined;
  readonly baseDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly noBrowser: boolean;
  readonly startupPresentation: StartupPresentation;
  readonly desktopBootstrapToken: string | undefined;
  /** Process-private credential for Desktop main's loopback control channel. */
  readonly desktopControlToken?: string | undefined;
  readonly computerUseBridge?: ComputerUseBridgeConfig | undefined;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly hubConnector?: HubConnectorConfig;
  /**
   * Kept beside `hubConnector` rather than inside it: `resolveHubConnectorConfig`
   * returns the defaults wholesale when the connector is disabled, and a policy
   * an operator configured must not be discarded because the connector happened
   * to be off on the start that read it.
   */
  readonly hubE2eePolicy?: NodeE2eePolicyConfig;
}

export function resolveManagedWorktreesRoot(
  config: Pick<ServerConfigShape, "workspaceAccessRoot" | "worktreesDir">,
): string {
  return config.workspaceAccessRoot === undefined
    ? config.worktreesDir
    : path.join(config.workspaceAccessRoot, ".ryco", "worktrees");
}

export const deriveServerPaths = Effect.fn(function* (
  baseDir: ServerConfigShape["baseDir"],
  devUrl: ServerConfigShape["devUrl"],
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = join(baseDir, devUrl !== undefined ? "dev" : "userdata");
  const dbPath = join(stateDir, "state.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  const providerStatusCacheDir = join(baseDir, "caches");
  return {
    stateDir,
    dbPath,
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    settingsPath: join(stateDir, "settings.json"),
    providerStatusCacheDir,
    worktreesDir: join(baseDir, "worktrees"),
    attachmentsDir,
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    serverTracePath: join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    terminalLogsDir: join(logsDir, "terminals"),
    anonymousIdPath: join(stateDir, "anonymous-id"),
    environmentIdPath: join(stateDir, "environment-id"),
    serverRuntimeStatePath: join(stateDir, "server-runtime.json"),
    hubIdentityStatePath: join(stateDir, "hub-identity.json"),
    secretsDir: join(stateDir, "secrets"),
  };
});

export const ensureServerDirectories = Effect.fn(function* (derivedPaths: ServerDerivedPaths) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = [
    derivedPaths.stateDir,
    derivedPaths.logsDir,
    derivedPaths.providerLogsDir,
    derivedPaths.terminalLogsDir,
    derivedPaths.attachmentsDir,
    derivedPaths.worktreesDir,
    path.dirname(derivedPaths.keybindingsConfigPath),
    path.dirname(derivedPaths.settingsPath),
    derivedPaths.providerStatusCacheDir,
    path.dirname(derivedPaths.anonymousIdPath),
    path.dirname(derivedPaths.serverRuntimeStatePath),
    path.dirname(derivedPaths.hubIdentityStatePath),
  ];

  yield* Effect.all(
    [...new Set(directories)].map((directory) => fs.makeDirectory(directory, { recursive: true })),
    { concurrency: "unbounded" },
  );
});

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "ryco/config/ServerConfig",
) {
  static readonly layerTest = (cwd: string, baseDirOrPrefix: string | { prefix: string }) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const devUrl = undefined;

        const fs = yield* FileSystem.FileSystem;
        const baseDir =
          typeof baseDirOrPrefix === "string"
            ? baseDirOrPrefix
            : yield* fs.makeTempDirectoryScoped({ prefix: baseDirOrPrefix.prefix });
        const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
        yield* ensureServerDirectories(derivedPaths);

        return {
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
          cwd,
          baseDir,
          ...derivedPaths,
          mode: "web",
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          hubConnector: DEFAULT_HUB_CONNECTOR_CONFIG,
          hubE2eePolicy: DEFAULT_NODE_E2EE_POLICY_CONFIG,
          port: 0,
          host: undefined,
          desktopBootstrapToken: undefined,
          desktopControlToken: undefined,
          staticDir: undefined,
          devUrl,
          noBrowser: false,
          startupPresentation: "browser",
        } satisfies ServerConfigShape;
      }),
    );
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
