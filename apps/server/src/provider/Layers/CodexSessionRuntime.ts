import {
  ApprovalRequestId,
  type AgentTokenMode,
  DEFAULT_MODEL,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type RuntimeSessionId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderTurnSteerResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { normalizeModelSlug } from "@ryco/shared/model";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Redacted,
  Ref,
  Scope,
  Schema,
  Schedule,
  Stream,
} from "effect";
import * as SchemaIssue from "effect/SchemaIssue";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  CODEX_ASK_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { appendProjectCustomSystemPrompt } from "../ProjectCustomSystemPrompt.ts";
import {
  createProcessDeviceToolBinding,
  type DeviceToolBinding,
} from "../../providerTools/deviceToolGateway.ts";

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;

/**
 * Injected per-runtime Agent Control MCP connection. The bearer enters
 * exactly one channel: the `thread/start` `config` record, which lands in
 * the app-server's in-memory session-flags layer. It is never written to
 * any config.toml, never placed in the process environment or argv, and
 * therefore can never be inherited by shell subprocesses codex spawns.
 */
export interface CodexAgentControlInjection {
  readonly serverName: string;
  readonly endpointUrl: string;
  readonly authorization: Redacted.Redacted<string>;
  readonly instructions: string;
}

// Keep this distinct from the user-installed `mcp_servers.ryco` external
// integration. Codex merges per-thread MCP config with the user's global
// config by server name, so reusing `ryco` would combine the external stdio
// command with this runtime-scoped URL and reject the entry as invalid.
export const CODEX_AGENT_CONTROL_SERVER_NAME = "ryco_agent_control";

/**
 * Session-flags config record advertising the private MCP endpoint to this
 * runtime's codex app-server. `http_headers` carries the literal bearer —
 * deliberately not `bearer_token_env_var`, which would force the token
 * into the codex process env where agent shell commands inherit it.
 */
export function buildAgentControlThreadConfig(
  injection: CodexAgentControlInjection,
): Record<string, unknown> {
  return {
    mcp_servers: {
      [injection.serverName]: {
        url: injection.endpointUrl,
        http_headers: {
          Authorization: `Bearer ${Redacted.value(injection.authorization)}`,
        },
        startup_timeout_sec: 10,
      },
    },
  };
}

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly tokenMode: AgentTokenMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly tokenReductionInstructions?: string | undefined;
  readonly agentControl?: CodexAgentControlInjection | undefined;
  readonly resumeCursor?: CodexResumeCursor;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
  readonly customSystemPrompt?: string;
}

export interface CodexSessionRuntimeSteerTurnInput {
  readonly expectedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
  readonly status?: "completed" | "failed" | "interrupted" | "inProgress";
  readonly startedAt?: number | null;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly steerTurn: (
    input: CodexSessionRuntimeSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly setGoal: (
    input: Omit<EffectCodexSchema.V2ThreadGoalSetParams, "threadId">,
  ) => Effect.Effect<EffectCodexSchema.V2ThreadGoalSetResponse, CodexSessionRuntimeError>;
  readonly getGoal: Effect.Effect<
    EffectCodexSchema.V2ThreadGoalGetResponse,
    CodexSessionRuntimeError
  >;
  readonly clearGoal: Effect.Effect<
    EffectCodexSchema.V2ThreadGoalClearResponse,
    CodexSessionRuntimeError
  >;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedError<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedError<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedError<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedError<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return Schema.is(CodexResumeCursorSchema)(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
  // Always explicit: omitting the field on resume keeps the thread's previous
  // reviewer, which would leave the subagent sticky after switching modes.
  readonly approvalsReviewer: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "guardian_subagent",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly deviceToolBinding?: DeviceToolBinding | null;
  readonly agentControl?: CodexAgentControlInjection | undefined;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const agentControlMcpServers = input.agentControl
    ? (buildAgentControlThreadConfig(input.agentControl).mcp_servers as Record<string, unknown>)
    : {};
  const mcpServers = {
    ...(input.deviceToolBinding
      ? {
          ryco_device: {
            url: input.deviceToolBinding.url,
            http_headers: { ...input.deviceToolBinding.headers },
          },
        }
      : {}),
    ...agentControlMcpServers,
  };
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    approvalsReviewer: config.approvalsReviewer,
    config: {
      "features.goals": true,
      ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
    },
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
    case "auto":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly customSystemPrompt?: string;
  readonly tokenReductionInstructions?: string;
  readonly hostContextInstructions?: string;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  const baseInstructions = appendProjectCustomSystemPrompt(
    appendProjectCustomSystemPrompt(
      input.interactionMode === "plan"
        ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
        : input.interactionMode === "ask"
          ? CODEX_ASK_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      input.tokenReductionInstructions,
    ),
    input.customSystemPrompt,
  );
  const developerInstructions = input.hostContextInstructions
    ? `${baseInstructions}\n\n${input.hostContextInstructions}`
    : baseInstructions;
  return {
    // The Codex app-server protocol only knows the "plan" and "default"
    // collaboration modes; "ask" rides on "default" with ask developer
    // instructions plus a read-only turn sandbox (see buildTurnStartParams).
    mode: input.interactionMode === "plan" ? "plan" : "default",
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions: developerInstructions,
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
  readonly customSystemPrompt?: string;
  readonly tokenReductionInstructions?: string;
  readonly hostContextInstructions?: string;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.customSystemPrompt ? { customSystemPrompt: input.customSystemPrompt } : {}),
    ...(input.tokenReductionInstructions
      ? { tokenReductionInstructions: input.tokenReductionInstructions }
      : {}),
    ...(input.hostContextInstructions
      ? { hostContextInstructions: input.hostContextInstructions }
      : {}),
  });

  // Ask mode forces a read-only sandbox so the turn cannot edit files,
  // regardless of the thread's runtime mode.
  const sandboxPolicy: EffectCodexSchema.V2TurnStartParams__SandboxPolicy =
    input.interactionMode === "ask"
      ? { type: "readOnly" }
      : runtimeModeToTurnSandboxPolicy(input.runtimeMode);

  return Schema.decodeUnknownEffect(CodexTurnStartParamsWithCollaborationMode)({
    threadId: input.threadId,
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
    sandboxPolicy,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/start request payload", error)),
  );
}

export function buildTurnSteerParams(input: {
  readonly threadId: string;
  readonly expectedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{ readonly type: "image"; readonly url: string }>;
}): Effect.Effect<
  EffectCodexSchema.V2TurnSteerParams,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnSteerParams__UserInput> = [];
  if (input.prompt) turnInput.push({ type: "text", text: input.prompt });
  for (const attachment of input.attachments ?? []) turnInput.push(attachment);
  return Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerParams)({
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    clientUserMessageId: input.messageId,
    input: turnInput,
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/steer request payload", error)),
  );
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";

interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
  readonly deviceToolBinding?: DeviceToolBinding | null;
  readonly agentControl?: CodexAgentControlInjection | undefined;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
    ...(input.deviceToolBinding !== undefined
      ? { deviceToolBinding: input.deviceToolBinding }
      : {}),
    ...(input.agentControl ? { agentControl: input.agentControl } : {}),
  });

  if (resumeThreadId === undefined) {
    return input.client.request("thread/start", startParams);
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.mapError((error) =>
        error.message.includes("already has an active writer")
          ? new CodexErrors.CodexAppServerRequestError({
              code: -32600,
              errorMessage:
                "This Codex thread already has an active writer in another process. Its history can still be recovered. Release the thread in that process before continuing it here.",
            })
          : error,
      ),
    );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "thread/goal/updated" ||
    method === "thread/goal/cleared" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

/**
 * Native collab child-agent tracking (multi-agent v2). Under v2 subagents are
 * full app-server threads: identity arrives on `thread/started` with
 * source.subAgent.thread_spawn, lifecycle on `subAgentActivity` items and the
 * child thread's own turn/status/tokenUsage notifications. The runtime
 * registers children from those explicit signals, intercepts their
 * notifications before parent-timeline mapping, and re-emits them as
 * synthetic `collabAgent/*` provider events the adapter turns into task.*
 * runtime events (timelineBypass keeps them out of the parent chat).
 *
 * Registration is deliberately explicit-signals-only: a child whose first
 * notification precedes registration passes through as today (no regression
 * vs main, which passes everything through).
 */
interface CollabChildAgentState {
  readonly agentThreadId: string;
  readonly nickname: string | undefined;
  readonly role: string | undefined;
  readonly agentPath: string | undefined;
  readonly depth: number | undefined;
  readonly parentThreadId: string | undefined;
  /**
   * Parent canonical turn active when the child registered. Stamped on every
   * synthetic collabAgent/* event so clients can batch a fleet by its spawn
   * turn — without it, separate fleets in one thread collapse into a single
   * "direct:no-turn" CTA.
   */
  readonly spawnTurnId: TurnId | undefined;
}

function readThreadSpawnSource(thread: { readonly source: unknown }):
  | {
      nickname: string | undefined;
      role: string | undefined;
      agentPath: string | undefined;
      depth: number | undefined;
      parentThreadId: string | undefined;
    }
  | undefined {
  const source = thread.source;
  if (typeof source !== "object" || source === null || !("subAgent" in source)) {
    return undefined;
  }
  const subAgent = (source as { subAgent: unknown }).subAgent;
  if (typeof subAgent !== "object" || subAgent === null || !("thread_spawn" in subAgent)) {
    return undefined;
  }
  const spawn = (subAgent as { thread_spawn: unknown }).thread_spawn;
  if (typeof spawn !== "object" || spawn === null) {
    return undefined;
  }
  const record = spawn as Record<string, unknown>;
  return {
    nickname: typeof record.agent_nickname === "string" ? record.agent_nickname : undefined,
    role: typeof record.agent_role === "string" ? record.agent_role : undefined,
    agentPath: typeof record.agent_path === "string" ? record.agent_path : undefined,
    depth: typeof record.depth === "number" ? record.depth : undefined,
    parentThreadId:
      typeof record.parent_thread_id === "string" ? record.parent_thread_id : undefined,
  };
}

/**
 * How a notification addressed to a REGISTERED child thread is handled.
 *
 * Exported and pure so the routing table can be asserted against captured
 * wire traces (see codexMultiAgentWire.json) rather than only read.
 *
 * - "agent-event": map to a synthetic collabAgent/* event (Agents surface).
 * - "parent": pass through to the parent path — it carries state the parent
 *   still owns (approval correlation cleanup).
 * - "drop": genuine child chatter with no parent meaning (deltas, name and
 *   plan updates).
 *
 * Default is "drop" ONLY for the enumerated chatter; anything unrecognized
 * routes to "parent" so new wire methods surface instead of vanishing.
 */
export type CodexChildNotificationRoute = "agent-event" | "parent" | "drop";

const CHILD_AGENT_EVENT_METHODS: ReadonlySet<string> = new Set([
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "item/started",
  "item/completed",
  "thread/closed",
  "error",
]);

const CHILD_CHATTER_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "thread/name/updated",
  "thread/settings/updated",
  "rawResponseItem/completed",
  // Child-owned thread lifecycle: the parent adapter maps these onto the
  // PARENT thread (archived/compacted state), so a child compacting would
  // rewrite the parent. Mirrors the v1 suppressor list — dropping them is
  // the pre-existing behavior for collab children.
  "thread/archived",
  "thread/unarchived",
  "thread/compacted",
  // Registration path 1 handles a child's first thread/started; a repeat
  // must not reach the parent (it would restart the parent's thread state).
  "thread/started",
]);

export function routeCodexChildNotification(method: string): CodexChildNotificationRoute {
  if (CHILD_AGENT_EVENT_METHODS.has(method)) {
    return "agent-event";
  }
  if (CHILD_CHATTER_METHODS.has(method)) {
    return "drop";
  }
  // Unknown or parent-owned (serverRequest/resolved, approvals, …).
  return "parent";
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (Schema.is(CodexUserInputAnswerObject)(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function toProtocolParseError(
  detail: string,
  cause: Schema.SchemaError,
): CodexErrors.CodexAppServerProtocolParseError {
  return new CodexErrors.CodexAppServerProtocolParseError({
    detail: `${detail}: ${formatSchemaIssue(cause.issue)}`,
    cause,
  });
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession> | ((session: ProviderSession) => Partial<ProviderSession>),
): Effect.Effect<void> {
  return Ref.update(sessionRef, (session) => ({
    ...session,
    ...(typeof updates === "function" ? updates(session) : updates),
    updatedAt: new Date().toISOString(),
  }));
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
      status: turn.status,
      ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
    })),
  };
}

export const readStoredCodexThread = (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly providerThreadId: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        CodexClient.layerCommand({
          command: input.binaryPath,
          args: ["app-server"],
          cwd: input.cwd,
          env: {
            ...(input.environment ?? process.env),
            ...(input.homePath ? { CODEX_HOME: expandHomePath(input.homePath) } : {}),
          },
          requestTimeoutMs: 20_000,
        }),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(context),
      );
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);
      return parseThreadSnapshot(
        yield* client.request("thread/read", {
          threadId: input.providerThreadId,
          includeTurns: true,
        }),
      );
    }),
  );

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    let deviceTurnActive = false;
    const deviceToolBinding = createProcessDeviceToolBinding({
      threadId: options.threadId,
      isTurnActive: () => deviceTurnActive,
    });
    if (deviceToolBinding) {
      yield* Scope.addFinalizer(
        runtimeScope,
        Effect.sync(() => deviceToolBinding.dispose()),
      );
    }
    const events = yield* Queue.bounded<ProviderEvent>(2_048);
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const collabChildAgentsRef = yield* Ref.make(new Map<string, CollabChildAgentState>());
    /** Child provider-thread id → its currently running provider turn id. */
    const collabChildLiveTurnsRef = yield* Ref.make(new Map<string, string>());
    // Only potentially active children need polling. Revisions fence reads against
    // newer notifications, including a follow-up that starts while a read is pending.
    const childRevisions = new Map<string, number>();
    const unsettledChildren = new Set<string>();
    const reconciledChildStatuses = new Map<string, string>();
    const closedRef = yield* Ref.make(false);

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...(options.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.binaryPath, ["app-server"], {
          cwd: options.cwd,
          env,
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const transportFailure = yield* Deferred.make<CodexErrors.CodexAppServerError>();
    const clientContext = yield* CodexClient.layerChildProcess(child, {
      onTermination: (error) => Deferred.succeed(transportFailure, error).pipe(Effect.asVoid),
    }).pipe(Layer.build, Effect.provideService(Scope.Scope, runtimeScope));
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    const serverNotifications = yield* Queue.bounded<CodexServerNotification>(512);

    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      runtimeSessionId: options.runtimeSessionId,
      status: "connecting",
      runtimeMode: options.runtimeMode,
      tokenMode: options.tokenMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.flatMap(
        Effect.sync(() => crypto.randomUUID()),
        (id) =>
          offerEvent({
            id: EventId.make(id),
            provider: PROVIDER,
            ...(options.providerInstanceId
              ? { providerInstanceId: options.providerInstanceId }
              : {}),
            createdAt: new Date().toISOString(),
            ...event,
          }),
      );
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    yield* Deferred.await(transportFailure).pipe(
      Effect.flatMap((error) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) =>
            closed
              ? Effect.void
              : Effect.gen(function* () {
                  deviceTurnActive = false;
                  yield* updateSession(sessionRef, {
                    status: "error",
                    activeTurnId: undefined,
                    lastError: "Codex connection was lost. Reopen the chat to recover its history.",
                  });
                  yield* emitSessionEvent(
                    "session/exited",
                    `Codex connection lost (${error._tag}).`,
                  );
                  // Only the child owned by this runtime is retired. Keep the resume
                  // cursor so recovery cannot accidentally switch to a new thread.
                  yield* child.kill().pipe(Effect.ignore);
                }),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    /**
     * Registers v2 collab children and re-emits their notifications as
     * synthetic `collabAgent/*` events for the adapter's task.* synthesis.
     * Returns true when the notification was fully handled (must not reach
     * parent-timeline mapping).
     */
    const interceptCollabChildNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        // Registration path 1: child thread announces itself with a
        // subAgent thread_spawn source.
        if (notification.method === "thread/started") {
          const thread = notification.params.thread;
          const spawn = readThreadSpawnSource(thread);
          if (!spawn) {
            return false;
          }
          // Merge with any subAgentActivity registration that got here
          // first. spawnTurnId is REGISTRATION-time-only on both paths: for
          // an already-known child we keep its value (set or unset) — a
          // later thread/started during an unrelated parent turn must not
          // backfill that turn as the spawn batch, which would stamp an old
          // child onto a new fleet's CTA. Only a genuinely new registration
          // captures the current turn.
          const existingChild = (yield* Ref.get(collabChildAgentsRef)).get(thread.id);
          const spawnTurnId = existingChild
            ? existingChild.spawnTurnId
            : ((yield* Ref.get(sessionRef)).activeTurnId ?? undefined);
          const state: CollabChildAgentState = {
            agentThreadId: thread.id,
            nickname: spawn.nickname ?? thread.agentNickname ?? existingChild?.nickname,
            role: spawn.role ?? thread.agentRole ?? existingChild?.role,
            agentPath: spawn.agentPath ?? existingChild?.agentPath,
            depth: spawn.depth ?? existingChild?.depth,
            parentThreadId:
              spawn.parentThreadId ?? thread.parentThreadId ?? existingChild?.parentThreadId,
            spawnTurnId,
          };
          yield* Ref.update(collabChildAgentsRef, (current) => {
            const next = new Map(current);
            next.set(thread.id, state);
            return next;
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "collabAgent/started",
            ...(state.spawnTurnId ? { turnId: state.spawnTurnId } : {}),
            payload: {
              agentThreadId: state.agentThreadId,
              ...(state.nickname ? { nickname: state.nickname } : {}),
              ...(state.role ? { role: state.role } : {}),
              ...(state.agentPath ? { agentPath: state.agentPath } : {}),
              ...(state.depth !== undefined ? { depth: state.depth } : {}),
              ...(state.parentThreadId ? { parentThreadId: state.parentThreadId } : {}),
            },
          });
          return true;
        }

        // Registration path 2: parent-side subAgentActivity item names the
        // child thread (may arrive before or after thread/started).
        if (
          (notification.method === "item/started" || notification.method === "item/completed") &&
          notification.params.item.type === "subAgentActivity"
        ) {
          const item = notification.params.item;
          // Never register the session's ROOT thread as its own child. The
          // wire emits subAgentActivity {agentPath: "/root", interacted}
          // about the root during collab runs; registering it intercepted
          // every subsequent root notification — including the final
          // assistant message and turn/completed — so the thread hung
          // "working" after all subagents finished.
          const rootProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          if (
            item.agentThreadId === rootProviderThreadId ||
            item.agentPath === "/root" ||
            item.agentPath === "/"
          ) {
            return false;
          }
          const activitySpawnTurnId = (yield* Ref.get(sessionRef)).activeTurnId ?? undefined;
          yield* Ref.update(collabChildAgentsRef, (current) => {
            const existing = current.get(item.agentThreadId);
            const next = new Map(current);
            // Merge-late semantics: when thread/started registered first, a
            // later subAgentActivity still carries the real agentPath (and a
            // derived nickname) — fill missing fields, never clobber known
            // ones. spawnTurnId is registration-time-only: for an already
            // registered child, a later activity during an UNRELATED turn
            // must not backfill that turn as the spawn batch; an unset spawn
            // turn stays unset.
            next.set(item.agentThreadId, {
              agentThreadId: item.agentThreadId,
              nickname:
                existing?.nickname ??
                item.agentPath.split("/").findLast((segment) => segment.length > 0),
              role: existing?.role,
              agentPath: existing?.agentPath ?? item.agentPath,
              depth: existing?.depth,
              parentThreadId: existing?.parentThreadId,
              spawnTurnId: existing ? existing.spawnTurnId : activitySpawnTurnId,
            });
            return next;
          });
          const registeredChild = (yield* Ref.get(collabChildAgentsRef)).get(item.agentThreadId);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "collabAgent/activity",
            ...(registeredChild?.spawnTurnId ? { turnId: registeredChild.spawnTurnId } : {}),
            payload: {
              agentThreadId: item.agentThreadId,
              agentPath: item.agentPath,
              activityKind: item.kind,
            },
          });
          return true;
        }

        // Interception: notifications addressed to a registered child thread
        // become agent-scoped synthetic events instead of parent chatter.
        const providerConversationId = readNotificationThreadId(notification);
        if (!providerConversationId) {
          return false;
        }
        // Belt-and-braces: the root thread's traffic must never be
        // intercepted, whatever the registry says.
        const interceptRootId = currentProviderThreadId(yield* Ref.get(sessionRef));
        if (providerConversationId === interceptRootId) {
          return false;
        }
        const children = yield* Ref.get(collabChildAgentsRef);
        const child = children.get(providerConversationId);
        if (!child) {
          return false;
        }
        const childIdentity = {
          agentThreadId: child.agentThreadId,
          ...(child.nickname ? { nickname: child.nickname } : {}),
          ...(child.role ? { role: child.role } : {}),
          ...(child.agentPath ? { agentPath: child.agentPath } : {}),
        };
        switch (notification.method) {
          case "turn/started": {
            const childTurnId =
              typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
                ? ((notification.params as { turn: { id: string } }).turn.id as string)
                : undefined;
            if (childTurnId) {
              yield* Ref.update(collabChildLiveTurnsRef, (current) => {
                const next = new Map(current);
                next.set(child.agentThreadId, childTurnId);
                return next;
              });
            }
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/turnStarted",
              payload: childIdentity,
            });
            return true;
          }
          case "turn/completed":
            yield* Ref.update(collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.delete(child.agentThreadId);
              return next;
            });
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/turnCompleted",
              payload: {
                ...childIdentity,
                turn: notification.params.turn,
              },
            });
            return true;
          case "thread/status/changed":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/statusChanged",
              payload: {
                ...childIdentity,
                status: notification.params.status,
              },
            });
            return true;
          case "thread/tokenUsage/updated":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/tokenUsage",
              payload: {
                ...childIdentity,
                tokenUsage: notification.params.tokenUsage,
              },
            });
            return true;
          case "item/started":
          case "item/completed":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/item",
              payload: {
                ...childIdentity,
                item: notification.params.item,
                lifecycle: notification.method,
              },
            });
            return true;
          case "thread/closed":
            // The child is gone: drop its live-turn entry so a later Stop
            // doesn't waste a turn/interrupt RPC on a closed thread before
            // reaching the parent.
            yield* Ref.update(collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.delete(child.agentThreadId);
              return next;
            });
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/closed",
              payload: childIdentity,
            });
            return true;
          case "error": {
            // A child error must surface as a failed agent, not vanish into
            // the default swallow. Retryable errors (willRetry) keep the
            // child RUNNING and interruptible — mirroring the root error
            // handler; settling it would orphan a still-live child from
            // Stop. Terminal errors clean up the live turn like
            // thread/closed and reuse the statusChanged systemError path.
            const willRetry = (notification.params as { willRetry?: boolean }).willRetry === true;
            if (willRetry) {
              return true;
            }
            yield* Ref.update(collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.delete(child.agentThreadId);
              return next;
            });
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/statusChanged",
              payload: {
                ...childIdentity,
                status: { type: "systemError" },
              },
            });
            return true;
          }
          default:
            // Routing table decides (single source of truth, asserted
            // against captured wire traces): enumerated chatter is dropped,
            // everything else — including methods this build has never seen
            // — falls through to the parent path rather than vanishing.
            return routeCodexChildNotification(notification.method) === "drop";
        }
      });

    const reconcileChild = (childThreadId: string, includeTurns = false) =>
      Effect.gen(function* () {
        const revision = childRevisions.get(childThreadId);
        const response = yield* client.request("thread/read", {
          threadId: childThreadId,
          includeTurns,
        });
        if (childRevisions.get(childThreadId) !== revision) return;
        const child = (yield* Ref.get(collabChildAgentsRef)).get(childThreadId);
        if (!child || response.thread.id !== childThreadId) return;
        const status = response.thread.status;
        const activeTurn = response.thread.turns.findLast((turn) => turn.status === "inProgress");
        const live = status.type === "active";
        yield* Ref.update(collabChildLiveTurnsRef, (current) => {
          const next = new Map(current);
          if (live && activeTurn) next.set(childThreadId, activeTurn.id);
          else if (!live) next.delete(childThreadId);
          return next;
        });
        if (!live) unsettledChildren.delete(childThreadId);
        const signature = JSON.stringify([revision, status]);
        if (reconciledChildStatuses.get(childThreadId) === signature) return;
        reconciledChildStatuses.set(childThreadId, signature);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
          method: "collabAgent/statusChanged",
          payload: {
            agentThreadId: childThreadId,
            ...(child.nickname ? { nickname: child.nickname } : {}),
            ...(child.role ? { role: child.role } : {}),
            ...(child.agentPath ? { agentPath: child.agentPath } : {}),
            status,
          },
        });
      }).pipe(Effect.timeout("3 seconds"));

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const payload = notification.params;
        const rootId = currentProviderThreadId(yield* Ref.get(sessionRef));
        const activity =
          (notification.method === "item/started" || notification.method === "item/completed") &&
          notification.params.item.type === "subAgentActivity"
            ? notification.params.item
            : undefined;
        const childId = activity?.agentThreadId ?? readNotificationThreadId(notification);
        if (childId && rootId && childId !== rootId) {
          childRevisions.set(childId, (childRevisions.get(childId) ?? 0) + 1);
          if (
            activity ||
            notification.method === "thread/started" ||
            notification.method === "turn/started" ||
            (notification.method === "thread/status/changed" &&
              notification.params.status.type === "active")
          ) {
            unsettledChildren.add(childId);
          }
          if (
            notification.method === "thread/closed" ||
            notification.method === "turn/completed" ||
            (notification.method === "thread/status/changed" &&
              notification.params.status.type !== "active")
          ) {
            unsettledChildren.delete(childId);
          }
        }
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const childParentTurnId = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return providerConversationId
            ? collabReceiverTurns.get(providerConversationId)
            : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        // Interception FIRST: a registered v2 child is usually also in the
        // receiver-turn map (collabAgentToolCall.receiverThreadIds), and the
        // legacy suppressor below would drop its lifecycle before it could
        // become synthetic collabAgent events. The suppressor still covers
        // UNREGISTERED children.
        if (yield* interceptCollabChildNotification(notification)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        // Suppression applies to receiver-map children (v1) AND to any
        // conversation that is not the root thread. The live capture
        // (codexMultiAgentWire.json) shows a child's thread/status/changed
        // arriving BEFORE anything registers the child — pre-registration
        // lifecycle must not reach the parent path, where the adapter maps
        // thread/* onto parent session state. Root-id-known guard keeps the
        // root's own early notifications flowing during session open.
        const suppressRootId = currentProviderThreadId(yield* Ref.get(sessionRef));
        const foreignConversation = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return (
            providerConversationId !== undefined &&
            suppressRootId !== undefined &&
            providerConversationId !== suppressRootId
          );
        })();
        if (
          (childParentTurnId !== undefined || foreignConversation) &&
          shouldSuppressChildConversationNotification(notification.method)
        ) {
          // Stop-everything must not depend on registration timing: a
          // child's turn/started can arrive before the subAgentActivity that
          // registers it (captured ordering), and suppressing it without
          // remembering the live turn would leave that child running after
          // Stop. Track live turns for ANY foreign conversation; interrupts
          // are best-effort per child, so a false-positive entry costs one
          // ignored RPC at worst.
          const foreignThreadId = readNotificationThreadId(notification);
          if (foreignThreadId !== undefined) {
            if (notification.method === "turn/started") {
              const foreignTurnId =
                typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
                  ? (notification.params as { turn: { id: string } }).turn.id
                  : undefined;
              if (foreignTurnId) {
                yield* Ref.update(collabChildLiveTurnsRef, (current) => {
                  const next = new Map(current);
                  next.set(foreignThreadId, foreignTurnId);
                  return next;
                });
              }
            } else if (
              notification.method === "turn/completed" ||
              notification.method === "thread/closed"
            ) {
              yield* Ref.update(collabChildLiveTurnsRef, (current) => {
                const next = new Map(current);
                next.delete(foreignThreadId);
                return next;
              });
            }
          }
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = childParentTurnId ?? route.turnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
      });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          deviceTurnActive = true;
          return updateSession(sessionRef, {
            status: "running",
            activeTurnId: TurnId.make(payload.turn.id),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          deviceTurnActive = false;
          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? payload.turn.error.message
              : undefined;
          return updateSession(sessionRef, {
            status: payload.turn.status === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            ...(lastError ? { lastError } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          const payloadThreadId = payload.threadId;
          if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
            return Effect.void;
          }
          const errorMessage = payload.error.message;
          const willRetry = payload.willRetry;
          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Effect.sync(() => crypto.randomUUID()));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Effect.sync(() => crypto.randomUUID()));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Effect.sync(() => crypto.randomUUID()));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            turnId,
            itemId,
            answers,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );

    yield* Effect.forEach(
      Object.values(
        CodexRpc.SERVER_NOTIFICATION_METHODS,
      ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    yield* Effect.suspend(() =>
      Effect.forEach(
        Array.from(unsettledChildren),
        (id) => reconcileChild(id).pipe(Effect.ignore),
        { concurrency: 4, discard: true },
      ),
    ).pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkIn(runtimeScope));

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
        deviceToolBinding,
        ...(options.agentControl ? { agentControl: options.agentControl } : {}),
      });

      const providerThreadId = opened.thread.id;
      const activeTurn = opened.thread.turns.findLast((turn) => turn.status === "inProgress");
      deviceTurnActive = activeTurn !== undefined;
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: activeTurn ? "running" : "ready",
        activeTurnId: activeTurn ? TurnId.make(activeTurn.id) : undefined,
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: new Date().toISOString(),
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      deviceTurnActive = false;
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped");
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const normalizedModel = normalizeCodexModelSlug(
            input.model ?? (yield* Ref.get(sessionRef)).model,
          );
          const params = yield* buildTurnStartParams({
            threadId: providerThreadId,
            runtimeMode: options.runtimeMode,
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
            ...(input.customSystemPrompt ? { customSystemPrompt: input.customSystemPrompt } : {}),
            ...(options.tokenReductionInstructions
              ? { tokenReductionInstructions: options.tokenReductionInstructions }
              : {}),
            ...(options.agentControl
              ? { hostContextInstructions: options.agentControl.instructions }
              : {}),
          });
          const rawResponse = yield* client.raw.request("turn/start", params);
          const response = yield* Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse)(
            rawResponse,
          ).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/start response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turn.id);
          deviceTurnActive = true;
          yield* updateSession(sessionRef, (session) => ({
            status: "running",
            // A follow-up can be accepted while another turn is active. The
            // returned id is queued, but interrupt must still target the turn
            // that is actually running now.
            activeTurnId: session.activeTurnId ?? turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          }));
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnStartResult;
        }),
      steerTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const params = yield* buildTurnSteerParams({
            threadId: providerThreadId,
            expectedTurnId: input.expectedTurnId,
            messageId: input.messageId,
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
          });
          const rawResponse = yield* client.raw.request("turn/steer", params);
          const response = yield* Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerResponse)(
            rawResponse,
          ).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/steer response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turnId);
          return {
            threadId: options.threadId,
            turnId,
          } satisfies ProviderTurnSteerResult;
        }),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          // Stop-everything: children are full threads with their own turns;
          // interrupting only the parent leaves the fleet running. Interrupt
          // each live child turn first, best-effort per child, BOUNDED: the
          // transport awaits an unbounded Deferred per request, so a wedged
          // child would otherwise block the parent interrupt forever —
          // exactly during the runaway fleet where Stop matters most.
          // Per-child and overall deadlines guarantee the parent interrupt
          // below always runs.
          // Recover missing turn/started notifications and retire stale entries
          // before deciding which child turns to interrupt.
          yield* Effect.forEach(
            Array.from((yield* Ref.get(collabChildAgentsRef)).keys()),
            (id) => reconcileChild(id, true).pipe(Effect.ignore),
            { concurrency: 8, discard: true },
          ).pipe(Effect.timeoutOption("5 seconds"));
          const liveChildTurns = yield* Ref.get(collabChildLiveTurnsRef);
          const registeredChildren = yield* Ref.get(collabChildAgentsRef);
          // A failed/raced read must not turn an unknown live child into a
          // successful no-op. The adapter will stop the owned session instead.
          let childInterruptFailed = Array.from(unsettledChildren).some(
            (id) => registeredChildren.has(id) && !liveChildTurns.has(id),
          );
          yield* Effect.forEach(
            Array.from(liveChildTurns.entries()),
            ([childThreadId, childTurnId]) =>
              client
                .request("turn/interrupt", {
                  threadId: childThreadId,
                  turnId: childTurnId,
                })
                .pipe(
                  Effect.timeout("3 seconds"),
                  Effect.catchCause(() =>
                    Effect.sync(() => {
                      childInterruptFailed = true;
                    }),
                  ),
                ),
            { concurrency: 8, discard: true },
          ).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchCause(() =>
              Effect.sync(() => {
                childInterruptFailed = true;
              }),
            ),
          );
          const effectiveTurnId = turnId ?? session.activeTurnId;
          if (effectiveTurnId) {
            yield* client.request("turn/interrupt", {
              threadId: providerThreadId,
              turnId: effectiveTurnId,
            });
          }
          if (childInterruptFailed) {
            return yield* Effect.fail(
              new CodexErrors.CodexAppServerTransportError({
                detail: "Could not interrupt all Codex child turns",
                cause: new Error("Child interrupt failed or timed out"),
              }),
            );
          }
          yield* Effect.forEach(
            Array.from((yield* Ref.get(collabChildAgentsRef)).keys()),
            (id) => reconcileChild(id, true).pipe(Effect.ignore),
            { concurrency: 8, discard: true },
          ).pipe(Effect.timeoutOption("5 seconds"));
        }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        const session = yield* Ref.get(sessionRef);
        if (
          session.activeTurnId &&
          response.thread.turns.some(
            (turn) => turn.id === session.activeTurnId && turn.status !== "inProgress",
          )
        ) {
          deviceTurnActive = false;
          yield* updateSession(sessionRef, { status: "ready", activeTurnId: undefined });
        }
        return parseThreadSnapshot(response);
      }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const response = yield* client.request("thread/rollback", {
            threadId: providerThreadId,
            numTurns,
          });
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });
          return parseThreadSnapshot(response);
        }),
      setGoal: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          return yield* client.request("thread/goal/set", {
            threadId: providerThreadId,
            ...input,
          });
        }),
      getGoal: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        return yield* client.request("thread/goal/get", { threadId: providerThreadId });
      }),
      clearGoal: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        return yield* client.request("thread/goal/clear", { threadId: providerThreadId });
      }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
