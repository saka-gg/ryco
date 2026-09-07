import {
  AGENT_CONTROL_CAPABILITIES,
  ProviderDriverKind,
  type AgentControlInjectionMode,
  type AgentControlProviderSupport,
  type ProviderInstanceId,
  type RuntimeSessionId,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import { Effect, Option, Redacted, Scope } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  AgentControlLeaseRevocationReason,
  AgentControlSessionRegistryShape,
} from "./Services/AgentControlSessionRegistry.ts";
import { blockProcessDeviceToolsForAgentControl } from "../providerTools/deviceToolGateway.ts";

export const AGENT_CONTROL_INTERNAL_SERVER_NAME = "ryco";
export const AGENT_CONTROL_STDIO_PROXY_ARG = "__agent-control-stdio-proxy";
export const AGENT_CONTROL_BOOTSTRAP_ENV = "RYCO_AGENT_CONTROL_BOOTSTRAP";
export const AGENT_CONTROL_BOOTSTRAP_URL_ENV = "RYCO_AGENT_CONTROL_BOOTSTRAP_URL";

const supported = (input: Omit<AgentControlProviderSupport, "supported" | "runtimeScoped">) => ({
  supported: true,
  runtimeScoped: true,
  ...input,
});

const unsupported = (input: Omit<AgentControlProviderSupport, "supported" | "runtimeScoped">) => ({
  supported: false,
  runtimeScoped: false,
  ...input,
});

/** Audited provider MCP isolation decisions. This is the single code-facing support matrix. */
export const AGENT_CONTROL_PROVIDER_SUPPORT = {
  codex: supported({
    http: "native",
    stdio: "unsupported",
    configurationScope: "runtime-session",
    credentialIsolation: "scoped-header",
    reason: null,
  }),
  claudeAgent: supported({
    http: "native",
    stdio: "native",
    configurationScope: "runtime-session",
    credentialIsolation: "scoped-header",
    reason: null,
  }),
  cursor: supported({
    http: "advertised",
    stdio: "proxy",
    configurationScope: "runtime-session",
    credentialIsolation: "scoped-header-or-bootstrap",
    reason: null,
  }),
  copilot: supported({
    http: "native",
    stdio: "native",
    configurationScope: "runtime-session",
    credentialIsolation: "scoped-header",
    reason: null,
  }),
  opencode: unsupported({
    http: "native",
    stdio: "native",
    configurationScope: "directory",
    credentialIsolation: "unsafe",
    reason:
      "OpenCode MCP configuration is server/project scoped, so another Ryco thread could inherit the connection.",
  }),
  grok: unsupported({
    http: "unsupported",
    stdio: "unsupported",
    configurationScope: "unknown",
    credentialIsolation: "unavailable",
    reason: "The Grok runtime does not expose a per-session MCP configuration surface.",
  }),
} as const satisfies Record<string, AgentControlProviderSupport>;

export const agentControlSupportForDriver = (
  driver: ProviderDriverKind,
): AgentControlProviderSupport =>
  AGENT_CONTROL_PROVIDER_SUPPORT[driver as keyof typeof AGENT_CONTROL_PROVIDER_SUPPORT] ??
  unsupported({
    http: "unsupported",
    stdio: "unsupported",
    configurationScope: "unknown",
    credentialIsolation: "unavailable",
    reason: "This provider has no audited per-session Agent Control injection boundary.",
  });

export const agentControlHostContext = (available: boolean): string =>
  available
    ? "Ryco Agent Control tools (ryco_*) are available through the private 'ryco' MCP server. Write tools create approval requests and never mutate immediately. If the server rejects access, treat the tools as unavailable instead of retrying."
    : "Ryco Agent Control tools (ryco_*) are unavailable for this provider session. Do not claim or attempt to use them.";

export type AgentControlProviderBridge = Pick<
  AgentControlSessionRegistryShape,
  "issueLease" | "issueStdioBootstrap" | "revokeLease" | "bindTurnAuthority" | "retireTurnAuthority"
>;

interface InstallInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeSessionId: RuntimeSessionId;
}

export interface AgentControlRuntimeLease {
  readonly sessionId: string;
  readonly injectionMode: AgentControlInjectionMode;
  readonly hostContext: string;
  readonly bindTurn: (turnId: TurnId) => Effect.Effect<void>;
  readonly retireTurn: (turnId?: TurnId) => Effect.Effect<void>;
  readonly revoke: (reason: AgentControlLeaseRevocationReason) => Effect.Effect<void>;
  readonly addScopeFinalizer: (scope: Scope.Closeable) => Effect.Effect<void>;
}

export interface AgentControlNativeHttpInjection extends AgentControlRuntimeLease {
  /** Redacted raw bearer for provider APIs whose SDK type owns header construction. */
  readonly credential: Redacted.Redacted<string>;
  readonly mcpServer: {
    readonly type: "http";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

export interface AgentControlAcpInjection extends AgentControlRuntimeLease {
  readonly mcpServer: EffectAcpSchema.McpServer;
}

const grantedCapabilities = [
  AGENT_CONTROL_CAPABILITIES.read,
  AGENT_CONTROL_CAPABILITIES.createThreads,
  AGENT_CONTROL_CAPABILITIES.sendMessage,
  AGENT_CONTROL_CAPABILITIES.interruptThread,
  AGENT_CONTROL_CAPABILITIES.updateThread,
  AGENT_CONTROL_CAPABILITIES.createProject,
  AGENT_CONTROL_CAPABILITIES.updateProject,
  AGENT_CONTROL_CAPABILITIES.removeProject,
  AGENT_CONTROL_CAPABILITIES.readSettings,
  AGENT_CONTROL_CAPABILITIES.changeSettings,
  AGENT_CONTROL_CAPABILITIES.readAutomations,
  AGENT_CONTROL_CAPABILITIES.manageAutomations,
  AGENT_CONTROL_CAPABILITIES.readActivity,
  AGENT_CONTROL_CAPABILITIES.readDiagnostics,
  AGENT_CONTROL_CAPABILITIES.readDevices,
  AGENT_CONTROL_CAPABILITIES.readDeviceContent,
  AGENT_CONTROL_CAPABILITIES.controlDevices,
  AGENT_CONTROL_CAPABILITIES.controlComputer,
  AGENT_CONTROL_CAPABILITIES.controlBrowser,
] as const;

const lifecycle = (input: {
  readonly bridge: AgentControlProviderBridge;
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly injectionMode: AgentControlInjectionMode;
}): AgentControlRuntimeLease => {
  const releaseLegacyDeviceTools = blockProcessDeviceToolsForAgentControl(
    input.threadId,
    input.sessionId,
  );
  const revoke = (reason: AgentControlLeaseRevocationReason) =>
    input.bridge
      .revokeLease({ sessionId: input.sessionId, reason })
      .pipe(Effect.ignore, Effect.ensuring(Effect.sync(releaseLegacyDeviceTools)));
  return {
    sessionId: input.sessionId,
    injectionMode: input.injectionMode,
    hostContext: agentControlHostContext(true),
    bindTurn: (turnId) =>
      input.bridge.bindTurnAuthority({ sessionId: input.sessionId, turnId }).pipe(Effect.ignore),
    retireTurn: (turnId) =>
      input.bridge
        .retireTurnAuthority({
          threadId: input.threadId,
          ...(turnId === undefined ? {} : { turnId }),
        })
        .pipe(Effect.ignore),
    revoke,
    addScopeFinalizer: (scope) => Scope.addFinalizer(scope, revoke("runtime-teardown")),
  };
};

export const installAgentControlNativeHttp = (
  bridge: AgentControlProviderBridge | undefined,
  input: InstallInput & {
    readonly injectionMode: "codex-http" | "claude-http" | "copilot-http";
  },
): Effect.Effect<Option.Option<AgentControlNativeHttpInjection>> => {
  if (!bridge) return Effect.succeed(Option.none());
  return bridge.issueLease({ ...input, capabilities: grantedCapabilities }).pipe(
    Effect.map(
      Option.map((lease) => ({
        ...lifecycle({
          bridge,
          threadId: input.threadId,
          sessionId: lease.sessionId,
          injectionMode: input.injectionMode,
        }),
        mcpServer: {
          type: "http" as const,
          url: lease.endpointUrl,
          headers: { Authorization: `Bearer ${Redacted.value(lease.credential)}` },
        },
        credential: lease.credential,
      })),
    ),
  );
};

export const installAgentControlAcp = (
  bridge: AgentControlProviderBridge | undefined,
  input: InstallInput & {
    readonly initializeResult: EffectAcpSchema.InitializeResponse;
    readonly proxyCommand: string;
    readonly proxyEntryPoint: string;
  },
): Effect.Effect<Option.Option<AgentControlAcpInjection>> => {
  if (!bridge) return Effect.succeed(Option.none());
  if (input.initializeResult.agentCapabilities?.mcpCapabilities?.http === true) {
    return bridge
      .issueLease({ ...input, capabilities: grantedCapabilities, injectionMode: "acp-http" })
      .pipe(
        Effect.map(
          Option.map((lease) => ({
            ...lifecycle({
              bridge,
              threadId: input.threadId,
              sessionId: lease.sessionId,
              injectionMode: "acp-http",
            }),
            mcpServer: {
              type: "http" as const,
              name: AGENT_CONTROL_INTERNAL_SERVER_NAME,
              url: lease.endpointUrl,
              headers: [
                { name: "Authorization", value: `Bearer ${Redacted.value(lease.credential)}` },
              ],
            },
          })),
        ),
      );
  }
  if (input.proxyEntryPoint.length === 0) return Effect.succeed(Option.none());
  return bridge
    .issueStdioBootstrap({
      ...input,
      capabilities: grantedCapabilities,
      injectionMode: "acp-stdio-proxy",
    })
    .pipe(
      Effect.map(
        Option.map((bootstrap) => ({
          ...lifecycle({
            bridge,
            threadId: input.threadId,
            sessionId: bootstrap.sessionId,
            injectionMode: "acp-stdio-proxy",
          }),
          mcpServer: {
            name: AGENT_CONTROL_INTERNAL_SERVER_NAME,
            command: input.proxyCommand,
            args: [input.proxyEntryPoint, AGENT_CONTROL_STDIO_PROXY_ARG],
            env: [
              {
                name: AGENT_CONTROL_BOOTSTRAP_ENV,
                value: Redacted.value(bootstrap.bootstrapToken),
              },
              {
                name: AGENT_CONTROL_BOOTSTRAP_URL_ENV,
                value: bootstrap.endpointUrl.replace(/\/mcp$/, "/_agent-control/bootstrap"),
              },
            ],
          },
        })),
      ),
    );
};

const SECRET_PATTERN = /rycoacb?_[A-Za-z0-9_-]{43}/g;

/** Defensive native-log redaction for provider configs that necessarily contain scoped secrets. */
export const redactAgentControlSecrets = (value: unknown): unknown => {
  if (typeof value === "string") return value.replaceAll(SECRET_PATTERN, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redactAgentControlSecrets);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactAgentControlSecrets(value.message),
    };
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactAgentControlSecrets(entry)]),
    );
  }
  return value;
};
