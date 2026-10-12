import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const MCP_SERVER_NAME_MAX_CHARS = 64;
const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const McpWorkspaceId = TrimmedNonEmptyString.pipe(Schema.brand("McpWorkspaceId"));
export type McpWorkspaceId = typeof McpWorkspaceId.Type;

export const McpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MCP_SERVER_NAME_MAX_CHARS),
  Schema.isPattern(MCP_SERVER_NAME_PATTERN),
).pipe(Schema.brand("McpServerName"));
export type McpServerName = typeof McpServerName.Type;

export const McpProviderInstanceUsage = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  accentColor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type McpProviderInstanceUsage = typeof McpProviderInstanceUsage.Type;

export const McpCapabilityAvailability = Schema.Literals(["available", "unavailable", "unknown"]);
export type McpCapabilityAvailability = typeof McpCapabilityAvailability.Type;

export const McpNativeScope = Schema.Literals([
  "user",
  "project",
  "directory",
  "runtime",
  "system",
  "unknown",
]);
export type McpNativeScope = typeof McpNativeScope.Type;

const unavailableCapability = () => Effect.succeed("unavailable" as const);

export const McpProviderCapabilities = Schema.Struct({
  readConfiguration: McpCapabilityAvailability.pipe(
    Schema.withDecodingDefault(unavailableCapability()),
  ),
  upsert: McpCapabilityAvailability.pipe(Schema.withDecodingDefault(unavailableCapability())),
  remove: McpCapabilityAvailability.pipe(Schema.withDecodingDefault(unavailableCapability())),
  enableDisable: McpCapabilityAvailability.pipe(
    Schema.withDecodingDefault(unavailableCapability()),
  ),
  reload: McpCapabilityAvailability.pipe(Schema.withDecodingDefault(unavailableCapability())),
  health: McpCapabilityAvailability.pipe(Schema.withDecodingDefault(unavailableCapability())),
  inventory: McpCapabilityAvailability.pipe(Schema.withDecodingDefault(unavailableCapability())),
  oauth: McpCapabilityAvailability.pipe(Schema.withDecodingDefault(unavailableCapability())),
  externalAgentControl: McpCapabilityAvailability.pipe(
    Schema.withDecodingDefault(unavailableCapability()),
  ),
  automaticAgentControl: McpCapabilityAvailability.pipe(
    Schema.withDecodingDefault(unavailableCapability()),
  ),
  scopes: Schema.Array(McpNativeScope).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type McpProviderCapabilities = typeof McpProviderCapabilities.Type;

export const McpWorkspaceProviderMetadataValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);
export type McpWorkspaceProviderMetadataValue = typeof McpWorkspaceProviderMetadataValue.Type;

export const McpWorkspaceProviderMetadata = Schema.Record(
  Schema.String,
  McpWorkspaceProviderMetadataValue,
);
export type McpWorkspaceProviderMetadata = typeof McpWorkspaceProviderMetadata.Type;

export const McpWorkspace = Schema.Struct({
  id: McpWorkspaceId,
  driver: ProviderDriverKind,
  providerDisplayName: Schema.optionalKey(TrimmedNonEmptyString),
  displayPath: TrimmedNonEmptyString,
  nativeScope: McpNativeScope,
  formatGeneration: TrimmedNonEmptyString,
  capabilities: McpProviderCapabilities,
  providerMetadata: McpWorkspaceProviderMetadata.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** @deprecated Codex compatibility metadata. Use providerMetadata. */
  sharedHomePath: TrimmedNonEmptyString,
  /** @deprecated Codex compatibility metadata. Use providerMetadata. */
  effectiveHomePath: Schema.optionalKey(TrimmedNonEmptyString),
  /** @deprecated Codex compatibility metadata. Use providerMetadata. */
  mode: Schema.Literals(["direct", "authOverlay"]),
  selectedInstanceId: ProviderInstanceId,
  providerInstances: Schema.Array(McpProviderInstanceUsage),
});
export type McpWorkspace = typeof McpWorkspace.Type;

export const McpWorkspaceIssue = Schema.Struct({
  instanceId: ProviderInstanceId,
  message: TrimmedNonEmptyString,
});
export type McpWorkspaceIssue = typeof McpWorkspaceIssue.Type;

export const McpProviderSupportStatus = Schema.Literals(["managed", "external", "unsupported"]);
export type McpProviderSupportStatus = typeof McpProviderSupportStatus.Type;

export const McpProviderSupport = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  accentColor: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  status: McpProviderSupportStatus,
  capabilities: McpProviderCapabilities,
  workspaceId: Schema.optionalKey(McpWorkspaceId),
  message: TrimmedNonEmptyString,
});
export type McpProviderSupport = typeof McpProviderSupport.Type;

export const McpListWorkspacesResult = Schema.Struct({
  workspaces: Schema.Array(McpWorkspace),
  providers: Schema.Array(McpProviderSupport).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  issues: Schema.Array(McpWorkspaceIssue).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type McpListWorkspacesResult = typeof McpListWorkspacesResult.Type;

export const McpTransport = Schema.Literals(["stdio", "http", "unknown"]);
export type McpTransport = typeof McpTransport.Type;

export const McpServerSource = Schema.Literals([
  "user",
  "project",
  "system",
  "managed",
  "mixed",
  "unknown",
]);
export type McpServerSource = typeof McpServerSource.Type;

export const McpStartupStatus = Schema.Literals([
  "ready",
  "starting",
  "failed",
  "disabled",
  "unknown",
]);
export type McpStartupStatus = typeof McpStartupStatus.Type;

export const McpAuthStatus = Schema.Literals([
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
  "unknown",
]);
export type McpAuthStatus = typeof McpAuthStatus.Type;

export const McpSecretPresence = Schema.Literals(["absent", "present"]);
export type McpSecretPresence = typeof McpSecretPresence.Type;

export const McpSecretMutation = Schema.Union([
  Schema.Struct({ action: Schema.Literal("retain") }),
  Schema.Struct({ action: Schema.Literal("clear") }),
  Schema.Struct({ action: Schema.Literal("replace"), value: Schema.String }),
]);
export type McpSecretMutation = typeof McpSecretMutation.Type;

export const McpSecretPresenceMap = Schema.Record(Schema.String, McpSecretPresence);
export type McpSecretPresenceMap = typeof McpSecretPresenceMap.Type;

export const McpSecretMutationMap = Schema.Record(Schema.String, McpSecretMutation);
export type McpSecretMutationMap = typeof McpSecretMutationMap.Type;

export const McpInventoryTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  inputSchema: Schema.Unknown,
  outputSchema: Schema.optionalKey(Schema.Unknown),
});
export type McpInventoryTool = typeof McpInventoryTool.Type;

export const McpInventoryResource = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  uri: TrimmedNonEmptyString,
  mimeType: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  size: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type McpInventoryResource = typeof McpInventoryResource.Type;

export const McpInventoryResourceTemplate = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  uriTemplate: TrimmedNonEmptyString,
  mimeType: Schema.optionalKey(Schema.NullOr(TrimmedString)),
});
export type McpInventoryResourceTemplate = typeof McpInventoryResourceTemplate.Type;

const McpServerWritableConfigFields = {
  transport: McpTransport,
  command: Schema.optionalKey(TrimmedString),
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  cwd: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  url: Schema.optionalKey(TrimmedString),
  bearerTokenEnvVar: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  envVars: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  httpHeaders: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  envHttpHeaders: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  required: Schema.optionalKey(Schema.Boolean),
  startupTimeoutSec: Schema.optionalKey(Schema.Number),
  toolTimeoutSec: Schema.optionalKey(Schema.Number),
  enabledTools: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  disabledTools: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  oauthScopes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
} as const;

export const McpServerWritableConfig = Schema.Struct(McpServerWritableConfigFields);
export type McpServerWritableConfig = typeof McpServerWritableConfig.Type;

export const McpServerConfig = Schema.Struct({
  ...McpServerWritableConfigFields,
  secretFields: Schema.optionalKey(McpSecretPresenceMap),
  rawConfig: Schema.optionalKey(Schema.Unknown),
});
export type McpServerConfig = typeof McpServerConfig.Type;

export const McpServer = Schema.Struct({
  name: McpServerName,
  config: McpServerConfig,
  source: McpServerSource,
  startupStatus: McpStartupStatus,
  authStatus: McpAuthStatus,
  error: Schema.optionalKey(Schema.NullOr(TrimmedString)),
  tools: Schema.Array(McpInventoryTool).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  resources: Schema.Array(McpInventoryResource).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  resourceTemplates: Schema.Array(McpInventoryResourceTemplate).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type McpServer = typeof McpServer.Type;

export const McpStatusDetail = Schema.Literals(["full", "toolsAndAuthOnly"]);
export type McpStatusDetail = typeof McpStatusDetail.Type;

export const McpListServersInput = Schema.Struct({
  workspaceId: McpWorkspaceId,
  detail: Schema.optionalKey(McpStatusDetail),
});
export type McpListServersInput = typeof McpListServersInput.Type;

export const McpListServersResult = Schema.Struct({
  workspace: McpWorkspace,
  servers: Schema.Array(McpServer),
  configPath: Schema.optionalKey(TrimmedNonEmptyString),
  warnings: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type McpListServersResult = typeof McpListServersResult.Type;

export const McpServerUpsertInput = Schema.Struct({
  workspaceId: McpWorkspaceId,
  name: McpServerName,
  config: McpServerWritableConfig,
  secretMutations: Schema.optionalKey(McpSecretMutationMap),
});
export type McpServerUpsertInput = typeof McpServerUpsertInput.Type;

export const McpServerEnabledInput = Schema.Struct({
  workspaceId: McpWorkspaceId,
  name: McpServerName,
  enabled: Schema.Boolean,
});
export type McpServerEnabledInput = typeof McpServerEnabledInput.Type;

export const McpServerRemoveInput = Schema.Struct({
  workspaceId: McpWorkspaceId,
  name: McpServerName,
});
export type McpServerRemoveInput = typeof McpServerRemoveInput.Type;

export const McpServersReloadInput = Schema.Struct({
  workspaceId: McpWorkspaceId,
});
export type McpServersReloadInput = typeof McpServersReloadInput.Type;

export const McpOauthLoginInput = Schema.Struct({
  workspaceId: McpWorkspaceId,
  serverName: McpServerName,
  scopes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  timeoutSecs: Schema.optionalKey(Schema.Number),
});
export type McpOauthLoginInput = typeof McpOauthLoginInput.Type;

export const McpOauthLoginResult = Schema.Struct({
  authorizationUrl: TrimmedNonEmptyString,
});
export type McpOauthLoginResult = typeof McpOauthLoginResult.Type;

export class McpSettingsError extends Schema.TaggedError<McpSettingsError>()("McpSettingsError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
