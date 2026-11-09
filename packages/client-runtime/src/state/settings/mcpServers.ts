import type {
  McpProviderCapabilities,
  McpProviderSupport,
  McpSecretMutationMap,
  McpServer,
  McpServerConfig,
  McpTransport,
  McpWorkspace,
} from "@ryco/contracts";

/**
 * Provider-native MCP server settings shared by the web's MCP page and the phone's Agents
 * screen: the editor form (secrets are write-only: the node returns only their presence) and
 * the words both show for a server, a provider and their states.
 */

/** How a status reads: matches the web's badge variants; the phone maps it to its own colors. */
export type SettingsStatusTone = "success" | "warning" | "error" | "outline";

export interface SettingsStatus {
  readonly label: string;
  readonly tone: SettingsStatusTone;
}

export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export interface McpServerFormState {
  readonly name: string;
  readonly transport: Exclude<McpTransport, "unknown">;
  readonly command: string;
  readonly argsText: string;
  readonly cwd: string;
  readonly url: string;
  readonly bearerTokenEnvVar: string;
  readonly envText: string;
  readonly envVarsText: string;
  readonly httpHeadersText: string;
  readonly envHttpHeadersText: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly startupTimeoutSec: string;
  readonly toolTimeoutSec: string;
  readonly enabledToolsText: string;
  readonly disabledToolsText: string;
  readonly oauthScopesText: string;
  readonly secretFields: ReadonlyArray<string>;
  readonly clearedSecretFields: ReadonlyArray<string>;
}

export function createEmptyMcpServerForm(): McpServerFormState {
  return {
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    cwd: "",
    url: "",
    bearerTokenEnvVar: "",
    envText: "",
    envVarsText: "",
    httpHeadersText: "",
    envHttpHeadersText: "",
    enabled: true,
    required: false,
    startupTimeoutSec: "",
    toolTimeoutSec: "",
    enabledToolsText: "",
    disabledToolsText: "",
    oauthScopesText: "",
    secretFields: [],
    clearedSecretFields: [],
  };
}

function joinList(values: readonly string[]): string {
  return values.join("\n");
}

function joinRecord(record: Readonly<Record<string, string>>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * The secret fields the node holds a value for. Nodes redact `env` and `httpHeaders` to `{}`
 * and report presence instead; a value that still arrives counts as stored, never as text.
 */
function storedSecretFields(config: McpServerConfig): string[] {
  const fields = new Set(
    Object.entries(config.secretFields ?? {})
      .filter(([, presence]) => presence === "present")
      .map(([field]) => field),
  );
  for (const key of Object.keys(config.env)) fields.add(`env.${key}`);
  for (const key of Object.keys(config.httpHeaders)) fields.add(`header.${key}`);
  return [...fields].toSorted();
}

export function formFromMcpServer(server: McpServer): McpServerFormState {
  const config = server.config;
  return {
    name: server.name,
    transport: config.transport === "http" ? "http" : "stdio",
    command: config.command ?? "",
    argsText: joinList(config.args),
    cwd: config.cwd ?? "",
    url: config.url ?? "",
    bearerTokenEnvVar: config.bearerTokenEnvVar ?? "",
    // Write-only: a stored value is never loaded into the form, only that its key holds one.
    envText: "",
    envVarsText: joinList(config.envVars),
    httpHeadersText: "",
    envHttpHeadersText: joinRecord(config.envHttpHeaders),
    enabled: config.enabled,
    required: config.required ?? false,
    startupTimeoutSec: config.startupTimeoutSec?.toString() ?? "",
    toolTimeoutSec: config.toolTimeoutSec?.toString() ?? "",
    enabledToolsText: joinList(config.enabledTools),
    disabledToolsText: joinList(config.disabledTools),
    oauthScopesText: joinList(config.oauthScopes),
    secretFields: storedSecretFields(config),
    clearedSecretFields: [],
  };
}

function parseList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseRecord(value: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of parseList(value)) {
    const splitAt = line.indexOf("=");
    if (splitAt <= 0) continue;
    const key = line.slice(0, splitAt).trim();
    const entryValue = line.slice(splitAt + 1).trim();
    if (key.length > 0) {
      record[key] = entryValue;
    }
  }
  return record;
}

function parseOptionalPositiveNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export function validateMcpServerForm(form: McpServerFormState): string | null {
  const name = form.name.trim();
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return "Server name must start with a letter and use only letters, numbers, dashes, and underscores.";
  }
  if (form.transport === "stdio" && form.command.trim().length === 0) {
    return "Stdio servers need a command.";
  }
  if (form.transport === "http" && form.url.trim().length === 0) {
    return "HTTP servers need a URL.";
  }
  for (const [label, value] of [
    ["Startup timeout", form.startupTimeoutSec],
    ["Tool timeout", form.toolTimeoutSec],
  ] as const) {
    const parsed = parseOptionalPositiveNumber(value);
    if (Number.isNaN(parsed)) {
      return `${label} must be a positive number.`;
    }
  }
  return null;
}

export function configFromMcpServerForm(form: McpServerFormState): McpServerConfig {
  const startupTimeoutSec = parseOptionalPositiveNumber(form.startupTimeoutSec);
  const toolTimeoutSec = parseOptionalPositiveNumber(form.toolTimeoutSec);

  return {
    transport: form.transport,
    command: form.command.trim(),
    args: parseList(form.argsText),
    cwd: form.cwd.trim() || null,
    url: form.url.trim(),
    bearerTokenEnvVar: form.bearerTokenEnvVar.trim() || null,
    env: parseRecord(form.envText),
    envVars: parseList(form.envVarsText),
    httpHeaders: parseRecord(form.httpHeadersText),
    envHttpHeaders: parseRecord(form.envHttpHeadersText),
    enabled: form.enabled,
    required: form.required,
    ...(startupTimeoutSec === undefined || Number.isNaN(startupTimeoutSec)
      ? {}
      : { startupTimeoutSec }),
    ...(toolTimeoutSec === undefined || Number.isNaN(toolTimeoutSec) ? {} : { toolTimeoutSec }),
    enabledTools: parseList(form.enabledToolsText),
    disabledTools: parseList(form.disabledToolsText),
    oauthScopes: parseList(form.oauthScopesText),
  };
}

export function secretMutationsFromMcpServerForm(form: McpServerFormState): McpSecretMutationMap {
  return Object.fromEntries(
    form.secretFields.map((field) => [
      field,
      form.clearedSecretFields.includes(field)
        ? ({ action: "clear" } as const)
        : ({ action: "retain" } as const),
    ]),
  );
}

export function summarizeMcpServerConnection(server: McpServer): string {
  const config = server.config;
  if (config.transport === "http") {
    return config.url || "HTTP";
  }
  if (config.transport === "stdio") {
    return [config.command, ...config.args].filter(Boolean).join(" ") || "stdio";
  }
  return "Configured outside the known MCP schema";
}

/** The two write-only record kinds the node redacts: environment values and static headers. */
export type McpSecretKind = "env" | "header";

const SECRET_TEXT_FIELD = {
  env: "envText",
  header: "httpHeadersText",
} as const satisfies Record<McpSecretKind, keyof McpServerFormState>;

/** Splits a stored secret field (`env.API_TOKEN`, `header.Authorization`) into kind and key. */
export function parseMcpSecretField(
  field: string,
): { readonly kind: McpSecretKind; readonly key: string } | null {
  const splitAt = field.indexOf(".");
  if (splitAt <= 0) return null;
  const prefix = field.slice(0, splitAt);
  const key = field.slice(splitAt + 1);
  if (key.length === 0) return null;
  if (prefix === "env" || prefix === "header") return { kind: prefix, key };
  return null;
}

/** The keys of the values typed into the form for one kind, which the save writes. */
export function mcpFormPendingSecretKeys(
  form: McpServerFormState,
  kind: McpSecretKind,
): ReadonlyArray<string> {
  return Object.keys(parseRecord(form[SECRET_TEXT_FIELD[kind]]));
}

/**
 * Sets (or with `value` null drops) one typed secret value. A key the node already holds is
 * replaced by the save, so replacing also takes it off the fields to clear.
 */
export function setMcpFormSecretValue(
  form: McpServerFormState,
  kind: McpSecretKind,
  key: string,
  value: string | null,
): McpServerFormState {
  const trimmedKey = key.trim();
  if (trimmedKey.length === 0 || /[=\r\n]/.test(trimmedKey)) return form;
  // One line per value: a line break would split it into another entry.
  if (value !== null && /[\r\n]/.test(value)) return form;
  const textField = SECRET_TEXT_FIELD[kind];
  const record = parseRecord(form[textField]);
  delete record[trimmedKey];
  if (value !== null) record[trimmedKey] = value;
  const field = `${kind}.${trimmedKey}`;
  return {
    ...form,
    [textField]: joinRecord(record),
    clearedSecretFields:
      value === null
        ? form.clearedSecretFields
        : form.clearedSecretFields.filter((entry) => entry !== field),
  };
}

/** Marks a stored secret field to be removed on save, or keeps it again. */
export function setMcpFormSecretCleared(
  form: McpServerFormState,
  field: string,
  cleared: boolean,
): McpServerFormState {
  const rest = form.clearedSecretFields.filter((entry) => entry !== field);
  return { ...form, clearedSecretFields: cleared ? [...rest, field] : rest };
}

export function mcpServerStatus(server: McpServer): SettingsStatus {
  if (server.startupStatus === "disabled") return { label: "Disabled", tone: "outline" };
  if (server.startupStatus === "failed") return { label: "Failed", tone: "error" };
  if (server.authStatus === "notLoggedIn") return { label: "Login needed", tone: "warning" };
  if (server.startupStatus === "ready") return { label: "Ready", tone: "success" };
  return { label: "Unknown", tone: "outline" };
}

export function mcpServerSourceLabel(source: McpServer["source"]): string {
  switch (source) {
    case "user":
      return "User config";
    case "project":
      return "Project";
    case "system":
      return "System";
    case "managed":
      return "Managed";
    case "mixed":
      return "Mixed";
    case "unknown":
      return "Unknown";
  }
}

const AUTH_STATUS_LABELS: Record<McpServer["authStatus"], string | null> = {
  unsupported: null,
  notLoggedIn: "Signed out",
  bearerToken: "Bearer token",
  oAuth: "OAuth",
  unknown: null,
};

/** How the server authenticates, or null when there is nothing to say. */
export function mcpServerAuthLabel(server: McpServer): string | null {
  return AUTH_STATUS_LABELS[server.authStatus];
}

/** Tool and resource counts, or that the agent does not report them. */
export function mcpServerInventoryLabel(
  server: McpServer,
  capabilities: McpProviderCapabilities,
): string {
  if (capabilities.inventory !== "available") return "Inventory not available";
  return `${server.tools.length} tools · ${server.resources.length + server.resourceTemplates.length} resources`;
}

/**
 * Whether Ryco may change this server: one from the user's own configuration, or a project's
 * when the workspace is that project's scope. System, managed and mixed entries stay read-only.
 */
export function isMcpServerWritable(server: McpServer, workspace: McpWorkspace | null): boolean {
  return (
    server.source === "user" ||
    (server.source === "project" && workspace !== null && workspace.nativeScope === "project")
  );
}

/** What the agent's MCP surface cannot do, for a quiet line under the workspace. */
export function mcpWorkspaceLimits(workspace: McpWorkspace, providerName: string): string[] {
  return [
    workspace.capabilities.health !== "available"
      ? `${providerName} doesn't report live health`
      : null,
    workspace.capabilities.inventory !== "available" ? "tool inventory unavailable" : null,
    workspace.capabilities.enableDisable !== "available" ? "no per-server toggle" : null,
  ].filter((entry): entry is string => entry !== null);
}

export function mcpProviderSupportStatus(provider: McpProviderSupport): SettingsStatus {
  if (!provider.enabled) return { label: "Disabled", tone: "outline" };
  switch (provider.status) {
    case "managed":
      return { label: "Managed", tone: "success" };
    case "external":
      return { label: "External config", tone: "warning" };
    case "unsupported":
      return { label: "Not wired", tone: "outline" };
  }
}
