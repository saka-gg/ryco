import {
  CodexSettings,
  McpAuthStatus,
  McpInventoryResource,
  McpInventoryResourceTemplate,
  McpInventoryTool,
  McpListServersInput,
  McpListServersResult,
  McpListWorkspacesResult,
  McpOauthLoginInput,
  McpOauthLoginResult,
  McpProviderCapabilities,
  McpProviderSupport,
  McpServer,
  McpServerConfig,
  McpServerEnabledInput,
  McpServerName,
  McpServerRemoveInput,
  McpServerSource,
  McpServerUpsertInput,
  McpServersReloadInput,
  McpSettingsError,
  McpStartupStatus,
  McpWorkspace,
  McpWorkspaceId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import { Cause, Duration, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../config.ts";
import { runProcess } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
  type CodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import {
  applyProviderMcpSecretMutations,
  providerMcpSecretPresence,
} from "./ProviderMcpSecrets.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const COPILOT_DRIVER = ProviderDriverKind.make("copilot");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const MCP_APP_SERVER_TIMEOUT = Duration.seconds(25);
const MCP_STATUS_PAGE_LIMIT = 100;
const MCP_STATUS_MAX_PAGES = 10;
const MCP_REMOVE_TIMEOUT_MS = 20_000;

interface WorkspaceRuntime {
  readonly workspace: McpWorkspace;
  readonly layout: CodexHomeLayout;
  readonly codexSettings: CodexSettings;
  readonly processEnv: NodeJS.ProcessEnv;
}

interface WorkspaceDiscovery {
  readonly runtimes: ReadonlyArray<WorkspaceRuntime>;
  readonly providers: ReadonlyArray<McpProviderSupport>;
  readonly issues: McpListWorkspacesResult["issues"];
}

type CodexMcpClientError = CodexErrors.CodexAppServerError;

function toMcpError(message: string, cause?: unknown): McpSettingsError {
  return new McpSettingsError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function normalizeUnknownError(cause: unknown, fallback: string): McpSettingsError {
  if (Schema.is(McpSettingsError)(cause)) {
    return cause;
  }
  if (cause instanceof Error) {
    return toMcpError(cause.message, cause);
  }
  return toMcpError(fallback, cause);
}

function workspaceIdFor(sharedHomePath: string): McpWorkspaceId {
  return McpWorkspaceId.make(`codex:${Buffer.from(sharedHomePath, "utf8").toString("base64url")}`);
}

export function mcpSupportForDriver(
  driver: ProviderDriverKind,
): Pick<McpProviderSupport, "status" | "message" | "capabilities"> {
  const unavailable = Schema.decodeSync(McpProviderCapabilities)({});
  switch (driver) {
    case CODEX_DRIVER:
      return {
        status: "managed",
        message: "Ryco can list, edit, reload, and start OAuth for Codex MCP servers.",
        capabilities: Schema.decodeSync(McpProviderCapabilities)({
          readConfiguration: "available",
          upsert: "available",
          remove: "available",
          enableDisable: "available",
          reload: "available",
          health: "available",
          inventory: "available",
          oauth: "available",
          externalAgentControl: "available",
          automaticAgentControl: "available",
          scopes: ["user"],
        }),
      };
    case COPILOT_DRIVER:
      return {
        status: "external",
        message:
          "GitHub Copilot can emit MCP tool calls, but its MCP server configuration is managed outside this panel.",
        capabilities: Schema.decodeSync(McpProviderCapabilities)({
          automaticAgentControl: "available",
        }),
      };
    case CLAUDE_DRIVER:
      return {
        status: "external",
        message:
          "Claude MCP tool activity can be displayed, but Claude server configuration is managed outside this panel.",
        capabilities: Schema.decodeSync(McpProviderCapabilities)({
          automaticAgentControl: "available",
        }),
      };
    case OPENCODE_DRIVER:
      return {
        status: "external",
        message:
          "OpenCode MCP setup is managed by OpenCode; Ryco only displays reported MCP activity.",
        capabilities: unavailable,
      };
    case CURSOR_DRIVER:
      return {
        status: "unsupported",
        message:
          "Cursor user-managed MCP configuration is not exposed in this panel; Ryco may separately inject its private internal Agent Control server per session.",
        capabilities: Schema.decodeSync(McpProviderCapabilities)({
          automaticAgentControl: "available",
        }),
      };
    default:
      return {
        status: "unsupported",
        message: "This driver has no MCP management integration registered in Ryco.",
        capabilities: unavailable,
      };
  }
}

function buildProviderSupport(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly workspaceId?: McpWorkspaceId | undefined;
}): McpProviderSupport {
  const support = mcpSupportForDriver(input.driver);
  return Schema.decodeSync(McpProviderSupport)({
    instanceId: input.instanceId,
    driver: input.driver,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled,
    status: support.status,
    capabilities: support.capabilities,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    message: input.enabled
      ? support.message
      : "This provider instance is disabled. Enable it before using MCP features.",
  });
}

function sortProviderSupport(left: McpProviderSupport, right: McpProviderSupport): number {
  const statusRank: Record<McpProviderSupport["status"], number> = {
    managed: 0,
    external: 1,
    unsupported: 2,
  };
  return (
    statusRank[left.status] - statusRank[right.status] ||
    Number(right.enabled) - Number(left.enabled) ||
    left.driver.localeCompare(right.driver) ||
    left.instanceId.localeCompare(right.instanceId)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const entries = Object.entries(record).filter((entry): entry is [string, string] => {
    const [, entryValue] = entry;
    return typeof entryValue === "string";
  });
  return Object.fromEntries(entries);
}

function asSpawnEnv(value: NodeJS.ProcessEnv): Record<string, string> {
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    const [, entryValue] = entry;
    return typeof entryValue === "string";
  });
  return Object.fromEntries(entries);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sourceFromOrigin(origin: unknown): McpServerSource {
  const source = asRecord(asRecord(origin)?.name);
  const type = source?.type;
  if (type === "user" || type === "project" || type === "system") {
    return type;
  }
  if (type === "mdm") {
    return "managed";
  }
  return "unknown";
}

function mergeSources(left: McpServerSource, right: McpServerSource): McpServerSource {
  if (left === right) return left;
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  return "mixed";
}

function sourceForServer(
  name: string,
  origins: Record<string, unknown>,
  layerServers: ReadonlyArray<Record<string, unknown>>,
): McpServerSource {
  const directOrigin =
    origins[`mcp_servers.${name}`] ??
    origins[`mcp_servers.${name}.command`] ??
    origins[`mcp_servers.${name}.url`];
  let source = sourceFromOrigin(directOrigin);

  for (const layerServer of layerServers) {
    if (Object.hasOwn(layerServer, name)) {
      source = mergeSources(source, "unknown");
    }
  }

  return source;
}

function collectLayerServers(
  layers: CodexSchema.V2ConfigReadResponse["layers"] | undefined | null,
): Array<Record<string, unknown>> {
  if (!layers) return [];
  const layerServers: Array<Record<string, unknown>> = [];
  for (const layer of layers) {
    const config = asRecord(layer.config);
    const servers = asRecord(config?.mcp_servers);
    if (servers) {
      layerServers.push(servers);
    }
  }
  return layerServers;
}

function decodeServerConfig(raw: unknown): McpServerConfig {
  const record = asRecord(raw);
  if (!record) {
    return Schema.decodeSync(McpServerConfig)({
      transport: "unknown",
    });
  }

  const transport =
    typeof record.url === "string"
      ? "http"
      : typeof record.command === "string"
        ? "stdio"
        : "unknown";
  const input: Record<string, unknown> = {
    transport,
    args: asStringArray(record.args),
    cwd: asOptionalString(record.cwd) ?? null,
    bearerTokenEnvVar: asOptionalString(record.bearer_token_env_var) ?? null,
    env: asStringRecord(record.env),
    envVars: asStringArray(record.env_vars),
    httpHeaders: asStringRecord(record.http_headers),
    envHttpHeaders: asStringRecord(record.env_http_headers),
    enabled: asOptionalBoolean(record.enabled) ?? true,
    enabledTools: asStringArray(record.enabled_tools),
    disabledTools: asStringArray(record.disabled_tools),
    oauthScopes: asStringArray(record.oauth_scopes),
  };
  const command = asOptionalString(record.command);
  const url = asOptionalString(record.url);
  const required = asOptionalBoolean(record.required);
  const startupTimeoutSec = asOptionalNumber(record.startup_timeout_sec);
  const toolTimeoutSec = asOptionalNumber(record.tool_timeout_sec);
  if (command !== undefined) input.command = command;
  if (url !== undefined) input.url = url;
  if (required !== undefined) input.required = required;
  if (startupTimeoutSec !== undefined) input.startupTimeoutSec = startupTimeoutSec;
  if (toolTimeoutSec !== undefined) input.toolTimeoutSec = toolTimeoutSec;
  return Schema.decodeUnknownSync(McpServerConfig)(input);
}

function normalizeServerConfig(raw: unknown): McpServerConfig {
  const decoded = decodeServerConfig(raw);
  return Schema.decodeSync(McpServerConfig)({
    ...decoded,
    env: {},
    httpHeaders: {},
    secretFields: providerMcpSecretPresence([
      { prefix: "env", values: decoded.env },
      { prefix: "header", values: decoded.httpHeaders },
    ]),
  });
}

function mergeServerSecrets(raw: unknown, input: McpServerUpsertInput): McpServerConfig {
  const existing = decodeServerConfig(raw);
  return Schema.decodeSync(McpServerConfig)({
    ...input.config,
    env: applyProviderMcpSecretMutations(
      existing.env,
      input.config.env,
      "env",
      input.secretMutations,
    ),
    httpHeaders: applyProviderMcpSecretMutations(
      existing.httpHeaders,
      input.config.httpHeaders,
      "header",
      input.secretMutations,
    ),
  });
}

function encodeServerConfig(config: McpServerConfig): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    enabled: config.enabled,
  };

  if (config.transport === "stdio") {
    encoded.command = config.command ?? "";
    if (config.args.length > 0) encoded.args = [...config.args];
    if (config.cwd && config.cwd.trim().length > 0) encoded.cwd = config.cwd;
  }

  if (config.transport === "http") {
    encoded.url = config.url ?? "";
    if (config.bearerTokenEnvVar && config.bearerTokenEnvVar.trim().length > 0) {
      encoded.bearer_token_env_var = config.bearerTokenEnvVar;
    }
    if (Object.keys(config.httpHeaders).length > 0) encoded.http_headers = config.httpHeaders;
    if (Object.keys(config.envHttpHeaders).length > 0) {
      encoded.env_http_headers = config.envHttpHeaders;
    }
  }

  if (Object.keys(config.env).length > 0) encoded.env = config.env;
  if (config.envVars.length > 0) encoded.env_vars = [...config.envVars];
  if (config.required !== undefined) encoded.required = config.required;
  if (config.startupTimeoutSec !== undefined)
    encoded.startup_timeout_sec = config.startupTimeoutSec;
  if (config.toolTimeoutSec !== undefined) encoded.tool_timeout_sec = config.toolTimeoutSec;
  if (config.enabledTools.length > 0) encoded.enabled_tools = [...config.enabledTools];
  if (config.disabledTools.length > 0) encoded.disabled_tools = [...config.disabledTools];
  if (config.oauthScopes.length > 0) encoded.oauth_scopes = [...config.oauthScopes];

  return encoded;
}

function normalizeAuthStatus(value: string | undefined): McpAuthStatus {
  switch (value) {
    case "unsupported":
    case "notLoggedIn":
    case "bearerToken":
    case "oAuth":
      return value;
    default:
      return "unknown";
  }
}

function normalizeTool(tool: CodexSchema.V2ListMcpServerStatusResponse__Tool): McpInventoryTool {
  return Schema.decodeSync(McpInventoryTool)({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  });
}

function normalizeResource(
  resource: CodexSchema.V2ListMcpServerStatusResponse__Resource,
): McpInventoryResource {
  return Schema.decodeSync(McpInventoryResource)({
    name: resource.name,
    title: resource.title ?? null,
    description: resource.description ?? null,
    uri: resource.uri,
    mimeType: resource.mimeType ?? null,
    size: resource.size ?? null,
  });
}

function normalizeResourceTemplate(
  template: CodexSchema.V2ListMcpServerStatusResponse__ResourceTemplate,
): McpInventoryResourceTemplate {
  return Schema.decodeSync(McpInventoryResourceTemplate)({
    name: template.name,
    title: template.title ?? null,
    description: template.description ?? null,
    uriTemplate: template.uriTemplate,
    mimeType: template.mimeType ?? null,
  });
}

function toStartupStatus(
  config: McpServerConfig,
  status: CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus | undefined,
): McpStartupStatus {
  if (!config.enabled) return "disabled";
  return status ? "ready" : "unknown";
}

function extractConfigPath(
  layers: CodexSchema.V2ConfigReadResponse["layers"] | undefined | null,
): string | undefined {
  const userLayer = layers?.find((layer) => {
    const name = asRecord(layer.name);
    return name?.type === "user" && typeof name.file === "string";
  });
  const file = asRecord(userLayer?.name)?.file;
  return typeof file === "string" ? file : undefined;
}

function buildServers(input: {
  readonly configResponse: CodexSchema.V2ConfigReadResponse;
  readonly statuses: ReadonlyArray<CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus>;
}): McpServer[] {
  const configRecord = input.configResponse.config as Record<string, unknown>;
  const configuredServers = asRecord(configRecord.mcp_servers) ?? {};
  const statusByName = new Map(input.statuses.map((status) => [status.name, status]));
  const names = [...new Set([...Object.keys(configuredServers), ...statusByName.keys()])].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const layerServers = collectLayerServers(input.configResponse.layers);

  return names
    .filter((name) => Schema.is(McpServerName)(name))
    .map((name) => {
      const rawConfig = configuredServers[name];
      const status = statusByName.get(name);
      const config = normalizeServerConfig(rawConfig);
      return Schema.decodeSync(McpServer)({
        name,
        config,
        source: sourceForServer(name, input.configResponse.origins, layerServers),
        startupStatus: toStartupStatus(config, status),
        authStatus: normalizeAuthStatus(status?.authStatus),
        tools: Object.values(status?.tools ?? {}).map(normalizeTool),
        resources: (status?.resources ?? []).map(normalizeResource),
        resourceTemplates: (status?.resourceTemplates ?? []).map(normalizeResourceTemplate),
      });
    });
}

function runtimeEnvFor(workspace: WorkspaceRuntime): Record<string, string> {
  return asSpawnEnv({
    ...workspace.processEnv,
    ...(workspace.layout.effectiveHomePath
      ? { CODEX_HOME: workspace.layout.effectiveHomePath }
      : {}),
  });
}

function chooseWorkspaceRuntime(
  discovery: WorkspaceDiscovery,
  workspaceId: McpWorkspaceId,
): Effect.Effect<WorkspaceRuntime, McpSettingsError> {
  const runtime = discovery.runtimes.find((entry) => entry.workspace.id === workspaceId);
  if (!runtime) {
    return Effect.fail(toMcpError("MCP workspace not found."));
  }
  return Effect.succeed(runtime);
}

export interface CodexMcpServiceShape {
  readonly listWorkspaces: Effect.Effect<McpListWorkspacesResult, McpSettingsError, never>;
  readonly listServers: (
    input: McpListServersInput,
  ) => Effect.Effect<McpListServersResult, McpSettingsError, never>;
  readonly upsertServer: (
    input: McpServerUpsertInput,
  ) => Effect.Effect<McpListServersResult, McpSettingsError, never>;
  readonly setServerEnabled: (
    input: McpServerEnabledInput,
  ) => Effect.Effect<McpListServersResult, McpSettingsError, never>;
  readonly removeServer: (
    input: McpServerRemoveInput,
  ) => Effect.Effect<McpListServersResult, McpSettingsError, never>;
  readonly reloadServers: (
    input: McpServersReloadInput,
  ) => Effect.Effect<McpListServersResult, McpSettingsError, never>;
  readonly startOauthLogin: (
    input: McpOauthLoginInput,
  ) => Effect.Effect<McpOauthLoginResult, McpSettingsError, never>;
}

export const makeCodexMcpService = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fileSystemService = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const discoverWorkspaces = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const entries = Object.entries(deriveProviderInstanceConfigMap(settings));
    const providerSupport = new Map<string, McpProviderSupport>();
    for (const [rawInstanceId, instance] of entries) {
      const instanceId = rawInstanceId as ProviderInstanceId;
      providerSupport.set(
        instanceId,
        buildProviderSupport({
          instanceId,
          driver: instance.driver,
          displayName: instance.displayName,
          accentColor: instance.accentColor,
          enabled: instance.enabled ?? true,
        }),
      );
    }
    const codexEntries = entries.filter(
      ([, instance]) => instance.driver === CODEX_DRIVER && (instance.enabled ?? true),
    );
    const groups = new Map<string, WorkspaceRuntime>();
    const issues: Array<McpListWorkspacesResult["issues"][number]> = [];

    for (const [rawInstanceId, instance] of codexEntries) {
      const instanceId = rawInstanceId as ProviderInstanceId;
      const decoded = Schema.decodeUnknownExit(CodexSettings)(instance.config ?? {});
      if (Exit.isFailure(decoded)) {
        issues.push({
          instanceId,
          message: "Codex settings for this provider instance could not be decoded.",
        });
        continue;
      }

      const codexSettings = decoded.value;
      if (!codexSettings.enabled) {
        continue;
      }
      const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
        Effect.provideService(Path.Path, pathService),
      );
      const materialized = yield* materializeCodexShadowHome(layout).pipe(
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(FileSystem.FileSystem, fileSystemService),
        Effect.exit,
      );
      if (Exit.isFailure(materialized)) {
        issues.push({ instanceId, message: Cause.pretty(materialized.cause) });
        continue;
      }

      const workspaceId = workspaceIdFor(layout.sharedHomePath);
      providerSupport.set(
        instanceId,
        buildProviderSupport({
          instanceId,
          driver: instance.driver,
          displayName: instance.displayName,
          accentColor: instance.accentColor,
          enabled: instance.enabled ?? true,
          workspaceId,
        }),
      );
      const usage = {
        instanceId,
        ...(instance.displayName ? { displayName: instance.displayName } : {}),
        ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
      };
      const existing = groups.get(workspaceId);
      if (existing) {
        groups.set(workspaceId, {
          ...existing,
          workspace: {
            ...existing.workspace,
            providerInstances: [...existing.workspace.providerInstances, usage],
          },
        });
        continue;
      }

      groups.set(workspaceId, {
        workspace: {
          id: workspaceId,
          driver: CODEX_DRIVER,
          providerDisplayName: "Codex",
          displayPath: layout.sharedHomePath,
          nativeScope: "user",
          formatGeneration: "codex-app-server-v2",
          capabilities: mcpSupportForDriver(CODEX_DRIVER).capabilities,
          providerMetadata: {
            sharedHomePath: layout.sharedHomePath,
            ...(layout.effectiveHomePath ? { effectiveHomePath: layout.effectiveHomePath } : {}),
            mode: layout.mode,
          },
          sharedHomePath: layout.sharedHomePath,
          ...(layout.effectiveHomePath ? { effectiveHomePath: layout.effectiveHomePath } : {}),
          mode: layout.mode,
          selectedInstanceId: instanceId,
          providerInstances: [usage],
        },
        layout,
        codexSettings,
        processEnv: mergeProviderInstanceEnvironment(instance.environment),
      });
    }

    const runtimes = [...groups.values()].toSorted((left, right) =>
      left.workspace.displayPath.localeCompare(right.workspace.displayPath),
    );
    const providers = [...providerSupport.values()].toSorted(sortProviderSupport);
    return { runtimes, providers, issues };
  }).pipe(
    Effect.mapError((cause) => normalizeUnknownError(cause, "Failed to discover MCP workspaces.")),
  );

  const withClient = <A>(
    workspace: WorkspaceRuntime,
    use: (
      client: CodexClient.CodexAppServerClientShape,
    ) => Effect.Effect<A, CodexMcpClientError, never>,
  ): Effect.Effect<A, McpSettingsError, never> =>
    Effect.scoped(
      Effect.gen(function* () {
        const clientContext = yield* Layer.build(
          CodexClient.layerCommand({
            command: workspace.codexSettings.binaryPath,
            args: ["app-server"],
            cwd: serverConfig.cwd,
            env: runtimeEnvFor(workspace),
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );
        yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);
        return yield* use(client);
      }),
    ).pipe(
      Effect.timeout(MCP_APP_SERVER_TIMEOUT),
      Effect.mapError((cause) => normalizeUnknownError(cause, "Codex app-server MCP call failed.")),
    );

  const findWorkspace = (workspaceId: McpWorkspaceId) =>
    discoverWorkspaces.pipe(
      Effect.flatMap((discovery) => chooseWorkspaceRuntime(discovery, workspaceId)),
    );

  const readStatuses = (
    client: CodexClient.CodexAppServerClientShape,
    detail: McpListServersInput["detail"],
  ): Effect.Effect<
    Array<CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus>,
    CodexMcpClientError,
    never
  > =>
    Effect.gen(function* () {
      const statuses: Array<CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus> = [];
      let cursor: string | null | undefined = undefined;
      let pages = 0;
      do {
        const response: CodexSchema.V2ListMcpServerStatusResponse = yield* client.request(
          "mcpServerStatus/list",
          {
            ...(cursor ? { cursor } : {}),
            detail: detail ?? "full",
            limit: MCP_STATUS_PAGE_LIMIT,
          },
        );
        statuses.push(...response.data);
        cursor = response.nextCursor;
        pages += 1;
      } while (cursor && pages < MCP_STATUS_MAX_PAGES);
      return statuses;
    });

  const listServersForWorkspace = (input: McpListServersInput) =>
    Effect.gen(function* () {
      const workspace = yield* findWorkspace(input.workspaceId);
      return yield* withClient(
        workspace,
        Effect.fn(function* (client) {
          const [configResponse, statuses] = yield* Effect.all(
            [
              client.request("config/read", { cwd: serverConfig.cwd, includeLayers: true }),
              readStatuses(client, input.detail),
            ],
            { concurrency: "unbounded" },
          );
          const configPath = extractConfigPath(configResponse.layers);
          return Schema.decodeUnknownSync(McpListServersResult)({
            workspace: workspace.workspace,
            servers: buildServers({ configResponse, statuses }),
            ...(configPath ? { configPath } : {}),
            warnings: [],
          });
        }),
      );
    }).pipe(
      Effect.mapError((cause) => normalizeUnknownError(cause, "Failed to list MCP servers.")),
    );

  const reloadServers = (input: McpServersReloadInput) =>
    Effect.gen(function* () {
      const workspace = yield* findWorkspace(input.workspaceId);
      yield* withClient(workspace, (client) =>
        client.request("config/mcpServer/reload", undefined),
      );
      return yield* listServersForWorkspace({ workspaceId: input.workspaceId, detail: "full" });
    });

  const mutateWithAppServer = (
    workspaceId: McpWorkspaceId,
    mutate: (
      client: CodexClient.CodexAppServerClientShape,
    ) => Effect.Effect<unknown, CodexMcpClientError, never>,
  ) =>
    Effect.gen(function* () {
      const workspace = yield* findWorkspace(workspaceId);
      yield* withClient(
        workspace,
        Effect.fn(function* (client) {
          yield* mutate(client);
          yield* client.request("config/mcpServer/reload", undefined);
        }),
      );
      return yield* listServersForWorkspace({ workspaceId, detail: "full" });
    }).pipe(
      Effect.mapError((cause) => normalizeUnknownError(cause, "Failed to update MCP servers.")),
    );

  const removeWithCli = (input: McpServerRemoveInput) =>
    Effect.gen(function* () {
      const workspace = yield* findWorkspace(input.workspaceId);
      yield* Effect.promise(() =>
        runProcess(workspace.codexSettings.binaryPath, ["mcp", "remove", input.name], {
          cwd: serverConfig.cwd,
          env: runtimeEnvFor(workspace),
          timeoutMs: MCP_REMOVE_TIMEOUT_MS,
          maxBufferBytes: 256 * 1024,
          outputMode: "truncate",
        }),
      );
      return yield* reloadServers({ workspaceId: input.workspaceId });
    }).pipe(
      Effect.mapError((cause) => normalizeUnknownError(cause, "Failed to remove MCP server.")),
    );

  return {
    listWorkspaces: discoverWorkspaces.pipe(
      Effect.map(({ runtimes, providers, issues }) => ({
        workspaces: runtimes.map((runtime) => runtime.workspace),
        providers,
        issues,
      })),
    ),
    listServers: listServersForWorkspace,
    upsertServer: (input) =>
      mutateWithAppServer(
        input.workspaceId,
        Effect.fn(function* (client) {
          const current = yield* client.request("config/read", {
            cwd: serverConfig.cwd,
            includeLayers: false,
          });
          const configRecord = current.config as Record<string, unknown>;
          const configuredServers = asRecord(configRecord.mcp_servers) ?? {};
          const config = mergeServerSecrets(configuredServers[input.name], input);
          return yield* client.request("config/batchWrite", {
            edits: [
              {
                keyPath: `mcp_servers.${input.name}`,
                mergeStrategy: "replace",
                value: encodeServerConfig(config),
              },
            ],
            reloadUserConfig: true,
          });
        }),
      ),
    setServerEnabled: (input) =>
      mutateWithAppServer(input.workspaceId, (client) =>
        client.request("config/value/write", {
          keyPath: `mcp_servers.${input.name}.enabled`,
          mergeStrategy: "replace",
          value: input.enabled,
        }),
      ),
    removeServer: removeWithCli,
    reloadServers,
    startOauthLogin: (input) =>
      Effect.gen(function* () {
        const workspace = yield* findWorkspace(input.workspaceId);
        return yield* withClient(
          workspace,
          Effect.fn(function* (client) {
            const result = yield* client.request("mcpServer/oauth/login", {
              name: input.serverName,
              ...(input.scopes.length > 0 ? { scopes: input.scopes } : {}),
              ...(input.timeoutSecs === undefined ? {} : { timeoutSecs: input.timeoutSecs }),
            });
            return Schema.decodeSync(McpOauthLoginResult)(result);
          }),
        );
      }).pipe(
        Effect.mapError((cause) =>
          normalizeUnknownError(cause, "Failed to start MCP OAuth login."),
        ),
      ),
  } satisfies CodexMcpServiceShape;
});
