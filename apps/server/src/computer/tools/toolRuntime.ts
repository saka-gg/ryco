import { Data, type Effect } from "effect";

type AgentGatewayCapability = "computer:control";
import type { JsonRpcId, McpToolCallResult, McpToolDefinition } from "./protocol.ts";

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export interface ProviderSessionPrincipal {
  readonly kind: "provider-session";
  readonly sessionKey: string;
  readonly threadId: string;
  readonly provider: string;
  readonly turnId: string | null;
}

export interface ToolContext {
  readonly principal: ProviderSessionPrincipal;
  readonly callerThreadId: string;
  /**
   * The caller thread as a human would name it, for surfaces the human sees -
   * today the agent cursor's badge on the desktop. Null when the thread has no
   * title yet, which is not an error: the surface falls back to a generic
   * label rather than showing a thread id.
   */
  readonly callerThreadLabel: string | null;
  readonly callerSessionKey: string;
  readonly callerProvider: string;
  readonly callerCapabilities: ReadonlySet<AgentGatewayCapability>;
  readonly callerTurnId: string | null;
  readonly assertCallerTurnActive: () => Effect.Effect<void, GatewayToolError>;
  readonly jsonRpcRequestId: JsonRpcId;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<McpToolCallResult>;

export interface ToolEntry {
  readonly definition: McpToolDefinition;
  readonly handler: ToolHandler;
  readonly requiredCapability: AgentGatewayCapability;
  readonly requiresActiveTurn?: boolean;
  /**
   * Callable by exact name but withheld from `tools/list`: the advertised
   * catalog stays small while a tool the model already knows — or finds
   * through computer_help — still dispatches. Discovery-only is not a
   * permission: capability checks, approval and audit all apply unchanged.
   */
  readonly discoveryOnly?: boolean;
}

export class GatewayToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class ComputerToolFailure extends Data.TaggedError("ComputerToolFailure")<{
  readonly cause: unknown;
}> {}
