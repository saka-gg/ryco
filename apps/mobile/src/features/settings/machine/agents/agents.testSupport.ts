import type {
  AgentControlMcpInstallation,
  McpListServersResult,
  McpProviderCapabilities,
  McpProviderSupport,
  McpServer,
  McpWorkspace,
  OpinionatedPluginCatalogItem,
  OpinionatedPluginStatus,
} from "@ryco/contracts";

/** Fixtures for the Agents screen's model and controller tests. */

export const ALL_CAPABILITIES: McpProviderCapabilities = {
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
};

export function workspaceFixture(overrides: Partial<McpWorkspace> = {}): McpWorkspace {
  return {
    id: "codex:home",
    driver: "codex",
    displayPath: "~/.codex/config.toml",
    nativeScope: "user",
    formatGeneration: "1",
    capabilities: ALL_CAPABILITIES,
    providerMetadata: {},
    sharedHomePath: "~/.codex",
    mode: "direct",
    selectedInstanceId: "codex",
    providerInstances: [{ instanceId: "codex" }],
    ...overrides,
  } as McpWorkspace;
}

export function serverFixture(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: "github",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "github-mcp"],
      cwd: null,
      env: {},
      envVars: [],
      httpHeaders: {},
      envHttpHeaders: {},
      enabled: true,
      enabledTools: [],
      disabledTools: [],
      oauthScopes: [],
      secretFields: { "env.GITHUB_TOKEN": "present" },
    },
    source: "user",
    startupStatus: "ready",
    authStatus: "unsupported",
    tools: [],
    resources: [],
    resourceTemplates: [],
    ...overrides,
  } as McpServer;
}

export function serversFixture(
  workspace: McpWorkspace,
  servers: ReadonlyArray<McpServer>,
): McpListServersResult {
  return { workspace, servers, warnings: [] };
}

export function providerFixture(overrides: Partial<McpProviderSupport> = {}): McpProviderSupport {
  return {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    status: "managed",
    capabilities: ALL_CAPABILITIES,
    workspaceId: "codex:home",
    message: "Managed",
    ...overrides,
  } as McpProviderSupport;
}

export function installationFixture(
  overrides: Partial<AgentControlMcpInstallation> = {},
): AgentControlMcpInstallation {
  return {
    installationId: "installation-1",
    integrationId: "integration-1",
    workspaceId: "codex:home",
    driver: "codex",
    serverName: "ryco",
    state: "connected",
    revision: 1,
    lastError: null,
    ownsNativeConfig: true,
    preservedUserChanges: false,
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:01.000Z",
    connectedAt: "2026-11-09T00:00:01.000Z",
    ...overrides,
  } as AgentControlMcpInstallation;
}

export function pluginFixture(
  overrides: Partial<OpinionatedPluginCatalogItem> = {},
): OpinionatedPluginCatalogItem {
  return {
    id: "rtk",
    name: "RTK",
    summary: "Shrinks tool output.",
    description: "Shrinks tool output.",
    impact: "tool-output",
    scope: "global",
    homepageUrl: "https://example.com/rtk",
    supportedDrivers: [],
    installNotes: [],
    ...overrides,
  } as OpinionatedPluginCatalogItem;
}

export function pluginStatusFixture(
  overrides: Partial<OpinionatedPluginStatus> = {},
): OpinionatedPluginStatus {
  return {
    pluginId: "rtk",
    targetKind: "global",
    state: "not-installed",
    canInstall: true,
    checkedAt: "2026-11-09T00:00:00.000Z",
    manualSteps: [],
    ...overrides,
  } as OpinionatedPluginStatus;
}
