import {
  EventId,
  type AgentTokenMode,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeSessionId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ThreadTokenUsageSnapshot,
} from "@ryco/contracts";
import type { HtmlRenderToolPresentation } from "@ryco/shared/htmlRenderToolPresentation";
import { resolveCommandPath } from "@ryco/shared/shell";
import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionEvent,
} from "@github/copilot-sdk";
import { RuntimeConnection } from "@github/copilot-sdk";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { DeviceToolBinding } from "../../providerTools/deviceToolGateway.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import type {
  AgentControlProviderBridge,
  AgentControlRuntimeLease,
} from "../../agentControl/ProviderInjection.ts";

export const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");
export const DEFAULT_BINARY_PATH = "copilot";
export const USER_INPUT_QUESTION_ID = "answer";

export interface PendingApprovalRequest {
  readonly request: PermissionRequest;
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: PermissionRequestResult) => void;
}

export interface PendingUserInputRequest {
  readonly turnId: TurnId | undefined;
  readonly choices: ReadonlyArray<string>;
  readonly resolve: (result: { readonly answer: string; readonly wasFreeform: boolean }) => void;
}

export interface PendingTurnStartRequest {
  readonly resolve: (turnId: TurnId) => void;
  readonly reject: (cause: Error) => void;
}

export interface MutableTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export interface ActiveCopilotSession {
  readonly client: CopilotClient;
  session: CopilotSession;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly agentControl?: AgentControlRuntimeLease;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly tokenMode: AgentTokenMode;
  readonly pendingApprovals: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInputRequest>;
  readonly pendingTurnStarts: Set<PendingTurnStartRequest>;
  /**
   * How each Ryco HTML tool call in flight shows in the work log, by tool
   * call id. Copilot's completion event names neither the tool nor its input.
   */
  readonly htmlRenderToolCalls: Map<string, HtmlRenderToolPresentation>;
  readonly deviceToolBinding: DeviceToolBinding | null;
  readonly turns: Array<MutableTurnSnapshot>;
  readonly renewSession: () => Promise<CopilotSession>;
  readonly attachSession: (session: CopilotSession) => void;
  unsubscribe: () => void;
  cwd: string | undefined;
  model: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  activeMessageId: string | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  /** Authoritative session gauge, independent of per-call billing usage. */
  contextUsage?: Pick<ThreadTokenUsageSnapshot, "usedTokens" | "maxTokens">;
  stopped: boolean;
}

export interface CopilotAdapterLiveOptions {
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotClient;
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly agentControl?: AgentControlProviderBridge;
}

export function resolveCopilotCliPath(
  settings: { readonly binaryPath: string },
  environment: NodeJS.ProcessEnv | undefined,
): string {
  const binaryPath =
    settings.binaryPath === DEFAULT_BINARY_PATH ? DEFAULT_BINARY_PATH : settings.binaryPath;
  return resolveCommandPath(binaryPath, { env: environment ?? process.env }) ?? binaryPath;
}

export function makeCopilotClientOptions(
  settings: { readonly binaryPath: string },
  environment: NodeJS.ProcessEnv | undefined,
  workingDirectory?: string,
): CopilotClientOptions {
  return {
    connection: RuntimeConnection.forStdio({
      path: resolveCopilotCliPath(settings, environment),
    }),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(environment ? { env: environment } : {}),
    logLevel: "error",
  };
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function isSessionNotFoundError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.toLowerCase().includes("session not found");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toRuntimeItemId(value: string | undefined): RuntimeItemId | undefined {
  return value ? RuntimeItemId.make(value) : undefined;
}

function toRuntimeRequestId(value: string | undefined): RuntimeRequestId | undefined {
  return value ? RuntimeRequestId.make(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value ? ProviderItemId.make(value) : undefined;
}

export function normalizeUsage(
  event: Extract<SessionEvent, { type: "assistant.usage" }>,
): ThreadTokenUsageSnapshot {
  const directInputTokens = event.data.inputTokens ?? 0;
  const outputTokens = event.data.outputTokens ?? 0;
  const cachedInputTokens = event.data.cacheReadTokens ?? 0;
  const reasoningOutputTokens = event.data.reasoningTokens ?? 0;
  const inputTokens = directInputTokens + cachedInputTokens;
  const usedTokens = inputTokens + outputTokens;

  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens > 0
      ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
    ...(typeof event.data.duration === "number" ? { durationMs: event.data.duration } : {}),
  };
}

export function buildThreadSnapshot(
  threadId: ThreadId,
  turns: ReadonlyArray<MutableTurnSnapshot>,
): ProviderThreadSnapshot {
  return {
    threadId,
    turns: turns.map<ProviderThreadTurnSnapshot>((turn) => ({
      id: turn.id,
      items: [...turn.items],
    })),
  };
}

export function eventBase(input: {
  eventId: EventId;
  createdAt: string;
  threadId: ThreadId;
  providerInstanceId: ProviderInstanceId;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = normalizeString(input.requestId);

  return {
    eventId: input.eventId,
    provider: COPILOT_DRIVER_KIND,
    providerInstanceId: input.providerInstanceId,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}

export function requestTypeFromPermissionRequest(request: PermissionRequest) {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval" as const;
    case "write":
      return "file_change_approval" as const;
    case "read":
      return "file_read_approval" as const;
    case "mcp":
    case "custom-tool":
    case "url":
    case "memory":
    case "hook":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
}

export function requestDetailFromPermissionRequest(request: PermissionRequest): string | undefined {
  const props = request as unknown as Record<string, unknown>;

  switch (request.kind) {
    case "shell":
      return normalizeString(props.fullCommandText);
    case "write":
      return normalizeString(props.fileName) ?? normalizeString(props.intention);
    case "read":
      return normalizeString(props.path) ?? normalizeString(props.intention);
    case "mcp":
      return normalizeString(props.toolTitle) ?? normalizeString(props.toolName);
    case "url":
      return normalizeString(props.url);
    case "custom-tool":
      return normalizeString(props.toolName) ?? normalizeString(props.toolDescription);
    case "memory":
      return normalizeString(props.subject) ?? normalizeString(props.fact);
    case "hook":
      return normalizeString(props.hookMessage) ?? normalizeString(props.toolName);
    default:
      return undefined;
  }
}

function getCopilotSessionApproval(
  request: PermissionRequest,
):
  | Exclude<
      PermissionRequestResult,
      { kind: "no-result" } | { kind: "approve-once" } | { kind: "reject" }
    >
  | undefined {
  const props = request as unknown as Record<string, unknown>;

  switch (request.kind) {
    case "shell": {
      if (props.canOfferSessionApproval !== true || !Array.isArray(props.commands)) {
        return undefined;
      }
      const commandIdentifiers = props.commands.flatMap((command) => {
        if (typeof command !== "object" || command === null || !("identifier" in command)) {
          return [];
        }
        return typeof command.identifier === "string" && command.identifier.length > 0
          ? [command.identifier]
          : [];
      });
      if (commandIdentifiers.length === 0) {
        return undefined;
      }
      return {
        kind: "approve-for-session",
        approval: {
          kind: "commands",
          commandIdentifiers,
        },
      };
    }
    case "write":
      return props.canOfferSessionApproval === true
        ? {
            kind: "approve-for-session",
            approval: { kind: "write" },
          }
        : undefined;
    case "read":
      return {
        kind: "approve-for-session",
        approval: { kind: "read" },
      };
    case "mcp": {
      const serverName = normalizeString(props.serverName);
      if (!serverName) return undefined;
      return {
        kind: "approve-for-session",
        approval: {
          kind: "mcp",
          serverName,
          toolName: normalizeString(props.toolName) ?? null,
        },
      };
    }
    case "custom-tool": {
      const toolName = normalizeString(props.toolName);
      if (!toolName) return undefined;
      return {
        kind: "approve-for-session",
        approval: {
          kind: "custom-tool",
          toolName,
        },
      };
    }
    case "memory":
      return {
        kind: "approve-for-session",
        approval: { kind: "memory" },
      };
    default:
      return undefined;
  }
}

export function approvalDecisionToPermissionResult(
  decision: ProviderApprovalDecision,
  request: PermissionRequest,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
      return { kind: "approve-once" };
    case "acceptForSession":
      return getCopilotSessionApproval(request) ?? { kind: "approve-once" };
    case "decline":
    case "cancel":
    default:
      return { kind: "reject" };
  }
}

export function selectionTargetsCopilotInstance(
  value: ProviderSendTurnInput["modelSelection"] | ProviderSession["resumeCursor"] | undefined,
  instanceId: ProviderInstanceId,
): value is NonNullable<ProviderSendTurnInput["modelSelection"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "instanceId" in value &&
    value.instanceId === instanceId &&
    "model" in value &&
    typeof value.model === "string"
  );
}
